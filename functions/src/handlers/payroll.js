// Payroll generation and approval workflow.
// Each entitlement (student + academic year + period + allowance type) has a fixed
// ID and can be attached to one payroll at a time, inside a transaction, so a
// repeated or concurrent generation can never pay it twice.
import { onCall } from "firebase-functions/v2/https";
import { db, now, actor, audit, notify, usersWith, bad, notFound, conflict, str, getSettings, idArg } from "../fb.js";
import { ENT, ELIG, PAYROLL, PERIOD_NAMES, payrollNumber, checkPayrollAction, eligibilityId, roundPesos } from "../core/policy.js";
import { manilaToday, manilaMonth } from "../core/dates.js";
import { fullName } from "../core/records.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function allocateNumber(month) {
  return db.runTransaction(async tx => {
    const ref = db.doc(`counters/payroll_${month}`);
    const snap = await tx.get(ref);
    const n = (snap.exists ? snap.data().n : 0) + 1;
    tx.set(ref, { n });
    return payrollNumber(month, n);
  });
}

async function chunkedWrites(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    ops.slice(i, i + 400).forEach(fn => fn(b));
    await b.commit();
  }
}

export async function recalcTotals(payrollNo) {
  const items = await db.collection("payrollItems").where("payrollNo", "==", payrollNo).where("status", "==", "Included").get();
  const total = roundPesos(items.docs.reduce((t, d) => t + Number(d.data().amount || 0), 0));
  const academicYears = [...new Set(items.docs.map(d => d.data().academicYear))].sort();
  const periods = [...new Set(items.docs.map(d => d.data().period))].sort();
  await db.doc(`payrolls/${payrollNo}`).update({ itemCount: items.size, total, academicYears, periods, updatedAt: now() });
  return { itemCount: items.size, total };
}

/**
 * Builds a payroll from every entitlement awaiting payroll.
 * a = acting user, or null for the scheduled job. Returns { payrollNo } or { skipped }.
 */
export async function generatePayrollCore({ month, a = null, auto = false }) {
  if (!MONTH_RE.test(month || "")) bad("Payroll month must look like 2026-10.");
  if (auto) {
    const existing = await db.collection("payrolls").where("autoMonth", "==", month).limit(1).get();
    if (!existing.empty) return { skipped: `An automatic payroll for ${month} already exists (${existing.docs[0].id}).` };
  }
  const awaiting = await db.collection("allowances").where("status", "==", ENT.AWAITING).limit(2000).get();
  if (awaiting.empty) return { skipped: "No qualified entitlements are waiting for payroll." };

  const payrollNo = await allocateNumber(month);
  const pref = db.doc(`payrolls/${payrollNo}`);
  const by = a ? { uid: a.uid, name: a.name } : { uid: "system", name: "Scheduled job" };
  await pref.set({
    payrollNo, month, status: auto ? PAYROLL.GENERATED : PAYROLL.DRAFT, auto, autoMonth: auto ? month : null,
    itemCount: 0, total: 0, academicYears: [], periods: [],
    generatedBy: by, preparedBy: null, reviewedBy: null, approvedBy: null,
    releasedAt: null, paymentRef: null, dvNo: null, createdAt: now(), updatedAt: now(),
    history: [{ at: new Date().toISOString(), by: by.name, action: "generated" }]
  });

  let added = 0;
  for (const e of awaiting.docs) {
    const ok = await db.runTransaction(async tx => {
      const es = await tx.get(e.ref);
      const ent = es.data();
      if (!es.exists || ent.status !== ENT.AWAITING || ent.payrollId) return false; // taken by another run
      const ss = await tx.get(db.doc(`students/${ent.studentId}`));
      const s = ss.data() || {};
      tx.update(e.ref, { status: ENT.IN_PROGRESS, payrollId: payrollNo, payrollNo, updatedAt: now() });
      tx.set(db.doc(`payrollItems/${payrollNo}_${e.id}`), {
        payrollId: payrollNo, payrollNo, month, entitlementId: e.id, status: "Included",
        studentId: ent.studentId, uid: ent.uid || s.uid || null, studentName: fullName(s) || ent.studentName,
        batch: s.qualification?.batch || s.batch || ent.batch || "", classification: s.classification || ent.classification || "",
        school: s.current?.school || "", atmNumber: s.atmNumber || "",
        academicYear: ent.academicYear, period: ent.period, typeCode: ent.typeCode, typeName: ent.typeName,
        amount: Number(ent.amount), createdAt: now()
      });
      return true;
    });
    if (ok) added++;
  }
  if (!added) {
    await pref.update({ status: PAYROLL.VOIDED, voidReason: "No entitlements were available when the payroll was built.", updatedAt: now() });
    return { skipped: "No entitlements were available (another payroll took them)." };
  }
  const totals = await recalcTotals(payrollNo);
  await audit(a, "payroll.generate", { type: "payroll", id: payrollNo }, { after: { month, auto, ...totals } });
  await notify(await usersWith("preparePayroll"), { title: `Payroll ${payrollNo} generated`, body: `${totals.itemCount} entitlement(s), total ₱${totals.total.toLocaleString("en-PH", { minimumFractionDigits: 2 })}. Review it and submit for approval.`, link: `#/payroll/${payrollNo}`, kind: "action" });
  return { payrollNo, ...totals };
}

export const generatePayroll = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"], perm: "preparePayroll" });
  const month = request.data?.month || manilaMonth();
  return generatePayrollCore({ month, a, auto: false });
});

async function setEligibilityStatus(items, status) {
  const ids = [...new Set(items.map(i => eligibilityId(i.studentId, i.academicYear, i.period)))];
  await chunkedWrites(ids.map(id => b => b.set(db.doc(`eligibility/${id}`), { status, updatedAt: now() }, { merge: true })));
}

/** data: { payrollNo, action, itemId?, dvNo?, paymentDate?, paymentRef?, reason? }
 * submitReview = the prepared payroll is forwarded to the Accounting Office under a DV number. */
export const payrollAction = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"] });
  const { action } = request.data || {};
  const payrollNo = idArg(request.data?.payrollNo, "payroll number");
  const input = { paymentDate: request.data?.paymentDate, paymentRef: str(request.data?.paymentRef, 120), dvNo: str(request.data?.dvNo, 60), reason: str(request.data?.reason, 500) };
  const pref = db.doc(`payrolls/${payrollNo}`);
  const settings = await getSettings();
  const entry = { at: new Date().toISOString(), by: a.name, action, ...(input.reason ? { reason: input.reason } : {}), ...(input.paymentRef ? { paymentRef: input.paymentRef } : {}), ...(input.dvNo ? { dvNo: input.dvNo } : {}) };

  // 1. Status change, checked and applied atomically.
  const before = await db.runTransaction(async tx => {
    const ps = await tx.get(pref);
    if (!ps.exists) notFound("Payroll not found.");
    const p = ps.data();
    const err = checkPayrollAction(p, action, a, input, manilaToday());
    if (err) conflict(err);
    const me = { uid: a.uid, name: a.name, at: new Date().toISOString() };
    const upd = { updatedAt: now(), history: [...(p.history || []), entry] };
    if (action === "submitReview") Object.assign(upd, { status: PAYROLL.REVIEW, preparedBy: me, reviewedBy: null, dvNo: input.dvNo, forwardedToAccountingAt: me.at });
    if (action === "review") Object.assign(upd, { reviewedBy: me });
    if (action === "approve") Object.assign(upd, { status: PAYROLL.APPROVED, approvedBy: me, signatories: settings.payroll.signatories, signatoryTitles: settings.payroll.signatoryTitles || null });
    if (action === "release") Object.assign(upd, { status: PAYROLL.RELEASED, releasedAt: input.paymentDate, paymentRef: input.paymentRef, releasedBy: me });
    if (action === "archive") Object.assign(upd, { status: PAYROLL.ARCHIVED });
    if (action === "void") Object.assign(upd, { status: PAYROLL.VOIDED, voidReason: input.reason, voidedBy: me });
    if (action !== "removeItem") tx.update(pref, upd);
    return p;
  });

  // 2. Effects on the lines and entitlements.
  const itemsSnap = await db.collection("payrollItems").where("payrollNo", "==", payrollNo).where("status", "==", "Included").get();
  const items = itemsSnap.docs.map(d => ({ ref: d.ref, ...d.data() }));
  const entRef = i => db.doc(`allowances/${i.entitlementId}`);

  if (action === "removeItem") {
    const item = items.find(i => i.ref.id === request.data?.itemId);
    if (!item) notFound("That line is not in this payroll.");
    if (!input.reason) bad("Give the reason for removing this line.");
    await db.runTransaction(async tx => {
      const [ps, es, is] = await Promise.all([tx.get(pref), tx.get(entRef(item)), tx.get(item.ref)]);
      const err = checkPayrollAction(ps.data(), "removeItem", a, input); if (err) conflict(err); // re-checked: status may have moved on
      if (!is.exists || is.data().status !== "Included") conflict("That line was already removed.");
      tx.update(item.ref, { status: "Removed", removedReason: input.reason, removedBy: { uid: a.uid, name: a.name } });
      if (es.exists && es.data().payrollNo === payrollNo) tx.update(entRef(item), { status: ENT.AWAITING, payrollId: null, payrollNo: null, updatedAt: now() });
      tx.update(pref, { history: [...(ps.data().history || []), entry], updatedAt: now() });
    });
    await recalcTotals(payrollNo);
  } else if (action === "approve") {
    await chunkedWrites(items.map(i => b => b.update(entRef(i), { status: ENT.INCLUDED, updatedAt: now() })));
    await setEligibilityStatus(items, ELIG.INCLUDED);
    await notify([...new Set(items.map(i => i.uid))], { title: "Allowance included in payroll", body: `Your allowance is included in approved payroll ${payrollNo}.`, link: "#/allowance", kind: "ok" });
    await notify(await usersWith("releasePayroll"), { title: `Payroll ${payrollNo} approved`, body: "Record the payment date and reference once it is released.", link: `#/payroll/${payrollNo}`, kind: "action", email: false });
  } else if (action === "release") {
    await chunkedWrites(items.map(i => b => b.update(entRef(i), { status: ENT.RELEASED, releasedAt: input.paymentDate, paymentRef: input.paymentRef, updatedAt: now() })));
    await setEligibilityStatus(items, ELIG.RELEASED);
    for (const i of items) if (i.uid) await notify(i.uid, { title: "Allowance released", body: `₱${Number(i.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })} (${i.typeName}, ${PERIOD_NAMES[i.period]}, AY ${i.academicYear}) was released on ${input.paymentDate}. Reference: ${input.paymentRef}.`, link: "#/allowance", kind: "ok" });
  } else if (action === "void") {
    await chunkedWrites(items.flatMap(i => [
      b => b.update(i.ref, { status: "Voided" }),
      b => b.update(entRef(i), { status: ENT.AWAITING, payrollId: null, payrollNo: null, updatedAt: now() })
    ]));
    if (before.status === PAYROLL.APPROVED) await setEligibilityStatus(items, ELIG.QUALIFIED);
  } else if (action === "submitReview") {
    await notify((await usersWith("preparePayroll")).filter(u => u !== a.uid), { title: `Payroll ${payrollNo} needs review`, body: "Check the lines and mark it reviewed.", link: `#/payroll/${payrollNo}`, kind: "action" });
  } else if (action === "review") {
    await notify(await usersWith("approvePayroll"), { title: `Payroll ${payrollNo} ready for approval`, body: `Reviewed by ${a.name}.`, link: `#/payroll/${payrollNo}`, kind: "action" });
  }
  await audit(a, `payroll.${action}`, { type: "payroll", id: payrollNo }, { before: { status: before.status }, after: { status: action === "removeItem" ? before.status : undefined, ...input }, reason: input.reason });
  return { ok: true };
});

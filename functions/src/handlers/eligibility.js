// Allowance eligibility per student, academic year and allowance period.
// Document approval and eligibility are separate: approved documents only make
// a period "For Review"; a staff decision makes it Qualified or Not Qualified.
import { onCall } from "firebase-functions/v2/https";
import { db, now, actor, audit, notify, bad, notFound, conflict, str, getSettings } from "../fb.js";
import {
  ELIG, ENT, PERIODS, PERIOD_NAMES, periodForTerm, termsForPeriod, termDocState, deriveEligibility,
  eligibilityId, entitlementId, academicRecordId, resolveOpeningDate, typeActiveOn, rateOn,
  validateTypeCombination, programActiveOn
} from "../core/policy.js";
import { fullName } from "../core/records.js";
import { isValidAY, manilaToday, compareYMD } from "../core/dates.js";

async function activeRequirements() {
  const q = await db.collection("documentRequirements").where("active", "==", true).get();
  return q.docs.map(d => d.data());
}

export async function recomputeForTerm(studentId, academicYear, term) {
  const settings = await getSettings();
  const period = periodForTerm(settings.termPeriodMap, term);
  if (period) await recompute(studentId, academicYear, period, settings);
}

export async function recompute(studentId, academicYear, period, settings = null) {
  settings = settings || await getSettings();
  const terms = termsForPeriod(settings.termPeriodMap, period);
  const [reqs, subsQ, recs, stu] = await Promise.all([
    activeRequirements(),
    db.collection("submissions").where("studentId", "==", studentId).where("academicYear", "==", academicYear).get(),
    Promise.all(terms.map(t => db.doc(`studentAcademicHistory/${academicRecordId(studentId, academicYear, t)}`).get())),
    db.doc(`students/${studentId}`).get()
  ]);
  const subs = subsQ.docs.map(d => d.data());
  const termStates = [];
  terms.forEach((t, i) => {
    const tSubs = subs.filter(s => s.term === t);
    if (!recs[i].exists && !tSubs.length) return; // not enrolled / nothing submitted for this term
    termStates.push({ term: t, ...termDocState(reqs, tSubs, t) });
  });
  const ref = db.doc(`eligibility/${eligibilityId(studentId, academicYear, period)}`);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    const { status, docsComplete } = deriveEligibility(cur?.status, termStates);
    const s = stu.data() || {};
    const value = {
      studentId, uid: s.uid || null, studentName: fullName(s), academicYear, period,
      status, docsComplete, terms: termStates, updatedAt: now()
    };
    if (!cur) tx.set(ref, { ...value, createdAt: now() });
    else if (cur.status !== status || cur.docsComplete !== docsComplete || JSON.stringify(cur.terms) !== JSON.stringify(termStates)) tx.update(ref, value);
    return value;
  });
}

/** The date whose allowance rate applies: the opening of the first enrolled term of the period. */
async function referenceDate(studentId, academicYear, period, settings) {
  const terms = termsForPeriod(settings.termPeriodMap, period);
  const ay = (await db.doc(`academicYears/${academicYear}`).get()).data() || null;
  const dates = [];
  for (const t of terms) {
    const r = await db.doc(`studentAcademicHistory/${academicRecordId(studentId, academicYear, t)}`).get();
    const rec = r.exists ? r.data() : null;
    const school = rec?.schoolId ? (await db.doc(`schools/${rec.schoolId}`).get()).data() : null;
    const d = resolveOpeningDate({ record: rec, school, academicYear: ay, ay: academicYear, term: t });
    if (d) dates.push(d);
  }
  dates.sort(compareYMD);
  return dates[0] || manilaToday();
}

/**
 * data: { studentId, academicYear, period, decision: "Qualified"|"Not Qualified", reason, allowanceTypes: [codes] }
 */
export const decideEligibility = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"], perm: "decideEligibility" });
  const { studentId, academicYear, period, decision, reason } = request.data || {};
  const codes = [...new Set((request.data?.allowanceTypes || []).map(c => str(c, 30)))];
  if (!isValidAY(academicYear) || !PERIODS.includes(period)) bad("Choose the academic year and allowance period.");
  if (![ELIG.QUALIFIED, ELIG.NOT_QUALIFIED].includes(decision)) bad("Decision must be Qualified or Not Qualified.");
  if (decision === ELIG.NOT_QUALIFIED && !str(reason)) bad("Give the reason the student is not qualified.");
  if (decision === ELIG.QUALIFIED && !codes.length) bad("Choose at least one allowance type.");

  const settings = await getSettings();
  await recompute(studentId, academicYear, period, settings);
  const refDate = await referenceDate(studentId, academicYear, period, settings);
  const eref = db.doc(`eligibility/${eligibilityId(studentId, academicYear, period)}`);
  const sref = db.doc(`students/${studentId}`);
  const typeRefs = codes.map(c => db.doc(`allowanceTypes/${c}`));
  const entRefs = codes.map(c => db.doc(`allowances/${entitlementId(studentId, academicYear, period, c)}`));

  const result = await db.runTransaction(async tx => {
    const [es, ss, ...rest] = await Promise.all([tx.get(eref), tx.get(sref), ...typeRefs.map(r => tx.get(r)), ...entRefs.map(r => tx.get(r))]);
    const typeSnaps = rest.slice(0, codes.length), entSnaps = rest.slice(codes.length);
    if (!es.exists || !ss.exists) notFound("No eligibility record for this period yet.");
    const e = es.data(), s = ss.data();
    if (![ELIG.REVIEW, ELIG.QUALIFIED, ELIG.NOT_QUALIFIED].includes(e.status)) conflict(`Eligibility is ${e.status}; it can't be changed now.`);
    // Existing entitlements for this period that are already in a payroll can't be undone here.
    const periodEnts = await tx.get(db.collection("allowances").where("studentId", "==", studentId).where("academicYear", "==", academicYear).where("period", "==", period));
    const locked = periodEnts.docs.filter(d => ![ENT.AWAITING, ENT.CANCELLED].includes(d.data().status));
    if (locked.length) conflict("This period is already in a payroll. Void or complete that payroll first.");

    let entitlements = [];
    if (decision === ELIG.QUALIFIED) {
      if (!e.docsComplete) conflict("All required documents for this period must be approved first.");
      if (!s.classification) conflict("Set the student's Top 10 / Top 20 classification first.");
      if (!programActiveOn(s, refDate)) conflict(`The student's program ended before ${refDate}.`);
      const types = typeSnaps.map((t, i) => { if (!t.exists) bad(`Unknown allowance type ${codes[i]}.`); return t.data(); });
      for (const t of types) {
        if (!typeActiveOn(t, refDate)) conflict(`${t.name} is not active on ${refDate}.`);
        if (t.classifications?.length && !t.classifications.includes(s.classification)) conflict(`${t.name} does not apply to this classification.`);
        if (t.appliesTo === "latinHonor" && !s.latinHonor) conflict(`${t.name} requires a verified Latin honor on the student's record.`);
        if (!rateOn(t, refDate)) conflict(`${t.name} has no rate in force on ${refDate}. Set it in Settings → Allowance types.`);
      }
      const combo = validateTypeCombination(types); if (combo) conflict(combo);
      for (const t of types) if (t.maxPeriods) {
        const used = await tx.get(db.collection("allowances").where("studentId", "==", studentId).where("typeCode", "==", t.code));
        const count = used.docs.filter(d => d.data().status !== ENT.CANCELLED && !(d.data().academicYear === academicYear && d.data().period === period)).length;
        if (count >= t.maxPeriods) conflict(`${t.name} can be paid at most ${t.maxPeriods} time(s); this student has reached the limit.`);
      }
      // Writes
      for (const d of periodEnts.docs) if (d.data().status === ENT.AWAITING && !codes.includes(d.data().typeCode)) tx.update(d.ref, { status: ENT.CANCELLED, cancelledAt: now(), cancelReason: "Allowance types changed" });
      types.forEach((t, i) => {
        const rate = rateOn(t, refDate);
        const existing = entSnaps[i].exists ? entSnaps[i].data() : null;
        if (existing && existing.status === ENT.AWAITING) return; // already queued
        const value = {
          studentId, uid: s.uid || null, studentName: fullName(s), academicYear, period, typeCode: t.code, typeName: t.name,
          amount: Number(rate.amount), rateEffectiveFrom: rate.effectiveFrom, referenceDate: refDate,
          classification: s.classification, batch: s.qualification?.batch || s.batch || "",
          status: ENT.AWAITING, payrollId: null, payrollNo: null, releasedAt: null, paymentRef: null,
          source: "system", qualifiedBy: { uid: a.uid, name: a.name }, updatedAt: now(), ...(existing ? {} : { createdAt: now() })
        };
        tx.set(entRefs[i], value, { merge: true });
        entitlements.push({ code: t.code, amount: value.amount });
      });
    } else {
      for (const d of periodEnts.docs) if (d.data().status === ENT.AWAITING) tx.update(d.ref, { status: ENT.CANCELLED, cancelledAt: now(), cancelReason: str(reason, 300) });
    }
    tx.update(eref, { status: decision, decision: { by: { uid: a.uid, name: a.name }, at: new Date().toISOString(), reason: str(reason, 500), allowanceTypes: decision === ELIG.QUALIFIED ? codes : [] }, updatedAt: now() });
    audit(a, "eligibility.decide", { type: "eligibility", id: eref.id }, { before: { status: e.status }, after: { status: decision, entitlements }, reason: str(reason, 500) }, tx);
    return { entitlements, uid: s.uid };
  });
  if (result.uid) await notify(result.uid, {
    title: decision === ELIG.QUALIFIED ? "You qualified for the allowance" : "Allowance eligibility result",
    body: decision === ELIG.QUALIFIED
      ? `You qualified for the ${PERIOD_NAMES[period]}, AY ${academicYear}. It will be included in the next payroll.`
      : `You did not qualify for the ${PERIOD_NAMES[period]}, AY ${academicYear}: ${str(reason, 300)}`,
    link: "#/allowance", kind: decision === ELIG.QUALIFIED ? "ok" : "warn"
  });
  return { ok: true, ...result };
});

/** Staff can trigger a recalculation (e.g. after changing requirements). */
export const recalcEligibility = onCall(async request => {
  await actor(request, { roles: ["staff", "admin"], perm: "decideEligibility" });
  const { studentId, academicYear, period } = request.data || {};
  if (!isValidAY(academicYear) || !PERIODS.includes(period)) bad("Choose the academic year and period.");
  return { ok: true, eligibility: await recompute(studentId, academicYear, period) };
});

// Bulk student import, historical payment import, and old-portal migration.
// Every import supports a dry run that validates rows and reports duplicates
// without writing anything.
import { onCall } from "firebase-functions/v2/https";
import { db, now, actor, audit, bad, str, getSettings, denied } from "../fb.js";
import { ENT, ELIG, entitlementId, eligibilityId, hasPermission } from "../core/policy.js";
import { validateHistoricalRow, validateStudentImportRow, mapLegacyStudent, nameKey, fullName } from "../core/records.js";
import { manilaToday } from "../core/dates.js";

const MAX_ROWS = 2000;

async function loadStudents() {
  const snap = await db.collection("students").get();
  const students = new Map(), byName = new Map(), byEmail = new Map(), byNameDob = new Map();
  for (const d of snap.docs) {
    const s = d.data();
    students.set(d.id, s);
    const k = nameKey(fullName(s));
    byName.set(k, [...(byName.get(k) || []), d.id]);
    if (s.emailLower) byEmail.set(s.emailLower, d.id);
    if (s.dateOfBirth) byNameDob.set(`${k}|${s.dateOfBirth}`, d.id);
  }
  return { students, byName, byEmail, byNameDob };
}

async function nextIds(count) {
  const year = manilaToday().slice(0, 4);
  return db.runTransaction(async tx => {
    const ref = db.doc(`counters/students_${year}`);
    const snap = await tx.get(ref);
    const start = (snap.exists ? snap.data().n : 0) + 1;
    tx.set(ref, { n: start + count - 1 });
    return Array.from({ length: count }, (_, i) => `TSC-${year}-${String(start + i).padStart(4, "0")}`);
  });
}

async function importStudents(a, rows, dryRun, importId) {
  const { students, byEmail, byNameDob } = await loadStudents();
  const seen = new Set();
  const results = rows.map((row, index) => {
    const { errors, value } = validateStudentImportRow(row);
    const warnings = [];
    const key = `${nameKey(fullName(value))}|${value.dateOfBirth}`;
    if (value.toscanId && students.has(value.toscanId)) errors.push(`TOSCAN ID ${value.toscanId} already exists.`);
    if (value.email && byEmail.has(value.email)) errors.push(`Email already belongs to ${byEmail.get(value.email)}.`);
    if (value.dateOfBirth && byNameDob.has(key)) errors.push(`Same name and birth date as ${byNameDob.get(key)}.`);
    const fileKey = value.toscanId || key;
    if (seen.has(fileKey)) errors.push("Duplicate of an earlier row in this file.");
    seen.add(fileKey);
    if (!value.toscanId) warnings.push("No TOSCAN ID: a TSC number will be generated.");
    if (!value.classification) warnings.push("No classification: set Top 10 / Top 20 before eligibility decisions.");
    return { index, ok: !errors.length, errors, warnings, value };
  });
  if (dryRun) return results;
  const good = results.filter(r => r.ok);
  const generated = await nextIds(good.filter(r => !r.value.toscanId).length);
  const ops = good.map(r => {
    const v = r.value;
    const id = v.toscanId || generated.shift();
    r.studentId = id;
    return b => b.create(db.doc(`students/${id}`), {
      studentId: id, profileVersion: 2, uid: null, email: v.email, emailLower: v.email,
      surname: v.surname, firstName: v.firstName, middleName: v.middleName, extName: v.extName,
      dateOfBirth: v.dateOfBirth, contact: v.contact, address: v.address, atmNumber: v.atmNumber,
      classification: v.classification, latinHonor: v.latinHonor,
      qualification: { batch: v.batch, yearQualified: v.yearQualified, schoolAtQualification: v.schoolAtQualification, awardType: "", admissionDate: v.admissionDate },
      current: { school: v.currentSchool, schoolAddress: "", level: v.level, program: v.program, yearLevel: v.yearLevel, academicYear: "", term: "", enrollmentStatus: "", expectedGraduation: "" },
      programStatus: v.programStatus, ...(v.programStatus === "Ended" ? { programEnded: { effectiveDate: "", reason: "Imported as Ended", remarks: "", by: { uid: a.uid, name: a.name } } } : {}),
      source: "import", importId, importedBy: { uid: a.uid, name: a.name }, importedAt: now(), createdAt: now(), updatedAt: now()
    });
  });
  for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
  return results;
}

async function importHistorical(a, rows, dryRun, importId, meta) {
  const settings = await getSettings();
  const { students, byName } = await loadStudents();
  const typesSnap = await db.collection("allowanceTypes").get();
  const types = new Map(typesSnap.docs.map(d => [d.id, d.data()]));
  const seen = new Set();
  const results = [];
  for (const [index, row] of rows.entries()) {
    const { errors, value } = validateHistoricalRow(row, { students, byName, types, termPeriodMap: settings.termPeriodMap });
    const warnings = [];
    if (!errors.length) {
      const eid = entitlementId(value.studentId, value.academicYear, value.period, value.typeCode);
      if (seen.has(eid)) errors.push("Duplicate of an earlier row (same student, year, period and category).");
      seen.add(eid);
      const existing = await db.doc(`allowances/${eid}`).get();
      if (existing.exists && existing.data().status !== ENT.CANCELLED) errors.push(`Already recorded as ${existing.data().status}${existing.data().payrollNo ? ` (payroll ${existing.data().payrollNo})` : ""}.`);
      value.entitlementId = eid;
      if (value.status === "Unpaid") warnings.push("Unpaid: will be queued for the next payroll.");
    }
    results.push({ index, ok: !errors.length, errors, warnings, value });
  }
  if (dryRun) return results;
  for (const r of results.filter(x => x.ok)) {
    const v = r.value, s = students.get(v.studentId);
    const entRef = db.doc(`allowances/${v.entitlementId}`);
    try {
      await db.runTransaction(async tx => {
        const es = await tx.get(entRef);
        if (es.exists && es.data().status !== ENT.CANCELLED) throw new Error(`Already recorded as ${es.data().status}.`);
        const hist = db.collection("historicalPayments").doc();
        tx.set(hist, {
          ...v, studentName: fullName(s), source: meta.sourceName || "Manual entry", importId, attachmentPath: meta.attachmentPath || "",
          migrated: true, importedBy: { uid: a.uid, name: a.name }, importedAt: now()
        });
        tx.set(entRef, {
          studentId: v.studentId, uid: s.uid || null, studentName: fullName(s), academicYear: v.academicYear, period: v.period,
          typeCode: v.typeCode, typeName: types.get(v.typeCode)?.name || v.typeCode, amount: v.amount, classification: s.classification || "",
          batch: v.batch || s.qualification?.batch || s.batch || "",
          status: v.status === "Released" ? ENT.RELEASED : ENT.AWAITING, payrollId: null, payrollNo: v.payrollNo || null,
          releasedAt: v.releaseDate || null, paymentRef: v.payrollNo || null, payrollDate: v.payrollDate || null,
          source: "imported", historicalPaymentId: hist.id, importId, remarks: v.remarks, createdAt: now(), updatedAt: now()
        });
        if (v.status === "Released") tx.set(db.doc(`eligibility/${eligibilityId(v.studentId, v.academicYear, v.period)}`), {
          studentId: v.studentId, uid: s.uid || null, studentName: fullName(s), academicYear: v.academicYear, period: v.period,
          status: ELIG.RELEASED, docsComplete: true, terms: [], source: "imported", updatedAt: now()
        }, { merge: true });
      });
      r.saved = true;
    } catch (e) { r.ok = false; r.errors = [e.message]; }
  }
  return results;
}

/** data: { kind: "students"|"historical", rows: [...], dryRun: bool, sourceName?, attachmentPath? } */
export const importRecords = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async request => {
  const a = await actor(request, { roles: ["staff", "admin"] });
  const { kind, rows, dryRun = true } = request.data || {};
  if (!Array.isArray(rows) || !rows.length) bad("The file has no rows.");
  if (rows.length > MAX_ROWS) bad(`Import at most ${MAX_ROWS} rows at a time.`);
  const attachmentPath = str(request.data?.attachmentPath, 300);
  if (attachmentPath && !attachmentPath.startsWith("historical/")) bad("Invalid attachment location.");
  const importId = db.collection("imports").doc().id;
  let results;
  if (kind === "students") {
    if (a.role !== "admin") denied("Only administrators can import students.");
    results = await importStudents(a, rows, dryRun, importId);
  } else if (kind === "historical") {
    if (!hasPermission(a, "encodeHistory")) denied("You are not authorized to encode historical records.");
    results = await importHistorical(a, rows, dryRun, importId, { sourceName: str(request.data?.sourceName, 200), attachmentPath });
  } else bad("Unknown import kind.");
  const summary = { total: results.length, valid: results.filter(r => r.ok).length, invalid: results.filter(r => !r.ok).length };
  if (!dryRun) {
    await db.doc(`imports/${importId}`).set({ kind, ...summary, sourceName: str(request.data?.sourceName, 200), attachmentPath, by: { uid: a.uid, name: a.name }, at: now() });
    await audit(a, `import.${kind}`, { type: "import", id: importId }, { after: summary });
  }
  return { importId: dryRun ? null : importId, dryRun, summary, results };
});

/**
 * Upgrades old-portal records in place. Existing values are never overwritten:
 * only missing structured fields are added. archivedStudents are copied (not moved)
 * into students with program status Ended.
 */
export const migrateLegacy = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async request => {
  const a = await actor(request, { roles: ["admin"] });
  const dryRun = request.data?.dryRun !== false;
  const [cur, arch] = await Promise.all([db.collection("students").get(), db.collection("archivedStudents").get()]);
  const plan = [];
  for (const d of cur.docs) {
    const s = d.data();
    if (s.profileVersion === 2) continue;
    const mapped = mapLegacyStudent(d.id, s);
    const patch = {};
    for (const [k, v] of Object.entries(mapped)) {
      if (typeof v === "object" && v && !Array.isArray(v)) {
        const existing = s[k] && typeof s[k] === "object" ? s[k] : {};
        const merged = { ...v, ...Object.fromEntries(Object.entries(existing).filter(([, x]) => x !== "" && x != null)) };
        patch[k] = merged;
      } else if (s[k] === undefined || s[k] === "") patch[k] = v;
    }
    patch.profileVersion = 2;
    plan.push({ id: d.id, action: "upgrade", name: fullName({ ...s, ...patch }), classification: patch.classification ?? s.classification ?? "", programStatus: patch.programStatus ?? s.programStatus, patch });
  }
  const existingIds = new Set(cur.docs.map(d => d.id));
  for (const d of arch.docs) {
    if (existingIds.has(d.id)) { plan.push({ id: d.id, action: "skip", reason: "A current record with this ID exists; the archived copy is left in archivedStudents." }); continue; }
    const mapped = mapLegacyStudent(d.id, d.data(), { archived: true });
    plan.push({ id: d.id, action: "copyArchived", name: fullName(mapped), classification: mapped.classification, programStatus: "Ended", patch: { ...d.data(), ...mapped, migratedFrom: "archivedStudents" } });
  }
  if (!dryRun) {
    const ops = plan.filter(p => p.action !== "skip").map(p => b => b.set(db.doc(`students/${p.id}`), { ...p.patch, migratedAt: now(), migratedBy: { uid: a.uid, name: a.name } }, { merge: true }));
    for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
    await audit(a, "migration.legacy", { type: "migration", id: "students" }, { after: { upgraded: plan.filter(p => p.action === "upgrade").length, copied: plan.filter(p => p.action === "copyArchived").length } });
  }
  return { dryRun, plan: plan.map(({ patch, ...rest }) => rest) };
});


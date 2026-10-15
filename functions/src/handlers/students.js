// Student master records, academic history, program status, deadline extensions.
import { onCall } from "firebase-functions/v2/https";
import { db, auth, now, actor, audit, notify, bad, notFound, conflict, denied, str, FieldValue, idArg } from "../fb.js";
import { academicRecordId, extensionId, TERMS, TERM_NAMES } from "../core/policy.js";
import { LATIN_HONORS, CLASSIFICATIONS } from "../core/records.js";
import { isValidAY, isValidYMD } from "../core/dates.js";
import { recomputeForTerm } from "./eligibility.js";

const TOP = ["surname", "firstName", "middleName", "extName", "dateOfBirth", "contact", "address", "atmNumber", "classification", "latinHonor"];
const QUAL = ["batch", "yearQualified", "schoolAtQualification", "awardType", "admissionDate"];
const CUR = ["school", "schoolId", "schoolAddress", "level", "program", "yearLevel", "academicYear", "term", "enrollmentStatus", "expectedGraduation"];
const LOCKED = ["surname", "firstName", "middleName", "dateOfBirth", "classification", "latinHonor", ...QUAL.map(k => "qualification." + k)];
const ENROLLMENT = ["Enrolled", "Not Enrolled", "On Leave", "Graduated", "Transferred"];

/** Administrator edit of any field, including locked identity and qualification data (reason required for those). */
export const adminUpdateStudent = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const { patch = {}, reason } = request.data || {};
  const studentId = idArg(request.data?.studentId, "TOSCAN ID");
  const ref = db.doc(`students/${studentId}`);
  const snap = await ref.get();
  if (!snap.exists) notFound("Student not found.");
  const s = snap.data();
  const update = {}, before = {}, after = {};
  const setField = (path, value, old) => {
    if ((old ?? "") === value) return;
    update[path] = value; before[path] = old ?? ""; after[path] = value;
  };
  for (const k of TOP) if (patch[k] !== undefined) {
    let v = str(patch[k], 300);
    if (["surname", "firstName", "middleName", "address"].includes(k)) v = v.toUpperCase();
    if (k === "dateOfBirth" && v && !isValidYMD(v)) bad("Invalid date of birth.");
    if (k === "classification" && v && !CLASSIFICATIONS[v]) bad("Classification must be top10 or top20.");
    if (k === "latinHonor" && !LATIN_HONORS.includes(v)) bad("Invalid Latin honor.");
    setField(k, v, s[k]);
  }
  for (const k of QUAL) if (patch.qualification?.[k] !== undefined) {
    const v = str(patch.qualification[k], 200);
    if (k === "admissionDate" && v && !isValidYMD(v)) bad("Invalid admission date.");
    if (k === "yearQualified" && v && !/^\d{4}$/.test(v)) bad("Year of qualification must be a 4-digit year.");
    setField(`qualification.${k}`, k === "schoolAtQualification" ? v.toUpperCase() : v, s.qualification?.[k]);
  }
  for (const k of CUR) if (patch.current?.[k] !== undefined) {
    const v = str(patch.current[k], 200);
    if (k === "academicYear" && v && !isValidAY(v)) bad("Invalid academic year.");
    if (k === "term" && v && !TERMS.includes(v)) bad("Invalid term.");
    if (k === "expectedGraduation" && v && !isValidYMD(v)) bad("Invalid expected graduation date.");
    if (k === "enrollmentStatus" && v && !ENROLLMENT.includes(v)) bad("Invalid enrollment status.");
    setField(`current.${k}`, ["school", "program"].includes(k) ? v.toUpperCase() : v, s.current?.[k]);
  }
  if (!Object.keys(update).length) return { ok: true, changed: 0 };
  const touchesLocked = Object.keys(update).some(k => LOCKED.includes(k));
  if (touchesLocked && !str(reason)) bad("Give a reason for changing verified identity, classification or qualification data.");
  // The school at qualification is a permanent historical reference once recorded.
  if (update["qualification.schoolAtQualification"] !== undefined && s.qualification?.schoolAtQualification) {
    update["qualification.originalSchoolAtQualification"] = s.qualification.originalSchoolAtQualification || s.qualification.schoolAtQualification;
  }
  await ref.update({ ...update, profileVersion: 2, updatedAt: now() });
  await audit(a, "student.update", { type: "student", id: studentId }, { before, after, reason: str(reason, 500) });
  return { ok: true, changed: Object.keys(after).length };
});

/** Active ↔ Ended, with effective date, reason and a permanent history entry. */
export const setProgramStatus = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const { status, effectiveDate, reason, remarks } = request.data || {};
  const studentId = idArg(request.data?.studentId, "TOSCAN ID");
  if (!["Active", "Ended"].includes(status)) bad("Status must be Active or Ended.");
  if (!isValidYMD(effectiveDate)) bad("Enter the effective date.");
  if (!str(reason)) bad("Give the reason for this change.");
  const ref = db.doc(`students/${studentId}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) notFound("Student not found.");
    const s = snap.data();
    if ((s.programStatus || "Active") === status) conflict(`The program status is already ${status}.`);
    const entry = { effectiveDate, reason: str(reason, 300), remarks: str(remarks, 500), by: { uid: a.uid, name: a.name }, changedAt: now() };
    tx.update(ref, status === "Ended"
      ? { programStatus: "Ended", programEnded: entry, updatedAt: now() }
      : { programStatus: "Active", programEnded: FieldValue.delete(), updatedAt: now() });
    tx.set(db.collection("programStatusHistory").doc(), { studentId, from: s.programStatus || "Active", to: status, ...entry });
    audit(a, "student.programStatus", { type: "student", id: studentId }, { before: { programStatus: s.programStatus || "Active" }, after: { programStatus: status, effectiveDate }, reason: entry.reason }, tx);
  });
  const uid = (await ref.get()).data().uid;
  if (uid) await notify(uid, { title: `Program status: ${status}`, body: status === "Ended" ? `Your TOSCAN program membership ended effective ${effectiveDate}. Your records remain available.` : "Your TOSCAN program membership is active.", kind: status === "Ended" ? "warn" : "ok" });
  return { ok: true };
});

const termOrder = (ay, term) => `${ay}#${term}`;

/**
 * A student's enrollment for one academic term. Each term is its own record, so
 * earlier terms are never overwritten. A change of school, level or program needs staff verification.
 */
export const submitAcademicRecord = onCall(async request => {
  const a = await actor(request, { roles: ["student", "staff", "admin"] });
  const d = request.data || {};
  const studentId = a.role === "student" ? a.studentId : str(d.studentId, 60);
  if (a.role !== "student" && !(a.role === "admin" || a.permissions.includes("verifyRecords"))) denied();
  if (!isValidAY(d.academicYear)) bad("Choose the academic year.");
  if (!TERMS.includes(d.term)) bad("Choose the semester or term.");
  if (!(await db.doc(`academicYears/${d.academicYear}`).get()).exists) bad(`Academic year ${d.academicYear} is not set up yet. Contact the TOSCAN Office.`);
  let school = null;
  if (d.schoolId) {
    const sc = await db.doc(`schools/${d.schoolId}`).get();
    if (!sc.exists) bad("Unknown school.");
    school = { id: sc.id, ...sc.data() };
    if (d.term === "T3" && school.termsPerYear !== 3) bad(`${school.name} has only two semesters per year.`);
  }
  const values = {
    school: school ? school.name : str(d.school, 160).toUpperCase(), schoolId: school ? school.id : "",
    schoolAddress: school ? school.address : str(d.schoolAddress, 300), level: str(d.level, 80),
    program: str(d.program, 160).toUpperCase(), yearLevel: str(d.yearLevel, 40),
    enrollmentStatus: ENROLLMENT.includes(d.enrollmentStatus) ? d.enrollmentStatus : "Enrolled",
    expectedGraduation: isValidYMD(d.expectedGraduation) ? d.expectedGraduation : ""
  };
  if (!values.school) bad("Enter the school.");
  if (!values.program && values.level !== "Senior High School") bad("Enter the course, strand or program.");

  const sref = db.doc(`students/${studentId}`);
  const rref = db.doc(`studentAcademicHistory/${academicRecordId(studentId, d.academicYear, d.term)}`);
  const result = await db.runTransaction(async tx => {
    const [ss, rs] = await Promise.all([tx.get(sref), tx.get(rref)]);
    if (!ss.exists) notFound("Student record not found.");
    const s = ss.data(), prev = rs.exists ? rs.data() : null;
    const base = prev?.status === "Verified" ? prev : (s.current || {});
    const significant = !base.school || ["school", "level", "program"].some(k => (base[k] || "") !== (values[k] || "") && !(k === "level" && !base[k]));
    const status = a.role !== "student" ? "Verified" : significant ? "For Verification" : (prev?.status === "Rejected" ? "For Verification" : "Verified");
    const record = {
      studentId, academicYear: d.academicYear, term: d.term, ...values, status,
      openingDate: prev?.openingDate || "", updatedAt: now(),
      revisions: FieldValue.arrayUnion({ at: new Date().toISOString(), by: a.uid, values, status }),
      ...(prev ? {} : { createdAt: now() }),
      ...(significant && prev?.status === "Verified" ? { previousVerified: Object.fromEntries(["school", "level", "program", "yearLevel"].map(k => [k, prev[k] || ""])) } : {})
    };
    tx.set(rref, record, { merge: true });
    if (status === "Verified" && termOrder(d.academicYear, d.term) >= termOrder(s.current?.academicYear || "", s.current?.term || "")) {
      tx.update(sref, { current: { ...(s.current || {}), ...values, academicYear: d.academicYear, term: d.term }, updatedAt: now() });
    }
    audit(a, "academic.submit", { type: "academicRecord", id: rref.id }, { before: prev ? Object.fromEntries(Object.keys(values).map(k => [k, prev[k] || ""])) : null, after: { ...values, status } }, tx);
    return { status, significant };
  });
  return { ok: true, ...result, id: rref.id };
});

/** Staff verify or reject a term record, and may set the term's opening date for deadline purposes. */
export const verifyAcademicRecord = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"], perm: "verifyRecords" });
  const { decision, remarks, openingDate } = request.data || {};
  const id = idArg(request.data?.id, "record id");
  if (!["verify", "reject", "setOpening"].includes(decision)) bad("Unknown decision.");
  if (openingDate && !isValidYMD(openingDate)) bad("Invalid opening date.");
  if (decision === "reject" && !str(remarks)) bad("Give the reason for rejecting this record.");
  const rref = db.doc(`studentAcademicHistory/${id}`);
  const out = await db.runTransaction(async tx => {
    const rs = await tx.get(rref);
    if (!rs.exists) notFound("Academic record not found.");
    const r = rs.data();
    const sref = db.doc(`students/${r.studentId}`);
    const ss = await tx.get(sref);
    const s = ss.data() || {};
    const update = { updatedAt: now() };
    if (openingDate !== undefined) update.openingDate = openingDate || "";
    if (decision === "verify") Object.assign(update, { status: "Verified", verifiedBy: { uid: a.uid, name: a.name }, verifiedAt: now(), remarks: str(remarks, 500) });
    if (decision === "reject") Object.assign(update, { status: "Rejected", verifiedBy: { uid: a.uid, name: a.name }, verifiedAt: now(), remarks: str(remarks, 500) });
    tx.update(rref, update);
    if (decision === "verify" && termOrder(r.academicYear, r.term) >= termOrder(s.current?.academicYear || "", s.current?.term || "")) {
      tx.update(sref, { current: { ...(s.current || {}), ...Object.fromEntries(CUR.filter(k => r[k] !== undefined).map(k => [k, r[k]])), academicYear: r.academicYear, term: r.term }, updatedAt: now() });
    }
    audit(a, `academic.${decision}`, { type: "academicRecord", id }, { before: { status: r.status, openingDate: r.openingDate || "" }, after: update.status ? { status: update.status, openingDate: update.openingDate ?? r.openingDate ?? "" } : { openingDate: update.openingDate }, reason: str(remarks, 500) }, tx);
    return { r, uid: s.uid };
  });
  if (decision !== "setOpening" && out.uid) await notify(out.uid, {
    title: decision === "verify" ? "Enrollment record verified" : "Enrollment record not accepted",
    body: `${TERM_NAMES[out.r.term]}, AY ${out.r.academicYear}: ${decision === "verify" ? "verified." : str(remarks, 300)}`, kind: decision === "verify" ? "ok" : "warn"
  });
  await recomputeForTerm(out.r.studentId, out.r.academicYear, out.r.term);
  return { ok: true };
});

/** Administrator-approved deadline extension for one student-term. */
export const grantExtension = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const { academicYear, term, deadline, reason } = request.data || {};
  const studentId = idArg(request.data?.studentId, "TOSCAN ID");
  if (!isValidAY(academicYear) || !TERMS.includes(term)) bad("Choose the academic year and term.");
  if (!isValidYMD(deadline)) bad("Enter the new deadline.");
  if (!str(reason)) bad("Give the reason for the extension.");
  const s = await db.doc(`students/${studentId}`).get();
  if (!s.exists) notFound("Student not found.");
  const ref = db.doc(`deadlineExtensions/${extensionId(studentId, academicYear, term)}`);
  const before = (await ref.get()).data() || null;
  const value = { studentId, academicYear, term, deadline, reason: str(reason, 500), approvedBy: { uid: a.uid, name: a.name }, approvedAt: now() };
  await ref.set(value);
  await audit(a, "deadline.extension", { type: "student", id: studentId }, { before, after: { academicYear, term, deadline }, reason: value.reason });
  if (s.data().uid) await notify(s.data().uid, { title: "Submission deadline extended", body: `You can submit documents for ${TERM_NAMES[term]}, AY ${academicYear} until ${deadline}.`, kind: "ok" });
  return { ok: true };
});

/* ---------------- Change a TOSCAN ID ---------------- */
const SID_RE = /^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$/;
const BY_FIELD = ["submissions", "payrollItems", "historicalPayments", "programStatusHistory"];      // keyed by random id, carry studentId
const BY_ID = ["studentAcademicHistory", "eligibility", "allowances", "deadlineExtensions"];          // keyed by `${studentId}_…`

async function chunked(ops) {
  for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(fn => fn(b)); await b.commit(); }
}

/**
 * Administrator: change a student's TOSCAN ID. Every record that carries the old ID
 * (documents, term records, eligibility, allowances, payroll lines, history, extensions,
 * the login account and its sign-in token) is moved to the new ID. The old ID is kept in
 * the record's `previousIds` and in the audit trail. Refused while a payroll containing
 * this student is still in progress.
 */
export const renameStudentId = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const oldId = idArg(request.data?.studentId, "TOSCAN ID");
  const newId = str(request.data?.newStudentId, 40).toUpperCase().replace(/\s+/g, "");
  const reason = str(request.data?.reason, 300);
  if (!SID_RE.test(newId)) bad("The new TOSCAN ID may contain capital letters, digits and dashes only (3–40 characters).");
  if (newId === oldId) bad("The new ID is the same as the current one.");
  if (!reason) bad("Enter the reason for changing the ID.");
  const oldRef = db.doc(`students/${oldId}`), newRef = db.doc(`students/${newId}`);
  const [os, ns] = await Promise.all([oldRef.get(), newRef.get()]);
  if (!os.exists) notFound("Student not found.");
  if (ns.exists) conflict(`TOSCAN ID ${newId} already belongs to another student.`);
  const s = os.data();

  const openItems = await db.collection("payrollItems").where("studentId", "==", oldId).where("status", "==", "Included").get();
  const openNos = [...new Set(openItems.docs.map(d => d.data().payrollNo))];
  if (openNos.length) {
    const pays = await Promise.all(openNos.map(no => db.doc(`payrolls/${no}`).get()));
    const live = pays.filter(p => p.exists && !["Released", "Archived", "Voided"].includes(p.data().status)).map(p => p.id);
    if (live.length) conflict(`Finish or void payroll ${live.join(", ")} first; it still contains this student.`);
  }

  const ops = [];
  // 1. The student record itself.
  ops.push(b => b.set(newRef, { ...s, studentId: newId, previousIds: [...(s.previousIds || []), oldId], idChangedAt: now(), updatedAt: now() }));
  ops.push(b => b.delete(oldRef));
  // 2. Records keyed by a random id: update the studentId field (and the entitlement reference on payroll lines).
  for (const coll of BY_FIELD) {
    const snap = await db.collection(coll).where("studentId", "==", oldId).get();
    for (const d of snap.docs) {
      const patch = { studentId: newId };
      if (coll === "payrollItems" && d.data().entitlementId?.startsWith(`${oldId}_`)) patch.entitlementId = newId + d.data().entitlementId.slice(oldId.length);
      ops.push(b => b.update(d.ref, patch));
    }
  }
  // 3. Records whose document id starts with the student id: copy under the new id, remove the old.
  for (const coll of BY_ID) {
    const snap = await db.collection(coll).where("studentId", "==", oldId).get();
    for (const d of snap.docs) {
      const nid = d.id.startsWith(`${oldId}_`) ? newId + d.id.slice(oldId.length) : d.id;
      ops.push(b => b.set(db.collection(coll).doc(nid), { ...d.data(), studentId: newId }));
      if (nid !== d.id) ops.push(b => b.delete(d.ref));
    }
  }
  // 4. Login account and sign-in token.
  const users = await db.collection("users").where("studentId", "==", oldId).get();
  for (const u of users.docs) ops.push(b => b.update(u.ref, { studentId: newId, claimsUpdatedAt: now() }));
  await chunked(ops);
  for (const u of users.docs) if (u.data().status === "approved" && u.data().role === "student") await auth.setCustomUserClaims(u.id, { role: "student", studentId: newId });

  await audit(a, "student.renameId", { type: "student", id: newId }, { before: { studentId: oldId }, after: { studentId: newId }, reason });
  if (s.uid) await notify(s.uid, { title: "Your TOSCAN ID was updated", body: `Your TOSCAN ID is now ${newId} (previously ${oldId}).`, link: "#/profile", kind: "info" });
  return { ok: true, studentId: newId };
});

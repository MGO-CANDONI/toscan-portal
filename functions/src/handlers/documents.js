// Document submission, review, locking and controlled supersession.
import { onCall } from "firebase-functions/v2/https";
import { db, bucket, now, actor, audit, notify, bad, notFound, conflict, str, getSettings, FieldValue } from "../fb.js";
import {
  DOC_STATUS, TERMS, TERM_NAMES, requirementApplies, submissionWindow, windowState, resolveOpeningDate,
  academicRecordId, extensionId
} from "../core/policy.js";
import { isValidAY } from "../core/dates.js";
import { recomputeForTerm } from "./eligibility.js";

export const MAX_BYTES = 15 * 1024 * 1024;
export const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

/** Everything needed to compute one student-term's submission window. */
export async function windowFor(studentId, academicYear, term, settings) {
  const [rec, ay, ext, stu] = await Promise.all([
    db.doc(`studentAcademicHistory/${academicRecordId(studentId, academicYear, term)}`).get(),
    db.doc(`academicYears/${academicYear}`).get(),
    db.doc(`deadlineExtensions/${extensionId(studentId, academicYear, term)}`).get(),
    db.doc(`students/${studentId}`).get()
  ]);
  const record = rec.exists ? rec.data() : null;
  const schoolId = record?.schoolId || stu.data()?.current?.schoolId;
  const school = schoolId ? (await db.doc(`schools/${schoolId}`).get()).data() : null;
  const openingDate = resolveOpeningDate({ record, school, academicYear: ay.exists ? ay.data() : null, ay: academicYear, term });
  const win = submissionWindow({
    openingDate, months: settings.deadline.months, policy: settings.deadline.policy, cutoff: settings.deadline.cutoff,
    extensionDeadline: ext.exists ? ext.data().deadline : null
  });
  return { win, openingDate, record, school, ayExists: ay.exists, extension: ext.exists ? ext.data() : null };
}

async function submissionsFor(studentId, code, academicYear, term, tx = null) {
  const query = db.collection("submissions")
    .where("studentId", "==", studentId).where("requirementCode", "==", code)
    .where("academicYear", "==", academicYear).where("term", "==", term);
  const q = await (tx ? tx.get(query) : query.get());
  return q.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Registers a file the student has already uploaded to
 * documents/{studentId}/{submissionId}/{fileName}. Storage rules allow that upload
 * only into the student's own folder and never allow overwriting or deleting.
 */
export const submitDocument = onCall(async request => {
  const a = await actor(request, { roles: ["student"] });
  const d = request.data || {};
  const studentId = a.studentId;
  const { submissionId, requirementCode, academicYear, term } = d;
  const fileName = str(d.fileName, 200);
  if (!/^[A-Za-z0-9]{10,40}$/.test(submissionId || "")) bad("Invalid submission id.");
  if (!isValidAY(academicYear) || !TERMS.includes(term)) bad("Choose the academic year and term.");
  const path = `documents/${studentId}/${submissionId}/${fileName}`;
  const file = bucket().file(path);
  const discard = async msg => { await file.delete().catch(() => {}); bad(msg); };

  const [exists] = await file.exists();
  if (!exists) bad("The uploaded file was not found. Please upload again.");
  const [meta] = await file.getMetadata();
  if (Number(meta.size) > MAX_BYTES) await discard("The file is larger than 15 MB.");
  if (!ALLOWED_TYPES.includes(meta.contentType)) await discard("Only PDF, JPG, PNG or WEBP files are accepted.");

  const reqSnap = await db.doc(`documentRequirements/${requirementCode}`).get();
  if (!reqSnap.exists || !requirementApplies(reqSnap.data(), term)) await discard("This document is not required for the selected term.");
  const req = reqSnap.data();

  const settings = await getSettings();
  const { win, ayExists, school } = await windowFor(studentId, academicYear, term, settings);
  if (!ayExists) await discard(`Academic year ${academicYear} is not set up yet.`);
  if (term === "T3" && school && school.termsPerYear !== 3) await discard(`${school.name} has only two semesters.`);
  const state = windowState(win);
  if (state === "closed") await discard(`The submission deadline for ${TERM_NAMES[term]}, AY ${academicYear} has passed. Ask the TOSCAN Office about an extension.`);
  if (state === "not-yet") await discard("Submission for this term is not open yet.");

  const subRef = db.doc(`submissions/${submissionId}`);
  const result = await db.runTransaction(async tx => {
    if ((await tx.get(subRef)).exists) conflict("This submission was already recorded.");
    const others = await submissionsFor(studentId, requirementCode, academicYear, term, tx);
    const live = others.filter(s => s.status !== DOC_STATUS.SUPERSEDED);
    if (live.some(s => [DOC_STATUS.SUBMITTED, DOC_STATUS.REVIEW].includes(s.status))) conflict("A version of this document is already waiting for review.");
    const approved = live.find(s => s.status === DOC_STATUS.APPROVED);
    if (approved && !approved.supersession?.open) conflict("This document is approved and locked. Ask the TOSCAN Office if it needs to be corrected.");
    const latest = live.sort((x, y) => (y.version || 1) - (x.version || 1))[0] || null;
    const record = {
      studentId, uid: a.uid, requirementCode, requirementName: req.name, academicYear, term,
      fileName, storagePath: path, contentType: meta.contentType, size: Number(meta.size),
      status: DOC_STATUS.SUBMITTED, version: (latest?.version || 0) + 1, previousSubmissionId: latest?.id || null,
      replacesApprovedId: approved?.id || null,
      submittedAt: now(), reviewer: null, reviewedAt: null, remarks: "",
      deadline: win.deadlineDate || null, locked: false,
      history: [{ at: new Date().toISOString(), by: a.uid, byName: a.name, action: "submitted" }]
    };
    tx.set(subRef, record);
    audit(a, "document.submit", { type: "submission", id: submissionId }, { after: { requirementCode, academicYear, term, version: record.version, fileName } }, tx);
    return record;
  });
  await recomputeForTerm(studentId, academicYear, term);
  await notify(a.uid, { title: "Document received", body: `${req.name} for ${TERM_NAMES[term]}, AY ${academicYear} was received and is waiting for review.`, link: "#/documents", kind: "info", email: false });
  return { ok: true, version: result.version };
});

/** Staff review: start, approve (locks the record) or return with remarks. */
export const reviewDocument = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"], perm: "reviewDocuments" });
  const { submissionId, action, remarks } = request.data || {};
  if (!["start", "approve", "return"].includes(action)) bad("Unknown review action.");
  if (action === "return" && !str(remarks)) bad("Give the reason for returning this document.");
  const ref = db.doc(`submissions/${submissionId}`);
  const sub = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) notFound("Submission not found.");
    const s = snap.data();
    const allowedFrom = action === "start" ? [DOC_STATUS.SUBMITTED] : [DOC_STATUS.SUBMITTED, DOC_STATUS.REVIEW];
    if (!allowedFrom.includes(s.status)) conflict(`This document is already ${s.status}.`);
    let prevRef = null;
    if (action === "approve" && s.replacesApprovedId) {
      prevRef = db.doc(`submissions/${s.replacesApprovedId}`);
      await tx.get(prevRef);
    }
    const status = action === "start" ? DOC_STATUS.REVIEW : action === "approve" ? DOC_STATUS.APPROVED : DOC_STATUS.RETURNED;
    tx.update(ref, {
      status, remarks: str(remarks, 1000), reviewer: { uid: a.uid, name: a.name }, reviewedAt: now(),
      locked: status === DOC_STATUS.APPROVED,
      history: FieldValue.arrayUnion({ at: new Date().toISOString(), by: a.uid, byName: a.name, action, remarks: str(remarks, 1000) })
    });
    if (prevRef) tx.update(prevRef, {
      status: DOC_STATUS.SUPERSEDED, supersededBy: submissionId, "supersession.open": false, "supersession.closedAt": new Date().toISOString(),
      history: FieldValue.arrayUnion({ at: new Date().toISOString(), by: a.uid, byName: a.name, action: "superseded", remarks: `Replaced by version ${s.version}` })
    });
    audit(a, `document.${action}`, { type: "submission", id: submissionId }, { before: { status: s.status }, after: { status }, reason: str(remarks, 1000) }, tx);
    return s;
  });
  await recomputeForTerm(sub.studentId, sub.academicYear, sub.term);
  if (action !== "start") await notify(sub.uid, {
    title: action === "approve" ? "Document approved" : "Document returned for correction",
    body: `${sub.requirementName} (${TERM_NAMES[sub.term]}, AY ${sub.academicYear}) ${action === "approve" ? "was approved." : `was returned: ${str(remarks, 500).replace(/[.\s]+$/, "")}. Upload a corrected version.`}`,
    link: "#/documents", kind: action === "approve" ? "ok" : "warn"
  });
  return { ok: true };
});

/**
 * Exceptional correction of an approved document. The approved version stays
 * on file and becomes "Superseded" only when the replacement is approved.
 */
export const openSupersession = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const { submissionId, reason } = request.data || {};
  if (!str(reason)) bad("Give the reason for allowing a corrected version.");
  const ref = db.doc(`submissions/${submissionId}`);
  const snap = await ref.get();
  if (!snap.exists) notFound("Submission not found.");
  const s = snap.data();
  if (s.status !== DOC_STATUS.APPROVED) conflict("Only an approved document can be superseded.");
  if (s.supersession?.open) conflict("A correction is already allowed for this document.");
  await ref.update({ supersession: { open: true, reason: str(reason, 500), by: { uid: a.uid, name: a.name }, at: new Date().toISOString() } });
  await audit(a, "document.supersessionOpened", { type: "submission", id: submissionId }, { reason: str(reason, 500) });
  await notify(s.uid, { title: "Corrected document requested", body: `The TOSCAN Office asked for a corrected ${s.requirementName} (${TERM_NAMES[s.term]}, AY ${s.academicYear}): ${str(reason, 300)}`, link: "#/documents", kind: "action" });
  return { ok: true };
});

/** Staff may record that a student cannot submit (kept for the audit trail only). */
export const noteDocument = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"], perm: "reviewDocuments" });
  const { submissionId, note } = request.data || {};
  if (!str(note)) bad("Enter a note.");
  const ref = db.doc(`submissions/${submissionId}`);
  if (!(await ref.get()).exists) notFound("Submission not found.");
  await ref.update({ history: FieldValue.arrayUnion({ at: new Date().toISOString(), by: a.uid, byName: a.name, action: "note", remarks: str(note, 1000) }) });
  return { ok: true };
});


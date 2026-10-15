// TOSCAN search applications: public application form, status check with an
// access code, bidbook upload for Top 20 finalists, and staff review.
import { onCall } from "firebase-functions/v2/https";
import { createHash, randomInt } from "node:crypto";
import { db, now, actor, audit, notify, usersWith, bad, notFound, conflict, fail, str, getSettings, bucket } from "../fb.js";
import {
  APP_STATUS, APP_TRANSITIONS, APP_STATUS_TEXT, BIDBOOK_MAX_MB, mergeApplicationConfig, applicationsOpen, bidbookOpen,
  validateApplication, applicantKey, applicantKeys
} from "../core/applications.js";
import { manilaToday } from "../core/dates.js";

const CONFIG_PATH = "publicConfig/application";
const REF_RE = /^TS\d{4}-\d{4,6}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_FAILS = 8, LOCK_MINUTES = 15;
const APPLICANT = { uid: "public", name: "Applicant (public form)", role: "public" };

export async function getApplicationConfig() {
  const s = await db.doc(CONFIG_PATH).get();
  return mergeApplicationConfig(s.exists ? s.data() : null);
}

const newCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
const hashCode = (ref, code) => createHash("sha256").update(`${ref}:${String(code || "").trim().toUpperCase().replace(/[\s-]/g, "")}`).digest("hex");
const fmtCode = c => `${c.slice(0, 5)}-${c.slice(5)}`;
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Applicants are always emailed (they have no portal account). Delivery needs the "Trigger Email from Firestore" extension on the `mail` collection. */
async function mailApplicant(to, subject, html) {
  if (!to) return;
  await db.collection("mail").doc().set({ to, createdAt: now(), message: { subject: `TOSCAN — ${subject}`, html: `${html}<p>— TOSCAN Office, Municipal Government of Candoni</p>` } });
}

/** Public: submit an application. No sign-in needed. Returns the reference number and access code (shown once). */
export const submitApplication = onCall(async request => {
  const config = await getApplicationConfig();
  const today = manilaToday();
  if (!applicationsOpen(config, today)) conflict("Applications are not being accepted right now.");
  const d = request.data || {};
  if (d.website) bad("Invalid submission."); // honeypot field, hidden from people
  const { errors, value } = validateApplication(config, d);
  if (errors.length) bad(errors.join(" "));
  const year = (String(config.title).match(/\b(20\d{2})\b/) || [])[1] || (config.closesOn || today).slice(0, 4);
  const key = applicantKey(value), keys = applicantKeys(value);
  const taken = async (field, v) => !(await db.collection("searchApplications").where("searchTitle", "==", config.title).where(field, "==", v).limit(1).get()).empty;
  const what = (await taken("emailKey", keys.emailKey)) ? "e-mail address" : (await taken("contactKey", keys.contactKey)) ? "contact number" : (await taken("nameKey", keys.nameKey)) ? "name" : null;
  if (what) conflict(`An application with this ${what} was already received for this search. Only one application per student is allowed. Use your reference number and access code to check its status, or contact the TOSCAN Office.`);

  const code = newCode();
  const ref = await db.runTransaction(async tx => {
    const cref = db.doc(`counters/applications_${year}`);
    const c = await tx.get(cref);
    const n = (c.exists ? c.data().n : 0) + 1;
    const appRef = `TS${year}-${String(n).padStart(4, "0")}`;
    tx.set(cref, { n });
    tx.set(db.doc(`searchApplications/${appRef}`), {
      ref: appRef, searchTitle: config.title, searchYear: year, ...value,
      emailLower: value.email.toLowerCase(), applicantKey: key, ...keys,
      questions: (config.questions || []).map(q => ({ id: q.id, label: q.label })),
      status: APP_STATUS.SUBMITTED, statusHistory: [{ status: APP_STATUS.SUBMITTED, at: new Date().toISOString(), by: "Applicant" }],
      publicMessage: "", codeHash: hashCode(appRef, code), failedLookups: 0, lockedUntil: null,
      bidbook: null, bidbookHistory: [], submittedBy: request.auth?.uid || null,
      createdAt: now(), updatedAt: now()
    });
    return appRef;
  });
  await audit(APPLICANT, "application.submit", { type: "searchApplication", id: ref }, { after: { name: `${value.lastName}, ${value.firstName}`, school: value.school } });
  await notify(await usersWith("reviewApplications"), { title: "New TOSCAN application", body: `${value.lastName}, ${value.firstName} (${value.school}) applied — ${ref}.`, link: "#/applications", kind: "info", email: false });
  await mailApplicant(value.email, `Application received (${ref})`,
    `<p>Dear ${esc(value.firstName)},</p><p>We received your application to the ${esc(config.title)}.</p><p><b>Reference number:</b> ${ref}<br><b>Access code:</b> ${fmtCode(code)}</p><p>Keep these. You need them to check your status and, if you are selected as a Top 20 finalist, to upload your bidbook.</p>`);
  return { ref, code: fmtCode(code), title: config.title };
});

/** Loads an application by reference and access code, with lock-out after repeated wrong codes. */
async function openWithCode(refNo, code) {
  const ref = String(refNo || "").trim().toUpperCase();
  if (!REF_RE.test(ref) || !code) bad("Enter your reference number and access code.");
  const docRef = db.doc(`searchApplications/${ref}`);
  const snap = await docRef.get();
  const wrong = "The reference number or access code is not correct.";
  if (!snap.exists) bad(wrong);
  const a = snap.data();
  if (a.lockedUntil && Date.parse(a.lockedUntil) > Date.now()) fail("resource-exhausted", "Too many wrong attempts. Try again in 15 minutes.");
  if (a.codeHash !== hashCode(ref, code)) {
    const fails = (a.failedLookups || 0) + 1;
    await docRef.update({ failedLookups: fails >= MAX_FAILS ? 0 : fails, lockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60e3).toISOString() : null });
    bad(wrong);
  }
  if (a.failedLookups) await docRef.update({ failedLookups: 0, lockedUntil: null });
  return { ref, docRef, a };
}

function publicView(ref, a, config) {
  const today = manilaToday();
  return {
    ref, title: a.searchTitle, name: [a.firstName, a.middleName && a.middleName.toUpperCase() !== "N/A" ? a.middleName : "", a.lastName].filter(Boolean).join(" "),
    school: a.school, status: a.status, statusText: APP_STATUS_TEXT[a.status] || "", message: a.publicMessage || "",
    bidbookOpen: bidbookOpen(a.status, config, today), bidbookDeadline: config.bidbookDeadline || "",
    bidbookTemplateUrl: config.bidbookTemplateUrl || "", maxMB: BIDBOOK_MAX_MB,
    bidbook: a.bidbook ? { fileName: a.bidbook.fileName, at: a.bidbook.at, size: a.bidbook.size } : null
  };
}

/** Public: application status by reference number and access code. */
export const applicationStatus = onCall(async request => {
  const { ref, a } = await openWithCode(request.data?.ref, request.data?.code);
  return publicView(ref, a, await getApplicationConfig());
});

/**
 * Finalists only: records an uploaded bidbook. The browser uploads first (anonymous
 * sign-in, path searchApplications/{ref}/{uid}/...), then calls this with the path.
 */
export const submitBidbook = onCall(async request => {
  if (!request.auth) bad("The upload session expired. Please try again.");
  const { ref, docRef, a } = await openWithCode(request.data?.ref, request.data?.code);
  const config = await getApplicationConfig();
  if (!bidbookOpen(a.status, config, manilaToday())) conflict(a.status === APP_STATUS.FINALIST || a.status === APP_STATUS.BIDBOOK ? "The bidbook deadline has passed." : "Bidbooks are accepted only from Top 20 finalists.");
  const path = String(request.data?.path || "");
  const prefix = `searchApplications/${ref}/${request.auth.uid}/`;
  if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) bad("Invalid file.");
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) bad("The uploaded file was not found. Please upload again.");
  const [meta] = await file.getMetadata();
  if (meta.contentType !== "application/pdf") bad("The bidbook must be a PDF file.");
  if (Number(meta.size) > BIDBOOK_MAX_MB * 1024 * 1024) bad(`The bidbook is larger than ${BIDBOOK_MAX_MB} MB.`);
  const entry = { path, fileName: str(request.data?.fileName || path.split("/").pop(), 150), size: Number(meta.size), at: new Date().toISOString() };
  const history = [...(a.bidbookHistory || []), entry];
  await docRef.update({
    bidbook: entry, bidbookHistory: history, status: APP_STATUS.BIDBOOK,
    statusHistory: a.status === APP_STATUS.BIDBOOK ? a.statusHistory : [...(a.statusHistory || []), { status: APP_STATUS.BIDBOOK, at: entry.at, by: "Applicant" }],
    updatedAt: now()
  });
  await audit(APPLICANT, "application.bidbook", { type: "searchApplication", id: ref }, { after: { fileName: entry.fileName, size: entry.size, version: history.length } });
  await notify(await usersWith("reviewApplications"), { title: "Bidbook received", body: `${a.lastName}, ${a.firstName} (${ref}) uploaded a bidbook${history.length > 1 ? ` (copy ${history.length})` : ""}.`, link: "#/applications", kind: "info", email: false });
  return publicView(ref, { ...a, bidbook: entry, status: APP_STATUS.BIDBOOK }, config);
});

/** Staff: change status, set the message shown to the applicant, or issue a new access code. */
export const reviewApplication = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"], perm: "reviewApplications" });
  const { ref, action, status, message, remarks } = request.data || {};
  const docRef = db.doc(`searchApplications/${str(ref, 20)}`);
  const snap = await docRef.get();
  if (!snap.exists) notFound("Application not found.");
  const app = snap.data();
  const by = { uid: a.uid, name: a.name };
  if (action === "resetCode") {
    const code = newCode();
    await docRef.update({ codeHash: hashCode(app.ref, code), failedLookups: 0, lockedUntil: null, updatedAt: now() });
    await audit(a, "application.resetCode", { type: "searchApplication", id: app.ref }, { reason: str(remarks, 300) });
    await mailApplicant(app.email, `New access code (${app.ref})`, `<p>Dear ${esc(app.firstName)},</p><p>Your new access code for application ${app.ref} is <b>${fmtCode(code)}</b>.</p>`);
    return { code: fmtCode(code) };
  }
  if (action !== "status") bad("Unknown action.");
  const next = String(status || "");
  const allowed = APP_TRANSITIONS[app.status] || [];
  if (next !== app.status && !allowed.includes(next)) conflict(`An application that is “${app.status}” can't be changed to “${next}”.`);
  if ([APP_STATUS.NOT_SELECTED, APP_STATUS.WITHDRAWN].includes(next) && !str(remarks)) bad("Enter remarks for this decision.");
  const msg = str(message, 1000);
  const update = { status: next, publicMessage: msg, updatedAt: now() };
  if (next !== app.status) update.statusHistory = [...(app.statusHistory || []), { status: next, at: new Date().toISOString(), by: a.name, remarks: str(remarks, 500) }];
  await docRef.update(update);
  await audit(a, "application.status", { type: "searchApplication", id: app.ref }, { before: { status: app.status, message: app.publicMessage || "" }, after: { status: next, message: msg }, reason: str(remarks, 500) });
  if (next !== app.status && next !== APP_STATUS.SCREENING) {
    const config = await getApplicationConfig();
    const extra = next === APP_STATUS.FINALIST
      ? `<p>Download the bidbook form${config.bidbookTemplateUrl ? ` (<a href="${esc(config.bidbookTemplateUrl)}">link</a>)` : ""}, fill it in and sign it, then upload it as one PDF on the TOSCAN Portal sign-in page under “Check application status” using your reference number and access code${config.bidbookDeadline ? `, on or before ${esc(config.bidbookDeadline)}` : ""}.</p>`
      : "";
    await mailApplicant(app.email, `Application update (${app.ref})`, `<p>Dear ${esc(app.firstName)},</p><p>${esc(APP_STATUS_TEXT[next] || next)}</p>${msg ? `<p>${esc(msg)}</p>` : ""}${extra}`);
  }
  return { ok: true };
});


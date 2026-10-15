// Accounts: first-admin bootstrap, registration, approval, roles, profile updates.
import { onCall } from "firebase-functions/v2/https";
import { db, auth, now, actor, audit, notify, admins, bad, denied, notFound, conflict, str, FieldValue } from "../fb.js";
import { ROLES, PERMISSIONS, DEFAULT_STAFF_PERMISSIONS } from "../core/policy.js";
import { validateRegistration, fullName, CLASSIFICATIONS } from "../core/records.js";
import { manilaToday, isValidYMD } from "../core/dates.js";
import { seedDefaults } from "./masterdata.js";

const bootstrapEmails = () => (process.env.BOOTSTRAP_ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

async function setClaims(uid, claims) {
  await auth.setCustomUserClaims(uid, claims);
  // The page listens to this field and refreshes its ID token when it changes.
  await db.doc(`users/${uid}`).set({ claimsUpdatedAt: now() }, { merge: true });
}

/**
 * The first administrator. Works only for a verified email listed in the
 * BOOTSTRAP_ADMIN_EMAILS function setting (functions/.env), never from client code.
 */
export const bootstrapAdmin = onCall(async request => {
  if (!request.auth) bad("Please sign in first.");
  const email = (request.auth.token.email || "").toLowerCase();
  if (!request.auth.token.email_verified || !bootstrapEmails().includes(email)) denied("This account is not set up as a bootstrap administrator.");
  const uid = request.auth.uid;
  const ref = db.doc(`users/${uid}`);
  const before = (await ref.get()).data() || null;
  await ref.set({
    uid, email: request.auth.token.email, emailLower: email, displayName: request.auth.token.name || "TOSCAN Office",
    status: "approved", role: "admin", permissions: PERMISSIONS, studentId: null,
    decidedAt: now(), decidedBy: { uid: "bootstrap", name: "Bootstrap" }, createdAt: before?.createdAt || now()
  }, { merge: true });
  await setClaims(uid, { role: "admin" });
  await seedDefaults();
  await audit({ uid, name: email, role: "admin" }, "admin.bootstrap", { type: "user", id: uid }, { before });
  return { ok: true };
});

/** Self-registration. Creates a pending account; never grants access by itself. */
export const register = onCall(async request => {
  if (!request.auth) bad("Please sign in first.");
  const uid = request.auth.uid, email = request.auth.token.email || "";
  if (!email) bad("Your sign-in has no email address.");
  const ref = db.doc(`users/${uid}`);
  const existing = await ref.get();
  if (existing.exists && ["approved", "disabled"].includes(existing.data().status)) conflict("This account is already registered.");
  const { errors, value } = validateRegistration(request.data || {});
  if (errors.length) bad(errors.join(" "));

  // Suggest the matching old-portal record so the admin can link it.
  let suggested = null;
  const byEmail = await db.collection("students").where("emailLower", "==", email.toLowerCase()).limit(2).get();
  if (byEmail.size === 1) suggested = byEmail.docs[0].id;
  if (!suggested && value.toscanId) {
    const s = await db.doc(`students/${value.toscanId}`).get();
    if (s.exists) suggested = s.id;
  }

  await ref.set({
    uid, email, emailLower: email.toLowerCase(), displayName: fullName(value),
    provider: request.auth.token.firebase?.sign_in_provider || "",
    status: "pending", role: "student", permissions: [], studentId: null,
    registration: value, suggestedStudentId: suggested,
    createdAt: existing.exists ? existing.data().createdAt : now(), updatedAt: now()
  }, { merge: true });
  await notify(await admins(), {
    title: "Registration waiting for approval",
    body: `${fullName(value)} (${email}) registered as ${value.accountType}.`, link: "#/approvals", kind: "action"
  });
  return { ok: true, suggestedStudentId: suggested };
});

async function nextStudentId(tx) {
  const year = manilaToday().slice(0, 4);
  const ref = db.doc(`counters/students_${year}`);
  const snap = await tx.get(ref);
  const n = (snap.exists ? snap.data().n : 0) + 1;
  tx.set(ref, { n });
  return `TSC-${year}-${String(n).padStart(4, "0")}`;
}

function newStudentFromRegistration(id, uid, email, r) {
  return {
    studentId: id, profileVersion: 2, uid, email, emailLower: email.toLowerCase(),
    surname: r.surname, firstName: r.firstName, middleName: r.middleName, extName: r.extName,
    dateOfBirth: r.dateOfBirth, contact: r.contact, address: r.address, atmNumber: "",
    classification: "", latinHonor: "",
    qualification: { batch: r.batch, yearQualified: "", schoolAtQualification: "", awardType: "", admissionDate: "" },
    current: { school: r.school, schoolAddress: "", level: "", program: r.program, yearLevel: r.yearLevel, academicYear: "", term: "", enrollmentStatus: "", expectedGraduation: "" },
    programStatus: "Active", source: "registration", createdAt: now(), updatedAt: now()
  };
}

/**
 * Approve or decline a registration.
 * data: { uid, decision: "approve"|"decline", role, permissions?, classification?, studentLink?: {mode:"existing", studentId}|{mode:"new"}, note? }
 */
export const decideUser = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const d = request.data || {};
  const ref = db.doc(`users/${d.uid}`);
  const snap = await ref.get();
  if (!snap.exists) notFound("Account not found.");
  const u = snap.data();
  if (d.uid === a.uid) denied("You can't approve your own account.");

  if (d.decision === "decline") {
    await ref.update({ status: "declined", note: str(d.note, 500), decidedAt: now(), decidedBy: { uid: a.uid, name: a.name } });
    await auth.setCustomUserClaims(d.uid, {});
    await audit(a, "user.decline", { type: "user", id: d.uid }, { reason: str(d.note, 500) });
    await notify(d.uid, { title: "Registration not approved", body: d.note ? `Reason: ${str(d.note, 500)}` : "Contact the TOSCAN Office for details.", kind: "warn" });
    return { ok: true };
  }
  if (d.decision !== "approve") bad("Unknown decision.");
  if (!ROLES.includes(d.role)) bad("Choose an access level.");

  let studentId = null;
  if (d.role === "student") {
    if (d.classification && !CLASSIFICATIONS[d.classification]) bad("Classification must be Top 10 or Top 20.");
    studentId = await db.runTransaction(async tx => {
      let sid, sref, sdata;
      if (d.studentLink?.mode === "existing") {
        sid = str(d.studentLink.studentId, 60);
        sref = db.doc(`students/${sid}`);
        const s = await tx.get(sref);
        if (!s.exists) notFound(`Student record ${sid} not found.`);
        sdata = s.data();
        if (sdata.uid && sdata.uid !== d.uid) conflict(`Student record ${sid} is already linked to another account.`);
      } else {
        const r = u.registration || {};
        const wanted = r.toscanId && /^[A-Z0-9-]{3,40}$/.test(r.toscanId) ? r.toscanId : null;
        if (wanted) {
          const s = await tx.get(db.doc(`students/${wanted}`));
          if (s.exists) conflict(`TOSCAN ID ${wanted} already has a record. Link to it instead of creating a new one.`);
        }
        sid = wanted || await nextStudentId(tx);
        sref = db.doc(`students/${sid}`);
        const rec = newStudentFromRegistration(sid, d.uid, u.email, r);
        if (d.classification) rec.classification = d.classification;
        tx.set(sref, rec);
      }
      if (d.studentLink?.mode === "existing") {
        const patch = { uid: d.uid, email: u.email, emailLower: (u.email || "").toLowerCase(), updatedAt: now() };
        if (d.classification) patch.classification = d.classification;
        // Fill gaps in an old record from the registration; existing values are never replaced.
        const r = u.registration || {};
        for (const k of ["dateOfBirth", "contact", "address", "middleName", "extName"]) if (!sdata[k] && r[k]) patch[k] = r[k];
        tx.set(sref, patch, { merge: true });
      }
      tx.update(ref, {
        status: "approved", role: "student", permissions: [], studentId: sid,
        decidedAt: now(), decidedBy: { uid: a.uid, name: a.name }, note: str(d.note, 500)
      });
      audit(a, "user.approve", { type: "user", id: d.uid }, { after: { role: "student", studentId: sid, classification: d.classification || sdata?.classification || "" } }, tx);
      return sid;
    });
    await auth.setCustomUserClaims(d.uid, { role: "student", studentId });
  } else {
    const perms = PERMISSIONS; // staff and administrators hold every permission; Administration pages are admin-only
    await ref.update({ status: "approved", role: d.role, permissions: perms, studentId: null, decidedAt: now(), decidedBy: { uid: a.uid, name: a.name }, note: str(d.note, 500) });
    await auth.setCustomUserClaims(d.uid, { role: d.role });
    await audit(a, "user.approve", { type: "user", id: d.uid }, { after: { role: d.role, permissions: perms } });
  }
  await ref.update({ claimsUpdatedAt: now() });
  await notify(d.uid, { title: "Your account is approved", body: `You now have ${d.role} access to the TOSCAN Portal.`, kind: "ok" });
  return { ok: true, studentId };
});

/** Change an approved account's role, permissions or status (approved / disabled). */
export const updateAccess = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const d = request.data || {};
  if (d.uid === a.uid) denied("You can't change your own access. Ask another administrator.");
  const ref = db.doc(`users/${d.uid}`);
  const snap = await ref.get();
  if (!snap.exists) notFound("Account not found.");
  const before = snap.data();
  const patch = {};
  if (d.role) {
    if (!ROLES.includes(d.role)) bad("Invalid role.");
    if (d.role === "student" && !before.studentId) bad("Link a student record first: approve the account as a student.");
    patch.role = d.role;
  }
  if (["staff", "admin"].includes(patch.role || before.role)) patch.permissions = PERMISSIONS;
  if (d.status) {
    if (!["approved", "disabled"].includes(d.status)) bad("Invalid status.");
    patch.status = d.status;
  }
  if ((before.role === "admin" && patch.role && patch.role !== "admin") || (before.role === "admin" && patch.status === "disabled")) {
    const others = (await admins()).filter(x => x !== d.uid);
    if (!others.length) conflict("At least one administrator must remain.");
  }
  await ref.update({ ...patch, updatedAt: now() });
  const role = patch.role || before.role, status = patch.status || before.status;
  await auth.setCustomUserClaims(d.uid, status === "approved" ? { role, ...(role === "student" ? { studentId: before.studentId } : {}) } : {});
  if (status === "disabled") await auth.revokeRefreshTokens(d.uid);
  await ref.update({ claimsUpdatedAt: now() });
  await audit(a, "user.access", { type: "user", id: d.uid }, { before: { role: before.role, status: before.status, permissions: before.permissions || [] }, after: patch, reason: str(d.reason, 300) });
  return { ok: true };
});

/**
 * Student self-service. Contact details and photo apply at once; identity and
 * payment details become pending changes that staff must verify.
 */
export const updateMyProfile = onCall(async request => {
  const a = await actor(request);
  const d = request.data || {};
  if (a.role !== "student") {
    const patch = {};
    if (d.photoPath !== undefined) {
      if (d.photoPath && !d.photoPath.startsWith(`photos/${a.uid}/`)) bad("Invalid photo location.");
      patch.photoPath = d.photoPath;
    }
    if (d.displayName) patch.displayName = str(d.displayName, 120);
    await db.doc(`users/${a.uid}`).update({ ...patch, updatedAt: now() });
    return { ok: true };
  }
  const sref = db.doc(`students/${a.studentId}`);
  const snap = await sref.get();
  if (!snap.exists) notFound("Student record not found.");
  const s = snap.data();
  const direct = {}, pending = {};
  if (d.contact !== undefined) {
    if (!/^[\d+()\-\s]{7,20}$/.test(str(d.contact))) bad("Enter a valid contact number.");
    direct.contact = str(d.contact, 30);
  }
  if (d.address !== undefined) { if (!str(d.address)) bad("Address can't be empty."); direct.address = str(d.address, 300).toUpperCase(); }
  if (d.photoPath !== undefined) {
    if (d.photoPath && !d.photoPath.startsWith(`photos/${a.uid}/`)) bad("Invalid photo location.");
    direct.photoPath = d.photoPath;
  }
  if (d.dateOfBirth && d.dateOfBirth !== s.dateOfBirth) {
    if (!isValidYMD(d.dateOfBirth)) bad("Invalid date of birth.");
    pending.dateOfBirth = { value: d.dateOfBirth, requestedAt: new Date().toISOString() };
  }
  if (d.atmNumber !== undefined && str(d.atmNumber, 40) !== (s.atmNumber || "")) {
    if (!/^[\d -]{6,40}$/.test(str(d.atmNumber, 40))) bad("ATM number can contain digits, spaces and dashes only.");
    pending.atmNumber = { value: str(d.atmNumber, 40), requestedAt: new Date().toISOString() };
  }
  const update = { ...direct, updatedAt: now() };
  for (const [k, v] of Object.entries(pending)) update[`pendingChanges.${k}`] = v;
  await sref.update(update);
  if (Object.keys(direct).length) await audit(a, "profile.update", { type: "student", id: a.studentId }, { before: Object.fromEntries(Object.keys(direct).map(k => [k, s[k] ?? ""])), after: direct });
  if (Object.keys(pending).length) await audit(a, "profile.changeRequested", { type: "student", id: a.studentId }, { after: pending });
  return { ok: true, pending: Object.keys(pending) };
});

/** Staff verify or reject a pending identity/payment change. */
export const verifyProfileChange = onCall(async request => {
  const a = await actor(request, { roles: ["staff", "admin"], perm: "verifyRecords" });
  const { studentId, field, decision, remarks } = request.data || {};
  if (!["dateOfBirth", "atmNumber"].includes(field)) bad("Unknown field.");
  const sref = db.doc(`students/${studentId}`);
  const snap = await sref.get();
  if (!snap.exists) notFound("Student not found.");
  const s = snap.data();
  const p = s.pendingChanges?.[field];
  if (!p) conflict("There is no pending change for this field.");
  const update = { [`pendingChanges.${field}`]: FieldValue.delete(), updatedAt: now() };
  if (decision === "approve") update[field] = p.value;
  await sref.update(update);
  await audit(a, `profile.change.${decision === "approve" ? "approved" : "rejected"}`, { type: "student", id: studentId }, { before: { [field]: s[field] ?? "" }, after: { [field]: p.value }, reason: str(remarks, 300) });
  if (s.uid) await notify(s.uid, {
    title: decision === "approve" ? "Profile change approved" : "Profile change not approved",
    body: `Your requested ${field === "atmNumber" ? "ATM number" : "date of birth"} change was ${decision === "approve" ? "approved" : "not approved"}.${remarks ? " " + str(remarks, 300) : ""}`,
    kind: decision === "approve" ? "ok" : "warn"
  });
  return { ok: true };
});

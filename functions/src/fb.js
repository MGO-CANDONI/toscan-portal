// Shared server helpers: Admin SDK, actor checks, audit trail, notifications.
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { HttpsError } from "firebase-functions/v2/https";
import { mergeSettings, hasPermission, DEFAULT_STAFF_PERMISSIONS, PERMISSIONS } from "./core/policy.js";
import { fullName } from "./core/records.js";

if (!getApps().length) initializeApp();
export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
export const auth = getAuth();
export const bucket = () => getStorage().bucket();
export { FieldValue, Timestamp, HttpsError };
export const now = () => FieldValue.serverTimestamp();

export function fail(code, message) { throw new HttpsError(code, message); }
export const bad = msg => fail("invalid-argument", msg);
export const denied = msg => fail("permission-denied", msg || "You are not allowed to do this.");
export const notFound = msg => fail("not-found", msg);
export const conflict = msg => fail("failed-precondition", msg);

/**
 * Loads the caller's account and checks role and permission.
 * The users document is the source of truth (claims only speed up security rules),
 * so a disabled account is refused immediately.
 */
export async function actor(request, { roles = ["student", "staff", "admin"], perm = null, allowPending = false } = {}) {
  if (!request.auth) fail("unauthenticated", "Please sign in.");
  const uid = request.auth.uid;
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) denied("Your account is not registered yet.");
  const u = snap.data();
  if (!allowPending && u.status !== "approved") denied("Your account is not approved.");
  if (!roles.includes(u.role)) denied();
  const a = {
    uid, email: u.email || request.auth.token.email || "", role: u.role, studentId: u.studentId || null,
    permissions: u.role === "admin" ? PERMISSIONS : (u.permissions || (u.role === "staff" ? DEFAULT_STAFF_PERMISSIONS : [])),
    name: u.displayName || fullName(u.registration) || u.email || uid
  };
  if (perm && !hasPermission(a, perm)) denied("Your account is not authorized for this action.");
  return a;
}

export function actorRef(a) {
  return a ? { uid: a.uid, name: a.name, role: a.role } : { uid: "system", name: "System", role: "system" };
}

/** Write an audit entry. Pass `tx` to make it part of a transaction or batch. */
export function audit(a, action, target, details = {}, tx = null) {
  const ref = db.collection("auditLogs").doc();
  const entry = {
    at: now(), actor: actorRef(a), action,
    targetType: target?.type || "", targetId: target?.id || "",
    before: details.before ?? null, after: details.after ?? null,
    reason: details.reason || "", details: details.details || null
  };
  if (tx) tx.set(ref, entry); else return ref.set(entry);
}

let settingsCache = null, settingsAt = 0;
export async function getSettings(fresh = false) {
  if (!fresh && settingsCache && Date.now() - settingsAt < 30000) return settingsCache;
  const s = await db.doc("settings/app").get();
  settingsCache = mergeSettings(s.exists ? s.data() : {});
  settingsAt = Date.now();
  return settingsCache;
}

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * In-app notification, plus an email when enabled in Settings. Emails use a fixed
 * template and are only ever queued by the server.
 * `id` makes a notification idempotent (scheduled reminders use it).
 */
export async function notify(uids, { title, body, link = "", kind = "info", id = null, email = true }) {
  const list = [...new Set((Array.isArray(uids) ? uids : [uids]).filter(Boolean))];
  if (!list.length) return;
  const settings = await getSettings();
  const batch = db.batch();
  for (const uid of list) {
    const ref = id ? db.doc(`notifications/${id}_${uid}`) : db.collection("notifications").doc();
    batch.set(ref, { uid, title, body, link, kind, read: false, createdAt: now() });
  }
  await batch.commit();
  if (!email || !settings.notifications.emailEnabled) return;
  const users = await Promise.all(list.map(uid => db.doc(`users/${uid}`).get()));
  const mail = db.batch();
  for (const u of users) {
    const to = u.exists && u.data().email;
    if (!to) continue;
    mail.set(db.collection("mail").doc(), {
      to, createdAt: now(),
      message: {
        subject: `TOSCAN Portal — ${title}`,
        html: `<p>${esc(body)}</p><p>Sign in to the TOSCAN Portal for details.</p><p>— TOSCAN Office, Municipal Government of Candoni</p>`
      }
    });
  }
  await mail.commit();
}

/** uids of approved staff/admins holding a permission. */
export async function usersWith(perm) {
  const snap = await db.collection("users").where("status", "==", "approved").where("role", "in", ["staff", "admin"]).get();
  return snap.docs.filter(d => hasPermission({ role: d.data().role, permissions: d.data().permissions || DEFAULT_STAFF_PERMISSIONS }, perm)).map(d => d.id);
}

export async function admins() {
  const snap = await db.collection("users").where("status", "==", "approved").where("role", "==", "admin").get();
  return snap.docs.map(d => d.id);
}

/** uid of the account linked to a student record, if any. */
export async function uidOfStudent(studentId) {
  const s = await db.doc(`students/${studentId}`).get();
  return s.exists ? s.data().uid || null : null;
}

export function str(v, max = 300) {
  return v == null ? "" : String(v).trim().slice(0, max);
}

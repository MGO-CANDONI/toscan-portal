// Live application state: Firestore listeners chosen by role.
import { db, doc, collection, query, where, orderBy, limit, onSnapshot } from "./fb.js";

export const S = {
  user: null, claims: {}, account: undefined, student: null,
  settings: null, master: { requirements: [], allowanceTypes: [], schools: [], academicYears: [] },
  d: {}, notifications: [], ready: new Set()
};

const subs = new Map();      // key -> unsubscribe
const watchers = new Set();  // (key) => void

export function onChange(fn) { watchers.add(fn); return () => watchers.delete(fn); }
function emit(key) { S.ready.add(key); watchers.forEach(fn => { try { fn(key); } catch (e) { console.error(e); } }); }

const rows = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

export function live(key, target, map = null) {
  if (subs.has(key)) return;
  const isDoc = target.type === "document";
  subs.set(key, onSnapshot(target, snap => {
    const v = isDoc ? (snap.exists() ? { id: snap.id, ...snap.data() } : null) : rows(snap);
    if (map) map(v); else S.d[key] = v;
    emit(key);
  }, err => { console.warn(`listener ${key}:`, err.code || err.message); S.d[key] = isDoc ? null : []; emit(key); }));
}
export function stop(prefix = "") {
  for (const [k, u] of subs) if (!prefix || k.startsWith(prefix)) { u(); subs.delete(k); S.ready.delete(k); }
}

/** Listeners every signed-in user needs. */
export function startCommon(uid) {
  live("account", doc(db, "users", uid), v => { S.account = v; });
  live("settings", doc(db, "settings", "app"), v => { S.settings = v || {}; });
  live("requirements", collection(db, "documentRequirements"), v => { S.master.requirements = v.sort((a, b) => (a.order || 99) - (b.order || 99)); });
  live("allowanceTypes", collection(db, "allowanceTypes"), v => { S.master.allowanceTypes = v; });
  live("schools", collection(db, "schools"), v => { S.master.schools = v.sort((a, b) => a.name.localeCompare(b.name)); });
  live("academicYears", collection(db, "academicYears"), v => { S.master.academicYears = v.sort((a, b) => b.id.localeCompare(a.id)); });
  live("notifications", query(collection(db, "notifications"), where("uid", "==", uid), orderBy("createdAt", "desc"), limit(60)), v => { S.notifications = v; });
}

/** Listeners that depend on the role in the ID token. */
export function startRole(claims) {
  stop("r:");
  const sid = claims.studentId;
  if (claims.role === "student" && sid) {
    live("r:student", doc(db, "students", sid), v => { S.student = v; });
    for (const c of ["submissions", "eligibility", "allowances", "studentAcademicHistory", "historicalPayments", "deadlineExtensions", "programStatusHistory"]) {
      live(`r:${c}`, query(collection(db, c), where("studentId", "==", sid)), v => { S.d[c] = v; });
    }
  } else if (claims.role === "staff" || claims.role === "admin") {
    live("r:users", collection(db, "users"), v => { S.d.users = v; });
    live("r:students", collection(db, "students"), v => { S.d.students = v; });
    live("r:queue", query(collection(db, "submissions"), where("status", "in", ["Submitted", "Under Review"])), v => { S.d.queue = v; });
    live("r:eligibility", collection(db, "eligibility"), v => { S.d.eligibility = v; });
    live("r:allowances", collection(db, "allowances"), v => { S.d.allowances = v; });
    live("r:payrolls", collection(db, "payrolls"), v => { S.d.payrolls = v; });
    live("r:applications", collection(db, "searchApplications"), v => { S.d.applications = v; });
    live("r:verify", query(collection(db, "studentAcademicHistory"), where("status", "==", "For Verification")), v => { S.d.verify = v; });
  }
}

export const studentById = id => (S.d.students || []).find(s => s.id === id) || null;
export const isAdmin = () => S.claims.role === "admin";
export const isStaff = () => ["staff", "admin"].includes(S.claims.role);
export function can(perm) {
  if (isAdmin()) return true;
  if (S.claims.role !== "staff") return false;
  const p = S.account?.permissions || ["reviewDocuments", "verifyRecords", "decideEligibility", "preparePayroll", "viewReports"];
  return p.includes(perm);
}
export function settings() {
  const s = S.settings || {};
  return {
    currentAcademicYear: s.currentAcademicYear || "",
    deadline: { months: 5, policy: "within", cutoff: "end-of-day", reminderDays: 14, ...(s.deadline || {}) },
    termPeriodMap: { T1: "P1", T2: "P2", T3: "P2", ...(s.termPeriodMap || {}) },
    payroll: { autoGenerate: true, dayOfMonth: 5, ...(s.payroll || {}), signatories: { a: "", b: "", c: "", d: "", ...((s.payroll || {}).signatories || {}) }, signatoryTitles: { ...((s.payroll || {}).signatoryTitles || {}) } },
    notifications: { emailEnabled: false, officeEmails: [], ...(s.notifications || {}) },
    lists: { batches: [], levels: [], yearLevels: [], programs: [], ...(s.lists || {}) },
    branding: { loginImagePath: "", ...(s.branding || {}) }
  };
}

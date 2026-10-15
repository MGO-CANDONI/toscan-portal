// Program policy: pure functions with no Firebase dependency, so they can be
// unit-tested and reused by every handler.
import { addMonthsYMD, manilaStart, manilaEnd, isValidYMD, compareYMD } from "./dates.js";

export const TERMS = ["T1", "T2", "T3"];
export const TERM_NAMES = { T1: "First Semester", T2: "Second Semester", T3: "Third Semester" };
export const PERIODS = ["P1", "P2"];
export const PERIOD_NAMES = { P1: "First Allowance", P2: "Second Allowance" };

export const ROLES = ["student", "staff", "admin"];
export const PERMISSIONS = [
  "reviewDocuments", "verifyRecords", "decideEligibility", "preparePayroll",
  "approvePayroll", "releasePayroll", "encodeHistory", "viewReports", "reviewApplications"
];
/** Staff hold every permission; only the Administration pages are limited to administrators. */
export const DEFAULT_STAFF_PERMISSIONS = [...PERMISSIONS];

export const DOC_STATUS = { SUBMITTED: "Submitted", REVIEW: "Under Review", RETURNED: "Returned", APPROVED: "Approved", SUPERSEDED: "Superseded" };

export const ELIG = {
  PENDING: "Pending Documents", REVIEW: "For Review", RETURNED: "Returned for Correction",
  QUALIFIED: "Qualified", NOT_QUALIFIED: "Not Qualified", INCLUDED: "Included in Payroll", RELEASED: "Released"
};
export const ELIG_DECIDED = [ELIG.QUALIFIED, ELIG.NOT_QUALIFIED, ELIG.INCLUDED, ELIG.RELEASED];

export const ENT = { AWAITING: "Awaiting Payroll", IN_PROGRESS: "Payroll In Progress", INCLUDED: "Included in Payroll", RELEASED: "Released", CANCELLED: "Cancelled" };

export const PAYROLL = { DRAFT: "Draft", GENERATED: "Generated", REVIEW: "For Review", APPROVED: "Approved", RELEASED: "Released", ARCHIVED: "Archived", VOIDED: "Voided" };

export const DEFAULT_SETTINGS = {
  currentAcademicYear: "",
  deadline: { months: 5, policy: "within", cutoff: "end-of-day", reminderDays: 14 },
  termPeriodMap: { T1: "P1", T2: "P2", T3: "P2" },
  payroll: { autoGenerate: true, dayOfMonth: 5, signatories: { a: "", b: "", c: "", d: "" } },
  notifications: { emailEnabled: false, officeEmails: [] },
  lists: {
    batches: ["Batch 1", "Batch 2", "Batch 3", "Batch 4", "Batch 5", "Batch 6", "Batch 7"],
    levels: ["Senior High School", "College", "Graduate School", "Technical-Vocational"],
    yearLevels: ["Grade 11", "Grade 12", "1st Year", "2nd Year", "3rd Year", "4th Year", "5th Year"],
    programs: []
  },
  branding: { loginImagePath: "" }
};

export function mergeSettings(stored) {
  const s = stored || {};
  return {
    ...DEFAULT_SETTINGS, ...s,
    deadline: { ...DEFAULT_SETTINGS.deadline, ...(s.deadline || {}) },
    termPeriodMap: { ...DEFAULT_SETTINGS.termPeriodMap, ...(s.termPeriodMap || {}) },
    payroll: { ...DEFAULT_SETTINGS.payroll, ...(s.payroll || {}), signatories: { ...DEFAULT_SETTINGS.payroll.signatories, ...((s.payroll || {}).signatories || {}) } },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(s.notifications || {}) },
    lists: { ...DEFAULT_SETTINGS.lists, ...(s.lists || {}) },
    branding: { ...DEFAULT_SETTINGS.branding, ...(s.branding || {}) }
  };
}

/* ---------------- Submission deadlines ---------------- */

/**
 * The submission window for one student-term.
 * policy "within": opens on the opening date, closes `months` later.
 * policy "after":  opens `months` after the opening date, no automatic close.
 * An approved extension can only push the close later, never earlier.
 */
export function submissionWindow({ openingDate, months = 5, policy = "within", cutoff = "end-of-day", extensionDeadline = null }) {
  if (!openingDate || !isValidYMD(openingDate)) return { opensAt: null, closesAt: null, deadlineDate: null, noCalendar: true };
  const shifted = addMonthsYMD(openingDate, Number(months) || 0);
  let opensAt, closesAt, deadlineDate;
  if (policy === "after") {
    opensAt = manilaStart(shifted); closesAt = null; deadlineDate = null;
  } else {
    opensAt = manilaStart(openingDate);
    deadlineDate = shifted;
    closesAt = cutoff === "start-of-day" ? manilaStart(shifted) : manilaEnd(shifted);
  }
  if (extensionDeadline && isValidYMD(extensionDeadline)) {
    const ext = manilaEnd(extensionDeadline);
    if (!closesAt || ext > closesAt) { closesAt = ext; deadlineDate = extensionDeadline; }
  }
  return { opensAt, closesAt, deadlineDate, noCalendar: false };
}

export function windowState(win, now = new Date()) {
  if (!win || win.noCalendar) return "no-calendar";
  if (win.opensAt && now < win.opensAt) return "not-yet";
  if (win.closesAt && now > win.closesAt) return "closed";
  return "open";
}

/** Opening date for a student-term: staff override, then school calendar, then academic-year default. */
export function resolveOpeningDate({ record, school, academicYear, ay, term }) {
  if (record?.openingDate && isValidYMD(record.openingDate)) return record.openingDate;
  const s = school?.calendars?.[ay]?.[term];
  if (s && isValidYMD(s)) return s;
  const d = academicYear?.terms?.[term]?.openingDate;
  if (d && isValidYMD(d)) return d;
  return null;
}

/* ---------------- Terms and allowance periods ---------------- */

export function periodForTerm(map, term) {
  const p = (map || DEFAULT_SETTINGS.termPeriodMap)[term];
  return PERIODS.includes(p) ? p : null;
}

export function termsForPeriod(map, period) {
  const m = map || DEFAULT_SETTINGS.termPeriodMap;
  return TERMS.filter(t => m[t] === period);
}

export function validateTermPeriodMap(map) {
  for (const t of TERMS) if (map[t] != null && map[t] !== "" && !PERIODS.includes(map[t])) return `Term ${t} must map to P1, P2 or nothing.`;
  if (!PERIODS.every(p => TERMS.some(t => map[t] === p))) return "Each allowance period (P1 and P2) needs at least one academic term.";
  return null;
}

/* ---------------- Allowance types and rates ---------------- */

export function typeActiveOn(type, ymd) {
  if (!type || type.active === false) return false;
  if (type.effectiveDate && compareYMD(ymd, type.effectiveDate) < 0) return false;
  if (type.endDate && compareYMD(ymd, type.endDate) > 0) return false;
  return true;
}

/** Latin honor levels; a Latin-honor allowance type carries a separate dated rate for each. */
export const LATIN_LEVELS = ["Summa Cum Laude", "Magna Cum Laude", "Cum Laude"];

/**
 * The rate in force on a date. Rates: [{amount, effectiveFrom, effectiveTo?, level?}]
 * For a Latin-honor type pass the student's level; each level has its own rates.
 */
export function rateOn(type, ymd, level = "") {
  let pool = type?.rates || [];
  if (type?.appliesTo === "latinHonor" && pool.some(r => r.level)) pool = pool.filter(r => r.level === level);
  const rates = [...pool].sort((a, b) => compareYMD(b.effectiveFrom, a.effectiveFrom));
  for (const r of rates) {
    if (compareYMD(r.effectiveFrom, ymd) <= 0 && (!r.effectiveTo || compareYMD(ymd, r.effectiveTo) <= 0)) return r;
  }
  return null;
}

const rateKey = r => `${r.level || ""}|${r.effectiveFrom}`;
const levelLabel = r => (r.level ? ` (${r.level})` : "");

export function validateRates(rates, { levels = false } = {}) {
  if (!Array.isArray(rates)) return "Rates must be a list.";
  for (const r of rates) {
    if (!isValidYMD(r.effectiveFrom)) return "Every rate needs a valid effective date.";
    if (r.effectiveTo && !isValidYMD(r.effectiveTo)) return "Invalid rate end date.";
    if (r.effectiveTo && compareYMD(r.effectiveTo, r.effectiveFrom) < 0) return "A rate ends before it starts.";
    if (!(Number(r.amount) >= 0) || Math.round(Number(r.amount) * 100) !== Number(r.amount) * 100) return "Rate amounts must be pesos with at most 2 decimals.";
    if (r.level && !levels) return "Only a Latin honor allowance can have rates per honor level.";
    if (levels && !LATIN_LEVELS.includes(r.level)) return "Each Latin honor rate must be for Summa Cum Laude, Magna Cum Laude or Cum Laude.";
  }
  for (const level of new Set(rates.map(r => r.level || ""))) {
    const sorted = rates.filter(r => (r.level || "") === level).sort((a, b) => compareYMD(a.effectiveFrom, b.effectiveFrom));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      if (!prev.effectiveTo || compareYMD(prev.effectiveTo, sorted[i].effectiveFrom) >= 0) return `Rates overlap${levelLabel(prev)}: ${prev.effectiveFrom} and ${sorted[i].effectiveFrom}. End the earlier rate the day before the next one starts.`;
    }
  }
  return null;
}

/** Existing rates may only be ended (effectiveTo set once); amounts and start dates never change and rates are never removed. */
export function rateHistoryPreserved(oldRates = [], newRates = []) {
  for (const o of oldRates) {
    const n = newRates.find(r => rateKey(r) === rateKey(o));
    if (!n) return `The rate${levelLabel(o)} effective ${o.effectiveFrom} can't be removed. End it instead.`;
    if (Number(n.amount) !== Number(o.amount)) return `The amount of the rate${levelLabel(o)} effective ${o.effectiveFrom} can't be changed. Add a new rate with a later effective date.`;
    if (o.effectiveTo && n.effectiveTo !== o.effectiveTo) return `The end date of the rate${levelLabel(o)} effective ${o.effectiveFrom} is already set.`;
  }
  return null;
}

/** Several allowance types for one student-period are allowed only if each lists the others as combinable. */
export function validateTypeCombination(types) {
  if (types.length <= 1) return null;
  for (const t of types) for (const o of types) {
    if (t.code !== o.code && !(t.combinableWith || []).includes(o.code)) return `${t.name} and ${o.name} can't be paid together under the current program policy.`;
  }
  return null;
}

/* ---------------- Documents and eligibility ---------------- */

export function requirementApplies(req, term) {
  if (!req || req.active === false) return false;
  return !Array.isArray(req.terms) || req.terms.length === 0 || req.terms.includes(term);
}

/** The newest version of each requirement among one student-term's submissions. */
export function latestByRequirement(subs) {
  const out = {};
  for (const s of subs) {
    if (s.status === DOC_STATUS.SUPERSEDED) continue;
    const cur = out[s.requirementCode];
    if (!cur || (s.version || 1) > (cur.version || 1)) out[s.requirementCode] = s;
  }
  return out;
}

export function termDocState(requirements, subs, term) {
  const req = requirements.filter(r => requirementApplies(r, term) && r.requiredForAllowance !== false);
  const latest = latestByRequirement(subs);
  // An approved document stays valid while its replacement is reviewed.
  const approvedCodes = new Set(subs.filter(s => s.status === DOC_STATUS.APPROVED).map(s => s.requirementCode));
  const missing = [], returned = [], inReview = [];
  for (const r of req) {
    if (approvedCodes.has(r.code)) continue;
    const s = latest[r.code];
    if (!s) missing.push(r.code);
    else if (s.status === DOC_STATUS.RETURNED) returned.push(r.code);
    else inReview.push(r.code);
  }
  let state = "complete";
  if (returned.length) state = "returned";
  else if (inReview.length) state = "in-review";
  else if (missing.length) state = "pending";
  if (!req.length) state = "no-requirements";
  return { state, missing, returned, inReview };
}

/**
 * Eligibility derived from document states. A decision already made by staff
 * (Qualified, Not Qualified, Included, Released) is never overwritten here.
 */
export function deriveEligibility(existingStatus, termStates) {
  if (ELIG_DECIDED.includes(existingStatus)) return { status: existingStatus, docsComplete: termStates.some(t => t.state === "complete") };
  const states = termStates.map(t => t.state);
  if (states.includes("complete")) return { status: ELIG.REVIEW, docsComplete: true };
  if (states.includes("returned")) return { status: ELIG.RETURNED, docsComplete: false };
  if (states.includes("in-review")) return { status: ELIG.REVIEW, docsComplete: false };
  return { status: ELIG.PENDING, docsComplete: false };
}

export function programActiveOn(student, ymd) {
  if (!student) return false;
  if (student.programStatus !== "Ended") return true;
  const eff = student.programEnded?.effectiveDate;
  return !!eff && compareYMD(ymd, eff) < 0;
}

/* ---------------- Identifiers ---------------- */

export const safeId = s => String(s).replace(/[^A-Za-z0-9-]/g, "_");
export const academicRecordId = (sid, ay, term) => `${safeId(sid)}_${ay}_${term}`;
export const eligibilityId = (sid, ay, period) => `${safeId(sid)}_${ay}_${period}`;
export const entitlementId = (sid, ay, period, typeCode) => `${safeId(sid)}_${ay}_${period}_${safeId(typeCode)}`;
export const extensionId = (sid, ay, term) => `${safeId(sid)}_${ay}_${term}`;

export function payrollNumber(month, seq) {
  return `PR-${month}-${String(seq).padStart(3, "0")}`;
}

/* ---------------- Payroll workflow ---------------- */

export const PAYROLL_ACTIONS = {
  submitReview: { from: [PAYROLL.DRAFT, PAYROLL.GENERATED], to: PAYROLL.REVIEW, perm: "preparePayroll" },
  review:       { from: [PAYROLL.REVIEW], to: PAYROLL.REVIEW, perm: "preparePayroll" },
  approve:      { from: [PAYROLL.REVIEW], to: PAYROLL.APPROVED, perm: "approvePayroll" },
  release:      { from: [PAYROLL.APPROVED], to: PAYROLL.RELEASED, perm: "releasePayroll" },
  archive:      { from: [PAYROLL.RELEASED], to: PAYROLL.ARCHIVED, perm: "approvePayroll" },
  void:         { from: [PAYROLL.DRAFT, PAYROLL.GENERATED, PAYROLL.REVIEW, PAYROLL.APPROVED], to: PAYROLL.VOIDED, perm: "approvePayroll" },
  removeItem:   { from: [PAYROLL.DRAFT, PAYROLL.GENERATED, PAYROLL.REVIEW], to: null, perm: "preparePayroll" }
};

export function hasPermission(actor, perm) {
  if (!actor) return false;
  if (actor.role === "admin" || actor.role === "staff") return PERMISSIONS.includes(perm);
  return false;
}

/** Checks one payroll action. Returns an error message or null. */
export function checkPayrollAction(payroll, action, actor, input = {}, today) {
  const rule = PAYROLL_ACTIONS[action];
  if (!rule) return "Unknown payroll action.";
  if (!hasPermission(actor, rule.perm)) return "You are not authorized for this payroll action.";
  if (!rule.from.includes(payroll.status)) return `A payroll that is ${payroll.status} can't be changed this way.`;
  if (action === "review" && payroll.preparedBy?.uid === actor.uid && actor.role !== "admin") return "The reviewer must be a different person from the preparer.";
  if (action === "approve" && !payroll.reviewedBy) return "The payroll must be reviewed before approval.";
  if (action === "approve" && !(payroll.itemCount > 0)) return "An empty payroll can't be approved.";
  if (action === "release") {
    if (!isValidYMD(input.paymentDate)) return "Enter the actual payment date.";
    if (today && compareYMD(input.paymentDate, today) > 0) return "The payment date can't be in the future.";
    if (!String(input.paymentRef || "").trim()) return "Enter the payment reference (check, LDDAP-ADA or disbursement voucher number).";
  }
  if (action === "void" && !String(input.reason || "").trim()) return "Give the reason for voiding this payroll.";
  return null;
}

export function roundPesos(n) {
  return Math.round(Number(n) * 100) / 100;
}

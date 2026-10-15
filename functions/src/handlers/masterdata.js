// Master data and settings (administrator only, audited).
import { onCall } from "firebase-functions/v2/https";
import { db, now, actor, audit, bad, notFound, str, getSettings } from "../fb.js";
import {
  DEFAULT_SETTINGS, TERMS, validateTermPeriodMap, validateRates, rateHistoryPreserved, PERIODS
} from "../core/policy.js";
import { isValidAY, isValidYMD, manilaToday } from "../core/dates.js";
import { cleanApplicationConfig } from "../core/applications.js";

const CODE_RE = /^[A-Z][A-Z0-9_]{1,29}$/;
const list = (v, max = 200) => (Array.isArray(v) ? v : []).map(x => str(x, 120)).filter(Boolean).slice(0, max);

function guessAY() {
  const t = manilaToday(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  return m >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Creates the default settings, requirements and allowance types if they don't exist yet. Amounts are never pre-filled. */
export async function seedDefaults() {
  const sref = db.doc("settings/app");
  if (!(await sref.get()).exists) await sref.set({ ...DEFAULT_SETTINGS, currentAcademicYear: guessAY(), createdAt: now() });
  const reqs = await db.collection("documentRequirements").limit(1).get();
  if (reqs.empty) {
    const b = db.batch();
    [
      ["SCHOOL_ID", "Student Identification Card", "Current valid school ID (front and back).", 1],
      ["ENROLLMENT", "Proof of Enrollment", "Certificate of Registration or Certificate of Enrollment for this term.", 2],
      ["GRADES", "Previous Semester Grades", "Report card or certified grade report of the preceding term.", 3]
    ].forEach(([code, name, description, order]) => b.set(db.doc(`documentRequirements/${code}`), {
      code, name, description, order, terms: [...TERMS], requiredForAllowance: true, active: true, createdAt: now()
    }));
    await b.commit();
  }
  const types = await db.collection("allowanceTypes").limit(1).get();
  if (types.empty) {
    const b = db.batch();
    b.set(db.doc("allowanceTypes/REG"), {
      code: "REG", name: "Regular Allowance", description: "Semestral allowance for active TOSCAN students.",
      eligibility: "Active Top 10 or Top 20 student with approved documents for the period.",
      appliesTo: "all", classifications: ["top10", "top20"], combinableWith: [], maxPeriods: null,
      effectiveDate: "", endDate: "", active: true, rates: [], remarks: "Set the rate before generating payroll.", createdAt: now()
    });
    b.set(db.doc("allowanceTypes/LATIN"), {
      code: "LATIN", name: "Latin Honor Allowance", description: "Allowance for students graduating with Latin honors.",
      eligibility: "Student with a verified Latin honor. Summa Cum Laude, Magna Cum Laude and Cum Laude each have their own rate.",
      appliesTo: "latinHonor", classifications: ["top10", "top20"], combinableWith: [], maxPeriods: 1,
      effectiveDate: "", endDate: "", active: true, rates: [], remarks: "Set the rate before generating payroll.", createdAt: now()
    });
    await b.commit();
  }
}

function cleanSettings(d, current) {
  const out = {};
  if (d.currentAcademicYear !== undefined) {
    if (!isValidAY(d.currentAcademicYear)) bad("Current academic year must look like 2026-2027.");
    out.currentAcademicYear = d.currentAcademicYear;
  }
  if (d.deadline) {
    const m = Number(d.deadline.months);
    if (!Number.isInteger(m) || m < 1 || m > 24) bad("Deadline months must be a whole number from 1 to 24.");
    if (!["within", "after"].includes(d.deadline.policy)) bad("Deadline policy must be 'within' or 'after'.");
    if (!["end-of-day", "start-of-day"].includes(d.deadline.cutoff)) bad("Invalid cutoff rule.");
    const r = Number(d.deadline.reminderDays);
    if (!Number.isInteger(r) || r < 0 || r > 60) bad("Reminder days must be 0 to 60.");
    out.deadline = { months: m, policy: d.deadline.policy, cutoff: d.deadline.cutoff, reminderDays: r };
  }
  if (d.termPeriodMap) {
    const map = {};
    for (const t of TERMS) map[t] = PERIODS.includes(d.termPeriodMap[t]) ? d.termPeriodMap[t] : "";
    const err = validateTermPeriodMap(map); if (err) bad(err);
    out.termPeriodMap = map;
  }
  if (d.payroll) {
    const day = Number(d.payroll.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 28) bad("Payroll day must be 1 to 28.");
    const sg = d.payroll.signatories || {};
    out.payroll = {
      autoGenerate: !!d.payroll.autoGenerate, dayOfMonth: day,
      signatories: Object.fromEntries(["a", "b", "c", "d"].map(k => [k, str(sg[k], 120)])),
      signatoryTitles: Object.fromEntries(["a", "b", "c", "d"].map(k => [k, str((d.payroll.signatoryTitles || {})[k], 120)]))
    };
  }
  if (d.notifications) {
    const emails = list(d.notifications.officeEmails, 10);
    if (emails.some(e => !/^\S+@\S+\.\S+$/.test(e))) bad("Office emails must be valid addresses.");
    out.notifications = { emailEnabled: !!d.notifications.emailEnabled, officeEmails: emails };
  }
  if (d.lists) out.lists = {
    batches: list(d.lists.batches ?? current.lists.batches), levels: list(d.lists.levels ?? current.lists.levels),
    yearLevels: list(d.lists.yearLevels ?? current.lists.yearLevels), programs: list(d.lists.programs ?? current.lists.programs, 500)
  };
  if (d.branding) {
    const p = str(d.branding.loginImagePath, 300);
    if (p && !p.startsWith("branding/")) bad("Login image must be uploaded under branding/.");
    out.branding = { loginImagePath: p };
  }
  return out;
}

function cleanAcademicYear(id, d) {
  if (!isValidAY(id)) bad("Academic year must look like 2026-2027.");
  const terms = {};
  for (const t of TERMS) {
    const o = d.terms?.[t]?.openingDate;
    if (o && !isValidYMD(o)) bad(`Invalid opening date for ${t}.`);
    terms[t] = { openingDate: o || "" };
  }
  return { label: id, active: d.active !== false, terms };
}

function cleanSchool(d) {
  const name = str(d.name, 160).toUpperCase();
  if (!name) bad("School name is required.");
  const tpy = Number(d.termsPerYear);
  if (![2, 3].includes(tpy)) bad("Terms per year must be 2 or 3.");
  const calendars = {};
  for (const [ay, terms] of Object.entries(d.calendars || {})) {
    if (!isValidAY(ay)) bad(`Invalid academic year ${ay}.`);
    calendars[ay] = {};
    for (const t of TERMS) {
      const v = terms?.[t];
      if (v && !isValidYMD(v)) bad(`Invalid ${ay} ${t} opening date.`);
      if (v) calendars[ay][t] = v;
    }
  }
  return { name, address: str(d.address, 300), termsPerYear: tpy, active: d.active !== false, calendars };
}

function cleanRequirement(code, d) {
  if (!CODE_RE.test(code)) bad("Requirement code: capital letters, digits and _ only (e.g. MEDICAL_CERT).");
  const name = str(d.name, 120); if (!name) bad("Requirement name is required.");
  const terms = (d.terms || []).filter(t => TERMS.includes(t));
  return { code, name, description: str(d.description, 500), terms: terms.length ? terms : [...TERMS], requiredForAllowance: d.requiredForAllowance !== false, active: d.active !== false, order: Number(d.order) || 99 };
}

function cleanAllowanceType(code, d, old) {
  if (!CODE_RE.test(code)) bad("Allowance code: capital letters, digits and _ only (e.g. REG).");
  const name = str(d.name, 120); if (!name) bad("Allowance name is required.");
  if (d.effectiveDate && !isValidYMD(d.effectiveDate)) bad("Invalid effective date.");
  if (d.endDate && !isValidYMD(d.endDate)) bad("Invalid end date.");
  const latin = d.appliesTo === "latinHonor";
  const rates = (d.rates || []).map(r => ({ amount: Number(r.amount), effectiveFrom: r.effectiveFrom, ...(r.effectiveTo ? { effectiveTo: r.effectiveTo } : {}), ...(r.level ? { level: str(r.level, 40) } : {}) }));
  if (old && (old.appliesTo === "latinHonor") !== latin && (old.rates || []).length) bad("\"Applies to\" can't be changed once the type has rates. Add a new allowance type instead.");
  const e1 = validateRates(rates, { levels: latin }); if (e1) bad(e1);
  const e2 = rateHistoryPreserved(old?.rates || [], rates); if (e2) bad(e2);
  const maxPeriods = d.maxPeriods === "" || d.maxPeriods == null ? null : Number(d.maxPeriods);
  if (maxPeriods !== null && (!Number.isInteger(maxPeriods) || maxPeriods < 1)) bad("Maximum payable periods must be a whole number, or blank for no limit.");
  return {
    code, name, description: str(d.description, 500), eligibility: str(d.eligibility, 500),
    appliesTo: latin ? "latinHonor" : "all",
    classifications: (d.classifications || []).filter(c => ["top10", "top20"].includes(c)),
    combinableWith: (d.combinableWith || []).map(c => str(c, 30)).filter(c => CODE_RE.test(c) && c !== code),
    maxPeriods, effectiveDate: d.effectiveDate || "", endDate: d.endDate || "", active: d.active !== false,
    rates, remarks: str(d.remarks, 500)
  };
}

/** data: { kind: "settings"|"academicYear"|"school"|"requirement"|"allowanceType"|"applicationForm", id?, data } */
export const saveMasterData = onCall(async request => {
  const a = await actor(request, { roles: ["admin"] });
  const { kind, id, data = {}, reason } = request.data || {};
  let ref, value, merge = false;
  if (kind === "settings") {
    ref = db.doc("settings/app"); value = cleanSettings(data, await getSettings(true)); merge = true;
  } else if (kind === "academicYear") {
    ref = db.doc(`academicYears/${id}`); value = cleanAcademicYear(id, data);
  } else if (kind === "school") {
    ref = id ? db.doc(`schools/${id}`) : db.collection("schools").doc();
    if (id && !(await ref.get()).exists) notFound("School not found.");
    value = cleanSchool(data);
  } else if (kind === "requirement") {
    ref = db.doc(`documentRequirements/${id}`); value = cleanRequirement(id, data);
  } else if (kind === "allowanceType") {
    ref = db.doc(`allowanceTypes/${id}`);
    const old = await ref.get();
    value = cleanAllowanceType(id, data, old.exists ? old.data() : null);
  } else if (kind === "applicationForm") {
    ref = db.doc("publicConfig/application");
    const { errors, value: v } = cleanApplicationConfig(data); if (errors.length) bad(errors.join(" "));
    value = v;
  } else bad("Unknown master data kind.");

  const beforeSnap = await ref.get();
  const before = beforeSnap.exists ? beforeSnap.data() : null;
  await ref.set({ ...value, updatedAt: now(), updatedBy: { uid: a.uid, name: a.name }, ...(before ? {} : { createdAt: now() }) }, { merge });
  await audit(a, `masterdata.${kind}`, { type: kind, id: ref.id }, { before, after: value, reason: str(reason, 300) });
  return { ok: true, id: ref.id };
});

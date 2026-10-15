// Pure validation and mapping for student records, imports and legacy data.
import { isValidYMD, isValidAY } from "./dates.js";
import { TERMS, PERIODS, roundPesos } from "./policy.js";

export const LATIN_HONORS = ["", "Summa Cum Laude", "Magna Cum Laude", "Cum Laude"];
export const CLASSIFICATIONS = { top10: "Top 10 — TOSCAN Awardee", top20: "Top 20 — TOSCAN Qualifier" };

const clean = v => (v == null ? "" : String(v).trim());
const upper = v => clean(v).toUpperCase().replace(/\s+/g, " ");
const normName = v => upper(v).replace(/[^A-ZÑ ]/g, "");

export function fullName(s) {
  if (!s) return "";
  return [s.surname ? s.surname + "," : "", s.firstName, s.middleName, s.extName].filter(Boolean).join(" ").trim();
}

/** Read Top 10 / Top 20 from the old portal's award text ("Batch 2 — Awardee (Top 1–10)"). */
export function classificationFromAward(award) {
  const a = String(award || "").toLowerCase();
  if (a.includes("awardee") || a.includes("top 10") || a.includes("top10") || a === "top 1–10") return "top10";
  if (a.includes("qualifier") || a.includes("top 20") || a.includes("top20")) return "top20";
  return "";
}

export function classificationFromText(v) {
  const a = clean(v).toLowerCase().replace(/\s+/g, "");
  if (["top10", "10", "awardee", "top10—toscanawardee"].includes(a) || a.startsWith("top10")) return "top10";
  if (["top20", "20", "qualifier"].includes(a) || a.startsWith("top20")) return "top20";
  return a ? null : "";
}

/** New structured fields for an old-portal student record. Old fields are left as they are. */
export function mapLegacyStudent(id, d, { archived = false } = {}) {
  const ended = archived || d.archived === true || ["Graduated", "Stopped"].includes(d.status);
  const out = {
    studentId: id,
    profileVersion: 2,
    surname: upper(d.surname), firstName: upper(d.firstName), middleName: upper(d.middleName), extName: clean(d.extName),
    email: clean(d.email), emailLower: clean(d.email).toLowerCase(),
    contact: clean(d.contact), address: clean(d.address), atmNumber: clean(d.atmNumber),
    classification: classificationFromAward(d.award),
    latinHonor: LATIN_HONORS.includes(d.latinHonor) ? d.latinHonor : "",
    qualification: {
      batch: clean(d.batch), yearQualified: "", schoolAtQualification: upper(d.school),
      awardType: clean(d.award), admissionDate: ""
    },
    current: {
      school: upper(d.school), schoolAddress: "", level: "", program: upper(d.course), yearLevel: "",
      academicYear: isValidAY(d.schoolYear) ? d.schoolYear : "", term: /2nd/i.test(d.semester || "") ? "T2" : /1st/i.test(d.semester || "") ? "T1" : "",
      enrollmentStatus: "", expectedGraduation: ""
    },
    programStatus: ended ? "Ended" : "Active",
    source: "legacy"
  };
  if (ended) out.programEnded = { effectiveDate: "", reason: d.status ? `Old portal status: ${d.status}` : "Archived in the old portal", remarks: "Migrated", by: "migration" };
  return out;
}

/* ---------------- Registration ---------------- */

export function validateRegistration(r) {
  const errors = [];
  const out = {
    surname: upper(r.surname), firstName: upper(r.firstName), middleName: upper(r.middleName), extName: clean(r.extName),
    dateOfBirth: clean(r.dateOfBirth), contact: clean(r.contact), address: upper(r.address),
    toscanId: upper(r.toscanId), batch: clean(r.batch), school: upper(r.school), program: upper(r.program), yearLevel: clean(r.yearLevel),
    accountType: r.accountType === "staff" ? "staff" : "student"
  };
  if (!out.surname) errors.push("Surname is required.");
  if (!out.firstName) errors.push("First name is required.");
  if (out.surname && !/^[\p{L} .'-]+$/u.test(out.surname)) errors.push("Surname can contain letters only.");
  if (out.firstName && !/^[\p{L} .'-]+$/u.test(out.firstName)) errors.push("First name can contain letters only.");
  if (!/^[\d+()\-\s]{7,20}$/.test(out.contact)) errors.push("Enter a valid contact number.");
  if (out.accountType === "student") {
    if (!isValidYMD(out.dateOfBirth)) errors.push("Enter your date of birth.");
    if (!out.address) errors.push("Address is required.");
    if (!out.school) errors.push("Current school is required.");
  }
  return { errors, value: out };
}

/* ---------------- Imports ---------------- */

const pick = (row, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(row).find(h => h.toLowerCase().replace(/[^a-z0-9]/g, "") === k);
    if (hit != null && clean(row[hit]) !== "") return clean(row[hit]);
  }
  return "";
};

/** Excel dates arrive as numbers or various strings; return YYYY-MM-DD or "" (invalid → null). */
export function normalizeDate(v) {
  const s = clean(v);
  if (!s) return "";
  if (/^\d{5}$/.test(s)) { // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (isValidYMD(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s); // MM/DD/YYYY (Philippine government forms)
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; const ymd = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; return isValidYMD(ymd) ? ymd : null; }
  return null;
}

export function normalizeTerm(v) {
  const s = clean(v).toLowerCase();
  if (!s) return "";
  if (["t1", "1", "1st", "first", "1st semester", "first semester", "1st sem"].includes(s)) return "T1";
  if (["t2", "2", "2nd", "second", "2nd semester", "second semester", "2nd sem"].includes(s)) return "T2";
  if (["t3", "3", "3rd", "third", "3rd semester", "third semester", "3rd sem", "summer"].includes(s)) return "T3";
  return null;
}

export function normalizePeriod(v) {
  const s = clean(v).toLowerCase();
  if (!s) return "";
  if (["p1", "1", "first", "first allowance", "1st"].includes(s)) return "P1";
  if (["p2", "2", "second", "second allowance", "2nd"].includes(s)) return "P2";
  return null;
}

export function parseAmount(v) {
  const n = Number(clean(v).replace(/[₱,\s]/g, ""));
  return clean(v) !== "" && Number.isFinite(n) && n >= 0 ? roundPesos(n) : null;
}

/**
 * One historical payment row. ctx: { students: Map(studentId → student), byName: Map(NAME KEY → [studentId]),
 *   types: Map(code → type), termPeriodMap }
 */
export function validateHistoricalRow(row, ctx) {
  const errors = [];
  let studentId = upper(pick(row, "studentid", "toscanid", "toscanreferencenumber", "referencenumber", "id"));
  const name = pick(row, "studentname", "name", "completename", "fullname");
  if (!studentId && name) {
    const hits = ctx.byName.get(nameKey(name)) || [];
    if (hits.length === 1) studentId = hits[0];
    else if (hits.length > 1) errors.push(`More than one student is named "${name}". Use the TOSCAN ID.`);
    else errors.push(`No student named "${name}". Import the student first or use the TOSCAN ID.`);
  }
  if (studentId && !ctx.students.has(studentId)) errors.push(`Unknown TOSCAN ID ${studentId}.`);
  const ay = pick(row, "schoolyear", "academicyear", "sy", "ay");
  if (!isValidAY(ay)) errors.push(`School year "${ay}" must look like 2024-2025.`);
  const term = normalizeTerm(pick(row, "semester", "academicsemester", "term"));
  if (term === null) errors.push("Semester must be 1st, 2nd or 3rd.");
  let period = normalizePeriod(pick(row, "allowanceperiod", "period"));
  if (period === null) errors.push("Allowance period must be First or Second.");
  if (!period && term) period = (ctx.termPeriodMap || {})[term] || "";
  if (!period) errors.push("Give the allowance period or the semester.");
  const typeCode = upper(pick(row, "allowancecategory", "allowancetype", "category", "type")) || "REG";
  if (!ctx.types.has(typeCode)) errors.push(`Unknown allowance category "${typeCode}".`);
  const amount = parseAmount(pick(row, "allowanceamount", "amount"));
  if (amount === null) errors.push("Amount must be a number in pesos.");
  const payrollDate = normalizeDate(pick(row, "payrollprocessingdate", "payrolldate"));
  const releaseDate = normalizeDate(pick(row, "releasedate", "datereleased", "paymentdate"));
  if (payrollDate === null) errors.push("Payroll date is not a valid date.");
  if (releaseDate === null) errors.push("Release date is not a valid date.");
  const statusRaw = pick(row, "paymentstatus", "historicalpaymentstatus", "status").toLowerCase();
  const status = !statusRaw || ["released", "paid"].includes(statusRaw) ? "Released" : ["unpaid", "not released", "pending"].includes(statusRaw) ? "Unpaid" : null;
  if (status === null) errors.push(`Payment status "${statusRaw}" must be Released or Unpaid.`);
  if (status === "Released" && !releaseDate) errors.push("A released payment needs its release date.");
  const value = {
    studentId, academicYear: ay, term: term || "", period, typeCode, amount,
    payrollNo: pick(row, "payrollnumber", "payrollno"), payrollDate: payrollDate || "", releaseDate: releaseDate || "",
    status, batch: pick(row, "toscanbatch", "batch"), remarks: pick(row, "remarks", "notes")
  };
  return { errors, value };
}

export function nameKey(name) {
  // "DELA CRUZ, MARIA G" and "Maria G. Dela Cruz" both become sorted word keys
  return normName(String(name).replace(",", " ")).split(" ").filter(w => w.length > 1).sort().join(" ");
}

export function validateStudentImportRow(row) {
  const errors = [];
  const cls = classificationFromText(pick(row, "classification", "toscanclassification", "group"));
  const v = {
    toscanId: upper(pick(row, "toscanid", "studentid", "toscanreferencenumber")),
    surname: upper(pick(row, "surname", "lastname")), firstName: upper(pick(row, "firstname", "givenname")),
    middleName: upper(pick(row, "middlename")), extName: clean(pick(row, "extension", "extname", "suffix")),
    dateOfBirth: normalizeDate(pick(row, "dateofbirth", "birthdate", "dob")),
    email: pick(row, "email", "emailaddress").toLowerCase(), contact: pick(row, "contact", "contactnumber"),
    address: upper(pick(row, "address", "completeaddress")),
    batch: pick(row, "toscanbatch", "batch"), yearQualified: pick(row, "yearofqualification", "yearqualified"),
    schoolAtQualification: upper(pick(row, "schoolatqualification", "qualificationschool", "originalschool")),
    admissionDate: normalizeDate(pick(row, "admissiondate", "dateofadmission")),
    classification: cls,
    currentSchool: upper(pick(row, "currentschool", "school")), program: upper(pick(row, "program", "course", "strand")),
    yearLevel: pick(row, "yearlevel"), level: pick(row, "educationallevel", "level"),
    latinHonor: pick(row, "latinhonor"), atmNumber: pick(row, "atmnumber", "atm"),
    programStatus: /ended/i.test(pick(row, "programstatus", "status")) ? "Ended" : "Active"
  };
  if (!v.surname || !v.firstName) errors.push("Surname and first name are required.");
  if (v.toscanId && !/^[A-Z0-9-]{3,40}$/.test(v.toscanId)) errors.push("TOSCAN ID may contain letters, digits and dashes only (3–40 characters).");
  if (v.dateOfBirth === null) errors.push("Date of birth is not a valid date.");
  if (v.admissionDate === null) errors.push("Admission date is not a valid date.");
  if (cls === null) errors.push("Classification must be Top 10 or Top 20.");
  if (v.latinHonor && !LATIN_HONORS.includes(v.latinHonor)) errors.push("Latin honor must be Summa, Magna or Cum Laude.");
  if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) errors.push("Email is not valid.");
  if (v.yearQualified && !/^\d{4}$/.test(v.yearQualified)) errors.push("Year of qualification must be a 4-digit year.");
  return { errors, value: { ...v, dateOfBirth: v.dateOfBirth || "", admissionDate: v.admissionDate || "", classification: cls || "" } };
}

export { TERMS, PERIODS };

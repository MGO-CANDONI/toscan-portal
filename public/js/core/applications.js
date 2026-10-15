// TOSCAN search applications: form configuration, validation and statuses.
// Shared, dependency-free code: copied to the web app by scripts/sync-core.mjs.
import { isValidYMD, compareYMD } from "./dates.js";

export const APP_STATUS = {
  SUBMITTED: "Submitted",
  SCREENING: "Under Screening",
  FINALIST: "Top 20 Finalist",
  BIDBOOK: "Bidbook Submitted",
  NOT_SELECTED: "Not Selected",
  TOP10: "Top 10 Awardee",
  TOP20: "Top 20 Qualifier",
  WITHDRAWN: "Withdrawn"
};

/** Status changes staff may make. "Bidbook Submitted" is set only by the applicant's upload. */
export const APP_TRANSITIONS = {
  [APP_STATUS.SUBMITTED]: [APP_STATUS.SCREENING, APP_STATUS.FINALIST, APP_STATUS.NOT_SELECTED, APP_STATUS.WITHDRAWN],
  [APP_STATUS.SCREENING]: [APP_STATUS.FINALIST, APP_STATUS.NOT_SELECTED, APP_STATUS.WITHDRAWN],
  [APP_STATUS.FINALIST]: [APP_STATUS.NOT_SELECTED, APP_STATUS.WITHDRAWN, APP_STATUS.SCREENING],
  [APP_STATUS.BIDBOOK]: [APP_STATUS.TOP10, APP_STATUS.TOP20, APP_STATUS.NOT_SELECTED, APP_STATUS.WITHDRAWN, APP_STATUS.FINALIST],
  [APP_STATUS.NOT_SELECTED]: [APP_STATUS.SCREENING],
  [APP_STATUS.TOP10]: [APP_STATUS.TOP20, APP_STATUS.BIDBOOK],
  [APP_STATUS.TOP20]: [APP_STATUS.TOP10, APP_STATUS.BIDBOOK],
  [APP_STATUS.WITHDRAWN]: [APP_STATUS.SCREENING]
};

/** What the applicant sees for each status. */
export const APP_STATUS_TEXT = {
  [APP_STATUS.SUBMITTED]: "Your application was received. The TOSCAN Office will screen all applications after the deadline.",
  [APP_STATUS.SCREENING]: "Your application is being screened.",
  [APP_STATUS.FINALIST]: "Congratulations! You were selected as a Top 20 finalist. Download the bidbook form, fill it in, sign it, and upload it here as one PDF before the deadline.",
  [APP_STATUS.BIDBOOK]: "Your bidbook was received. You can upload a corrected copy until the deadline; the latest copy is the one evaluated.",
  [APP_STATUS.NOT_SELECTED]: "Thank you for applying. You were not selected to continue in this search.",
  [APP_STATUS.TOP10]: "Congratulations! You were selected as one of the Ten Outstanding Students of Candoni.",
  [APP_STATUS.TOP20]: "Congratulations! You were selected as a TOSCAN Top 20 qualifier.",
  [APP_STATUS.WITHDRAWN]: "This application was withdrawn."
};

export const BIDBOOK_STATUSES = [APP_STATUS.FINALIST, APP_STATUS.BIDBOOK];
export const BIDBOOK_MAX_MB = 25;

/** The fixed questions of the application (from the TOSCAN application Google Form). */
export const CORE_FIELDS = [
  { id: "lastName", label: "Last Name", type: "text", required: true },
  { id: "firstName", label: "First Name", type: "text", required: true },
  { id: "middleName", label: "Middle Name", help: "Put N/A if not applicable", type: "text", required: true },
  { id: "school", label: "School", type: "school", required: true },
  { id: "contact", label: "Contact Number", type: "tel", required: true },
  { id: "email", label: "E-mail Address", type: "email", required: true }
];
export const QUESTION_TYPES = ["text", "textarea", "select", "date", "number"];

export const DEFAULT_APPLICATION_CONFIG = {
  open: false,
  title: "TOSCAN APPLICATION 2027",
  intro: "The Ten Outstanding Students of Candoni (TOSCAN) Awards is the annual program of the Municipal Government of Candoni that recognizes the outstanding students in the Municipality in the fields of Academics, Leadership, and Community Service.\n\nThe applicants will come from Grade 10 High School Students (Public and Private).",
  guidelinesUrl: "",
  contactEmail: "toscan.candoni@gmail.com",
  closesOn: "",
  bidbookTemplateUrl: "https://docs.google.com/document/d/1CWj7P_urfFgJj9ZmyCRW5IwcrcUbtMuw/edit",
  bidbookDeadline: "",
  schools: [],
  questions: []
};

export function mergeApplicationConfig(stored) {
  return { ...DEFAULT_APPLICATION_CONFIG, ...(stored || {}), schools: Array.isArray(stored?.schools) ? stored.schools : [], questions: Array.isArray(stored?.questions) ? stored.questions : [] };
}

/** Applications are accepted when open and (if set) on or before the closing date (Asia/Manila). */
export function applicationsOpen(config, todayYMD) {
  if (!config?.open) return false;
  return !config.closesOn || compareYMD(todayYMD, config.closesOn) <= 0;
}

export function bidbookOpen(status, config, todayYMD) {
  if (!BIDBOOK_STATUSES.includes(status)) return false;
  return !config?.bidbookDeadline || compareYMD(todayYMD, config.bidbookDeadline) <= 0;
}

const s = (v, max) => (v == null ? "" : String(v).trim().slice(0, max));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;
const URL_RE = /^https:\/\/[^\s]+$/;
const QID_RE = /^q_[a-z0-9]{1,20}$/;

/** Validates an admin's form configuration; returns { errors, value }. */
export function cleanApplicationConfig(d = {}) {
  const errors = [];
  const value = {
    open: !!d.open,
    title: s(d.title, 120),
    intro: s(d.intro, 3000),
    guidelinesUrl: s(d.guidelinesUrl, 500),
    contactEmail: s(d.contactEmail, 120),
    closesOn: d.closesOn || "",
    bidbookTemplateUrl: s(d.bidbookTemplateUrl, 500),
    bidbookDeadline: d.bidbookDeadline || "",
    schools: [...new Set((Array.isArray(d.schools) ? d.schools : []).map(x => s(x, 160)).filter(Boolean))].slice(0, 200),
    questions: []
  };
  if (!value.title) errors.push("The form needs a title.");
  if (value.closesOn && !isValidYMD(value.closesOn)) errors.push("Invalid closing date.");
  if (value.bidbookDeadline && !isValidYMD(value.bidbookDeadline)) errors.push("Invalid bidbook deadline.");
  for (const [k, l] of [["guidelinesUrl", "Guidelines link"], ["bidbookTemplateUrl", "Bidbook form link"]]) if (value[k] && !URL_RE.test(value[k])) errors.push(`${l} must start with https://`);
  if (value.contactEmail && !EMAIL_RE.test(value.contactEmail)) errors.push("Invalid contact email.");
  const ids = new Set();
  for (const q of (Array.isArray(d.questions) ? d.questions : []).slice(0, 40)) {
    const label = s(q.label, 200);
    if (!label) continue;
    const id = QID_RE.test(q.id) ? q.id : null;
    if (!id || ids.has(id)) { errors.push(`Question “${label}” has an invalid id.`); continue; }
    ids.add(id);
    const type = QUESTION_TYPES.includes(q.type) ? q.type : "text";
    const options = type === "select" ? (Array.isArray(q.options) ? q.options : []).map(o => s(o, 120)).filter(Boolean).slice(0, 50) : [];
    if (type === "select" && options.length < 2) errors.push(`Question “${label}” needs at least two choices.`);
    value.questions.push({ id, label, help: s(q.help, 300), type, options, required: !!q.required });
  }
  return { errors, value };
}

/** Validates an applicant's answers against the form; returns { errors, value }. */
export const OTHER_SCHOOL = "__other__";

/** The applicant picks a school from the form's own list (Settings → Search applications) or "Other" and types the name. */
export function validateApplication(config, d = {}) {
  const schools = config?.schools || [];
  const errors = [], value = {}, answers = {};
  for (const f of CORE_FIELDS) {
    value[f.id] = s(d[f.id], f.id === "school" ? 200 : 100);
    if (f.required && !value[f.id]) errors.push(`${f.label} is required.`);
  }
  if (value.school === OTHER_SCHOOL || (schools?.length && !schools.includes(value.school))) {
    const other = s(d.schoolOther, 200);
    if (!other) errors.push("Choose your school from the list, or choose “Other” and type its name.");
    value.school = other; value.schoolOther = true;
  }
  if (value.email && !EMAIL_RE.test(value.email)) errors.push("Enter a valid e-mail address.");
  if (value.contact && !PHONE_RE.test(value.contact)) errors.push("Enter a valid contact number.");
  for (const q of config?.questions || []) {
    let v = s(d.answers?.[q.id], q.type === "textarea" ? 3000 : 300);
    if (q.required && !v) { errors.push(`${q.label} is required.`); continue; }
    if (!v) continue;
    if (q.type === "select" && !q.options.includes(v)) errors.push(`Choose one of the options for “${q.label}”.`);
    if (q.type === "date" && !isValidYMD(v)) errors.push(`“${q.label}” must be a date.`);
    if (q.type === "number" && !Number.isFinite(Number(v))) errors.push(`“${q.label}” must be a number.`);
    answers[q.id] = v;
  }
  if (d.consent !== true) errors.push("Please confirm that the information is true and agree to the data privacy notice.");
  value.answers = answers;
  return { errors, value };
}

/** Normalized keys used to refuse a second application by the same person in one search. */
const norm = x => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
export const applicantKeys = v => ({
  nameKey: [v.lastName, v.firstName, v.middleName && !/^n\/?a$/i.test(String(v.middleName).trim()) ? v.middleName : ""].map(norm).join("|"),
  emailKey: norm(v.email),
  contactKey: String(v.contact || "").replace(/\D/g, "").replace(/^63/, "0").replace(/^(?!0)/, "0")
});
export const applicantKey = v => { const k = applicantKeys(v); return `${k.nameKey}|${k.emailKey}`; };

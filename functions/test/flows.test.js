// End-to-end workflow tests: the real Cloud Function handlers running against an
// in-memory Firestore/Auth/Storage (see test/fakes). Run with `npm run test:flows`.
// Security rules are covered separately by tests/rules.test.mjs on the emulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./fakes/firestore.mjs";
import { claims } from "./fakes/auth.mjs";
import { files } from "./fakes/storage.mjs";

process.env.BOOTSTRAP_ADMIN_EMAILS = "toscan.candoni@gmail.com";
const fx = await import("../index.js");
const { runDailyJobs } = await import("../src/handlers/jobs.js");

const tokens = {
  admin: { uid: "u_admin", token: { email: "toscan.candoni@gmail.com", email_verified: true, name: "TOSCAN Office" } },
  maria: { uid: "u_maria", token: { email: "maria@gmail.com", email_verified: true } },
  staff: { uid: "u_staff", token: { email: "staff@gmail.com", email_verified: true } },
  intruder: { uid: "u_bad", token: { email: "bad@gmail.com", email_verified: true } }
};
const call = (name, who, data = {}) => fx[name].run({ auth: who ? tokens[who] : null, data });
const rejects = async (p, re) => { await assert.rejects(p, e => { assert.match(e.message, re); return true; }); };
const get = path => store.get(path);
const all = coll => [...store.entries()].filter(([p]) => p.startsWith(coll + "/") && p.split("/").length === 2).map(([p, d]) => ({ id: p.split("/")[1], ...d }));
let subSeq = 0;
async function upload(who, sid, code, ay, term, { type = "application/pdf", size = 1000 } = {}) {
  const id = `sub${String(++subSeq).padStart(10, "0")}`;
  const fileName = `${code}.pdf`;
  files.set(`documents/${sid}/${id}/${fileName}`, { size, contentType: type });
  return { id, res: call("submitDocument", who, { submissionId: id, requirementCode: code, academicYear: ay, term, fileName }) };
}
const AY = "2026-2027";

test("full program lifecycle", async t => {
  await t.test("bootstrap admin only for the configured verified email", async () => {
    await rejects(call("bootstrapAdmin", "intruder"), /not set up as a bootstrap/);
    await call("bootstrapAdmin", "admin");
    assert.equal(get("users/u_admin").role, "admin");
    assert.deepEqual(claims.get("u_admin"), { role: "admin" });
    assert.ok(get("documentRequirements/SCHOOL_ID"));
    assert.deepEqual(get("allowanceTypes/REG").rates, []); // amounts are never pre-filled
  });

  await t.test("master data", async () => {
    await call("saveMasterData", "admin", { kind: "academicYear", id: AY, data: { terms: { T1: { openingDate: "2026-08-01" }, T2: { openingDate: "2027-01-15" }, T3: { openingDate: "2027-05-01" } } } });
    await call("saveMasterData", "admin", { kind: "academicYear", id: "2025-2026", data: { terms: { T1: { openingDate: "2025-06-01" } } } });
    const cnhs = await call("saveMasterData", "admin", { kind: "school", data: { name: "Candoni National High School", termsPerYear: 2 } });
    const usls = await call("saveMasterData", "admin", { kind: "school", data: { name: "University of St. La Salle", termsPerYear: 3 } });
    t.cnhs = cnhs.id; t.usls = usls.id;
    await call("saveMasterData", "admin", { kind: "allowanceType", id: "REG", data: { ...get("allowanceTypes/REG"), rates: [{ amount: 5000, effectiveFrom: "2024-01-01" }] } });
    await call("saveMasterData", "admin", { kind: "settings", data: { currentAcademicYear: AY } });
    await rejects(call("saveMasterData", "admin", { kind: "settings", data: { termPeriodMap: { T1: "P1", T2: "P1", T3: "" } } }), /P2/);
    await rejects(call("saveMasterData", "staff", { kind: "settings", data: {} }), /not registered|not allowed/);
    assert.ok(all("auditLogs").some(l => l.action === "masterdata.allowanceType"));
  });

  await t.test("legacy migration upgrades in place and copies archived records", async () => {
    store.set("students/TO2-201001", { toscanId: "TO2-201001", surname: "DELA CRUZ", firstName: "MARIA", middleName: "G", batch: "Batch 2", school: "CANDONI NATIONAL HIGH SCHOOL", course: "BSED", schoolYear: "2025-2026", semester: "2nd Semester", award: "Batch 2 — Awardee (Top 1–10)", email: "maria@gmail.com", emailLower: "maria@gmail.com", status: "Active", amount: "5000" });
    store.set("archivedStudents/TO1-100", { toscanId: "TO1-100", surname: "REYES", firstName: "ANA", award: "Batch 1 — Qualifier (Top 11–20)", status: "Graduated", school: "CNHS" });
    const dry = await call("migrateLegacy", "admin", { dryRun: true });
    assert.equal(dry.plan.length, 2);
    assert.equal(get("students/TO2-201001").profileVersion, undefined); // dry run wrote nothing
    await call("migrateLegacy", "admin", { dryRun: false });
    const m = get("students/TO2-201001");
    assert.equal(m.profileVersion, 2);
    assert.equal(m.classification, "top10");
    assert.equal(m.amount, "5000");                         // old field untouched
    assert.equal(m.qualification.schoolAtQualification, "CANDONI NATIONAL HIGH SCHOOL");
    assert.equal(get("students/TO1-100").programStatus, "Ended");
    assert.ok(get("archivedStudents/TO1-100"));              // original kept
  });

  await t.test("registration and approval link the old record", async () => {
    await rejects(call("register", "maria", { surname: "Dela Cruz" }), /First name is required/);
    const r = await call("register", "maria", { surname: "Dela Cruz", firstName: "Maria", dateOfBirth: "2006-03-04", contact: "09171234567", address: "Candoni", school: "CNHS" });
    assert.equal(r.suggestedStudentId, "TO2-201001");
    assert.equal(get("users/u_maria").status, "pending");
    await rejects(call("submitAcademicRecord", "maria", {}), /not approved/);
    await call("register", "staff", { surname: "Santos", firstName: "Jose", contact: "09170000000", accountType: "staff" });
    await rejects(call("decideUser", "staff", { uid: "u_maria", decision: "approve", role: "admin" }), /not approved/);
    await call("decideUser", "admin", { uid: "u_maria", decision: "approve", role: "student", studentLink: { mode: "existing", studentId: "TO2-201001" } });
    await call("decideUser", "admin", { uid: "u_staff", decision: "approve", role: "staff" });
    assert.deepEqual(claims.get("u_maria"), { role: "student", studentId: "TO2-201001" });
    assert.equal(get("students/TO2-201001").uid, "u_maria");
    assert.deepEqual(claims.get("u_staff"), { role: "staff" });
    await rejects(call("updateAccess", "staff", { uid: "u_staff", role: "admin" }), /not allowed/);
    await rejects(call("updateAccess", "admin", { uid: "u_admin", role: "staff" }), /your own access/);
  });

  await t.test("academic history: same school verifies itself; transfer needs staff", async () => {
    const r1 = await call("submitAcademicRecord", "maria", { academicYear: AY, term: "T1", schoolId: t.cnhs, program: "BSED", yearLevel: "2nd Year" });
    assert.equal(r1.status, "Verified");
    const r2 = await call("submitAcademicRecord", "maria", { academicYear: AY, term: "T2", schoolId: t.usls, program: "BSED", yearLevel: "2nd Year" });
    assert.equal(r2.status, "For Verification");
    assert.equal(get("students/TO2-201001").current.school, "CANDONI NATIONAL HIGH SCHOOL"); // not changed until verified
    await rejects(call("submitAcademicRecord", "maria", { academicYear: AY, term: "T3", schoolId: t.cnhs, program: "BSED" }), /only two semesters/);
    await call("verifyAcademicRecord", "staff", { id: r2.id, decision: "verify" });
    assert.equal(get("students/TO2-201001").current.school, "UNIVERSITY OF ST. LA SALLE");
    assert.equal(get(`studentAcademicHistory/${r1.id}`).school, "CANDONI NATIONAL HIGH SCHOOL"); // history kept
  });

  await t.test("document submission, return, correction and locking", async () => {
    const bad = await upload("maria", "TO2-201001", "SCHOOL_ID", AY, "T1", { type: "application/zip" });
    await rejects(bad.res, /Only PDF/);
    assert.equal(files.has(`documents/TO2-201001/${bad.id}/SCHOOL_ID.pdf`), false); // rejected upload discarded
    const big = await upload("maria", "TO2-201001", "SCHOOL_ID", AY, "T1", { size: 16 * 1024 * 1024 });
    await rejects(big.res, /15 MB/);

    const id1 = await upload("maria", "TO2-201001", "SCHOOL_ID", AY, "T1"); await id1.res;
    const dup = await upload("maria", "TO2-201001", "SCHOOL_ID", AY, "T1");
    await rejects(dup.res, /already waiting/);
    const en = await upload("maria", "TO2-201001", "ENROLLMENT", AY, "T1"); await en.res;
    const gr = await upload("maria", "TO2-201001", "GRADES", AY, "T1"); await gr.res;
    assert.equal(get(`eligibility/TO2-201001_${AY}_P1`).status, "For Review");
    assert.equal(get(`eligibility/TO2-201001_${AY}_P1`).docsComplete, false);

    await rejects(call("reviewDocument", "maria", { submissionId: id1.id, action: "approve" }), /not allowed/);
    await rejects(call("reviewDocument", "staff", { submissionId: gr.id, action: "return" }), /reason/);
    await call("reviewDocument", "staff", { submissionId: id1.id, action: "start" });
    await call("reviewDocument", "staff", { submissionId: id1.id, action: "approve" });
    await call("reviewDocument", "staff", { submissionId: en.id, action: "approve" });
    await call("reviewDocument", "staff", { submissionId: gr.id, action: "return", remarks: "Grades are from the wrong semester" });
    assert.equal(get(`eligibility/TO2-201001_${AY}_P1`).status, "Returned for Correction");
    assert.ok(all("notifications").some(n => n.uid === "u_maria" && /returned/.test(n.title)));

    const gr2 = await upload("maria", "TO2-201001", "GRADES", AY, "T1"); await gr2.res;
    assert.equal(get(`submissions/${gr2.id}`).version, 2);
    assert.equal(get(`submissions/${gr2.id}`).previousSubmissionId, gr.id);
    await call("reviewDocument", "staff", { submissionId: gr2.id, action: "approve" });
    assert.equal(get(`submissions/${gr2.id}`).locked, true);
    assert.equal(get(`eligibility/TO2-201001_${AY}_P1`).docsComplete, true);

    const again = await upload("maria", "TO2-201001", "SCHOOL_ID", AY, "T1");
    await rejects(again.res, /approved and locked/);
    await rejects(call("reviewDocument", "staff", { submissionId: id1.id, action: "return", remarks: "x" }), /already Approved/);

    // Controlled supersession: the approved original stays on file
    await call("openSupersession", "admin", { submissionId: id1.id, reason: "ID photo unreadable" });
    const id2 = await upload("maria", "TO2-201001", "SCHOOL_ID", AY, "T1"); await id2.res;
    assert.equal(get(`eligibility/TO2-201001_${AY}_P1`).docsComplete, true); // still complete during correction
    await call("reviewDocument", "staff", { submissionId: id2.id, action: "approve" });
    assert.equal(get(`submissions/${id1.id}`).status, "Superseded");
    assert.equal(get(`submissions/${id1.id}`).supersededBy, id2.id);
    assert.ok(files.has(`documents/TO2-201001/${id1.id}/SCHOOL_ID.pdf`));
    t.ids = { id1: id1.id };
  });

  await t.test("five-month deadline and extensions", async () => {
    const late = await upload("maria", "TO2-201001", "SCHOOL_ID", "2025-2026", "T1");
    await rejects(late.res, /deadline .* has passed/);
    const early = await upload("maria", "TO2-201001", "SCHOOL_ID", AY, "T2");
    await rejects(early.res, /not open yet/);
    await rejects(call("grantExtension", "staff", { studentId: "TO2-201001", academicYear: "2025-2026", term: "T1", deadline: "2026-12-31", reason: "x" }), /not allowed/);
    await call("grantExtension", "admin", { studentId: "TO2-201001", academicYear: "2025-2026", term: "T1", deadline: "2026-12-31", reason: "Hospitalized during the submission period" });
    const ok = await upload("maria", "TO2-201001", "SCHOOL_ID", "2025-2026", "T1");
    await ok.res;
  });

  await t.test("eligibility is a separate decision from document approval", async () => {
    assert.equal(all("allowances").length, 0); // approved documents alone create no payment
    await rejects(call("decideEligibility", "staff", { studentId: "TO2-201001", academicYear: AY, period: "P1", decision: "Not Qualified" }), /reason/);
    await rejects(call("decideEligibility", "staff", { studentId: "TO2-201001", academicYear: AY, period: "P1", decision: "Qualified", allowanceTypes: ["LATIN"] }), /Latin honor/);
    await rejects(call("decideEligibility", "staff", { studentId: "TO2-201001", academicYear: AY, period: "P2", decision: "Qualified", allowanceTypes: ["REG"] }), /Pending Documents/);
    await call("decideEligibility", "staff", { studentId: "TO2-201001", academicYear: AY, period: "P1", decision: "Qualified", allowanceTypes: ["REG"] });
    const ent = get(`allowances/TO2-201001_${AY}_P1_REG`);
    assert.equal(ent.status, "Awaiting Payroll");
    assert.equal(ent.amount, 5000);
    assert.equal(ent.referenceDate, "2026-08-01");
  });

  await t.test("payroll: generate once, review, approve, release", async () => {
    await rejects(call("generatePayroll", "maria", { month: "2026-10" }), /not allowed/);
    const g = await call("generatePayroll", "staff", { month: "2026-10" });
    assert.equal(g.payrollNo, "PR-2026-10-001");
    assert.equal(g.total, 5000);
    const again = await call("generatePayroll", "staff", { month: "2026-10" });
    assert.match(again.skipped, /No qualified/);
    assert.equal(all("payrollItems").length, 1);
    assert.equal(get(`allowances/TO2-201001_${AY}_P1_REG`).status, "Payroll In Progress");
    // the same entitlement can't be qualified again while in payroll
    await rejects(call("decideEligibility", "staff", { studentId: "TO2-201001", academicYear: AY, period: "P1", decision: "Not Qualified", reason: "x" }), /already in a payroll/);

    const P = "PR-2026-10-001";
    await call("payrollAction", "staff", { payrollNo: P, action: "submitReview" });
    await rejects(call("payrollAction", "staff", { payrollNo: P, action: "review" }), /different person/);
    await rejects(call("payrollAction", "admin", { payrollNo: P, action: "approve" }), /reviewed before/);
    await call("payrollAction", "admin", { payrollNo: P, action: "review" });
    await rejects(call("payrollAction", "maria", { payrollNo: P, action: "approve" }), /not allowed/);
    await call("payrollAction", "admin", { payrollNo: P, action: "approve" });
    assert.equal(get(`allowances/TO2-201001_${AY}_P1_REG`).status, "Included in Payroll");
    assert.equal(get(`eligibility/TO2-201001_${AY}_P1`).status, "Included in Payroll");
    await rejects(call("payrollAction", "maria", { payrollNo: P, action: "release", paymentDate: "2026-10-10", paymentRef: "DV-1" }), /not allowed/);
    await rejects(call("payrollAction", "admin", { payrollNo: P, action: "release", paymentDate: "2026-10-10" }), /reference/);
    await rejects(call("payrollAction", "admin", { payrollNo: P, action: "release", paymentDate: "2099-01-01", paymentRef: "DV-1" }), /future/);
    await call("payrollAction", "admin", { payrollNo: P, action: "release", paymentDate: "2026-10-12", paymentRef: "DV-2026-10-0001" });
    const e = get(`allowances/TO2-201001_${AY}_P1_REG`);
    assert.equal(e.status, "Released");
    assert.equal(e.releasedAt, "2026-10-12");
    assert.equal(get(`eligibility/TO2-201001_${AY}_P1`).status, "Released");
    assert.match((await call("generatePayroll", "admin", { month: "2026-11" })).skipped, /No qualified/);
  });

  await t.test("rate changes don't touch paid amounts; history can't be rewritten", async () => {
    const reg = get("allowanceTypes/REG");
    await rejects(call("saveMasterData", "admin", { kind: "allowanceType", id: "REG", data: { ...reg, rates: [{ amount: 9999, effectiveFrom: "2024-01-01" }] } }), /can't be changed/);
    await call("saveMasterData", "admin", { kind: "allowanceType", id: "REG", data: { ...reg, rates: [{ amount: 5000, effectiveFrom: "2024-01-01", effectiveTo: "2026-10-31" }, { amount: 7500, effectiveFrom: "2026-11-01" }] } });
    assert.equal(get(`allowances/TO2-201001_${AY}_P1_REG`).amount, 5000);
    assert.equal(all("payrollItems")[0].amount, 5000);
  });

  await t.test("historical import: validation, duplicates, no double payment", async () => {
    const rows = [
      { "TOSCAN ID": "TO2-201001", "School Year": "2024-2025", Semester: "2nd", Category: "REG", Amount: "5,000", "Release Date": "2025-03-10", Status: "Released", "Payroll Number": "OLD-2025-01" },
      { "TOSCAN ID": "TO2-201001", "School Year": AY, "Allowance Period": "First", Category: "REG", Amount: "5000", "Release Date": "2026-10-12", Status: "Released" },
      { "TOSCAN ID": "NOPE", "School Year": "2024-2025", Semester: "1st", Amount: "5000", "Release Date": "2025-01-01" },
      { "Student Name": "Ana Reyes", "School Year": "2025-2026", Semester: "1st", Amount: "4000", Status: "Unpaid" }
    ];
    await rejects(call("importRecords", "maria", { kind: "historical", rows, dryRun: true }), /not allowed/);
    const dry = await call("importRecords", "admin", { kind: "historical", rows, dryRun: true });
    assert.deepEqual(dry.results.map(r => r.ok), [true, false, false, true]);
    assert.match(dry.results[1].errors[0], /Already recorded as Released/);
    assert.equal(all("historicalPayments").length, 0);
    const run = await call("importRecords", "admin", { kind: "historical", rows, dryRun: false, sourceName: "2024 payroll binder" });
    assert.equal(run.summary.valid, 2);
    assert.equal(get("allowances/TO2-201001_2024-2025_P2_REG").status, "Released");
    assert.equal(get("allowances/TO2-201001_2024-2025_P2_REG").source, "imported");
    const rerun = await call("importRecords", "admin", { kind: "historical", rows: [rows[0]], dryRun: false });
    assert.equal(rerun.summary.valid, 0);
    // The unpaid historical row is queued; the released one never is
    const g = await call("generatePayroll", "admin", { month: "2026-11" });
    assert.equal(g.itemCount, 1);
    assert.equal(g.total, 4000);
    t.unpaidPayroll = g.payrollNo;
  });

  await t.test("voiding a payroll returns its entitlements; removed lines too", async () => {
    await call("payrollAction", "admin", { payrollNo: t.unpaidPayroll, action: "void", reason: "Wrong month" });
    assert.equal(get("allowances/TO1-100_2025-2026_P1_REG").status, "Awaiting Payroll");
    const g = await call("generatePayroll", "admin", { month: "2026-11" });
    assert.equal(g.payrollNo, "PR-2026-11-002");
    const item = all("payrollItems").find(i => i.payrollNo === g.payrollNo);
    await rejects(call("payrollAction", "staff", { payrollNo: g.payrollNo, action: "removeItem", itemId: item.id }), /reason/);
    await call("payrollAction", "staff", { payrollNo: g.payrollNo, action: "removeItem", itemId: item.id, reason: "Duplicate of check already issued" });
    assert.equal(get(`payrolls/${g.payrollNo}`).itemCount, 0);
    assert.equal(get("allowances/TO1-100_2025-2026_P1_REG").status, "Awaiting Payroll");
  });

  await t.test("student import", async () => {
    const rows = [
      { Surname: "Lopez", "First Name": "Ben", "Date of Birth": "2007-01-01", Classification: "Top 20", Batch: "Batch 8", "School at Qualification": "CNHS" },
      { Surname: "Dela Cruz", "First Name": "Maria", "Middle Name": "G", "TOSCAN ID": "TO2-201001" },
      { Surname: "Lopez", "First Name": "Ben", "Date of Birth": "2007-01-01" }
    ];
    await rejects(call("importRecords", "staff", { kind: "students", rows, dryRun: true }), /Only administrators/);
    const dry = await call("importRecords", "admin", { kind: "students", rows, dryRun: true });
    assert.deepEqual(dry.results.map(r => r.ok), [true, false, false]);
    const run = await call("importRecords", "admin", { kind: "students", rows: [rows[0]], dryRun: false });
    assert.match(run.results[0].studentId, /^TSC-\d{4}-0001$/);
  });

  await t.test("profile changes needing verification", async () => {
    const r = await call("updateMyProfile", "maria", { contact: "09998887777", atmNumber: "1234-5678-90" });
    assert.deepEqual(r.pending, ["atmNumber"]);
    assert.equal(get("students/TO2-201001").contact, "09998887777");
    assert.notEqual(get("students/TO2-201001").atmNumber, "1234-5678-90");
    await call("verifyProfileChange", "staff", { studentId: "TO2-201001", field: "atmNumber", decision: "approve" });
    assert.equal(get("students/TO2-201001").atmNumber, "1234-5678-90");
    await rejects(call("updateMyProfile", "maria", { photoPath: "photos/u_other/x.jpg" }), /Invalid photo/);
  });

  await t.test("Latin honor allowance is paid at the rate of the student's honor level", async () => {
    const latin = get("allowanceTypes/LATIN");
    await rejects(call("saveMasterData", "admin", { kind: "allowanceType", id: "REG", data: { ...get("allowanceTypes/REG"), rates: [...get("allowanceTypes/REG").rates, { level: "Cum Laude", amount: 1, effectiveFrom: "2030-01-01" }] } }), /Only a Latin honor/);
    await call("saveMasterData", "admin", { kind: "allowanceType", id: "LATIN", data: { ...latin, rates: [
      { level: "Summa Cum Laude", amount: 15000, effectiveFrom: "2024-01-01" },
      { level: "Magna Cum Laude", amount: 10000, effectiveFrom: "2024-01-01" },
      { level: "Cum Laude", amount: 7000, effectiveFrom: "2024-01-01" }] } });
    await rejects(call("saveMasterData", "admin", { kind: "allowanceType", id: "LATIN", data: { ...get("allowanceTypes/LATIN"), appliesTo: "all" } }), /can't be changed/);
    store.set("students/TO2-201001", { ...get("students/TO2-201001"), latinHonor: "Magna Cum Laude" });
    store.set(`eligibility/TO2-201001_${AY}_P2`, { studentId: "TO2-201001", academicYear: AY, period: "P2", status: "For Review", docsComplete: true, terms: [{ term: "T2", state: "complete" }] });
    for (const code of ["SCHOOL_ID", "ENROLLMENT", "GRADES"]) store.set(`submissions/p2${code}`, { studentId: "TO2-201001", requirementCode: code, academicYear: AY, term: "T2", status: "Approved", version: 1 });
    await call("decideEligibility", "staff", { studentId: "TO2-201001", academicYear: AY, period: "P2", decision: "Qualified", allowanceTypes: ["LATIN"] });
    const ent = get(`allowances/TO2-201001_${AY}_P2_LATIN`);
    assert.equal(ent.amount, 10000);
    assert.equal(ent.honorLevel, "Magna Cum Laude");
    assert.equal(ent.typeName, "Latin Honor Allowance — Magna Cum Laude");
  });

  await t.test("ending the program blocks new periods but keeps history", async () => {
    await rejects(call("setProgramStatus", "admin", { studentId: "TO2-201001", status: "Ended", effectiveDate: "2027-01-10" }), /reason/);
    await call("setProgramStatus", "admin", { studentId: "TO2-201001", status: "Ended", effectiveDate: "2027-01-10", reason: "Graduated", remarks: "BSED 2027" });
    assert.equal(get("students/TO2-201001").programStatus, "Ended");
    assert.equal(all("programStatusHistory").length, 1);
    assert.equal(get(`allowances/TO2-201001_${AY}_P1_REG`).status, "Released");
    // simulate complete documents for P2 and try to qualify
    store.set(`eligibility/TO2-201001_${AY}_P2`, { studentId: "TO2-201001", academicYear: AY, period: "P2", status: "For Review", docsComplete: true, terms: [{ term: "T2", state: "complete" }] });
    for (const code of ["SCHOOL_ID", "ENROLLMENT", "GRADES"]) store.set(`submissions/p2${code}`, { studentId: "TO2-201001", requirementCode: code, academicYear: AY, term: "T2", status: "Approved", version: 1 });
    await rejects(call("decideEligibility", "staff", { studentId: "TO2-201001", academicYear: AY, period: "P2", decision: "Qualified", allowanceTypes: ["REG"] }), /program ended/);
  });

  await t.test("daily job: automatic payroll once per month, staff digest", async () => {
    await call("saveMasterData", "admin", { kind: "settings", data: { payroll: { autoGenerate: true, dayOfMonth: 15, signatories: {} } } });
    const day = new Date("2026-12-15T00:00:00Z"); // 08:00 Manila on the 15th
    const r1 = await runDailyJobs(day);
    assert.ok(r1.payroll.payrollNo, JSON.stringify(r1.payroll));
    assert.equal(get(`payrolls/${r1.payroll.payrollNo}`).status, "Generated");
    const r2 = await runDailyJobs(day);
    assert.match(r2.payroll.skipped, /already exists/);
    assert.ok(r1.digests >= 1);
  });

  await t.test("search applications: apply without signing in, finalist uploads bidbook", async () => {
    const form = { lastName: "Santos", firstName: "Ana", middleName: "N/A", school: "CANDONI NATIONAL HIGH SCHOOL", contact: "09171234567", email: "ana@gmail.com", consent: true };
    await rejects(call("submitApplication", null, form), /not being accepted/);
    await rejects(call("saveMasterData", "staff", { kind: "applicationForm", data: { title: "X" } }), /not allowed|authorized/);
    await rejects(call("saveMasterData", "admin", { kind: "applicationForm", data: { title: "T", questions: [{ id: "q_gwa", label: "GWA", type: "select", options: ["A"] }] } }), /two choices/);
    await call("saveMasterData", "admin", { kind: "applicationForm", data: { open: true, title: "TOSCAN APPLICATION 2099", closesOn: "2099-12-31", bidbookDeadline: "2099-12-31", questions: [{ id: "q_gwa", label: "Grade 9 general average", type: "number", required: true }] } });
    await rejects(call("submitApplication", null, { ...form, answers: {} }), /Grade 9 general average is required/);
    await rejects(call("submitApplication", null, { ...form, consent: false, answers: { q_gwa: "95" } }), /confirm/);
    await rejects(call("submitApplication", null, { ...form, school: "Some School Not In Master", answers: { q_gwa: "95.4" } }), /Choose your school/);
    const other = await call("submitApplication", null, { ...form, firstName: "Ben", email: "ben@gmail.com", school: "__other__", schoolOther: "St. Joseph Academy", answers: { q_gwa: "90" } });
    assert.equal(get(`searchApplications/${other.ref}`).school, "St. Joseph Academy");
    assert.equal(get(`searchApplications/${other.ref}`).schoolOther, true);
    const r = await call("submitApplication", null, { ...form, answers: { q_gwa: "95.4" } });
    assert.match(r.ref, /^TS2099-0002$/);
    assert.match(r.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const doc = get(`searchApplications/${r.ref}`);
    assert.equal(doc.status, "Submitted"); assert.equal(doc.answers.q_gwa, "95.4"); assert.equal(doc.codeHash.length, 64);
    assert.equal(JSON.stringify(doc).includes(r.code), false); // the code itself is never stored
    await rejects(call("submitApplication", null, { ...form, email: "ANA@gmail.com ", answers: { q_gwa: "90" } }), /already received/);

    const st = await call("applicationStatus", null, { ref: r.ref, code: r.code.toLowerCase().replace("-", "") });
    assert.equal(st.status, "Submitted"); assert.equal(st.bidbookOpen, false);
    for (let i = 0; i < 8; i++) await rejects(call("applicationStatus", null, { ref: r.ref, code: "WRONG-CODE" + i }), /not correct/);
    await rejects(call("applicationStatus", null, { ref: r.ref, code: r.code }), /Too many/);
    store.set(`searchApplications/${r.ref}`, { ...get(`searchApplications/${r.ref}`), lockedUntil: null });

    // not a finalist yet: no bidbook
    const anon = { uid: "anon_1", token: { firebase: { sign_in_provider: "anonymous" } } };
    const path = `searchApplications/${r.ref}/anon_1/bidbook.pdf`;
    files.set(path, { size: 2_000_000, contentType: "application/pdf" });
    await assert.rejects(fx.submitBidbook.run({ auth: anon, data: { ref: r.ref, code: r.code, path } }), /only from Top 20 finalists/);

    await rejects(call("reviewApplication", "maria", { ref: r.ref, action: "status", status: "Top 20 Finalist" }), /not allowed/);
    await rejects(call("reviewApplication", "admin", { ref: r.ref, action: "status", status: "Top 10 Awardee" }), /can't be changed/);
    await call("reviewApplication", "admin", { ref: r.ref, action: "status", status: "Top 20 Finalist", message: "Bring the original copy on interview day." });
    assert.equal((await call("applicationStatus", null, { ref: r.ref, code: r.code })).bidbookOpen, true);

    await assert.rejects(fx.submitBidbook.run({ auth: anon, data: { ref: r.ref, code: r.code, path: `searchApplications/${r.ref}/someone_else/bidbook.pdf` } }), /Invalid file/);
    files.set(`searchApplications/${r.ref}/anon_1/big.pdf`, { size: 30 * 1024 * 1024, contentType: "application/pdf" });
    await assert.rejects(fx.submitBidbook.run({ auth: anon, data: { ref: r.ref, code: r.code, path: `searchApplications/${r.ref}/anon_1/big.pdf` } }), /larger than 25 MB/);
    const after = await fx.submitBidbook.run({ auth: anon, data: { ref: r.ref, code: r.code, path, fileName: "Santos bidbook.pdf" } });
    assert.equal(after.status, "Bidbook Submitted");
    assert.equal(get(`searchApplications/${r.ref}`).bidbookHistory.length, 1);

    await rejects(call("reviewApplication", "admin", { ref: r.ref, action: "status", status: "Not Selected" }), /remarks/);
    await call("reviewApplication", "admin", { ref: r.ref, action: "status", status: "Top 10 Awardee", remarks: "Final deliberation" });
    const reset = await call("reviewApplication", "admin", { ref: r.ref, action: "resetCode" });
    await rejects(call("applicationStatus", null, { ref: r.ref, code: r.code }), /not correct/);
    assert.equal((await call("applicationStatus", null, { ref: r.ref, code: reset.code })).status, "Top 10 Awardee");
    // an anonymous sign-in can't register a portal account
    await assert.rejects(fx.register.run({ auth: anon, data: {} }), /no email/);
  });

  await t.test("every privileged action left an audit entry", async () => {
    const actions = new Set(all("auditLogs").map(l => l.action));
    for (const a of ["admin.bootstrap", "user.approve", "document.approve", "document.return", "document.supersessionOpened", "eligibility.decide", "payroll.generate", "payroll.approve", "payroll.release", "payroll.void", "import.historical", "student.programStatus", "deadline.extension", "migration.legacy", "application.submit", "application.bidbook", "application.status", "application.resetCode"]) {
      assert.ok(actions.has(a), `missing audit for ${a}`);
    }
  });
});

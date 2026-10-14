import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classificationFromAward, mapLegacyStudent, validateHistoricalRow, validateStudentImportRow,
  normalizeDate, normalizeTerm, nameKey, validateRegistration
} from "../src/core/records.js";

test("old-portal award text maps to classification", () => {
  assert.equal(classificationFromAward("Batch 2 — Awardee (Top 1–10)"), "top10");
  assert.equal(classificationFromAward("Batch 5 — Qualifier (Top 11–20)"), "top20");
  assert.equal(classificationFromAward(""), "");
});

test("legacy mapping keeps the qualification school and ends archived records", () => {
  const m = mapLegacyStudent("TO2-201001", { surname: "dela cruz", firstName: "maria", school: "cnhs", course: "bsed", schoolYear: "2025-2026", semester: "1st Semester", award: "Batch 2 — Awardee (Top 1–10)", status: "Graduated" });
  assert.equal(m.qualification.schoolAtQualification, "CNHS");
  assert.equal(m.current.term, "T1");
  assert.equal(m.classification, "top10");
  assert.equal(m.programStatus, "Ended");
});

test("dates from spreadsheets", () => {
  assert.equal(normalizeDate("2025-01-15"), "2025-01-15");
  assert.equal(normalizeDate("01/15/2025"), "2025-01-15");
  assert.equal(normalizeDate("3/1/26"), "2026-03-01");
  assert.equal(normalizeDate("45672"), "2025-01-15"); // Excel serial
  assert.equal(normalizeDate("15/01/2025"), null);
  assert.equal(normalizeDate(""), "");
  assert.equal(normalizeTerm("2nd Semester"), "T2");
  assert.equal(normalizeTerm("summer"), "T3");
});

test("name keys ignore order and punctuation", () => {
  assert.equal(nameKey("DELA CRUZ, MARIA G."), nameKey("Maria G Dela Cruz"));
});

test("historical rows: student lookup, period from semester, required release date", () => {
  const ctx = {
    students: new Map([["TO2-1", {}]]), byName: new Map([[nameKey("Dela Cruz, Maria"), ["TO2-1"]]]),
    types: new Map([["REG", {}]]), termPeriodMap: { T1: "P1", T2: "P2", T3: "P2" }
  };
  const ok = validateHistoricalRow({ "Student Name": "Maria Dela Cruz", "School Year": "2024-2025", Semester: "3rd", Amount: "₱5,000.00", "Release Date": "03/10/2025", Status: "Released" }, ctx);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.studentId, "TO2-1");
  assert.equal(ok.value.period, "P2");
  assert.equal(ok.value.amount, 5000);
  const bad = validateHistoricalRow({ "TOSCAN ID": "XX", "School Year": "2024", Amount: "abc", Status: "Released" }, ctx);
  assert.ok(bad.errors.some(e => /Unknown TOSCAN ID/.test(e)));
  assert.ok(bad.errors.some(e => /School year/.test(e)));
  assert.ok(bad.errors.some(e => /Amount/.test(e)));
  assert.ok(bad.errors.some(e => /release date/.test(e)));
});

test("student import rows", () => {
  const r = validateStudentImportRow({ Surname: "Reyes", "First Name": "Ana", Classification: "Top 20", "Date of Birth": "2006-04-02", Email: "ANA@X.COM" });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.classification, "top20");
  assert.equal(r.value.email, "ana@x.com");
  assert.ok(validateStudentImportRow({ Surname: "X", "First Name": "Y", Classification: "Top 5" }).errors.length);
});

test("registration validation", () => {
  assert.ok(validateRegistration({ surname: "A1", firstName: "", contact: "x", accountType: "student" }).errors.length >= 3);
  const ok = validateRegistration({ surname: "dela cruz", firstName: "maría", dateOfBirth: "2006-01-02", contact: "0917 123 4567", address: "candoni", school: "cnhs" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.surname, "DELA CRUZ");
});

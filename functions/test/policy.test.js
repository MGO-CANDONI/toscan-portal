import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonthsYMD, manilaStart, manilaEnd, manilaToday, isValidYMD, isValidAY } from "../src/core/dates.js";
import {
  submissionWindow, windowState, resolveOpeningDate, periodForTerm, termsForPeriod, validateTermPeriodMap,
  rateOn, validateRates, rateHistoryPreserved, validateTypeCombination, termDocState, deriveEligibility,
  programActiveOn, checkPayrollAction, entitlementId, typeActiveOn, ELIG, PAYROLL
} from "../src/core/policy.js";

test("months are added on the calendar and clamp to month end", () => {
  assert.equal(addMonthsYMD("2026-08-01", 5), "2027-01-01");
  assert.equal(addMonthsYMD("2026-08-31", 1), "2026-09-30");
  assert.equal(addMonthsYMD("2027-09-30", 5), "2028-02-29"); // leap year
  assert.equal(addMonthsYMD("2026-10-31", 4), "2027-02-28");
});

test("Manila day boundaries are UTC+8", () => {
  assert.equal(manilaStart("2027-01-01").toISOString(), "2026-12-31T16:00:00.000Z");
  assert.equal(manilaEnd("2027-01-01").toISOString(), "2027-01-01T15:59:59.999Z");
  assert.equal(manilaToday(new Date("2026-12-31T16:30:00Z")), "2027-01-01");
  assert.equal(manilaToday(new Date("2026-12-31T15:59:00Z")), "2026-12-31");
});

test("date and academic year validation", () => {
  assert.ok(isValidYMD("2028-02-29"));
  assert.ok(!isValidYMD("2027-02-29"));
  assert.ok(!isValidYMD("2027-13-01"));
  assert.ok(isValidAY("2026-2027"));
  assert.ok(!isValidAY("2026-2028"));
});

test("within-5-months window: Aug 1 opening closes end of Jan 1 Manila", () => {
  const w = submissionWindow({ openingDate: "2026-08-01", months: 5 });
  assert.equal(w.deadlineDate, "2027-01-01");
  assert.equal(windowState(w, new Date("2026-07-31T15:59:59Z")), "not-yet");      // Jul 31 23:59 Manila
  assert.equal(windowState(w, new Date("2026-07-31T16:00:00Z")), "open");         // Aug 1 00:00 Manila
  assert.equal(windowState(w, new Date("2027-01-01T15:59:59Z")), "open");         // Jan 1 23:59:59 Manila
  assert.equal(windowState(w, new Date("2027-01-01T16:00:01Z")), "closed");       // Jan 2 Manila
});

test("start-of-day cutoff closes at the first moment of the deadline date", () => {
  const w = submissionWindow({ openingDate: "2026-08-01", months: 5, cutoff: "start-of-day" });
  assert.equal(windowState(w, new Date("2026-12-31T16:00:01Z")), "closed");
});

test("after-5-months policy opens later and has no automatic close", () => {
  const w = submissionWindow({ openingDate: "2026-08-01", months: 5, policy: "after" });
  assert.equal(windowState(w, new Date("2026-12-01T00:00:00Z")), "not-yet");
  assert.equal(windowState(w, new Date("2026-12-31T16:00:00Z")), "open");
  assert.equal(windowState(w, new Date("2030-01-01T00:00:00Z")), "open");
});

test("extensions only move the deadline later", () => {
  const later = submissionWindow({ openingDate: "2026-08-01", months: 5, extensionDeadline: "2027-01-20" });
  assert.equal(later.deadlineDate, "2027-01-20");
  assert.equal(windowState(later, new Date("2027-01-15T00:00:00Z")), "open");
  const earlier = submissionWindow({ openingDate: "2026-08-01", months: 5, extensionDeadline: "2026-12-01" });
  assert.equal(earlier.deadlineDate, "2027-01-01");
});

test("no calendar means no window", () => {
  assert.equal(windowState(submissionWindow({ openingDate: "" })), "no-calendar");
});

test("opening date: student override, then school calendar, then academic-year default", () => {
  const ay = { terms: { T1: { openingDate: "2026-08-10" } } };
  const school = { calendars: { "2026-2027": { T1: "2026-08-03" } } };
  assert.equal(resolveOpeningDate({ record: { openingDate: "2026-09-01" }, school, academicYear: ay, ay: "2026-2027", term: "T1" }), "2026-09-01");
  assert.equal(resolveOpeningDate({ record: {}, school, academicYear: ay, ay: "2026-2027", term: "T1" }), "2026-08-03");
  assert.equal(resolveOpeningDate({ record: null, school: null, academicYear: ay, ay: "2026-2027", term: "T1" }), "2026-08-10");
  assert.equal(resolveOpeningDate({ record: null, school: null, academicYear: ay, ay: "2026-2027", term: "T2" }), null);
});

test("third term maps to the second allowance and never creates a third period", () => {
  const map = { T1: "P1", T2: "P2", T3: "P2" };
  assert.equal(periodForTerm(map, "T3"), "P2");
  assert.deepEqual(termsForPeriod(map, "P2"), ["T2", "T3"]);
  assert.equal(entitlementId("TO2-1", "2026-2027", periodForTerm(map, "T2"), "REG"), entitlementId("TO2-1", "2026-2027", periodForTerm(map, "T3"), "REG"));
  assert.match(validateTermPeriodMap({ T1: "P1", T2: "P1", T3: "" }), /P2/);
  assert.match(validateTermPeriodMap({ T1: "P1", T2: "P2", T3: "P3" }), /T3/);
  assert.equal(validateTermPeriodMap({ T1: "P1", T2: "P2", T3: "" }), null);
});

test("allowance rates are dated and history is protected", () => {
  const type = { active: true, rates: [{ amount: 5000, effectiveFrom: "2024-01-01", effectiveTo: "2026-06-30" }, { amount: 7500, effectiveFrom: "2026-07-01" }] };
  assert.equal(rateOn(type, "2025-08-01").amount, 5000);
  assert.equal(rateOn(type, "2026-08-01").amount, 7500);
  assert.equal(rateOn(type, "2023-08-01"), null);
  assert.equal(validateRates(type.rates), null);
  assert.match(validateRates([{ amount: 1, effectiveFrom: "2024-01-01" }, { amount: 2, effectiveFrom: "2025-01-01" }]), /overlap/);
  assert.match(rateHistoryPreserved(type.rates, [{ amount: 9999, effectiveFrom: "2024-01-01", effectiveTo: "2026-06-30" }, type.rates[1]]), /can't be changed/);
  assert.match(rateHistoryPreserved(type.rates, [type.rates[1]]), /can't be removed/);
  assert.equal(rateHistoryPreserved([{ amount: 1, effectiveFrom: "2024-01-01" }], [{ amount: 1, effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" }, { amount: 2, effectiveFrom: "2025-01-01" }]), null);
  assert.ok(!typeActiveOn({ active: true, endDate: "2025-12-31" }, "2026-01-01"));
});

test("regular and Latin honor allowances combine only when both allow it", () => {
  const reg = { code: "REG", name: "Regular", combinableWith: [] }, lat = { code: "LATIN", name: "Latin", combinableWith: [] };
  assert.ok(validateTypeCombination([reg, lat]));
  assert.equal(validateTypeCombination([{ ...reg, combinableWith: ["LATIN"] }, { ...lat, combinableWith: ["REG"] }]), null);
});

const reqs = [
  { code: "SCHOOL_ID", active: true, terms: ["T1", "T2", "T3"] },
  { code: "ENROLLMENT", active: true },
  { code: "GRADES", active: true, terms: ["T2"] },
  { code: "OLD", active: false }
];

test("document state per term", () => {
  assert.equal(termDocState(reqs, [], "T1").state, "pending");
  const t1 = [{ requirementCode: "SCHOOL_ID", status: "Approved", version: 1 }, { requirementCode: "ENROLLMENT", status: "Approved", version: 1 }];
  assert.equal(termDocState(reqs, t1, "T1").state, "complete");
  assert.equal(termDocState(reqs, t1, "T2").state, "pending"); // grades also required in T2
  const returned = [...t1, { requirementCode: "GRADES", status: "Returned", version: 1 }];
  assert.equal(termDocState(reqs, returned, "T2").state, "returned");
  const corrected = [...returned, { requirementCode: "GRADES", status: "Submitted", version: 2 }];
  assert.equal(termDocState(reqs, corrected, "T2").state, "in-review");
  // An approved document stays valid while its correction (supersession) is reviewed
  const superseding = [...t1, { requirementCode: "SCHOOL_ID", status: "Submitted", version: 2 }];
  assert.equal(termDocState(reqs, superseding, "T1").state, "complete");
});

test("eligibility never overrides a staff decision", () => {
  assert.equal(deriveEligibility(undefined, []).status, ELIG.PENDING);
  assert.deepEqual(deriveEligibility(ELIG.PENDING, [{ state: "complete" }]), { status: ELIG.REVIEW, docsComplete: true });
  assert.equal(deriveEligibility(undefined, [{ state: "returned" }, { state: "pending" }]).status, ELIG.RETURNED);
  assert.equal(deriveEligibility(ELIG.NOT_QUALIFIED, [{ state: "complete" }]).status, ELIG.NOT_QUALIFIED);
  assert.equal(deriveEligibility(ELIG.RELEASED, []).status, ELIG.RELEASED);
  // A 3-term school: T2 incomplete but T3 complete still qualifies the second period for review
  assert.equal(deriveEligibility(undefined, [{ state: "pending" }, { state: "complete" }]).docsComplete, true);
});

test("ended program only blocks periods starting on or after the effective date", () => {
  const s = { programStatus: "Ended", programEnded: { effectiveDate: "2027-01-15" } };
  assert.ok(programActiveOn(s, "2026-08-01"));
  assert.ok(!programActiveOn(s, "2027-01-15"));
  assert.ok(programActiveOn({ programStatus: "Active" }, "2030-01-01"));
});

test("payroll workflow guards", () => {
  const staff = { uid: "s1", role: "staff", permissions: ["preparePayroll"] };
  const approver = { uid: "a1", role: "staff", permissions: ["approvePayroll"] };
  const admin = { uid: "ad", role: "admin" };
  const p = st => ({ status: st, itemCount: 3, preparedBy: { uid: "s1" }, reviewedBy: null });
  assert.equal(checkPayrollAction(p(PAYROLL.GENERATED), "submitReview", staff), null);
  assert.match(checkPayrollAction(p(PAYROLL.REVIEW), "review", staff), /different person/);
  assert.match(checkPayrollAction(p(PAYROLL.REVIEW), "approve", staff), /not authorized/);
  assert.match(checkPayrollAction(p(PAYROLL.REVIEW), "approve", approver), /reviewed before/);
  assert.equal(checkPayrollAction({ ...p(PAYROLL.REVIEW), reviewedBy: { uid: "x" } }, "approve", approver), null);
  assert.match(checkPayrollAction(p(PAYROLL.APPROVED), "release", staff), /not authorized/);
  assert.match(checkPayrollAction(p(PAYROLL.APPROVED), "release", admin, {}), /payment date/);
  assert.match(checkPayrollAction(p(PAYROLL.APPROVED), "release", admin, { paymentDate: "2026-10-20" }, "2026-10-14"), /future/);
  assert.match(checkPayrollAction(p(PAYROLL.APPROVED), "release", admin, { paymentDate: "2026-10-10" }), /reference/);
  assert.equal(checkPayrollAction(p(PAYROLL.APPROVED), "release", admin, { paymentDate: "2026-10-10", paymentRef: "DV-1" }, "2026-10-14"), null);
  assert.match(checkPayrollAction(p(PAYROLL.RELEASED), "void", admin, { reason: "x" }), /can't be changed/);
  assert.match(checkPayrollAction(p(PAYROLL.GENERATED), "release", admin, { paymentDate: "2026-10-10", paymentRef: "x" }), /can't be changed/);
});

test("Latin honor rates per level", () => {
  const t = { appliesTo: "latinHonor", rates: [
    { level: "Summa Cum Laude", amount: 15000, effectiveFrom: "2024-01-01" },
    { level: "Magna Cum Laude", amount: 10000, effectiveFrom: "2024-01-01", effectiveTo: "2025-12-31" },
    { level: "Magna Cum Laude", amount: 12000, effectiveFrom: "2026-01-01" },
    { level: "Cum Laude", amount: 8000, effectiveFrom: "2024-01-01" }] };
  assert.equal(rateOn(t, "2026-08-01", "Summa Cum Laude").amount, 15000);
  assert.equal(rateOn(t, "2025-08-01", "Magna Cum Laude").amount, 10000);
  assert.equal(rateOn(t, "2026-08-01", "Magna Cum Laude").amount, 12000);
  assert.equal(rateOn(t, "2026-08-01", "Cum Laude").amount, 8000);
  assert.equal(rateOn(t, "2026-08-01", ""), null);
  assert.equal(validateRates(t.rates, { levels: true }), null); // same dates in different levels don't overlap
  assert.match(validateRates([{ level: "Cum Laude", amount: 1, effectiveFrom: "2024-01-01" }, { level: "Cum Laude", amount: 2, effectiveFrom: "2025-01-01" }], { levels: true }), /overlap \(Cum Laude\)/);
  assert.match(validateRates([{ level: "Summa", amount: 1, effectiveFrom: "2024-01-01" }], { levels: true }), /Summa Cum Laude/);
  assert.match(validateRates([{ level: "Cum Laude", amount: 1, effectiveFrom: "2024-01-01" }]), /Only a Latin honor/);
  assert.match(rateHistoryPreserved(t.rates, t.rates.filter(r => r.level !== "Cum Laude")), /\(Cum Laude\).*can't be removed/);
});

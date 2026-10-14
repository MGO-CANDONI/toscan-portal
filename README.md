# TOSCAN Portal

Ten Outstanding Students of Candoni — student records, document compliance, allowance eligibility and payroll for the Municipal Government of Candoni, Negros Occidental.

**Excellence. Leadership. Service.**

## Architecture

| Part | Where | What it does |
| --- | --- | --- |
| Website | `public/` (Netlify, no build step) | One sign-in (Google or email). Student, staff and administrator dashboards. Reads data; writes only file uploads and "mark notification read". |
| Cloud Functions | `functions/` (Firebase, `asia-southeast1`) | Every change: registration and approval, roles, documents, deadlines, eligibility, payroll, imports, settings, audit log, notifications, the daily scheduled job. |
| Security rules | `firestore.rules`, `storage.rules` | Students read only their own records; browsers can't write program, document or payroll data; files can't be overwritten or deleted. |
| Shared policy code | `functions/src/core/` → copied to `public/js/core/` | Deadlines (Asia/Manila), term → allowance-period mapping, statuses — identical on server and website. |

Roles are Firebase custom claims (`student` with a `studentId`, `staff`, `admin`) set only by the functions. Staff have individual permissions (review documents, verify records, decide eligibility, prepare payroll, approve payroll, record release, encode history, view reports).

## Main workflows

1. **Registration** → admin approves, links the TOSCAN record, sets classification (Top 10 / Top 20) and access.
2. **Enrollment record per term** → a change of school, level or program waits for staff verification; earlier terms are kept.
3. **Documents** (school ID, proof of enrollment, previous grades — configurable) → Submitted → Under Review → Approved (locked permanently) or Returned with remarks → corrected version linked to the previous one. Approved documents can only be replaced through an administrator-opened correction; the original stays on file as *Superseded*.
4. **Deadline**: by default within 5 months of the term opening (configurable: months, within/after, cutoff, per-school calendars, per-student opening date, approved extensions).
5. **Eligibility** per allowance period (two per year; a third term maps to the second period) → staff decide Qualified / Not Qualified. Qualifying creates an **entitlement** whose ID is `student + year + period + allowance type`, so it can exist only once.
6. **Payroll**: a draft is generated automatically each month (and on demand) from entitlements awaiting payroll → submitted → reviewed by a different person → approved → released with the actual payment date and reference.
7. **Historical records**: manual entry or CSV/Excel import with preview and duplicate detection; released history is never paid again.
8. **Reports** with Excel/CSV export and print-to-PDF; totals are computed from payroll lines.

## Collections

`users`, `students` (old records upgraded in place), `studentAcademicHistory`, `documentRequirements`, `submissions`, `deadlineExtensions`, `eligibility`, `allowanceTypes`, `allowances` (entitlements), `payrolls`, `payrollItems`, `historicalPayments`, `programStatusHistory`, `academicYears`, `schools`, `settings`, `notifications`, `auditLogs`, `imports`, `mail`, `counters`. Old-portal collections are kept read-only.

## Tests

```bash
cd functions && npm install && npm test   # policy unit tests + full workflow tests of the functions
cd tests && npm install && npm test       # security rules on the Firebase emulators (needs Java)
```

## Deploying

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Assessment and migration plan: [docs/ASSESSMENT.md](docs/ASSESSMENT.md). What changed: [docs/RELEASE-NOTES.md](docs/RELEASE-NOTES.md).

The previous single-file app is kept unpublished in `legacy/index.html` for reference.

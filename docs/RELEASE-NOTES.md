# Release notes — TOSCAN Portal 2.0 (October 2026)

Delivered as one release covering phases 1–7 of the enhancement requirements.

## Files changed

| Path | Change |
| --- | --- |
| `public/index.html` | Replaced: small shell that loads the modular app |
| `public/assets/` | New: `app.css` (black / charcoal / muted gold design), seal images |
| `public/js/` | New: `main.js` (sign-in, roles, routing), `fb.js`, `state.js`, `ui.js`, `core/` (shared policy code), `views/` (auth, student, staff, students, payroll, reports, imports, admin, common) |
| `functions/` | New: Cloud Functions (`index.js`, `src/handlers/*`, `src/core/*`), `.env` (bootstrap admin), tests |
| `firestore.rules`, `storage.rules` | Rewritten around custom claims; browsers read, the server writes |
| `firestore.indexes.json` | Notifications and review-queue indexes |
| `firebase.json` | Adds functions and emulator configuration |
| `storage-cors.json` | New: lets signed-in browsers open private files |
| `netlify.toml` | No-cache for scripts and styles; permissions policy |
| `tests/` | New: security-rules tests for the Firebase emulators |
| `scripts/sync-core.mjs` | New: copies shared policy code to the website |
| `docs/` | New: assessment and migration plan, deployment guide, these notes |
| `README.md` | Rewritten |

## Database changes

- **New collections:** `studentAcademicHistory`, `documentRequirements`, `deadlineExtensions`, `eligibility`, `allowanceTypes`, `payrolls`, `payrollItems`, `historicalPayments`, `programStatusHistory`, `academicYears`, `schools`, `notifications`, `auditLogs`, `imports`, `counters`.
- **`students`**: kept and upgraded in place by the previewed migration. New structured fields (`qualification`, `current`, `classification`, `programStatus`…) are added beside the old ones; old values are never overwritten.
- **`users`, `submissions`, `allowances`, `settings`**: restructured. Only test data from the October redesign existed; it can be deleted from the console after go-live.
- **Old-portal collections** (`archivedStudents`, `applications`, `sync_*`, …) and old Storage folders: untouched, read-only.

## Security changes

- Roles in **custom claims**, set only by Cloud Functions; the first administrator is claimed through a server setting, not client code.
- Browsers can't write program, document, eligibility, allowance, payroll, settings, audit or mail records — including administrators. All changes go through validated, audited functions.
- Students read only records carrying their own `studentId`.
- Uploads only into the student's own folder, PDF/JPG/PNG/WEBP up to 15 MB; **no overwrite or delete for anyone**.
- No public download links: files open through the signed-in SDK.
- The `mail` queue is server-only with fixed templates (closes the spam hole).
- Payroll: transactional generation keyed by entitlement (no double payment), separation of duties (preparer ≠ reviewer; approve and release are separate permissions), release requires actual date and reference.

## Features completed

- One sign-in (Google or email) with registration, approval, linking to old records, Top 10 / Top 20 classification and roles (student, staff with granular permissions, administrator).
- Student dashboard: profile and photo, classification, program status, current academic info, compliance per term with countdown, allowance timeline per period, ledger (including history), notifications, returned-document remarks.
- Staff: overview, directory with search and export, full student record (profile, academic history, documents, eligibility and ledger, program status), review queue with document viewer (Previous/Next, download, history), verifications (transfers, identity and ATM changes), eligibility decisions, payroll, historical records, reports.
- Administrator: registrations, users and permissions, settings and master data (academic years and term openings, schools with own calendars and 2/3 terms, document requirements, allowance types with dated rates, lists, deadline policy, term → period mapping, payroll day and signatories, notifications, login photo), data migration and bulk student import, audit trail.
- Documents: configurable requirements, five-state workflow, permanent locking on approval, linked corrected versions, controlled supersession, five-month deadline (configurable, Asia/Manila) with per-school calendars, per-student opening dates and extensions.
- Allowances: Regular and Latin Honor types (more can be added), dated rates that never change past amounts, combination rules, maximum periods, two periods per year with third-term mapping.
- Payroll: automatic monthly draft (06:00 Manila on the configured day), manual generation, review → approve → release → archive, void and remove-line with return to queue, printable payroll with signatories, Excel and CSV export.
- Historical import (manual, CSV, Excel) with preview, validation and duplicate detection.
- Reports: student lists and counts, compliance by term (including overdue), eligibility, monthly payroll register, allowance summary (by period, year, batch, student, category), released, pending, historical register, total expenditure.
- Notifications in the app (and email when enabled): registration, document received/returned/approved, deadline reminders and overdue notices, eligibility result, payroll inclusion and release; daily work-queue digest for staff.

## Testing done

| Test | Result |
| --- | --- |
| Policy unit tests (deadlines, Manila time, term mapping, rates, eligibility, payroll guards, imports) | Pass |
| Workflow tests of every Cloud Function on an in-memory database (registration → documents → eligibility → payroll → release; duplicates; deadlines; extensions; supersession; voiding; imports; program end; daily job; audit) | Pass |
| Browser end-to-end run of all screens against the real functions on a simulated Firebase (admin, two staff, student; desktop and phone) | Pass, no console errors |
| Security rules on the Firebase emulators (`tests/`) | **Written but not yet run.** The emulator could not be downloaded in the development environment. Run it before go-live (DEPLOYMENT.md §8). |

## Update — October 15, 2026

- **TOSCAN search applications.** The sign-in page shows the current search. Grade 10 students apply without an account (Last Name, First Name, Middle Name, School, Contact Number, E-mail Address, plus any questions the administrator adds) and receive a reference number and a one-time access code. Staff with the new *Review TOSCAN search applications* permission screen applications under **TOSCAN Search → Applications**, mark **Top 20 finalists**, and record results (Top 10 Awardee / Top 20 Qualifier / Not Selected). Finalists use the reference number and access code to download the bidbook form and upload the signed bidbook as one PDF (up to 25 MB) before the deadline. Every step is audited; codes are stored only as hashes; repeated wrong codes lock the lookup for 15 minutes.
- **Latin Honor levels.** The Latin Honor allowance has a separate dated rate for Summa Cum Laude, Magna Cum Laude and Cum Laude. The amount follows the level on the student's record; the payroll line shows the level.
- **Design.** New summary tiles; the Reports menu no longer overlaps; settings tabs wrap; buttons that are links no longer show underlines.
- **Security rules.** Anonymous sign-ins count as signed out for portal data. New: `searchApplications` (staff read only), `publicConfig` (public read), bidbook uploads limited to the uploader's own folder, PDF only, no overwrite or delete.

## Update — October 15, 2026 (afternoon)

- **Design refresh.** One typeface (Inter) across the whole portal, true gold accents on white, light top bar and sidebar, quieter key figures instead of tiles. The staff **Home** page now greets the user and lists only what needs attention (registrations, documents, verifications, eligibility, payrolls, applications), with a short "At a glance" and "Upcoming" panel.
- **Staff access.** Staff now have every function except the Administration pages (registrations, users, settings and master data, data import, audit trail). The per-person permission checkboxes are gone. Payroll separation of duties still applies: the person who prepares a payroll can't review it, and approval and release are separate steps.
- **Application form.** The school is chosen from the schools in master data (Settings → Schools), with an "Other — not listed" option; applications from unlisted schools are flagged for staff.
- **Security rules.** `schools` is readable without signing in (names only; needed by the public form). Run `tests/` to confirm.

## Outstanding items

1. Run the security-rules tests and a pilot with real accounts on the deployed project before announcing the portal.
2. App Check is documented but not switched on (needs a reCAPTCHA Enterprise key).
3. PDF output uses the browser's **Print → Save as PDF**; no server-generated PDF files.
4. A released payroll can't be voided; corrections after release need a manual adjusting entry (historical record).
5. A disabled account can keep working for up to one hour until its sign-in token expires.
6. A program status set to *Ended* with a future effective date shows as Ended immediately, although payments for periods before that date stay allowed.
7. Upload an approved photo of the Municipal Hall or a program activity for the sign-in page.
8. Backups: switch on scheduled Firestore backups (DEPLOYMENT.md §9).

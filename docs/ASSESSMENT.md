# TOSCAN Portal: system assessment and migration plan (Phase 1)

Assessed: 14 October 2026, against `main` @ `370e7e8` ("npppatch1").

## 1. What exists today

| Part | State |
| --- | --- |
| `public/index.html` | The single-file app from the October redesign: one sign-in (Google or email), admin approval with role and Top 10/Top 20 group, student dashboard (uploads, file status, one allowance per semester, photo), staff file review, admin payroll print. |
| `legacy/index.html` | The original portal (three login tabs). Not published. Kept as reference for its data shapes. |
| `firestore.rules` / `storage.rules` | Written for the redesign. Admin role comes from a hard-coded Google email plus a `users` document. |
| Cloud Functions | None. Every write is made by the browser. |
| Firebase plan | Blaze (confirmed), so Cloud Functions and scheduled jobs are available. |
| Netlify | Publishes `public/`, no build step. |

### Firestore collections in production

| Collection | Written by | Contents | Plan |
| --- | --- | --- | --- |
| `students/{TOSCAN ID}` | Old portal | Student records: names, batch, school, course, SY, semester, ATM, email, `award` ("Batch N — Awardee/Qualifier…"), `latinHonor`, `status`, `amount`, `driveFileUrl` | **Kept and upgraded in place** as the student master record (new fields added; old fields untouched) |
| `archivedStudents/{TOSCAN ID}` | Old portal | Archived students (same shape) | Copied into `students` with program status **Ended**; originals left in place |
| `applications`, `sync_*`, `logins`, `attachmentUpdates`, `latinHonorUpdates`, `top20Submissions`, `mail` | Old portal | Applications, access requests, logs | Left untouched; admin read-only |
| `users`, `submissions`, `allowances`, `settings` | Redesign | Test data only (not in real use) | Restructured (see §4) |

Storage paths from the old portal (`students/**`, `latinHonor/**`, `top20Submissions/**`, `archives/**`, `backups/**`) stay where they are and become staff/admin read-only.

## 2. Security gaps found

| # | Gap | Risk | Fix in this release |
| --- | --- | --- | --- |
| 1 | Admins have a rules-level "write anything" grant | Any admin browser session can silently change payroll, delete records or files | Clients write almost nothing directly; every change goes through Cloud Functions that validate and log it |
| 2 | Admin identity hard-coded as an email in rules and in the page | Provisioning depends on code edits; no revocation | Roles held in **custom claims** set by functions; first admin claimed once via a server-side bootstrap setting |
| 3 | Students can delete their unreviewed uploads; admin can delete any file | Evidence can disappear | Storage deletes are denied for everyone; uploads can't overwrite |
| 4 | Files opened through permanent download-token links | A copied link opens a private ID or grade report without signing in | No token links are stored. Files open through the signed-in SDK (`getBlob`) and the rules check every read |
| 5 | Any signed-in user can add to the `mail` queue | The queue can be abused to send arbitrary emails from the office account | Clients can't write `mail`; only functions queue emails, using fixed templates |
| 6 | Payroll amounts and statuses written from the browser | Duplicate or altered payments | Payroll is generated in **transactions** keyed by entitlement; approval and release are function-only, with role and permission checks |
| 7 | No audit trail | No accountability for sensitive changes | `auditLogs` written server-side for every privileged action (actor, time, action, record, before/after) |
| 8 | Old public registration rules | Removed in the redesign; confirmed still closed | — |

## 3. Requirements vs. current system

Everything in sections 1–17 of the requirements is new except: single sign-in, admin approval, Top 10/Top 20 assignment, photo upload, basic file status, and payroll printing.

## 4. New data model

All program records are keyed by **studentId** (the TOSCAN ID for existing students, or a generated `TSC-YYYY-NNNN`). This keeps old records valid and lets the office import students who don't have a login yet.

| Collection | Key | Purpose |
| --- | --- | --- |
| `users/{uid}` | Firebase uid | Login account: role, status, permissions, linked `studentId` |
| `students/{studentId}` | TOSCAN ID | Master profile: identity, qualification (locked), current academic info, classification, program status |
| `studentAcademicHistory/{studentId}_{AY}_{term}` | deterministic | One enrollment record per academic term; never overwritten by a later term |
| `documentRequirements/{code}` | code | Configurable required documents |
| `submissions/{id}` | auto | One document version: file, term, status, review history, link to the previous version |
| `deadlineExtensions/{studentId}_{AY}_{term}` | deterministic | Approved deadline extensions with reason |
| `eligibility/{studentId}_{AY}_{period}` | deterministic | Eligibility per allowance period |
| `allowanceTypes/{code}` | code | Allowance categories with dated rate history |
| `allowances/{studentId}_{AY}_{period}_{type}` | deterministic | **Entitlements.** The ID makes a second payment for the same student, type, year and period impossible |
| `payrolls/{payrollNo}` / `payrollItems/{payrollNo}_{entitlementId}` | numbered | Payroll headers and lines |
| `historicalPayments/{id}` | auto | Imported past payments, also recorded as Released entitlements |
| `programStatusHistory/{id}` | auto | Active ↔ Ended changes |
| `academicYears`, `schools`, `settings` | — | Calendars, term openings per school, policies |
| `notifications/{id}` | auto | In-app notifications |
| `auditLogs/{id}` | auto | Accountability log |

`submissionVersions` from the suggested structure is implemented as a chain inside `submissions` (`version`, `previousSubmissionId`, `supersededBy`), so every version keeps its own file and review history without a second collection to keep in sync.

## 5. Migration plan

1. Deploy rules, indexes and functions, then publish the site.
2. The first admin claims admin rights once (server-side bootstrap).
3. Admin → **Data Migration → Preview legacy migration** (dry run), then **Run**:
   - each `students/{id}` gets the new structured fields beside its old ones (`profileVersion: 2`);
   - each `archivedStudents/{id}` is copied to `students` with status Ended (original kept);
   - classification is read from the old `award` text (Awardee → Top 10, Qualifier → Top 20);
   - the old `amount` field is **not** converted to a payment, because it has no release date or reference. Past payments are entered through **Historical Import**.
4. When a returning student signs in and registers with the same email, the admin links the account to the existing record during approval.
5. The test data from the redesign (`users`, `submissions`, `allowances`) is not used by the new code and can be deleted from the console after go-live.

Nothing in this plan deletes a production record or file.

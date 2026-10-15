# TOSCAN Portal — clear TEST data before go-live (PowerShell).
#
# Run from the repository folder:  .\scripts\reset-test-data.ps1
#
# DELETES: students, user accounts other than administrators, submissions, academic records,
#          eligibility, allowances, payrolls, historical payments, extensions, program status history,
#          notifications, audit trail, search applications, queued emails, counters, import logs,
#          and the uploaded files (documents, bidbooks, photos).
# KEEPS:   settings, academic years, schools, document requirements, allowance types & rates,
#          the public application form (publicConfig), the old-portal collections, administrator accounts.
#
# This cannot be undone. Make sure no real data has been entered yet.

$project = "mgo-toscan"
$bucket  = "gs://mgo-toscan.firebasestorage.app"

Write-Host ""
Write-Host "This permanently deletes all test data in Firebase project '$project'." -ForegroundColor Yellow
$answer = Read-Host "Type DELETE to continue"
if ($answer -ne "DELETE") { Write-Host "Cancelled."; exit }

$collections = @(
  "students", "submissions", "studentAcademicHistory", "eligibility", "allowances",
  "payrolls", "payrollItems", "historicalPayments", "deadlineExtensions", "programStatusHistory",
  "notifications", "auditLogs", "searchApplications", "mail", "counters", "imports"
)

foreach ($c in $collections) {
  Write-Host "Deleting collection $c ..." -ForegroundColor Cyan
  firebase firestore:delete $c --recursive --force --project $project
}

# User accounts: keep administrators, delete everyone else (students and staff created during testing).
Write-Host "Deleting non-administrator user accounts ..." -ForegroundColor Cyan
$users = gcloud firestore documents list users --project $project --format="value(name)" 2>$null
if (-not $users) {
  Write-Host "  (Could not list users with gcloud; delete student/staff documents under 'users' in the Firebase console.)" -ForegroundColor Yellow
} else {
  foreach ($u in $users) {
    $uid = $u.Split("/")[-1]
    $role = gcloud firestore documents describe "users/$uid" --project $project --format="value(fields.role.stringValue)" 2>$null
    if ($role -ne "admin") {
      Write-Host "  users/$uid ($role)"
      firebase firestore:delete "users/$uid" --force --project $project | Out-Null
    } else {
      Write-Host "  users/$uid (admin) kept"
    }
  }
}

# Uploaded files
Write-Host "Deleting uploaded test files ..." -ForegroundColor Cyan
foreach ($folder in @("documents", "searchApplications", "photos", "historical")) {
  gcloud storage rm -r "$bucket/$folder/**" --project $project 2>$null
}

Write-Host ""
Write-Host "Done. Next, in the Firebase console:" -ForegroundColor Green
Write-Host "  1. Authentication -> Users: delete the test sign-ins (students, staff, applicants' anonymous uploads)."
Write-Host "  2. Sign in to the portal as administrator; it should show no students, payrolls or applications."

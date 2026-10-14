# Deploying the TOSCAN Portal

This release adds Cloud Functions and new security rules. **Deploy the backend first, then push the website.** The old data is not changed by deploying; the migration is a separate, previewed step inside the portal.

Allow about an hour the first time.

## 0. What you need on the computer you deploy from

| Tool | Why | Install |
| --- | --- | --- |
| Node.js 20 | Cloud Functions and tests | <https://nodejs.org> (LTS 20) |
| Firebase CLI | Deploy rules, indexes, functions | `npm install -g firebase-tools` then `firebase login` |
| Google Cloud CLI (`gcloud`) | One-time Storage CORS setting | <https://cloud.google.com/sdk/docs/install> |
| Java 11+ | Only for running the security-rules tests | <https://adoptium.net> |

The Firebase project must be on the **Blaze** plan (it is).

## 1. Get the code

In GitHub Desktop: **Fetch origin → Pull origin**, then open a terminal in the `toscan-portal` folder (**Repository → Open in Command Prompt**).

## 2. Set the first administrator

Open `functions/.env` and check the address:

```
BOOTSTRAP_ADMIN_EMAILS=toscan.candoni@gmail.com
```

Only a **verified Google account** listed here can press **Claim administrator access**. It is a server setting, not part of the website. More administrators are added later from **Users & Permissions**.

## 3. Firebase console settings (one time)

<https://console.firebase.google.com> → **mgo-toscan**:

1. **Authentication → Sign-in method** → enable **Google** and **Email/Password**.
2. **Authentication → Settings → Authorized domains** → add the Netlify address (e.g. `toscan-candoni.netlify.app`) and any custom domain.
3. *(Optional, for email notifications)* **Extensions → Trigger Email from Firestore**, collection `mail`. Then tick “Also send notifications by email” in **Settings & Master Data**.

## 4. Deploy the backend

From the repository folder:

```bash
cd functions
npm install
npm test                 # all checks must pass
cd ..
firebase deploy --only firestore:rules,firestore:indexes,storage,functions
```

- The first functions deploy asks to enable Cloud Functions, Cloud Build, Artifact Registry and Cloud Scheduler APIs: answer **yes**.
- The `dailyJobs` function creates a Cloud Scheduler job (06:00 Asia/Manila) automatically.
- Functions run in `asia-southeast1` (Singapore).

## 5. Allow the browser to open private files (Storage CORS)

Files are opened through the signed-in SDK, never through public links, so the bucket needs a CORS rule (sign-in is still required for every file):

```bash
gcloud storage buckets update gs://mgo-toscan.firebasestorage.app --cors-file=storage-cors.json
```

(or with `gsutil cors set storage-cors.json gs://mgo-toscan.firebasestorage.app`)

## 6. Publish the website

Commit and **Push origin** in GitHub Desktop. Netlify publishes `public/` automatically.

## 7. First sign-in and setup checklist

1. Open the site → **Continue with Google** with the bootstrap account → **Claim administrator access**.
2. **Settings & Master Data**:
   - **Academic years**: add the year(s) and the default opening date of each term.
   - **General & policies**: set the current academic year; confirm the deadline policy (*within 5 months*, end of day) and the term → allowance mapping (3rd term → Second Allowance).
   - **Schools**: add schools; mark trimester schools as 3 terms; add school calendars that differ from the defaults.
   - **Allowance types & rates**: enter the rate and effective date for **Regular** and **Latin Honor** (no amount is pre-filled).
   - **Payroll & signatories**: names, positions, auto-generation day.
   - **Login page photo**: upload an approved photo of the Municipal Hall or a program activity.
3. **Data Import & Migration → Preview migration**, check the list, then **Run migration**.
4. Encode or import past payments under **Historical Records** before the first payroll, so nothing already paid is paid again.
5. Ask staff and students to register; approve them under **Registrations**.

## 8. Run the security-rules tests (recommended before go-live)

```bash
cd tests
npm install
npm test
```

This starts the Firestore and Storage emulators and checks that students can only read their own records, that nobody can write payroll or documents from a browser, and that files can't be overwritten or deleted.

## 9. Backups

Turn on daily Firestore backups once (keeps 7 days):

```bash
gcloud firestore backups schedules create --database="(default)" --recurrence=daily --retention=7d
```

To restore, see <https://firebase.google.com/docs/firestore/backups>. Uploaded files are never deleted by the portal.

## 10. Optional hardening: App Check

App Check blocks requests that don't come from the real website.

1. Firebase console → **App Check** → register the web app with **reCAPTCHA Enterprise** and copy the site key.
2. In `public/js/fb.js`, after `initializeApp`, add:
   ```js
   import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
   initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider("YOUR_SITE_KEY"), isTokenAutoRefreshEnabled: true });
   ```
3. Watch the App Check metrics for a week, then **Enforce** for Firestore, Storage and Functions.

## Updating later

- Website only (`public/`): push; Netlify redeploys.
- Rules or functions: `firebase deploy --only firestore:rules,storage,functions`.
- If you edit `functions/src/core/dates.js` or `policy.js`, run `node scripts/sync-core.mjs` so the website uses the same code (a test fails if they differ).

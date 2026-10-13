# TOSCAN Portal

Ten Outstanding Students & Payroll System — Municipality of Candoni.

A static web app (`public/index.html`) that uses **Firebase** (Authentication, Firestore, Cloud Storage),
is kept on **GitHub**, and is deployed by **Netlify**.

```
toscan-portal/
├── public/index.html      ← the app (Firebase config for project "mgo-toscan" is built in)
├── firestore.rules        ← database security rules
├── storage.rules          ← file-upload security rules
├── firebase.json / .firebaserc / firestore.indexes.json
├── netlify.toml           ← Netlify publishes the "public" folder, no build step
└── legacy/index.html      ← the previous version of the portal (not published, kept for reference)
```

## How it works

1. **One sign-in page** for everyone: *Sign in with Google*, or email and password.
2. A new person fills in their details and waits. Their record is **pending**.
3. The **Admin** opens **Approvals**, chooses the access level (**Student**, **Staff** or **Admin**) and the group
   (**Top 10 — Awardee** or **Top 20 — Qualifier**), then approves. The person is emailed.
4. Each student has **their own dashboard**: upload files, see each file's status
   (Submitted → Under Review → Approved / Returned, with remarks), see their allowance per semester
   (Processing / Released), and change their profile picture.
5. **Staff** can view all users and review files. **Admins** can also approve users, set allowances,
   print the payroll and change settings.

| Firestore collection | What it holds |
| --- | --- |
| `users/{uid}` | One record per person: details, picture, `status`, `role`, `group` |
| `submissions` | Uploaded files with `status`, `remarks`, reviewer |
| `allowances/{uid}__{SY}__{semester}` | One amount per student per semester, `Processing` or `Released` |
| `settings/app` | Current term, upload window, batches, payroll signatories, office email |
| `mail` | Outgoing emails (sent by the *Trigger Email from Firestore* extension) |
| `students` | Records from the old portal — read-only, used to pre-fill a returning student's form |

## One-time Firebase setup

In <https://console.firebase.google.com> → project **mgo-toscan**:

1. **Authentication → Sign-in method**: enable **Google** and **Email/Password**.
2. **Authentication → Settings → Authorized domains**: add the Netlify domain
   (for example `toscan-candoni.netlify.app`) and any custom domain.
3. **Firestore** and **Storage** must exist (they already do if the old portal was used).
4. *(For emails)* **Extensions → Trigger Email from Firestore**, collection `mail`.
5. Deploy the security rules — **required**, the app depends on them:

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules,storage
   ```

   On the first deploy, accept the prompt that lets Storage rules read Firestore.

### The first Admin

`toscan.candoni@gmail.com` becomes Admin automatically the first time it signs in with
**Sign in with Google**. It must be Google sign-in, because the rules only trust a verified email.
From there, make other people Admin or Staff in **Approvals** or **Users**.

To use a different Admin Google account, change the email in **three places**:
`ADMIN_EMAILS` in `public/index.html`, and `bootstrapAdmin()` in both `firestore.rules` and `storage.rules`.

## Deploying changes

Netlify redeploys automatically on every push to `main`:

```bash
git add .
git commit -m "Describe the change"
git push
```

## Moving from the old portal

- Old records stay in Firestore (`students`, `applications`, …) and are not deleted.
- Students register again with the same email; the form is pre-filled from their old record.
  The Admin then approves them and assigns Top 10 / Top 20.
- Uploaded files from the old portal remain in Storage and can be opened from the Firebase console.

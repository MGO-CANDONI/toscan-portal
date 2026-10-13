# TOSCAN Portal

Ten Outstanding Students & Payroll System — Municipality of Candoni.

Static web app (isa lang ka `public/index.html`) nga naga-gamit sang **Firebase**
(Firestore + Cloud Storage + Authentication) bilang database, ginatago sa **GitHub**,
kag ginadeploy sa **Netlify**.

```
toscan-portal/
├── public/
│   └── index.html          ← ang app (may built-in na Firebase config sang "mgo-toscan")
├── firestore.rules         ← security rules sang database
├── storage.rules           ← security rules sang file uploads
├── firebase.json           ← para sa Firebase CLI
├── .firebaserc             ← project: mgo-toscan
├── firestore.indexes.json
├── netlify.toml            ← Netlify: i-publish ang "public" folder, wala build
└── .gitignore
```

---

## 1. Firebase setup (isa ka beses lang)

Sa <https://console.firebase.google.com> → project **mgo-toscan**:

1. **Firestore Database** → Create database (Production mode, region `asia-southeast1`).
2. **Storage** → Get started. *(Ang bag-o nga projects nagakinahanglan sang Blaze plan para sa Storage.)*
3. **Authentication** → Sign-in method → i-enable ang **Email/Password**.
4. **Authentication → Users → Add user**: `toscan.candoni@gmail.com` + password sang Admin.
   Amo ini ang gamiton sang Admin sa pag-login (username `admin`, password = ang ginbutang mo diri).
5. **Authentication → Settings → Authorized domains** → idugang ang Netlify domain mo
   (halimbawa `toscan-candoni.netlify.app`).
6. *(Para makapadala sang email)* **Extensions** → i-install ang **Trigger Email from Firestore**,
   collection: `mail`. Kon wala ini, ang emails ma-queue lang sa `mail` collection.

### I-deploy ang security rules

Kinahanglan ini antes mag-live — kon wala, bisan sin-o pwede makabasa/makasulat sang records.

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,storage
```

> Kon lain ang email sang Admin, ilisan ang `toscan.candoni@gmail.com` sa
> `firestore.rules`, `storage.rules`, **kag** sa `TOSCAN_STAFF_EMAIL` sa `public/index.html`.

---

## 2. I-push sa GitHub

Maghimo anay sang bag-o nga repository sa <https://github.com/new>
(halimbawa `toscan-portal`, **Private**, wala README). Dayon sa folder sini:

```bash
git init
git add .
git commit -m "TOSCAN Portal with Firebase backend and Netlify config"
git branch -M main
git remote add origin https://github.com/<USERNAME-MO>/toscan-portal.git
git push -u origin main
```

Sa masunod nga pagbag-o:

```bash
git add .
git commit -m "Describe the change"
git push
```

---

## 3. I-deploy sa Netlify

1. <https://app.netlify.com> → **Add new site → Import an existing project → GitHub**.
2. Pilia ang `toscan-portal` repo.
3. Build settings — ginabasa na halin sa `netlify.toml`, gani pabay-i lang:
   - Build command: *(blangko)*
   - Publish directory: `public`
4. **Deploy**. Pagkatapos, ang site mo ara sa `https://<pangalan>.netlify.app`.
5. *(Optional)* Site configuration → Change site name, ukon idugang ang custom domain.

Kada `git push` sa `main`, ang Netlify kusa nga mag-redeploy.

---

## 4. Paano nagaobra ang database connection

- Ang Firebase config ara na sa `public/index.html` (`TOSCAN_FIREBASE_CONFIG`), gani
  **tanan nga device kusa nga naka-connect** — wala na kinahanglan i-paste sa Settings.
- Ang **CloudSync** layer naga-mirror sang applications, confirmations (sign-in approvals)
  kag shared settings (deadlines, open/closed windows) sa Firestore, para makita
  sang Admin ang ginsubmit halin sa iban nga phones/computers.
- Ang mga estudyante kag applicants naga-download lang sang **ila kaugalingon** nga records
  pagkatapos mag-sign in (ginapatuman sang security rules).
- Ang passwords **wala gid** ginatago sa Firestore — ang Firebase Authentication lang ang may hawid.

### Una nga paggamit sang Admin

1. Login bilang `admin` (password = ang sa Firebase Auth user sa step 1.4).
2. Settings → Backend & Database → **Test Firebase Connection**.
3. Kon may records na sa sini nga computer halin sang una: **Upload All Local Data to Firestore**.

### Mga dapat mahibal-an

- Ang mga estudyante nga gin-register sang **Admin** (indi self-registration) wala pa
  Firebase Auth account. Himui sila sa Authentication → Users, ukon ipa-register sila mismo.
- Ang `mail` kag `applications` collections bukas para sa public nga *create* (kinahanglan
  sang registration/application forms nga wala pa naka-login). Bantayi ang usage sa
  Firebase console; pwede magdugang sang **App Check** kon may abuso.

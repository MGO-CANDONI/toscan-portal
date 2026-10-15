// Security-rules tests. Needs Java 11+ and the Firebase emulators:
//   cd tests && npm install && npm test
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, addDoc } from "firebase/firestore";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";

let env;
const u = (uid, claims = {}) => env.authenticatedContext(uid, { email: `${uid}@x.com`, email_verified: true, ...claims });
const maria = () => u("maria", { role: "student", studentId: "S1" });
const ben = () => u("ben", { role: "student", studentId: "S2" });
const staff = () => u("staff", { role: "staff" });
const admin = () => u("admin", { role: "admin" });
const pending = () => u("newbie");
const anon = () => env.unauthenticatedContext();
const anonSignIn = (uid = "anon1") => env.authenticatedContext(uid, { firebase: { sign_in_provider: "anonymous" } });
const pdf = new Uint8Array([37, 80, 68, 70]);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-toscan",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
    storage: { rules: readFileSync("../storage.rules", "utf8"), host: "127.0.0.1", port: 9199 }
  });
  await env.withSecurityRulesDisabled(async c => {
    const d = c.firestore();
    await setDoc(doc(d, "users/maria"), { uid: "maria", role: "student", studentId: "S1" });
    await setDoc(doc(d, "students/S1"), { studentId: "S1", uid: "maria" });
    await setDoc(doc(d, "students/S2"), { studentId: "S2", uid: "ben" });
    for (const c2 of ["submissions", "allowances", "eligibility", "payrollItems", "studentAcademicHistory", "historicalPayments"]) {
      await setDoc(doc(d, `${c2}/m1`), { studentId: "S1", status: "Approved", amount: 5000 });
      await setDoc(doc(d, `${c2}/b1`), { studentId: "S2", status: "Approved", amount: 5000 });
    }
    await setDoc(doc(d, "payrolls/PR-2026-10-001"), { status: "Approved", total: 5000 });
    await setDoc(doc(d, "auditLogs/a1"), { action: "x" });
    await setDoc(doc(d, "settings/app"), { currentAcademicYear: "2026-2027" });
    await setDoc(doc(d, "notifications/n1"), { uid: "maria", read: false, title: "Hi" });
    await setDoc(doc(d, "notifications/n2"), { uid: "ben", read: false, title: "Hi" });
    await setDoc(doc(d, "archivedStudents/old"), { surname: "OLD" });
    await setDoc(doc(d, "searchApplications/TS2027-0001"), { lastName: "SANTOS", status: "Submitted" });
    await setDoc(doc(d, "publicConfig/application"), { open: true, title: "TOSCAN 2027" });
    const s = c.storage();
    await uploadBytes(ref(s, "documents/S1/abcdefghij12/id.pdf"), pdf, { contentType: "application/pdf" });
  });
});
after(async () => { await env?.cleanup(); });

test("students read only their own records", async () => {
  const d = maria().firestore();
  await assertSucceeds(getDoc(doc(d, "students/S1")));
  await assertFails(getDoc(doc(d, "students/S2")));
  for (const c of ["submissions", "allowances", "eligibility", "payrollItems", "studentAcademicHistory", "historicalPayments"]) {
    await assertSucceeds(getDocs(query(collection(d, c), where("studentId", "==", "S1"))));
    await assertFails(getDocs(query(collection(d, c), where("studentId", "==", "S2"))));
    await assertFails(getDocs(collection(d, c)));
    await assertFails(getDoc(doc(d, `${c}/b1`)));
  }
  await assertFails(getDoc(doc(d, "payrolls/PR-2026-10-001")));
  await assertFails(getDocs(collection(d, "users")));
});

test("nobody writes program, document or payroll records from a browser", async () => {
  for (const ctx of [maria(), staff(), admin()]) {
    const d = ctx.firestore();
    await assertFails(updateDoc(doc(d, "allowances/m1"), { amount: 99999 }));
    await assertFails(updateDoc(doc(d, "payrolls/PR-2026-10-001"), { status: "Released" }));
    await assertFails(updateDoc(doc(d, "submissions/m1"), { status: "Approved" }));
    await assertFails(deleteDoc(doc(d, "submissions/m1")));
    await assertFails(setDoc(doc(d, "students/S9"), { studentId: "S9" }));
    await assertFails(setDoc(doc(d, "settings/app"), { x: 1 }, { merge: true }));
    await assertFails(addDoc(collection(d, "auditLogs"), { action: "fake" }));
    await assertFails(addDoc(collection(d, "mail"), { to: "anyone@x.com", message: { subject: "spam" } }));
    await assertFails(updateDoc(doc(d, "users/maria"), { role: "admin" }));
  }
});

test("staff read everything operational; only admins read the audit log", async () => {
  const d = staff().firestore();
  await assertSucceeds(getDocs(collection(d, "submissions")));
  await assertSucceeds(getDocs(collection(d, "payrolls")));
  await assertSucceeds(getDocs(collection(d, "users")));
  await assertFails(getDocs(collection(d, "auditLogs")));
  await assertFails(getDocs(collection(d, "archivedStudents")));
  await assertSucceeds(getDocs(collection(admin().firestore(), "auditLogs")));
  await assertSucceeds(getDocs(collection(admin().firestore(), "archivedStudents")));
});

test("pending and signed-out users", async () => {
  await assertSucceeds(getDoc(doc(pending().firestore(), "settings/app")));
  await assertFails(getDoc(doc(pending().firestore(), "students/S1")));
  await assertFails(getDoc(doc(anon().firestore(), "settings/app")));
});

test("notifications: own only, and only the read flag", async () => {
  const d = maria().firestore();
  await assertSucceeds(getDocs(query(collection(d, "notifications"), where("uid", "==", "maria"))));
  await assertFails(getDoc(doc(d, "notifications/n2")));
  await assertSucceeds(updateDoc(doc(d, "notifications/n1"), { read: true, readAt: "2026-10-14" }));
  await assertFails(updateDoc(doc(d, "notifications/n1"), { title: "changed" }));
  await assertFails(updateDoc(doc(d, "notifications/n2"), { read: true }));
});

test("document files: upload only into your own folder, never overwrite or delete", async () => {
  const s = maria().storage();
  await assertSucceeds(uploadBytes(ref(s, "documents/S1/zzzzzzzzzz01/grades.pdf"), pdf, { contentType: "application/pdf" }));
  await assertFails(uploadBytes(ref(s, "documents/S1/abcdefghij12/id.pdf"), pdf, { contentType: "application/pdf" }));  // overwrite
  await assertFails(uploadBytes(ref(s, "documents/S2/zzzzzzzzzz02/x.pdf"), pdf, { contentType: "application/pdf" }));    // other student
  await assertFails(uploadBytes(ref(s, "documents/S1/zzzzzzzzzz03/x.exe"), pdf, { contentType: "application/x-msdownload" }));
  await assertFails(uploadBytes(ref(s, "documents/S1/zzzzzzzzzz04/big.pdf"), new Uint8Array(16 * 1024 * 1024), { contentType: "application/pdf" }));
  await assertFails(deleteObject(ref(s, "documents/S1/abcdefghij12/id.pdf")));
  await assertFails(deleteObject(ref(admin().storage(), "documents/S1/abcdefghij12/id.pdf")));
  await assertSucceeds(getBytes(ref(s, "documents/S1/abcdefghij12/id.pdf")));
  await assertFails(getBytes(ref(ben().storage(), "documents/S1/abcdefghij12/id.pdf")));
  await assertSucceeds(getBytes(ref(staff().storage(), "documents/S1/abcdefghij12/id.pdf")));
  await assertFails(uploadBytes(ref(pending().storage(), "documents/S1/zzzzzzzzzz05/x.pdf"), pdf, { contentType: "application/pdf" }));
});

test("photos", async () => {
  await assertSucceeds(uploadBytes(ref(maria().storage(), "photos/maria/me.jpg"), pdf, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(maria().storage(), "photos/ben/me.jpg"), pdf, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(pending().storage(), "photos/newbie/me.jpg"), pdf, { contentType: "image/jpeg" }));
  await assertFails(getBytes(ref(ben().storage(), "photos/maria/me.jpg")));
  await assertSucceeds(getBytes(ref(staff().storage(), "photos/maria/me.jpg")));
});

test("search applications: public form settings, private applications, finalist bidbook uploads", async () => {
  await assertSucceeds(getDoc(doc(anon().firestore(), "publicConfig/application")));
  await assertSucceeds(getDocs(collection(anon().firestore(), "schools")));
  await assertFails(setDoc(doc(admin().firestore(), "publicConfig/application"), { open: false }));
  await assertFails(getDoc(doc(anon().firestore(), "searchApplications/TS2027-0001")));
  await assertFails(getDoc(doc(anonSignIn().firestore(), "searchApplications/TS2027-0001")));
  await assertFails(getDoc(doc(maria().firestore(), "searchApplications/TS2027-0001")));
  await assertSucceeds(getDoc(doc(staff().firestore(), "searchApplications/TS2027-0001")));
  await assertFails(setDoc(doc(anonSignIn().firestore(), "searchApplications/TS2027-9999"), { status: "Top 10 Awardee" }));
  // anonymous sign-ins are not "signed in" for portal data
  await assertFails(getDoc(doc(anonSignIn().firestore(), "settings/app")));
  const s = anonSignIn("anon1").storage();
  await assertSucceeds(uploadBytes(ref(s, "searchApplications/TS2027-0001/anon1/bidbook.pdf"), pdf, { contentType: "application/pdf" }));
  await assertFails(uploadBytes(ref(s, "searchApplications/TS2027-0001/anon1/bidbook.pdf"), pdf, { contentType: "application/pdf" })); // no overwrite
  await assertFails(uploadBytes(ref(s, "searchApplications/TS2027-0001/anon2/bidbook.pdf"), pdf, { contentType: "application/pdf" })); // someone else's folder
  await assertFails(uploadBytes(ref(s, "searchApplications/TS2027-0001/anon1/b.docx"), pdf, { contentType: "application/msword" }));
  await assertFails(uploadBytes(ref(anon().storage(), "searchApplications/TS2027-0001/x/b.pdf"), pdf, { contentType: "application/pdf" }));
  await assertFails(getBytes(ref(s, "searchApplications/TS2027-0001/anon1/bidbook.pdf")));
  await assertSucceeds(getBytes(ref(staff().storage(), "searchApplications/TS2027-0001/anon1/bidbook.pdf")));
  await assertFails(deleteObject(ref(admin().storage(), "searchApplications/TS2027-0001/anon1/bidbook.pdf")));
});

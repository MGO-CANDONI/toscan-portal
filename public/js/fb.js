// Firebase client: initialisation and thin wrappers.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, signOut, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, collection, query, where, orderBy, limit, onSnapshot, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable, uploadBytes, getBlob, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

export const CONFIG = {
  apiKey: "AIzaSyAH7pRS9FCZhD25_ctgQw_Od-0fvJd6jRk",
  authDomain: "mgo-toscan.firebaseapp.com",
  projectId: "mgo-toscan",
  storageBucket: "mgo-toscan.firebasestorage.app",
  messagingSenderId: "1025153807203",
  appId: "1:1025153807203:web:7f7b5e050f7aba15ced956"
};

export const app = initializeApp(CONFIG);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, "asia-southeast1");

export {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, signOut, signInAnonymously,
  doc, getDoc, getDocs, collection, query, where, orderBy, limit, onSnapshot, updateDoc, serverTimestamp,
  ref, uploadBytesResumable, uploadBytes, getDownloadURL
};

/** Calls a Cloud Function; rejects with a readable message. */
export async function call(name, data = {}) {
  try {
    const res = await httpsCallable(functions, name, { timeout: 300000 })(data);
    return res.data;
  } catch (e) {
    const msg = e?.message?.replace(/^FirebaseError:\s*/, "") || "Something went wrong.";
    const err = new Error(e?.code === "functions/internal" ? "The server could not complete the request. Try again; if it keeps failing, tell the administrator." : msg);
    err.code = e?.code; throw err;
  }
}

/** Private files open through the signed-in SDK (security rules apply); no shareable links are created. */
const blobCache = new Map();
export async function fileUrl(path) {
  if (!path) return "";
  if (blobCache.has(path)) return blobCache.get(path);
  const p = getBlob(ref(storage, path)).then(b => URL.createObjectURL(b));
  blobCache.set(path, p);
  try { return await p; } catch (e) { blobCache.delete(path); throw e; }
}
export async function fileBlob(path) { return getBlob(ref(storage, path)); }

export function storageError(e) {
  if (e?.code === "storage/unauthorized") return "You don't have access to this file.";
  if (e?.code === "storage/object-not-found") return "The file was not found.";
  if (/CORS|NetworkError|Failed to fetch/i.test(e?.message || "")) return "The file storage is not yet set up for viewing in the browser (Storage CORS). See DEPLOYMENT.md, step 5.";
  return e?.message || "Could not open the file.";
}

export function authError(e) {
  const map = {
    "auth/invalid-credential": "Incorrect email or password.", "auth/wrong-password": "Incorrect email or password.",
    "auth/user-not-found": "No account uses that email. Create an account first.", "auth/invalid-email": "That email address is not valid.",
    "auth/email-already-in-use": "An account with this email already exists. Sign in instead, or use “Continue with Google” for a Gmail address.",
    "auth/weak-password": "Use a password of at least 8 characters.", "auth/too-many-requests": "Too many attempts. Wait a few minutes, then try again.",
    "auth/network-request-failed": "No internet connection.", "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups and try again.",
    "auth/unauthorized-domain": "This website address is not yet allowed to sign in (Firebase → Authentication → Settings → Authorized domains).",
    "auth/operation-not-allowed": "This sign-in method is not enabled yet (Firebase → Authentication → Sign-in method).",
    "auth/account-exists-with-different-credential": "This email already uses a different sign-in method."
  };
  return map[e?.code] || (e?.message || "Sign-in failed.").replace(/^Firebase:\s*/, "");
}

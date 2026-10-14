// Test-only: replace the Firebase Admin SDK with in-memory fakes.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
globalThis.__TOSCAN_FAKES__ = {
  "firebase-admin/app": await import("./fakes/app.mjs"),
  "firebase-admin/firestore": await import("./fakes/firestore.mjs"),
  "firebase-admin/auth": await import("./fakes/auth.mjs"),
  "firebase-admin/storage": await import("./fakes/storage.mjs")
};

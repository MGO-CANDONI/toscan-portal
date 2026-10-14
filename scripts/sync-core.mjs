// Copies the shared, dependency-free policy code from the Cloud Functions into the
// web app so deadlines, mappings and statuses are computed identically on both sides.
// Run after editing functions/src/core/*.js:  node scripts/sync-core.mjs
import { copyFileSync } from "node:fs";
for (const f of ["dates.js", "policy.js"]) {
  copyFileSync(new URL(`../functions/src/core/${f}`, import.meta.url), new URL(`../public/js/core/${f}`, import.meta.url));
  console.log("synced", f);
}

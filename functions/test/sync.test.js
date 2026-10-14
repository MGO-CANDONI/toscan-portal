import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("web app uses the same policy code as the server (run scripts/sync-core.mjs)", () => {
  for (const f of ["dates.js", "policy.js"]) {
    assert.equal(readFileSync(new URL(`../../public/js/core/${f}`, import.meta.url), "utf8"), readFileSync(new URL(`../src/core/${f}`, import.meta.url), "utf8"), `${f} differs`);
  }
});

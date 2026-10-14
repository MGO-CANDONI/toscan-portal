import { test } from "node:test";
import assert from "node:assert/strict";
test("every function deploys to asia-southeast1 (the region the website calls)", async () => {
  const m = await import("../index.js");
  for (const [name, fn] of Object.entries(m)) assert.equal(fn.__endpoint?.region?.[0] ?? fn.__endpoint?.region, "asia-southeast1", name);
});

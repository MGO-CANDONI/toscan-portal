// Test-only: route firebase-admin imports to in-memory fakes.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

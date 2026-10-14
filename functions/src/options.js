// Global settings for every function. This module must be imported before any
// handler: ES module imports run before the importing file's own code, so
// calling setGlobalOptions in index.js itself would be too late.
import { setGlobalOptions } from "firebase-functions/v2";
setGlobalOptions({ region: "asia-southeast1", maxInstances: 10 });

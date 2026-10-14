// TOSCAN Portal — Cloud Functions (region asia-southeast1).
// All privileged changes happen here; the web app only reads, plus a few narrow
// writes allowed by the security rules (uploads into one's own folder, marking
// notifications read).
import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ region: "asia-southeast1", maxInstances: 10 });

export { bootstrapAdmin, register, decideUser, updateAccess, updateMyProfile, verifyProfileChange } from "./src/handlers/accounts.js";
export { saveMasterData } from "./src/handlers/masterdata.js";
export { adminUpdateStudent, setProgramStatus, submitAcademicRecord, verifyAcademicRecord, grantExtension } from "./src/handlers/students.js";
export { submitDocument, reviewDocument, openSupersession, noteDocument } from "./src/handlers/documents.js";
export { decideEligibility, recalcEligibility } from "./src/handlers/eligibility.js";
export { generatePayroll, payrollAction } from "./src/handlers/payroll.js";
export { importRecords, migrateLegacy } from "./src/handlers/imports.js";
export { dailyJobs } from "./src/handlers/jobs.js";

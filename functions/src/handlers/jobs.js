// Daily scheduled work (06:00 Asia/Manila): monthly payroll draft on the configured
// day, deadline reminders and overdue notices for students, and a digest for staff.
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { db, notify, getSettings, usersWith } from "../fb.js";
import { windowFor } from "./documents.js";
import { generatePayrollCore } from "./payroll.js";
import { windowState, termDocState, TERM_NAMES, DOC_STATUS, PAYROLL, ELIG } from "../core/policy.js";
import { manilaToday, manilaMonth, manilaDayOfMonth } from "../core/dates.js";

export async function runDailyJobs(nowDate = new Date()) {
  const settings = await getSettings(true);
  const today = manilaToday(nowDate);
  const report = { payroll: null, reminders: 0, overdue: 0, digests: 0 };

  if (settings.payroll.autoGenerate && manilaDayOfMonth(nowDate) === Number(settings.payroll.dayOfMonth)) {
    report.payroll = await generatePayrollCore({ month: manilaMonth(nowDate), auto: true }).catch(e => ({ error: e.message }));
  }

  const ay = settings.currentAcademicYear;
  if (ay) {
    const reqs = (await db.collection("documentRequirements").where("active", "==", true).get()).docs.map(d => d.data());
    const recs = await db.collection("studentAcademicHistory").where("academicYear", "==", ay).where("status", "==", "Verified").get();
    for (const r of recs.docs) {
      const rec = r.data();
      const stu = (await db.doc(`students/${rec.studentId}`).get()).data();
      if (!stu?.uid || stu.programStatus === "Ended") continue;
      const { win } = await windowFor(rec.studentId, ay, rec.term, settings);
      if (!win.closesAt) continue;
      const subs = (await db.collection("submissions").where("studentId", "==", rec.studentId).where("academicYear", "==", ay).where("term", "==", rec.term).get()).docs.map(d => d.data());
      const ds = termDocState(reqs, subs, rec.term);
      const missing = reqs.filter(q => ds.missing.includes(q.code) || ds.returned.includes(q.code));
      if (!missing.length) continue;
      const state = windowState(win, nowDate);
      const daysLeft = Math.ceil((win.closesAt - nowDate) / 86400000);
      const names = missing.map(m => m.name).join(", ");
      if (state === "open" && daysLeft <= settings.deadline.reminderDays) {
        await notify(stu.uid, { id: `deadline_${r.id}_${win.deadlineDate}`, title: "Submission deadline approaching", body: `${TERM_NAMES[rec.term]}, AY ${ay}: submit ${names} by ${win.deadlineDate} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left).`, link: "#/documents", kind: "action" });
        report.reminders++;
      } else if (state === "closed") {
        await notify(stu.uid, { id: `overdue_${r.id}_${win.deadlineDate}`, title: "Documents overdue", body: `${TERM_NAMES[rec.term]}, AY ${ay}: the deadline (${win.deadlineDate}) passed without ${names}. Contact the TOSCAN Office.`, link: "#/documents", kind: "warn" });
        report.overdue++;
      }
    }
  }

  const [toReview, toVerify, toDecide, payrolls] = await Promise.all([
    db.collection("submissions").where("status", "in", [DOC_STATUS.SUBMITTED, DOC_STATUS.REVIEW]).count().get(),
    db.collection("studentAcademicHistory").where("status", "==", "For Verification").count().get(),
    db.collection("eligibility").where("status", "==", ELIG.REVIEW).where("docsComplete", "==", true).count().get(),
    db.collection("payrolls").where("status", "in", [PAYROLL.DRAFT, PAYROLL.GENERATED, PAYROLL.REVIEW, PAYROLL.APPROVED]).count().get()
  ]);
  const c = { docs: toReview.data().count, verify: toVerify.data().count, decide: toDecide.data().count, payroll: payrolls.data().count };
  if (c.docs + c.verify + c.decide + c.payroll > 0) {
    const parts = [
      c.docs && `${c.docs} document(s) to review`, c.verify && `${c.verify} enrollment record(s) to verify`,
      c.decide && `${c.decide} eligibility decision(s)`, c.payroll && `${c.payroll} payroll(s) in progress`
    ].filter(Boolean);
    const staff = await usersWith("reviewDocuments");
    await notify(staff, { id: `digest_${today}`, title: "Today's TOSCAN work queue", body: parts.join(" · "), link: "#/home", kind: "action" });
    report.digests = staff.length;
  }
  logger.info("Daily jobs", report);
  return report;
}

export const dailyJobs = onSchedule({ schedule: "0 6 * * *", timeZone: "Asia/Manila", retryCount: 1, timeoutSeconds: 540, memory: "512MiB" }, async () => {
  await runDailyJobs();
});

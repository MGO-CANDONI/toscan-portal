// Staff/admin work queues: overview, document review, verifications, eligibility.
import { S, settings, can, isAdmin, studentById } from "../state.js";
import { call } from "../fb.js";
import {
  $, $$, esc, toast, busy, opts, fmtDate, fmtDateTime, money, docBadge, eligBadge, recordBadge, payrollBadge,
  TERM_NAMES, TERM_SHORT, PERIOD_NAMES, CLASS_SHORT, fullName, renderTable, confirmBox, openModal, avatar, manilaToday
} from "../ui.js";
import { openViewer, counts } from "./common.js";

const sname = id => fullName(studentById(id)) || id;

/* ---------------- Home ---------------- */
const I = {
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>`,
  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>`,
  cash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`
};
function greeting() {
  const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Manila" }));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function firstName() {
  const a = S.account || {};
  const n = a.registration?.firstName || (a.displayName || "").replace(/^[^,]+,\s*/, "").split(" ")[0] || "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : "";
}
function nextPayrollDate(cfg) {
  if (!cfg.autoGenerate) return null;
  const today = manilaToday(); const [y, m] = today.split("-").map(Number);
  const d = String(cfg.dayOfMonth).padStart(2, "0");
  const thisMonth = `${y}-${String(m).padStart(2, "0")}-${d}`;
  if (thisMonth >= today) return thisMonth;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${d}`;
}

export function overview(main) {
  const c = counts(), cfg = settings(), ay = cfg.currentAcademicYear;
  const students = S.d.students || [];
  const active = students.filter(s => s.programStatus !== "Ended");
  const ents = (S.d.allowances || []).filter(e => e.status !== "Cancelled");
  const relAY = ents.filter(e => e.status === "Released" && e.academicYear === ay).reduce((t, e) => t + Number(e.amount || 0), 0);
  const awaiting = ents.filter(e => e.status === "Awaiting Payroll");
  const pays = (S.d.payrolls || []).filter(p => ["Draft", "Generated", "For Review", "Approved"].includes(p.status)).sort((a, b) => b.payrollNo.localeCompare(a.payrollNo));
  const incomplete = (S.d.eligibility || []).filter(e => e.academicYear === ay && ["Pending Documents", "Returned for Correction"].includes(e.status)).length;
  const oldest = [...(S.d.queue || [])].sort((a, b) => (a.submittedAt?.seconds || 0) - (b.submittedAt?.seconds || 0)).slice(0, 5);
  const apps = (S.d.applications || []);
  const newApps = apps.filter(a => a.status === "Submitted").length, newBids = apps.filter(a => a.status === "Bidbook Submitted").length;

  const row = (icon, cls, title, sub, n, href) => `<li><a href="${href}"><span class="ic ${cls}">${icon}</span><span class="t"><b>${esc(title)}</b><span>${esc(sub)}</span></span><span class="n">${n}</span></a></li>`;
  const items = [
    isAdmin() && c.pending && row(I.user, "red", "Registrations to approve", "New accounts waiting for approval", c.pending, "#/approvals"),
    c.queue && row(I.doc, "", "Documents to review", oldest[0] ? `Oldest from ${sname(oldest[0].studentId)}, ${fmtDate(oldest[0].submittedAt)}` : "", c.queue, "#/review"),
    c.verify && row(I.check, "blue", "Records to verify", "Enrollment, identity and ATM changes", c.verify, "#/verify"),
    c.decide && row(I.star, "", "Eligibility decisions", "Students with complete documents for the period", c.decide, "#/eligibility"),
    ...pays.map(p => row(I.cash, "green", `Payroll ${p.payrollNo} — ${p.status}`, `${money(p.total)} · ${p.itemCount || 0} line${p.itemCount === 1 ? "" : "s"}`, "Open", `#/payroll/${p.payrollNo}`)),
    newApps && row(I.mail, "", "Applications to screen", "New TOSCAN search applications", newApps, "#/applications"),
    newBids && row(I.mail, "", "Bidbooks received", "Finalists who uploaded a bidbook", newBids, "#/applications")
  ].filter(Boolean);
  const nextPay = nextPayrollDate(cfg.payroll);
  const name = firstName();
  main.innerHTML = `
    <div class="home-head">${avatar(S.account?.registration || S.account, null, "lg")}<div><h1>${greeting()}${name ? `, ${esc(name)}` : ""}</h1><p>Here's what's happening · Academic year ${esc(ay || "not set")}</p></div></div>
    ${!ay && isAdmin() ? `<div class="notice warn">Set the current academic year and its term opening dates in <a href="#/settings">Settings</a> before students submit documents.</div>` : ""}
    ${isAdmin() && S.master.allowanceTypes.some(t => t.active !== false && !(t.rates || []).length) ? `<div class="notice warn">Some allowance types have no rate yet. Set them in <a href="#/settings">Settings → Allowance types</a>.</div>` : ""}
    <div class="home">
      <div>
        <div class="card"><div class="card-head"><h3>Needs your attention</h3><span class="small muted">${items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : ""}</span></div>
          <ul class="inbox">${items.join("") || `<li><span class="ic green">${I.check}</span><span class="t"><b>You're all caught up</b><span>Nothing is waiting for action right now.</span></span></li>`}</ul></div>
        ${oldest.length ? `<div class="card"><div class="card-head"><h3>Waiting longest for review</h3><a class="btn sm" href="#/review">Open queue</a></div>
          <div class="table-wrap"><table><tbody>${oldest.map(s => `<tr><td>${esc(sname(s.studentId))}</td><td>${esc(s.requirementName)}</td><td class="small">${esc(TERM_SHORT[s.term])} ${esc(s.academicYear)}</td><td class="small muted right">${fmtDateTime(s.submittedAt)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      </div>
      <div>
        <div class="card"><div class="card-head"><h3>At a glance</h3><span class="small muted">${esc(fmtDate(new Date()))}</span></div>
          <ul class="glance">
            <li><a href="#/students"><span>Active students</span></a><b>${active.length}</b></li>
            <li><span>Top 10 awardees</span><b>${active.filter(s => s.classification === "top10").length}</b></li>
            <li><span>Top 20 qualifiers</span><b>${active.filter(s => s.classification === "top20").length}</b></li>
            <li><span>Incomplete requirements, AY ${esc(ay || "—")}</span><b>${incomplete}</b></li>
            <li><a href="#/payroll"><span>Awaiting payroll (${awaiting.length})</span></a><b>${money(awaiting.reduce((t, e) => t + Number(e.amount || 0), 0))}</b></li>
            <li><a href="#/reports"><span>Released, AY ${esc(ay || "—")}</span></a><b>${money(relAY)}</b></li>
          </ul></div>
        <div class="card"><div class="card-head"><h3>Upcoming</h3></div>
          <ul class="upcoming">
            ${nextPay ? `<li><span class="when">${fmtDate(nextPay)}</span>Automatic payroll draft${awaiting.length ? ` — ${awaiting.length} allowance${awaiting.length === 1 ? "" : "s"} ready` : ""}</li>` : `<li><span class="when">Payroll</span>Automatic generation is off; generate payrolls manually.</li>`}
            ${Object.entries(S.master.academicYears.find(y => y.id === ay)?.terms || {}).filter(([, t]) => t?.openingDate && t.openingDate >= manilaToday()).sort((a, b) => a[1].openingDate.localeCompare(b[1].openingDate)).map(([k, t]) => `<li><span class="when">${fmtDate(t.openingDate)}</span>${esc(TERM_NAMES[k] || k)} opens</li>`).join("")}
          </ul></div>
      </div>
    </div>`;
}
overview.deps = ["r:queue", "r:verify", "r:eligibility", "r:students", "r:users", "r:payrolls", "r:allowances", "r:applications", "settings", "allowanceTypes", "academicYears", "account"];

/* ---------------- Document review ---------------- */
export function review(main) {
  const list = [...(S.d.queue || [])].sort((a, b) => (a.submittedAt?.seconds || 0) - (b.submittedAt?.seconds || 0));
  main.innerHTML = `<div class="page-head"><div><h1>Document Review</h1><p>Approve documents that are complete and correct, or return them with the reason. Approved documents are locked permanently.</p></div></div><div class="card" id="t"></div>`;
  const years = [...new Set(list.map(s => s.academicYear))].sort().reverse();
  renderTable($("#t", main), {
    id: "review", rows: list, pageSize: 30,
    searchText: s => `${sname(s.studentId)} ${s.studentId} ${s.requirementName} ${s.fileName}`, searchPlaceholder: "Student, TOSCAN ID, document",
    filters: [
      { key: "st", label: "Status", options: ["Submitted", "Under Review"], test: (s, v) => s.status === v },
      { key: "ay", label: "Academic year", options: years, test: (s, v) => s.academicYear === v },
      { key: "req", label: "Document", options: S.master.requirements.map(r => [r.code, r.name]), test: (s, v) => s.requirementCode === v }
    ],
    columns: [
      { label: "Submitted", render: s => `<span class="nowrap">${fmtDateTime(s.submittedAt)}</span>`, sort: s => s.submittedAt?.seconds || 0 },
      { label: "Student", render: s => `${esc(sname(s.studentId))}<div class="xs muted mono">${esc(s.studentId)}</div>`, sort: s => sname(s.studentId) },
      { label: "Document", render: s => `${esc(s.requirementName)}${s.version > 1 ? ` <span class="badge b-info">v${s.version}</span>` : ""}${s.replacesApprovedId ? ` <span class="badge b-warn">Correction</span>` : ""}`, sort: s => s.requirementName },
      { label: "Term", render: s => `${esc(TERM_SHORT[s.term])} · ${esc(s.academicYear)}`, sort: s => s.academicYear + s.term },
      { label: "Status", render: s => docBadge(s.status), sort: s => s.status },
      { label: "Deadline", render: s => s.deadline ? fmtDate(s.deadline) : "—", sort: s => s.deadline || "" }
    ],
    empty: "Nothing to review. 🎉",
    onRow: s => { const rows = $("#t", main).currentRows || list; openReview(rows, rows.indexOf(s)); }
  });
}
review.deps = ["r:queue", "r:students", "requirements"];

export function openReview(list, index) {
  openViewer(list, index, {
    actions: s => ["Submitted", "Under Review"].includes(s.status) && can("reviewDocuments") ? `
      <h4>Review</h4>
      <label for="rv-remarks">Remarks <span class="muted">(required when returning)</span></label>
      <textarea id="rv-remarks" placeholder="e.g. Grades are from the wrong semester"></textarea>
      <div class="btn-row" style="margin-top:.6rem">
        ${s.status === "Submitted" ? `<button class="btn sm" data-a="start">Start review</button>` : ""}
        <button class="btn sm ok" data-a="approve">Approve</button><button class="btn sm danger" data-a="return">Return for correction</button></div>
      <div class="xs muted" style="margin-top:.4rem">Approving locks this document permanently. Eligibility for the allowance is decided separately.</div>`
      : s.status === "Approved" && isAdmin() && !s.supersession?.open ? `<button class="btn sm" data-a="supersede">Allow a corrected version…</button>` : "",
    onAction: (s, el) => {
      if (!el) return;
      $$("[data-a]", el).forEach(b => b.onclick = async () => {
        const action = b.dataset.a;
        if (action === "supersede") {
          const v = await confirmBox({ title: "Allow a corrected version?", body: "The approved file stays on record. The student may upload a replacement; the original becomes “Superseded” only when the replacement is approved.", fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }], confirmText: "Allow correction" });
          if (v) busy(b, () => call("openSupersession", { submissionId: s.id, reason: v.reason }), "Correction allowed. The student was notified.").catch(() => {});
          return;
        }
        const remarks = $("#rv-remarks", el).value.trim();
        if (action === "return" && !remarks) { toast("Write the reason for returning the document.", "err"); $("#rv-remarks", el).focus(); return; }
        if (action === "approve" && !(await confirmBox({ title: "Approve this document?", body: "It will be locked and can no longer be replaced or deleted.", confirmText: "Approve" }))) return;
        await busy(b, () => call("reviewDocument", { submissionId: s.id, action, remarks }), action === "approve" ? "Approved." : action === "return" ? "Returned to the student." : "Marked as under review.").catch(() => {});
        s.status = action === "approve" ? "Approved" : action === "return" ? "Returned" : "Under Review";
        el.innerHTML = `<div class="notice ok">Recorded: ${esc(s.status)}. Use Next → to continue.</div>`;
      });
    }
  });
}

/* ---------------- Verifications ---------------- */
export function verify(main) {
  const recs = [...(S.d.verify || [])].sort((a, b) => (a.updatedAt?.seconds || 0) - (b.updatedAt?.seconds || 0));
  const changes = (S.d.students || []).filter(s => s.pendingChanges && Object.keys(s.pendingChanges).length)
    .flatMap(s => Object.entries(s.pendingChanges).map(([field, p]) => ({ s, field, ...p })));
  main.innerHTML = `
    <div class="page-head"><div><h1>Verifications</h1><p>Changes of school, level or program, and identity or payment details, need a staff check before they take effect.</p></div></div>
    <div class="card"><div class="card-head"><h3>Enrollment records (${recs.length})</h3></div><div class="table-wrap"><table>
      <thead><tr><th>Student</th><th>Term</th><th>Before</th><th>Now</th><th>Opening date</th><th></th></tr></thead>
      <tbody>${recs.map((r, i) => {
        const s = studentById(r.studentId) || {}, p = r.previousVerified || s.current || {};
        return `<tr><td>${esc(fullName(s))}<div class="xs muted mono">${esc(r.studentId)}</div></td><td>${esc(TERM_NAMES[r.term])}<div class="xs muted">AY ${esc(r.academicYear)}</div></td>
          <td class="small">${esc(p.school || "—")}<br>${esc(p.program || "")} ${esc(p.level || "")}</td>
          <td class="small"><b>${esc(r.school)}</b><br>${esc(r.program)} ${esc(r.level)} ${esc(r.yearLevel)}<br><span class="muted">${esc(r.enrollmentStatus)}</span></td>
          <td><input type="date" data-open="${i}" value="${esc(r.openingDate || "")}" title="Leave blank to use the school calendar" data-nodirty></td>
          <td class="nowrap"><button class="btn sm ok" data-v="${i}">Verify</button> <button class="btn sm danger" data-x="${i}">Reject</button></td></tr>`;
      }).join("") || `<tr><td colspan="6" class="empty">No enrollment records waiting.</td></tr>`}</tbody></table></div></div>
    <div class="card"><div class="card-head"><h3>Identity and payment changes (${changes.length})</h3></div><div class="table-wrap"><table>
      <thead><tr><th>Student</th><th>Field</th><th>Current</th><th>Requested</th><th>Requested on</th><th></th></tr></thead>
      <tbody>${changes.map((c, i) => `<tr><td>${esc(fullName(c.s))}</td><td>${c.field === "atmNumber" ? "ATM number" : "Date of birth"}</td><td class="mono">${esc(c.s[c.field] || "—")}</td><td class="mono"><b>${esc(c.value)}</b></td><td>${fmtDateTime(c.requestedAt)}</td>
        <td class="nowrap"><button class="btn sm ok" data-cv="${i}">Approve</button> <button class="btn sm danger" data-cx="${i}">Reject</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">No pending changes.</td></tr>`}</tbody></table></div></div>`;
  $$("[data-v]", main).forEach(b => b.onclick = () => { const i = +b.dataset.v; busy(b, () => call("verifyAcademicRecord", { id: recs[i].id, decision: "verify", openingDate: $(`[data-open="${i}"]`, main).value }), "Verified.").catch(() => {}); });
  $$("[data-x]", main).forEach(b => b.onclick = async () => {
    const v = await confirmBox({ title: "Reject this record?", fields: [{ name: "remarks", label: "Reason (shown to the student)", type: "textarea", required: true }], confirmText: "Reject", danger: true });
    if (v) busy(b, () => call("verifyAcademicRecord", { id: recs[+b.dataset.x].id, decision: "reject", remarks: v.remarks }), "Rejected.").catch(() => {});
  });
  $$("[data-cv]", main).forEach(b => b.onclick = () => { const c = changes[+b.dataset.cv]; busy(b, () => call("verifyProfileChange", { studentId: c.s.id, field: c.field, decision: "approve" }), "Change applied.").catch(() => {}); });
  $$("[data-cx]", main).forEach(b => b.onclick = async () => {
    const c = changes[+b.dataset.cx];
    const v = await confirmBox({ title: "Reject this change?", fields: [{ name: "remarks", label: "Reason", type: "textarea", required: true }], confirmText: "Reject", danger: true });
    if (v) busy(b, () => call("verifyProfileChange", { studentId: c.s.id, field: c.field, decision: "reject", remarks: v.remarks }), "Change rejected.").catch(() => {});
  });
}
verify.deps = ["r:verify", "r:students"];

/* ---------------- Eligibility ---------------- */
export function eligibility(main) {
  const rows = (S.d.eligibility || []).map(e => ({ ...e, s: studentById(e.studentId) || {} }));
  const years = [...new Set(rows.map(e => e.academicYear))].sort().reverse();
  main.innerHTML = `<div class="page-head"><div><h1>Allowance Eligibility</h1><p>Approved documents make a period ready for a decision. A student is paid only after being marked Qualified.</p></div></div><div class="card" id="t"></div>`;
  renderTable($("#t", main), {
    id: "elig", rows, pageSize: 30,
    searchText: e => `${fullName(e.s)} ${e.studentId}`,
    filters: [
      { key: "ready", label: "Show", options: [["ready", "Ready for decision"], ["Pending Documents", "Pending documents"], ["Returned for Correction", "Returned for correction"], ["Qualified", "Qualified"], ["Not Qualified", "Not qualified"], ["Included in Payroll", "Included in payroll"], ["Released", "Released"]], value: "ready",
        test: (e, v) => v === "ready" ? e.status === "For Review" && e.docsComplete : e.status === v },
      { key: "ay", label: "Academic year", options: years, value: settings().currentAcademicYear && years.includes(settings().currentAcademicYear) ? settings().currentAcademicYear : "", test: (e, v) => e.academicYear === v },
      { key: "p", label: "Period", options: Object.entries(PERIOD_NAMES), test: (e, v) => e.period === v },
      { key: "c", label: "Classification", options: Object.entries(CLASS_SHORT), test: (e, v) => e.s.classification === v }
    ],
    columns: [
      { label: "Student", render: e => `${esc(fullName(e.s) || e.studentName)}<div class="xs muted mono">${esc(e.studentId)}</div>`, sort: e => fullName(e.s) },
      { label: "Class", render: e => esc(CLASS_SHORT[e.s.classification] || "—"), sort: e => e.s.classification || "" },
      { label: "Period", render: e => `${esc(PERIOD_NAMES[e.period])}<div class="xs muted">AY ${esc(e.academicYear)}</div>`, sort: e => e.academicYear + e.period },
      { label: "Documents", render: e => (e.terms || []).map(t => `<span class="badge ${t.state === "complete" ? "b-ok" : t.state === "returned" ? "b-bad" : t.state === "in-review" ? "b-info" : ""}">${esc(TERM_SHORT[t.term])}: ${esc(t.state)}</span>`).join(" ") || "—" },
      { label: "Status", render: e => `${eligBadge(e.status)}${e.decision?.reason ? `<div class="xs muted">${esc(e.decision.reason)}</div>` : ""}`, sort: e => e.status },
      { label: "", render: e => ["For Review", "Qualified", "Not Qualified"].includes(e.status) ? `<button class="btn sm ${e.status === "For Review" && e.docsComplete ? "primary" : ""}" data-decide="${esc(e.id)}">Decide</button>` : "" }
    ],
    afterDraw: el => $$("[data-decide]", el).forEach(b => b.onclick = () => decide(rows.find(r => r.id === b.dataset.decide)))
  });
}
eligibility.deps = ["r:eligibility", "r:students", "allowanceTypes"];

export function decide(e) {
  const s = e.s || studentById(e.studentId) || {};
  const types = S.master.allowanceTypes.filter(t => t.active !== false && (!t.classifications?.length || t.classifications.includes(s.classification)));
  const m = openModal(`
    <h2>Eligibility — ${esc(fullName(s))}</h2>
    <p class="muted">${esc(PERIOD_NAMES[e.period])}, AY ${esc(e.academicYear)} · ${esc(CLASS_SHORT[s.classification] || "No classification")} · Program ${esc(s.programStatus || "Active")}</p>
    ${!e.docsComplete ? `<div class="notice warn">Required documents are not all approved yet. The student can only be marked Not Qualified.</div>` : ""}
    <form class="grid" id="df">
      <div class="btn-row"><label class="check"><input type="radio" name="decision" value="Qualified" ${e.docsComplete ? "checked" : "disabled"}> Qualified</label>
        <label class="check"><input type="radio" name="decision" value="Not Qualified" ${e.docsComplete ? "" : "checked"}> Not qualified</label></div>
      <fieldset id="types"><legend>Allowance types</legend>${types.map(t => `<label class="check"><input type="checkbox" name="t" value="${esc(t.code)}" ${t.appliesTo === "latinHonor" ? (s.latinHonor ? "" : "disabled") : "checked"}> ${esc(t.name)}${t.appliesTo === "latinHonor" ? (s.latinHonor ? ` <span class="badge b-info">${esc(s.latinHonor)}</span>` : ` <span class="xs muted">(no Latin honor on record)</span>`) : ""}</label>`).join("") || "<p class='muted'>No active allowance types apply.</p>"}
        <p class="xs muted">The amount is the rate in force on the period's opening date. Regular and Latin honor allowances are combined only if both types allow it.</p></fieldset>
      <div><label id="rl">Reason / remarks</label><textarea name="reason" placeholder="Required when not qualified"></textarea></div>
      <div class="modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary" type="submit">Save decision</button></div>
    </form>`, { size: "narrow" });
  const f = $("#df", m);
  const sync = () => { $("#types", m).classList.toggle("hidden", f.decision.value !== "Qualified"); $("#rl", m).className = f.decision.value === "Not Qualified" ? "req" : ""; };
  $$("input[name=decision]", f).forEach(r => r.onchange = sync); sync();
  $("[data-c]", m).onclick = () => m.close();
  f.onsubmit = ev => {
    ev.preventDefault();
    const decision = f.decision.value, reason = f.reason.value.trim();
    const allowanceTypes = $$("input[name=t]:checked", f).map(x => x.value);
    busy(f.querySelector("[type=submit]"), async () => {
      await call("decideEligibility", { studentId: e.studentId, academicYear: e.academicYear, period: e.period, decision, reason, allowanceTypes });
      m.close();
    }, decision === "Qualified" ? "Marked qualified. The allowance is queued for the next payroll." : "Marked not qualified.").catch(() => {});
  };
}

// Student directory and full student record (staff/admin).
import { S, settings, isAdmin, can, studentById } from "../state.js";
import { db, collection, query, where, getDocs, call } from "../fb.js";
import {
  $, $$, esc, toast, busy, opts, fmtDate, fmtDateTime, money, docBadge, eligBadge, entBadge, classBadge, programBadge, recordBadge,
  TERM_NAMES, TERM_SHORT, PERIOD_NAMES, CLASS_NAMES, CLASS_SHORT, LATIN, fullName, renderTable, confirmBox, openModal, downloadCSV, downloadXLSX, fieldHtml
} from "../ui.js";
import { avatarFor, hydratePhotos, openViewer, termWindow, windowText } from "./common.js";
import { openReview, decide } from "./staff.js";

/* ---------------- Directory ---------------- */
export function directory(main) {
  const rows = S.d.students || [];
  const ay = settings().currentAcademicYear;
  const elig = id => (S.d.eligibility || []).filter(e => e.studentId === id && e.academicYear === ay);
  const batches = [...new Set(rows.map(s => s.qualification?.batch || s.batch).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const schools = [...new Set(rows.map(s => s.current?.school).filter(Boolean))].sort();
  main.innerHTML = `
    <div class="page-head"><div><h1>Student Directory</h1><p>${rows.length} student records, including those whose program has ended.</p></div>
      <div class="btn-row"><button class="btn" id="csv">Export CSV</button><button class="btn" id="xlsx">Export Excel</button>${isAdmin() ? `<button class="btn primary" id="add">Add student</button>` : ""}</div></div>
    <div class="card" id="t"></div>`;
  const t = renderTable($("#t", main), {
    id: "dir", rows, pageSize: 30, defaultSort: 1,
    searchText: s => `${fullName(s)} ${s.studentId} ${s.email || ""} ${s.current?.school || ""} ${s.current?.program || ""}`, searchPlaceholder: "Name, TOSCAN ID, email, school, program",
    filters: [
      { key: "status", label: "Program", options: ["Active", "Ended"], value: "Active", test: (s, v) => (s.programStatus || "Active") === v },
      { key: "cls", label: "Classification", options: Object.entries(CLASS_SHORT), test: (s, v) => s.classification === v },
      { key: "batch", label: "Batch", options: batches, test: (s, v) => (s.qualification?.batch || s.batch) === v },
      { key: "school", label: "Current school", options: schools, test: (s, v) => s.current?.school === v }
    ],
    columns: [
      { label: "", render: s => avatarFor(s, s.photoPath, "sm") },
      { label: "Name", render: s => `<b>${esc(fullName(s))}</b><div class="xs muted mono">${esc(s.studentId)}</div>`, sort: s => fullName(s) },
      { label: "Batch", render: s => esc(s.qualification?.batch || s.batch || "—"), sort: s => s.qualification?.batch || s.batch || "" },
      { label: "Class", render: s => esc(CLASS_SHORT[s.classification] || "—"), sort: s => s.classification || "" },
      { label: "Current school / program", render: s => `${esc(s.current?.school || "—")}<div class="xs muted">${esc(s.current?.program || "")} ${esc(s.current?.yearLevel || "")}</div>`, sort: s => s.current?.school || "" },
      { label: `AY ${ay}`, render: s => elig(s.id).map(e => `${esc(e.period)} ${eligBadge(e.status)}`).join("<br>") || `<span class="xs muted">—</span>` },
      { label: "Program", render: s => programBadge(s.programStatus), sort: s => s.programStatus || "Active" },
      { label: "Account", render: s => s.uid ? `<span class="badge b-ok">Linked</span>` : `<span class="badge">No login</span>` }
    ],
    afterDraw: el => hydratePhotos(el),
    onRow: s => { location.hash = `#/students/${encodeURIComponent(s.id)}`; }
  });
  const exportRows = () => t.rows().map(s => [s.studentId, fullName(s), s.qualification?.batch || s.batch || "", CLASS_SHORT[s.classification] || "", s.qualification?.schoolAtQualification || "", s.current?.school || "", s.current?.program || "", s.current?.yearLevel || "", s.latinHonor || "", s.programStatus || "Active", s.email || "", s.contact || ""]);
  const headers = ["TOSCAN ID", "Name", "Batch", "Classification", "School at qualification", "Current school", "Program", "Year level", "Latin honor", "Program status", "Email", "Contact"];
  $("#csv").onclick = () => downloadCSV("toscan-students", headers, exportRows());
  $("#xlsx").onclick = e => busy(e.target, () => downloadXLSX("toscan-students", [{ name: "Students", headers, rows: exportRows() }])).catch(() => {});
  $("#add") && ($("#add").onclick = addStudent);
}
directory.deps = ["r:students", "r:eligibility", "settings"];

function addStudent() {
  const m = openModal(`<h2>Add student</h2><p class="muted small">For students without a portal login (for example, earlier batches). They can link an account later by registering with the same email.</p>
    <form id="af" class="grid g2">
      ${[["TOSCAN ID", "TOSCAN ID", "", "Leave blank to generate a TSC number"], ["Surname", "Surname", "req"], ["First Name", "First name", "req"], ["Middle Name", "Middle name"], ["Date of Birth", "Date of birth", "", "", "date"], ["Email", "Email"], ["Contact", "Contact number"], ["Batch", "TOSCAN batch"], ["Year Qualified", "Year of qualification"], ["School at Qualification", "School at qualification"], ["Admission Date", "Admission date", "", "", "date"], ["Current School", "Current school"], ["Program", "Course / strand"], ["Year Level", "Year level"]]
        .map(([n, l, r, h, type]) => fieldHtml({ name: n, label: l, required: r === "req", hint: h, type: type || "text" })).join("")}
      ${fieldHtml({ name: "Classification", label: "Classification", type: "select", options: [["", "—"], ["Top 10", "Top 10 — Awardee"], ["Top 20", "Top 20 — Qualifier"]] })}
      ${fieldHtml({ name: "Latin Honor", label: "Latin honor", type: "select", options: LATIN.map(x => [x, x || "None"]) })}
      <div class="spanall form-msg err" id="am"></div>
      <div class="spanall modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary">Add student</button></div></form>`);
  $("[data-c]", m).onclick = () => m.close();
  $("#af", m).onsubmit = ev => {
    ev.preventDefault();
    const row = Object.fromEntries(new FormData(ev.target).entries());
    busy(ev.target.querySelector(".btn.primary"), async () => {
      const r = await call("importRecords", { kind: "students", rows: [row], dryRun: false });
      const res = r.results[0];
      if (!res.ok) { $("#am", m).textContent = res.errors.join(" "); throw new Error(res.errors[0]); }
      m.close(); toast(`Student ${res.studentId} added.`, "ok");
    }).catch(() => {});
  };
}

/* ---------------- Student record ---------------- */
const cache = new Map();
async function loadStudentData(id, force = false) {
  if (!force && cache.has(id)) return cache.get(id);
  const q = c => getDocs(query(collection(db, c), where("studentId", "==", id))).then(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
  const [subs, recs, hist, ext, statusHist] = await Promise.all([q("submissions"), q("studentAcademicHistory"), q("historicalPayments"), q("deadlineExtensions"), q("programStatusHistory")]);
  const data = { subs, recs, hist, ext, statusHist };
  cache.set(id, data);
  return data;
}

let tab = "profile";
export async function detail(main, [id]) {
  const s = studentById(id);
  if (!s) { main.innerHTML = (S.d.students ? `<div class="notice bad">Student ${esc(id)} was not found.</div>` : `<div class="loading">Loading…</div>`); return; }
  if (!cache.has(id)) main.innerHTML = `<div class="loading">Loading ${esc(fullName(s))}…</div>`;
  const data = await loadStudentData(id, true);
  const acc = (S.d.users || []).find(u => u.uid === s.uid);
  const tabs = [["profile", "Profile"], ["academic", "Academic history"], ["documents", "Documents"], ["allowance", "Eligibility & allowance"], ["status", "Program status"]];
  main.innerHTML = `
    <div class="page-head"><div><a href="#/students" class="small">← Student directory</a></div></div>
    <div class="card"><div class="profile">${avatarFor(s, s.photoPath, "lg")}
      <div class="info"><h2>${esc(fullName(s))}</h2>
        <div class="small muted">TOSCAN ID <b class="mono">${esc(s.studentId)}</b> · ${esc(s.qualification?.batch || s.batch || "No batch")} · ${acc ? `Login: ${esc(acc.email)}` : "No portal login"}</div>
        <div class="chips" style="margin-top:.4rem">${classBadge(s.classification)}${programBadge(s.programStatus)}${s.latinHonor ? `<span class="badge b-info">${esc(s.latinHonor)}</span>` : ""}${s.source === "legacy" ? `<span class="badge">From old portal</span>` : ""}</div></div>
      ${isAdmin() ? `<div class="btn-row"><button class="btn" id="edit">Edit record</button></div>` : ""}</div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "active" : ""}">${esc(l)}</button>`).join("")}</div>
    <div id="tab"></div>`;
  hydratePhotos(main);
  $$("[data-tab]", main).forEach(b => b.onclick = () => { tab = b.dataset.tab; detail(main, [id]); });
  $("#edit") && ($("#edit").onclick = () => editStudent(s));
  const el = $("#tab", main);
  ({ profile: tabProfile, academic: tabAcademic, documents: tabDocuments, allowance: tabAllowance, status: tabStatus })[tab](el, s, data, () => detail(main, [id]));
}
detail.deps = ["r:students", "r:eligibility", "r:allowances", "r:queue", "r:verify"];

function tabProfile(el, s) {
  const q = s.qualification || {}, c = s.current || {};
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v || "—"}</dd>`;
  el.innerHTML = `<div class="grid g2">
    <div class="card"><h3>Personal information</h3><dl class="kv">
      ${row("Name", esc(fullName(s)))}${row("Date of birth", s.dateOfBirth ? fmtDate(s.dateOfBirth) : "")}${row("Email", esc(s.email))}${row("Contact", esc(s.contact))}
      ${row("Address", esc(s.address))}${row("ATM number", `<span class="mono">${esc(s.atmNumber)}</span>`)}</dl>
      ${s.pendingChanges && Object.keys(s.pendingChanges).length ? `<div class="notice warn small" style="margin-top:.8rem">Pending change: ${Object.entries(s.pendingChanges).map(([k, v]) => `${k === "atmNumber" ? "ATM" : "Birth date"} → ${esc(v.value)}`).join(", ")}. <a href="#/verify">Verify</a></div>` : ""}</div>
    <div class="card"><h3>TOSCAN qualification</h3><dl class="kv">
      ${row("Classification", esc(CLASS_NAMES[s.classification] || ""))}${row("Batch", esc(q.batch || s.batch))}${row("Year qualified", esc(q.yearQualified))}
      ${row("School at qualification", esc(q.schoolAtQualification))}${q.originalSchoolAtQualification ? row("Originally recorded as", esc(q.originalSchoolAtQualification)) : ""}
      ${row("Award information", esc(q.awardType || s.award))}${row("Admission date", q.admissionDate ? fmtDate(q.admissionDate) : "")}${row("Latin honor", esc(s.latinHonor || "None"))}</dl></div>
    <div class="card spanall"><h3>Current academic information</h3><dl class="kv">
      ${row("School", esc(c.school))}${row("School address", esc(c.schoolAddress))}${row("Level", esc(c.level))}${row("Program", esc(c.program))}${row("Year level", esc(c.yearLevel))}
      ${row("Term", c.term ? `${esc(TERM_NAMES[c.term])}, AY ${esc(c.academicYear)}` : "")}${row("Enrollment status", esc(c.enrollmentStatus))}${row("Expected graduation", c.expectedGraduation ? fmtDate(c.expectedGraduation) : "")}</dl></div></div>`;
}

function tabAcademic(el, s, data) {
  const recs = [...data.recs].sort((a, b) => `${b.academicYear}${b.term}`.localeCompare(`${a.academicYear}${a.term}`));
  el.innerHTML = `<div class="card"><div class="table-wrap"><table>
    <thead><tr><th>Academic year</th><th>Term</th><th>School</th><th>Program</th><th>Year level</th><th>Enrollment</th><th>Opening date</th><th>Status</th></tr></thead>
    <tbody>${recs.map(r => `<tr><td>${esc(r.academicYear)}</td><td>${esc(TERM_NAMES[r.term])}</td><td>${esc(r.school)}</td><td>${esc(r.program)}</td><td>${esc(r.yearLevel)}</td><td>${esc(r.enrollmentStatus)}</td><td>${r.openingDate ? fmtDate(r.openingDate) : "<span class='muted small'>Calendar</span>"}</td><td>${recordBadge(r.status)}${r.verifiedBy ? `<div class="xs muted">${esc(r.verifiedBy.name)}</div>` : ""}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">No term records.</td></tr>`}</tbody></table></div></div>`;
}

function tabDocuments(el, s, data, reload) {
  const subs = [...data.subs].sort((a, b) => `${b.academicYear}${b.term}${b.requirementCode}${String(b.version).padStart(3, "0")}`.localeCompare(`${a.academicYear}${a.term}${a.requirementCode}${String(a.version).padStart(3, "0")}`));
  const groups = [...new Set(subs.map(x => `${x.academicYear}|${x.term}`))];
  const ext = data.ext;
  el.innerHTML = `${isAdmin() ? `<div class="btn-row end" style="margin-bottom:.8rem"><button class="btn" id="ext">Grant deadline extension…</button></div>` : ""}
    ${ext.length ? `<div class="notice info">Extensions: ${ext.map(x => `${esc(TERM_SHORT[x.term])} ${esc(x.academicYear)} until ${fmtDate(x.deadline)} (${esc(x.reason)})`).join("; ")}</div>` : ""}
    ${groups.map(g => {
      const [ay, term] = g.split("|");
      const list = subs.filter(x => x.academicYear === ay && x.term === term);
      const w = windowText(termWindow({ studentId: s.studentId, academicYear: ay, term, record: data.recs.find(r => r.academicYear === ay && r.term === term), extensions: ext }));
      return `<div class="card"><div class="card-head"><h3>${esc(TERM_NAMES[term])}, AY ${esc(ay)}</h3><span class="small muted">${esc(w.text)}</span></div><div class="table-wrap"><table>
        <thead><tr><th>Document</th><th>Version</th><th>Submitted</th><th>Status</th><th>Reviewer</th><th>Remarks</th></tr></thead>
        <tbody>${list.map(x => `<tr class="click" data-sub="${esc(x.id)}"><td>${esc(x.requirementName)}</td><td>v${x.version || 1}</td><td class="nowrap">${fmtDateTime(x.submittedAt)}</td><td>${docBadge(x.status)}</td><td class="small">${esc(x.reviewer?.name || "")}</td><td class="small">${esc(x.remarks || "")}</td></tr>`).join("")}</tbody></table></div></div>`;
    }).join("") || `<div class="card empty">No documents submitted.</div>`}`;
  $$("[data-sub]", el).forEach(tr => tr.onclick = () => { const i = subs.findIndex(x => x.id === tr.dataset.sub); openReview(subs, i); });
  $("#ext", el) && ($("#ext", el).onclick = async () => {
    const v = await confirmBox({ title: "Grant a deadline extension", body: "The new deadline applies to this student and term only.", confirmText: "Grant extension", fields: [
      { name: "academicYear", label: "Academic year", type: "select", options: S.master.academicYears.map(a => a.id), value: settings().currentAcademicYear, required: true },
      { name: "term", label: "Term", type: "select", options: Object.entries(TERM_NAMES), required: true },
      { name: "deadline", label: "New deadline", type: "date", required: true },
      { name: "reason", label: "Reason", type: "textarea", required: true }] });
    if (v) busy(null, () => call("grantExtension", { studentId: s.studentId, ...v }), "Extension granted.").then(reload).catch(() => {});
  });
}

function tabAllowance(el, s, data) {
  const elig = (S.d.eligibility || []).filter(e => e.studentId === s.id).sort((a, b) => `${b.academicYear}${b.period}`.localeCompare(`${a.academicYear}${a.period}`));
  const ents = (S.d.allowances || []).filter(e => e.studentId === s.id).sort((a, b) => `${b.academicYear}${b.period}`.localeCompare(`${a.academicYear}${a.period}`));
  const live = ents.filter(e => e.status !== "Cancelled");
  el.innerHTML = `
    <div class="card"><div class="card-head"><h3>Eligibility by period</h3></div><div class="table-wrap"><table>
      <thead><tr><th>Period</th><th>Documents</th><th>Status</th><th>Decision</th><th></th></tr></thead>
      <tbody>${elig.map(e => `<tr><td>${esc(PERIOD_NAMES[e.period])}<div class="xs muted">AY ${esc(e.academicYear)}</div></td>
        <td>${e.docsComplete ? `<span class="badge b-ok">Complete</span>` : (e.terms || []).map(t => `<span class="badge">${esc(TERM_SHORT[t.term])}: ${esc(t.state)}</span>`).join(" ") || "—"}</td>
        <td>${eligBadge(e.status)}</td><td class="small">${e.decision ? `${esc(e.decision.by?.name || "")} · ${fmtDateTime(e.decision.at)}${e.decision.reason ? `<br>${esc(e.decision.reason)}` : ""}` : ""}</td>
        <td>${can("decideEligibility") && ["For Review", "Qualified", "Not Qualified"].includes(e.status) ? `<button class="btn sm" data-d="${esc(e.id)}">Decide</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No eligibility records yet.</td></tr>`}</tbody></table></div></div>
    <div class="card"><div class="card-head"><h3>Allowance ledger</h3><span>Released total <b>${money(live.filter(e => e.status === "Released").reduce((t, e) => t + Number(e.amount || 0), 0))}</b></span></div><div class="table-wrap"><table>
      <thead><tr><th>School year</th><th>Period</th><th>Allowance</th><th class="right">Amount</th><th>Status</th><th>Payroll</th><th>Released</th><th>Reference</th><th>Source</th></tr></thead>
      <tbody>${ents.map(e => `<tr><td>${esc(e.academicYear)}</td><td>${esc(PERIOD_NAMES[e.period])}</td><td>${esc(e.typeName || e.typeCode)}</td><td class="right">${money(e.amount)}</td><td>${entBadge(e.status)}</td><td>${e.payrollNo ? `<a class="mono" href="#/payroll/${esc(e.payrollNo)}">${esc(e.payrollNo)}</a>` : "—"}</td><td>${e.releasedAt ? fmtDate(e.releasedAt) : "—"}</td><td class="small">${esc(e.paymentRef || "")}</td><td class="small">${e.source === "imported" ? "Imported" : "Portal"}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">No entitlements.</td></tr>`}</tbody></table></div></div>
    ${data.hist.length ? `<div class="card"><h3>Imported historical payments</h3><div class="table-wrap"><table><thead><tr><th>School year</th><th>Period</th><th>Category</th><th class="right">Amount</th><th>Status</th><th>Payroll no.</th><th>Released</th><th>Source</th><th>Imported</th></tr></thead><tbody>
      ${data.hist.map(h => `<tr><td>${esc(h.academicYear)}</td><td>${esc(PERIOD_NAMES[h.period])}</td><td>${esc(h.typeCode)}</td><td class="right">${money(h.amount)}</td><td>${esc(h.status)}</td><td class="mono">${esc(h.payrollNo)}</td><td>${h.releaseDate ? fmtDate(h.releaseDate) : "—"}</td><td class="small">${esc(h.source)}</td><td class="small">${esc(h.importedBy?.name || "")} ${fmtDate(h.importedAt)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
  $$("[data-d]", el).forEach(b => b.onclick = () => decide({ ...elig.find(e => e.id === b.dataset.d), s }));
}

function tabStatus(el, s, data, reload) {
  const hist = [...data.statusHist].sort((a, b) => (b.changedAt?.seconds || 0) - (a.changedAt?.seconds || 0));
  el.innerHTML = `<div class="card"><div class="card-head"><h3>Program membership: ${programBadge(s.programStatus)}</h3>
      ${isAdmin() ? `<button class="btn ${s.programStatus === "Ended" ? "" : "danger"}" id="chg">${s.programStatus === "Ended" ? "Reactivate…" : "End program…"}</button>` : ""}</div>
    ${s.programStatus === "Ended" ? `<dl class="kv"><dt>Effective</dt><dd>${fmtDate(s.programEnded?.effectiveDate)}</dd><dt>Reason</dt><dd>${esc(s.programEnded?.reason)}</dd><dt>Remarks</dt><dd>${esc(s.programEnded?.remarks || "—")}</dd><dt>By</dt><dd>${esc(s.programEnded?.by?.name || "")}</dd></dl>` : ""}
    <p class="small muted">Ending the program stops new allowance periods that start on or after the effective date. Payments already approved stay payable, and all records remain available.</p>
    <h4>History</h4><ul class="timeline small">${hist.map(h => `<li class="${h.to === "Ended" ? "bad" : "done"}"><b>${esc(h.from)} → ${esc(h.to)}</b> effective ${fmtDate(h.effectiveDate)}<div class="when">${esc(h.reason)}${h.remarks ? ` — ${esc(h.remarks)}` : ""} · ${esc(h.by?.name || "")} · ${fmtDateTime(h.changedAt)}</div></li>`).join("") || "<li>No changes recorded.</li>"}</ul></div>`;
  $("#chg", el) && ($("#chg", el).onclick = async () => {
    const to = s.programStatus === "Ended" ? "Active" : "Ended";
    const v = await confirmBox({ title: to === "Ended" ? "End program membership" : "Reactivate program membership", danger: to === "Ended", confirmText: to === "Ended" ? "End program" : "Reactivate", fields: [
      { name: "effectiveDate", label: "Effective date", type: "date", required: true },
      { name: "reason", label: "Reason", type: to === "Ended" ? "select" : "text", options: ["Graduated", "Did not maintain academic requirements", "Stopped schooling", "Transferred out of the program", "Voluntary withdrawal", "Other"], required: true },
      { name: "remarks", label: "Remarks", type: "textarea" }] });
    if (v) busy(null, () => call("setProgramStatus", { studentId: s.studentId, status: to, ...v }), `Program status set to ${to}.`).then(reload).catch(() => {});
  });
}

function editStudent(s) {
  const q = s.qualification || {}, c = s.current || {};
  const f = (name, label, value, extra = {}) => fieldHtml({ name, label, value, ...extra });
  const m = openModal(`<h2>Edit ${esc(fullName(s))}</h2>
    <p class="small muted">Changes to identity, classification, Latin honor or qualification data need a reason and are kept in the audit trail.</p>
    <form id="ef" class="grid g3">
      <fieldset class="spanall grid g3"><legend>Identity</legend>
        ${f("surname", "Surname", s.surname)}${f("firstName", "First name", s.firstName)}${f("middleName", "Middle name", s.middleName)}
        ${f("extName", "Extension", s.extName)}${f("dateOfBirth", "Date of birth", s.dateOfBirth, { type: "date" })}${f("contact", "Contact", s.contact)}
        ${f("address", "Address", s.address, { span: "span2" })}${f("atmNumber", "ATM number", s.atmNumber)}</fieldset>
      <fieldset class="spanall grid g3"><legend>TOSCAN qualification</legend>
        ${f("classification", "Classification", s.classification, { type: "select", options: [["", "—"], ...Object.entries(CLASS_NAMES)] })}
        ${f("latinHonor", "Latin honor", s.latinHonor || "", { type: "select", options: LATIN.map(x => [x, x || "None"]) })}
        ${f("q.batch", "Batch", q.batch || s.batch)}${f("q.yearQualified", "Year qualified", q.yearQualified)}${f("q.schoolAtQualification", "School at qualification", q.schoolAtQualification)}
        ${f("q.admissionDate", "Admission date", q.admissionDate, { type: "date" })}${f("q.awardType", "Award information", q.awardType, { span: "span3" })}</fieldset>
      <fieldset class="spanall grid g3"><legend>Current academic information</legend>
        ${f("c.school", "School", c.school)}${f("c.schoolAddress", "School address", c.schoolAddress)}${f("c.level", "Level", c.level, { type: "select", options: ["", ...settings().lists.levels] })}
        ${f("c.program", "Program", c.program)}${f("c.yearLevel", "Year level", c.yearLevel)}${f("c.enrollmentStatus", "Enrollment status", c.enrollmentStatus, { type: "select", options: ["", "Enrolled", "Not Enrolled", "On Leave", "Graduated", "Transferred"] })}
        ${f("c.academicYear", "Academic year", c.academicYear)}${f("c.term", "Term", c.term, { type: "select", options: [["", "—"], ...Object.entries(TERM_NAMES)] })}${f("c.expectedGraduation", "Expected graduation", c.expectedGraduation, { type: "date" })}</fieldset>
      ${f("reason", "Reason for the change", "", { type: "textarea", span: "spanall" })}
      <div class="spanall modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary">Save</button></div></form>`, { size: "wide" });
  $("[data-c]", m).onclick = () => m.close();
  $("#ef", m).onsubmit = ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target).entries());
    const patch = { qualification: {}, current: {} };
    for (const [k, v] of Object.entries(d)) {
      if (k === "reason") continue;
      if (k.startsWith("q.")) patch.qualification[k.slice(2)] = v; else if (k.startsWith("c.")) patch.current[k.slice(2)] = v; else patch[k] = v;
    }
    busy(ev.target.querySelector(".btn.primary"), async () => {
      const r = await call("adminUpdateStudent", { studentId: s.studentId, patch, reason: d.reason });
      m.close(); toast(r.changed ? `${r.changed} field(s) updated.` : "Nothing changed.", "ok");
    }).catch(() => {});
  };
}

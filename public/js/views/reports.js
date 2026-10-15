// Reports: students, compliance, eligibility, payroll registers and allowance summaries.
// Money totals are computed from payroll lines (and imported historical payments),
// never from separately maintained summary figures.
import { S, settings, studentById } from "../state.js";
import { db, collection, query, where, getDocs } from "../fb.js";
import {
  $, $$, esc, opts, busy, fmtDate, money, docBadge, eligBadge, entBadge, payrollBadge, TERM_NAMES, TERM_SHORT, PERIOD_NAMES, CLASS_SHORT,
  fullName, renderTable, downloadCSV, downloadXLSX, printHtml, printHeader
} from "../ui.js";
import { termWindow } from "./common.js";
import { latestByRequirement, requirementApplies } from "../core/policy.js";

const all = async c => (await getDocs(collection(db, c))).docs.map(d => ({ id: d.id, ...d.data() }));
const batchOf = s => s?.qualification?.batch || s?.batch || "";
const sum = (rows, f) => rows.reduce((t, r) => t + Number(f(r) || 0), 0);

/** Released money from payroll lines of released payrolls + imported historical releases. */
async function releasedLines() {
  const [items, pays] = await Promise.all([all("payrollItems"), Promise.resolve(S.d.payrolls || [])]);
  const released = new Map(pays.filter(p => ["Released", "Archived"].includes(p.status)).map(p => [p.payrollNo, p]));
  const portal = items.filter(i => i.status === "Included" && released.has(i.payrollNo)).map(i => ({
    source: "Portal payroll", studentId: i.studentId, studentName: i.studentName, batch: i.batch, classification: i.classification,
    academicYear: i.academicYear, period: i.period, typeCode: i.typeCode, typeName: i.typeName, amount: i.amount,
    payrollNo: i.payrollNo, releasedAt: released.get(i.payrollNo).releasedAt, paymentRef: released.get(i.payrollNo).paymentRef
  }));
  const imported = (S.d.allowances || []).filter(e => e.source === "imported" && e.status === "Released").map(e => ({
    source: "Historical record", studentId: e.studentId, studentName: e.studentName, batch: e.batch, classification: e.classification,
    academicYear: e.academicYear, period: e.period, typeCode: e.typeCode, typeName: e.typeName || e.typeCode, amount: e.amount,
    payrollNo: e.payrollNo || "", releasedAt: e.releasedAt, paymentRef: e.paymentRef || ""
  }));
  return [...portal, ...imported];
}

const REPORTS = [
  { group: "Students", id: "students", title: "Student list" },
  { group: "Students", id: "studentCounts", title: "Student counts by group" },
  { group: "Compliance", id: "compliance", title: "Document compliance by term" },
  { group: "Compliance", id: "eligibility", title: "Qualified and not qualified students" },
  { group: "Allowance & payroll", id: "register", title: "Monthly payroll register" },
  { group: "Allowance & payroll", id: "summary", title: "Allowance summary" },
  { group: "Allowance & payroll", id: "released", title: "Released allowances" },
  { group: "Allowance & payroll", id: "pending", title: "Pending allowances" },
  { group: "Allowance & payroll", id: "historical", title: "Historical payroll register" },
  { group: "Allowance & payroll", id: "expenditure", title: "Total allowance expenditure" }
];

let current = "students", countsBy = "batch", summaryBy = "academicYear", complianceAY = null;
const rerun = () => reports(document.getElementById("main"));

export function reports(main) {
  main.innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><p>Filter, then export to Excel or CSV, or print / save as PDF.</p></div></div>
    <div class="split rep-split">
      <div class="card rep-menu" style="padding:.6rem">${[...new Set(REPORTS.map(r => r.group))].map(g => `<div class="xs muted" style="text-transform:uppercase;letter-spacing:.5px;margin:.6rem .4rem .3rem">${esc(g)}</div>${REPORTS.filter(r => r.group === g).map(r => `<button class="btn ghost block" style="justify-content:flex-start;${r.id === current ? "background:var(--gold-soft)" : ""}" data-r="${r.id}">${esc(r.title)}</button>`).join("")}`).join("")}</div>
      <div class="card"><div class="card-head"><h2 id="rt"></h2><div class="btn-row"><button class="btn sm" id="x-xlsx">Excel</button><button class="btn sm" id="x-csv">CSV</button><button class="btn sm" id="x-print">Print / PDF</button></div></div>
        <div id="rbody"><div class="loading">Preparing report…</div></div></div></div>`;
  $$("[data-r]", main).forEach(b => b.onclick = () => { current = b.dataset.r; reports(main); });
  $("#rt").textContent = REPORTS.find(r => r.id === current).title;
  build(current, $("#rbody")).then(table => {
    const out = () => { const cols = table.columns, rows = table.ctl.rows(); return { headers: cols.map(c => c.label), rows: rows.map(r => cols.map(c => c.value ? c.value(r) : r[c.key])) }; };
    const name = `toscan-${current}-${new Date().toISOString().slice(0, 10)}`;
    $("#x-csv").onclick = () => { const o = out(); downloadCSV(name, o.headers, o.rows); };
    $("#x-xlsx").onclick = e => busy(e.target, () => { const o = out(); return downloadXLSX(name, [{ name: REPORTS.find(r => r.id === current).title, headers: o.headers, rows: o.rows }]); }).catch(() => {});
    $("#x-print").onclick = () => {
      const o = out();
      printHtml(`${printHeader("TOSCAN PROGRAM REPORT", REPORTS.find(r => r.id === current).title + (table.subtitle ? ` — ${table.subtitle}` : ""))}
        <table class="pt"><thead><tr>${o.headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${o.rows.map(r => `<tr>${r.map(v => `<td>${esc(typeof v === "number" ? v.toLocaleString("en-PH", { minimumFractionDigits: 2 }) : v)}</td>`).join("")}</tr>`).join("")}</tbody></table>
        <p style="font-size:10px">Generated ${esc(new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }))} by ${esc(S.account?.displayName || S.account?.email || "")}. ${o.rows.length} row(s).</p>`);
    };
  }).catch(e => { $("#rbody").innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
}
reports.deps = [];

async function build(id, el) {
  const students = S.d.students || [];
  const ay = settings().currentAcademicYear;
  const years = [...new Set([...S.master.academicYears.map(a => a.id), ...(S.d.allowances || []).map(e => e.academicYear)])].sort().reverse();
  const batches = [...new Set(students.map(batchOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const schools = [...new Set(students.map(s => s.current?.school).filter(Boolean))].sort();
  const programs = [...new Set(students.map(s => s.current?.program).filter(Boolean))].sort();
  const F = {
    status: { key: "status", label: "Program", options: ["Active", "Ended"], test: (r, v) => ((r.s || r).programStatus || "Active") === v },
    cls: { key: "cls", label: "Class", options: Object.entries(CLASS_SHORT), test: (r, v) => (r.classification ?? r.s?.classification) === v },
    batch: { key: "batch", label: "Batch", options: batches, test: (r, v) => (r.batch ?? batchOf(r.s || r)) === v },
    ay: (value = "") => ({ key: "ay", label: "School year", options: years, value, test: (r, v) => r.academicYear === v }),
    period: { key: "period", label: "Period", options: Object.entries(PERIOD_NAMES), test: (r, v) => r.period === v }
  };
  const C = (label, value, render, cls) => ({ label, value, render: render || (r => esc(value(r))), sort: value, cls });
  const M = (label, f) => ({ label, value: r => Number(f(r) || 0), render: r => money(f(r)), sort: r => Number(f(r) || 0), cls: "right" });
  let cfg, subtitle = "";

  if (id === "students") {
    cfg = { rows: students, searchText: s => `${fullName(s)} ${s.studentId}`, filters: [F.status, F.cls, F.batch,
        { key: "school", label: "Current school", options: schools, test: (s, v) => s.current?.school === v },
        { key: "prog", label: "Program", options: programs, test: (s, v) => s.current?.program === v }],
      columns: [C("TOSCAN ID", s => s.studentId), C("Name", fullName), C("Batch", batchOf), C("Classification", s => CLASS_SHORT[s.classification] || ""),
        C("School at qualification", s => s.qualification?.schoolAtQualification || ""), C("Current school", s => s.current?.school || ""), C("Program", s => s.current?.program || ""),
        C("Year level", s => s.current?.yearLevel || ""), C("Academic year", s => s.current?.academicYear || ""), C("Latin honor", s => s.latinHonor || ""), C("Program status", s => s.programStatus || "Active")] };
  } else if (id === "studentCounts") {
    const keyFn = { batch: batchOf, school: s => s.current?.school || "(not recorded)", program: s => s.current?.program || "(not recorded)", classification: s => CLASS_SHORT[s.classification] || "Unclassified", academicYear: s => s.current?.academicYear || "(not recorded)", status: s => s.programStatus || "Active" }[countsBy];
    const groups = new Map();
    for (const s of students) { const k = keyFn(s) || "(none)"; const g = groups.get(k) || { group: k, total: 0, active: 0, ended: 0, top10: 0, top20: 0 }; g.total++; g[(s.programStatus || "Active") === "Ended" ? "ended" : "active"]++; if (s.classification) g[s.classification]++; groups.set(k, g); }
    el.innerHTML = `<div class="table-tools"><div><label>Group by</label><select id="gb" data-nodirty>${opts([["batch", "TOSCAN batch"], ["school", "Current school"], ["program", "Course / strand"], ["classification", "Classification"], ["academicYear", "Academic year"], ["status", "Program status"]], countsBy)}</select></div></div><div id="inner"></div>`;
    $("#gb", el).onchange = e => { countsBy = e.target.value; rerun(); };
    el = $("#inner", el);
    cfg = { rows: [...groups.values()], columns: [C("Group", r => r.group), C("Students", r => r.total, null, "right"), C("Active", r => r.active, null, "right"), C("Ended", r => r.ended, null, "right"), C("Top 10", r => r.top10, null, "right"), C("Top 20", r => r.top20, null, "right")],
      footer: list => `<tr><td>Total</td>${["total", "active", "ended", "top10", "top20"].map(k => `<td class="right">${sum(list, r => r[k])}</td>`).join("")}</tr>` };
  } else if (id === "compliance") {
    complianceAY = complianceAY || ay || years[0];
    el.innerHTML = `<div class="table-tools"><div><label>School year</label><select id="cay" data-nodirty>${opts(years, complianceAY)}</select></div></div><div id="inner"><div class="loading">Loading submissions…</div></div>`;
    $("#cay", el).onchange = e => { complianceAY = e.target.value; rerun(); };
    const subs = (await getDocs(query(collection(db, "submissions"), where("academicYear", "==", complianceAY)))).docs.map(d => d.data());
    const recs = (await getDocs(query(collection(db, "studentAcademicHistory"), where("academicYear", "==", complianceAY)))).docs.map(d => d.data());
    const exts = await all("deadlineExtensions");
    const rows = [];
    for (const s of students.filter(x => (x.programStatus || "Active") === "Active")) {
      const terms = new Set([...recs.filter(r => r.studentId === s.id).map(r => r.term), ...subs.filter(x => x.studentId === s.id).map(x => x.term)]);
      if (!terms.size) terms.add("T1");
      for (const term of terms) {
        const tSubs = subs.filter(x => x.studentId === s.id && x.term === term);
        const latest = latestByRequirement(tSubs);
        const approved = new Set(tSubs.filter(x => x.status === "Approved").map(x => x.requirementCode));
        const reqs = S.master.requirements.filter(r => requirementApplies(r, term) && r.requiredForAllowance !== false);
        const missing = reqs.filter(r => !approved.has(r.code) && !latest[r.code]);
        const returned = reqs.filter(r => !approved.has(r.code) && latest[r.code]?.status === "Returned");
        const review = reqs.filter(r => !approved.has(r.code) && ["Submitted", "Under Review"].includes(latest[r.code]?.status));
        const w = termWindow({ studentId: s.id, academicYear: complianceAY, term, record: recs.find(r => r.studentId === s.id && r.term === term), extensions: exts });
        const state = !missing.length && !returned.length && !review.length ? "Complete" : (w.state === "closed" && (missing.length || returned.length)) ? "Overdue" : returned.length ? "Returned" : review.length && !missing.length ? "Under review" : "Incomplete";
        rows.push({ s, studentId: s.id, term, academicYear: complianceAY, approved: approved.size, total: reqs.length, missing: missing.map(r => r.name).join(", "), returned: returned.map(r => r.name).join(", "), review: review.map(r => r.name).join(", "), state, deadline: w.win.deadlineDate || "" });
      }
    }
    subtitle = `SY ${complianceAY}`;
    el = $("#inner", el);
    cfg = { rows, searchText: r => `${fullName(r.s)} ${r.studentId}`, filters: [
        { key: "state", label: "Compliance", options: ["Complete", "Incomplete", "Under review", "Returned", "Overdue"], test: (r, v) => r.state === v },
        { key: "term", label: "Term", options: Object.entries(TERM_NAMES), test: (r, v) => r.term === v }, F.cls, F.batch],
      columns: [C("Student", r => fullName(r.s)), C("TOSCAN ID", r => r.studentId), C("Term", r => TERM_SHORT[r.term]), C("Approved", r => `${r.approved}/${r.total}`),
        C("Missing", r => r.missing), C("Returned", r => r.returned), C("Under review", r => r.review), C("Deadline", r => r.deadline, r => r.deadline ? fmtDate(r.deadline) : "—"),
        { label: "Status", value: r => r.state, render: r => `<span class="badge ${{ Complete: "b-ok", Overdue: "b-bad", Returned: "b-bad", "Under review": "b-info" }[r.state] || "b-warn"}">${esc(r.state)}</span>`, sort: r => r.state }] };
  } else if (id === "eligibility") {
    const rows = (S.d.eligibility || []).map(e => ({ ...e, s: studentById(e.studentId) || {} }));
    cfg = { rows, searchText: r => `${fullName(r.s)} ${r.studentId}`, filters: [
        { key: "st", label: "Status", options: ["Qualified", "Not Qualified", "Included in Payroll", "Released", "For Review", "Pending Documents", "Returned for Correction"], test: (r, v) => r.status === v },
        F.ay(ay), F.period, F.cls, F.batch],
      columns: [C("Student", r => fullName(r.s) || r.studentName), C("TOSCAN ID", r => r.studentId), C("School year", r => r.academicYear), C("Period", r => PERIOD_NAMES[r.period]),
        { label: "Status", value: r => r.status, render: r => eligBadge(r.status), sort: r => r.status }, C("Reason", r => r.decision?.reason || ""), C("Decided by", r => r.decision?.by?.name || "")] };
  } else if (id === "register") {
    const items = await all("payrollItems");
    const pays = new Map((S.d.payrolls || []).map(p => [p.payrollNo, p]));
    const rows = items.filter(i => i.status === "Included").map(i => ({ ...i, p: pays.get(i.payrollNo) || {} }));
    const months = [...new Set(rows.map(r => r.month))].sort().reverse();
    cfg = { rows, searchText: r => `${r.studentName} ${r.studentId} ${r.payrollNo}`, filters: [
        { key: "m", label: "Payroll month", options: months, value: months[0] || "", test: (r, v) => r.month === v },
        { key: "ps", label: "Payroll status", options: ["Draft", "Generated", "For Review", "Approved", "Released", "Archived"], test: (r, v) => r.p.status === v }, F.batch],
      columns: [C("Payroll no.", r => r.payrollNo), C("Month", r => r.month), { label: "Payroll status", value: r => r.p.status || "", render: r => payrollBadge(r.p.status) }, C("Student", r => r.studentName), C("TOSCAN ID", r => r.studentId),
        C("Batch", r => r.batch), C("Class", r => CLASS_SHORT[r.classification] || ""), C("School", r => r.school), C("Allowance", r => r.typeName), C("Period", r => `${PERIOD_NAMES[r.period]} ${r.academicYear}`), M("Amount", r => r.amount),
        C("Released", r => r.p.releasedAt || "")],
      footer: list => `<tr><td colspan="10">Total</td><td class="right">${money(sum(list, r => r.amount))}</td><td></td></tr>` };
  } else if (id === "summary") {
    const released = await releasedLines();
    const pending = (S.d.allowances || []).filter(e => !["Released", "Cancelled"].includes(e.status));
    const keyFn = { period: r => `${r.academicYear} · ${PERIOD_NAMES[r.period]}`, academicYear: r => r.academicYear, batch: r => r.batch || "(none)", student: r => `${r.studentName} (${r.studentId})`, category: r => r.typeName || r.typeCode }[summaryBy] || (r => r.academicYear);
    const groups = new Map();
    const add = (r, k2) => { const k = keyFn(r); const g = groups.get(k) || { group: k, released: 0, releasedCount: 0, pending: 0, pendingCount: 0 }; g[k2] += Number(r.amount || 0); g[k2 + "Count"]++; groups.set(k, g); };
    released.forEach(r => add(r, "released")); pending.forEach(r => add(r, "pending"));
    el.innerHTML = `<div class="table-tools"><div><label>Summarize by</label><select id="gb" data-nodirty>${opts([["period", "Semester / allowance period"], ["academicYear", "School year"], ["batch", "TOSCAN batch"], ["student", "Student"], ["category", "Allowance category"]], summaryBy)}</select></div></div><div id="inner"></div>`;
    $("#gb", el).onchange = e => { summaryBy = e.target.value; rerun(); };
    el = $("#inner", el);
    cfg = { rows: [...groups.values()].sort((a, b) => b.group.localeCompare(a.group)), columns: [C("Group", r => r.group), C("Paid (count)", r => r.releasedCount, null, "right"), M("Released", r => r.released), C("Pending (count)", r => r.pendingCount, null, "right"), M("Pending", r => r.pending)],
      footer: list => `<tr><td>Total</td><td class="right">${sum(list, r => r.releasedCount)}</td><td class="right">${money(sum(list, r => r.released))}</td><td class="right">${sum(list, r => r.pendingCount)}</td><td class="right">${money(sum(list, r => r.pending))}</td></tr>` };
  } else if (id === "released") {
    const rows = await releasedLines();
    cfg = { rows, searchText: r => `${r.studentName} ${r.studentId} ${r.payrollNo}`, filters: [F.ay(), F.period, F.batch, F.cls, { key: "src", label: "Source", options: ["Portal payroll", "Historical record"], test: (r, v) => r.source === v }],
      columns: [C("Student", r => r.studentName), C("TOSCAN ID", r => r.studentId), C("Batch", r => r.batch), C("School year", r => r.academicYear), C("Period", r => PERIOD_NAMES[r.period]), C("Allowance", r => r.typeName), M("Amount", r => r.amount), C("Payroll no.", r => r.payrollNo), C("Released", r => r.releasedAt || ""), C("Reference", r => r.paymentRef || ""), C("Source", r => r.source)],
      footer: list => `<tr><td colspan="6">Total</td><td class="right">${money(sum(list, r => r.amount))}</td><td colspan="4"></td></tr>` };
  } else if (id === "pending") {
    const rows = (S.d.allowances || []).filter(e => !["Released", "Cancelled"].includes(e.status));
    cfg = { rows, searchText: r => `${r.studentName} ${r.studentId}`, filters: [F.ay(), F.period, F.batch, { key: "st", label: "Status", options: ["Awaiting Payroll", "Payroll In Progress", "Included in Payroll"], test: (r, v) => r.status === v }],
      columns: [C("Student", r => r.studentName), C("TOSCAN ID", r => r.studentId), C("Batch", r => r.batch), C("School year", r => r.academicYear), C("Period", r => PERIOD_NAMES[r.period]), C("Allowance", r => r.typeName || r.typeCode), M("Amount", r => r.amount), { label: "Status", value: r => r.status, render: r => entBadge(r.status), sort: r => r.status }, C("Payroll no.", r => r.payrollNo || "")],
      footer: list => `<tr><td colspan="6">Total</td><td class="right">${money(sum(list, r => r.amount))}</td><td colspan="2"></td></tr>` };
  } else if (id === "historical") {
    const rows = await all("historicalPayments");
    cfg = { rows, searchText: r => `${r.studentName} ${r.studentId} ${r.payrollNo}`, filters: [F.ay(), F.period, { key: "st", label: "Status", options: ["Released", "Unpaid"], test: (r, v) => r.status === v }],
      columns: [C("Student", r => r.studentName), C("TOSCAN ID", r => r.studentId), C("School year", r => r.academicYear), C("Semester", r => TERM_SHORT[r.term] || ""), C("Period", r => PERIOD_NAMES[r.period]), C("Category", r => r.typeCode), M("Amount", r => r.amount), C("Payroll no.", r => r.payrollNo), C("Payroll date", r => r.payrollDate), C("Released", r => r.releaseDate), C("Status", r => r.status), C("Source", r => r.source), C("Imported by", r => r.importedBy?.name || "")],
      footer: list => `<tr><td colspan="6">Total</td><td class="right">${money(sum(list, r => r.amount))}</td><td colspan="6"></td></tr>` };
  } else if (id === "expenditure") {
    const rows0 = await releasedLines();
    const groups = new Map();
    for (const r of rows0) { const k = `${r.academicYear}|${r.typeName}`; const g = groups.get(k) || { academicYear: r.academicYear, category: r.typeName, portal: 0, historical: 0, count: 0 }; g[r.source === "Portal payroll" ? "portal" : "historical"] += Number(r.amount || 0); g.count++; groups.set(k, g); }
    cfg = { rows: [...groups.values()].sort((a, b) => b.academicYear.localeCompare(a.academicYear)), filters: [F.ay()],
      columns: [C("School year", r => r.academicYear), C("Category", r => r.category), C("Payments", r => r.count, null, "right"), M("From portal payrolls", r => r.portal), M("From historical records", r => r.historical), M("Total released", r => r.portal + r.historical)],
      footer: list => `<tr><td colspan="2">Total</td><td class="right">${sum(list, r => r.count)}</td><td class="right">${money(sum(list, r => r.portal))}</td><td class="right">${money(sum(list, r => r.historical))}</td><td class="right">${money(sum(list, r => r.portal + r.historical))}</td></tr>` };
  }
  const ctl = renderTable(el, { id: `rep-${id}`, pageSize: 50, empty: "No data for this report yet.", ...cfg });
  return { ctl, columns: cfg.columns, subtitle };
}

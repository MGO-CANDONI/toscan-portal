// Payroll list, generation, review/approval/release workflow, print and export.
import { S, settings, can, isAdmin, studentById } from "../state.js";
import { db, collection, query, where, getDocs, call } from "../fb.js";
import {
  $, $$, esc, toast, busy, fmtDate, fmtDateTime, money, payrollBadge, entBadge, PERIOD_NAMES, CLASS_SHORT, fullName,
  renderTable, confirmBox, downloadCSV, downloadXLSX, printHtml, printHeader, manilaToday
} from "../ui.js";

const ACTIVE = ["Draft", "Generated", "For Review", "Approved"];
const ACTION_NAMES = { generated: "Generated", submitReview: "Forwarded to Accounting", review: "Reviewed", approve: "Approved", release: "Released", archive: "Archived", void: "Voided", removeItem: "Line removed" };

export function list(main) {
  const pays = [...(S.d.payrolls || [])].sort((a, b) => b.payrollNo.localeCompare(a.payrollNo));
  const awaiting = (S.d.allowances || []).filter(e => e.status === "Awaiting Payroll");
  const cfg = settings().payroll;
  main.innerHTML = `
    <div class="page-head"><div><h1>Payroll</h1><p>${cfg.autoGenerate ? `A payroll draft is generated automatically on day ${esc(cfg.dayOfMonth)} of each month from every qualified allowance not yet paid.` : "Automatic monthly generation is off."} Each allowance period is paid once only.</p></div>
      ${can("preparePayroll") ? `<button class="btn primary" id="gen" ${awaiting.length ? "" : "disabled"}>Generate payroll now</button>` : ""}</div>
    <div class="stats">
      <div class="stat"><div class="n">${awaiting.length}</div><div class="l">Allowances awaiting payroll</div></div>
      <div class="stat"><div class="n">${money(awaiting.reduce((t, e) => t + Number(e.amount || 0), 0))}</div><div class="l">Amount awaiting payroll</div></div>
      <div class="stat"><div class="n">${pays.filter(p => ACTIVE.includes(p.status)).length}</div><div class="l">Payrolls in progress</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Payrolls</h3></div><div id="t"></div></div>
    ${awaiting.length ? `<div class="card"><div class="card-head"><h3>Waiting for the next payroll</h3></div><div class="table-wrap"><table>
      <thead><tr><th>Student</th><th>Period</th><th>Allowance</th><th class="right">Amount</th><th>Qualified by</th><th>Source</th></tr></thead>
      <tbody>${awaiting.map(e => `<tr><td>${esc(e.studentName)}<div class="xs muted mono">${esc(e.studentId)}</div></td><td>${esc(PERIOD_NAMES[e.period])}, AY ${esc(e.academicYear)}</td><td>${esc(e.typeName || e.typeCode)}</td><td class="right">${money(e.amount)}</td><td class="small">${esc(e.qualifiedBy?.name || "")}</td><td class="small">${e.source === "imported" ? "Historical (unpaid)" : "Portal"}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
  renderTable($("#t", main), {
    id: "payrolls", rows: pays, pageSize: 20,
    searchText: p => `${p.payrollNo} ${p.month}`,
    filters: [{ key: "st", label: "Status", options: ["Draft", "Generated", "For Review", "Approved", "Released", "Archived", "Voided"], test: (p, v) => p.status === v }],
    columns: [
      { label: "Payroll no.", render: p => `<b class="mono">${esc(p.payrollNo)}</b>${p.auto ? ` <span class="badge">Auto</span>` : ""}`, sort: p => p.payrollNo },
      { label: "Month", render: p => esc(p.month), sort: p => p.month },
      { label: "Periods", render: p => (p.periods || []).map(x => PERIOD_NAMES[x]).join(", ") + `<div class="xs muted">${esc((p.academicYears || []).join(", "))}</div>` },
      { label: "Lines", render: p => esc(p.itemCount), sort: p => p.itemCount, cls: "right" },
      { label: "Total", render: p => money(p.total), sort: p => p.total, cls: "right" },
      { label: "Status", render: p => payrollBadge(p.status), sort: p => p.status },
      { label: "DV No.", render: p => p.dvNo ? `<span class="mono">${esc(p.dvNo)}</span>` : "—", sort: p => p.dvNo || "" },
      { label: "Released", render: p => p.releasedAt ? `${fmtDate(p.releasedAt)}<div class="xs muted">${esc(p.paymentRef)}</div>` : "—" }
    ],
    empty: "No payrolls yet.",
    onRow: p => { location.hash = `#/payroll/${encodeURIComponent(p.payrollNo)}`; }
  });
  $("#gen") && ($("#gen").onclick = async e => {
    const v = await confirmBox({ title: "Generate payroll", body: `Builds a payroll from the ${awaiting.length} qualified allowance(s) waiting. Allowances already in a payroll or paid are never included again.`, confirmText: "Generate", fields: [{ name: "month", label: "Payroll month", type: "month", value: manilaToday().slice(0, 7), required: true }] });
    if (!v) return;
    busy(e.target, async () => {
      const r = await call("generatePayroll", { month: v.month });
      if (r.skipped) toast(r.skipped); else { toast(`Payroll ${r.payrollNo} created: ${r.itemCount} line(s), ${money(r.total)}.`, "ok"); location.hash = `#/payroll/${r.payrollNo}`; }
    }).catch(() => {});
  });
}
list.deps = ["r:payrolls", "r:allowances", "settings"];

async function items(no) {
  const snap = await getDocs(query(collection(db, "payrollItems"), where("payrollNo", "==", no)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => `${a.batch}|${a.studentName}`.localeCompare(`${b.batch}|${b.studentName}`, undefined, { numeric: true }));
}

export async function detail(main, [no]) {
  const p = (S.d.payrolls || []).find(x => x.payrollNo === no);
  if (!p) { main.innerHTML = S.d.payrolls ? `<div class="notice bad">Payroll ${esc(no)} was not found.</div>` : `<div class="loading">Loading…</div>`; return; }
  const all = await items(no);
  const lines = all.filter(i => i.status === "Included");
  const other = all.filter(i => i.status !== "Included");
  const total = lines.reduce((t, i) => t + Number(i.amount || 0), 0);
  const editable = ["Draft", "Generated", "For Review"].includes(p.status) && can("preparePayroll");
  const me = S.user.uid;
  const btn = (action, label, cls = "", show = true) => show ? `<button class="btn ${cls}" data-act="${action}">${esc(label)}</button>` : "";
  main.innerHTML = `
    <div class="page-head"><div><a href="#/payroll" class="small">← Payroll</a><h1 class="mono" style="margin-top:.3rem">${esc(p.payrollNo)} ${payrollBadge(p.status)}</h1>
      <p>Payroll month ${esc(p.month)} · ${lines.length} line(s) · ${money(total)}${p.dvNo ? ` · DV No. ${esc(p.dvNo)}` : ""}</p></div>
      <div class="btn-row"><button class="btn" id="print">Print / PDF</button><button class="btn" id="xlsx">Excel</button><button class="btn" id="csv">CSV</button></div></div>
    ${p.status === "Voided" ? `<div class="notice bad">Voided: ${esc(p.voidReason || "")}. Its allowances were returned to the waiting list.</div>` : ""}
    <div class="split">
      <div class="card"><div class="card-head"><h3>Lines</h3>${editable ? `<span class="xs muted">Removing a line returns that allowance to the waiting list.</span>` : ""}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Student</th><th>Batch</th><th>Class</th><th>School</th><th>Allowance</th><th>Period</th><th>ATM</th><th class="right">Amount</th>${editable ? "<th></th>" : ""}</tr></thead>
          <tbody>${lines.map((i, n) => `<tr><td>${n + 1}</td><td><a href="#/students/${encodeURIComponent(i.studentId)}">${esc(i.studentName)}</a><div class="xs muted mono">${esc(i.studentId)}</div></td><td>${esc(i.batch)}</td><td>${esc(CLASS_SHORT[i.classification] || "")}</td><td class="small">${esc(i.school)}</td><td>${esc(i.typeName)}</td><td class="small">${esc(PERIOD_NAMES[i.period])}<br>AY ${esc(i.academicYear)}</td><td class="mono small">${esc(i.atmNumber)}</td><td class="right">${money(i.amount)}</td>${editable ? `<td><button class="btn sm danger" data-rm="${esc(i.id)}">Remove</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="10" class="empty">No lines.</td></tr>`}</tbody>
          <tfoot><tr><td colspan="8">Total</td><td class="right">${money(total)}</td>${editable ? "<td></td>" : ""}</tr></tfoot></table></div>
        ${other.length ? `<details style="margin-top:.8rem"><summary class="small">Removed or voided lines (${other.length})</summary><ul class="small">${other.map(i => `<li>${esc(i.studentName)} — ${esc(i.typeName)} ${money(i.amount)}: ${esc(i.status)}${i.removedReason ? ` (${esc(i.removedReason)})` : ""}</li>`).join("")}</ul></details>` : ""}</div>
      <div>
        <div class="card"><h3>Workflow</h3>
          <ul class="timeline small">
            <li class="done"><b>Generated</b><div class="when">${esc(p.generatedBy?.name || "")} · ${fmtDateTime(p.createdAt)}</div></li>
            <li class="${p.preparedBy ? "done" : "current"}"><b>Forwarded to Accounting${p.dvNo ? ` — DV No. ${esc(p.dvNo)}` : ""}</b><div class="when">${p.preparedBy ? `${esc(p.preparedBy.name)} · ${fmtDateTime(p.preparedBy.at)}` : "Pending — assign the DV number once the payroll is with the Accounting Office"}</div></li>
            <li class="${p.reviewedBy ? "done" : ""}"><b>Reviewed</b><div class="when">${p.reviewedBy ? `${esc(p.reviewedBy.name)} · ${fmtDateTime(p.reviewedBy.at)}` : "Pending"}</div></li>
            <li class="${p.approvedBy ? "done" : ""}"><b>Approved / finalized</b><div class="when">${p.approvedBy ? `${esc(p.approvedBy.name)} · ${fmtDateTime(p.approvedBy.at)}` : "Pending"}</div></li>
            <li class="${p.releasedAt ? "done" : ""}"><b>Released</b><div class="when">${p.releasedAt ? `${fmtDate(p.releasedAt)} · Ref. ${esc(p.paymentRef)} · ${esc(p.releasedBy?.name || "")}` : "Pending"}</div></li>
          </ul>
          <div class="btn-row">
            ${btn("submitReview", "Forward to Accounting…", "primary", ["Draft", "Generated"].includes(p.status) && can("preparePayroll"))}
            ${btn("review", "Mark as reviewed", "primary", p.status === "For Review" && !p.reviewedBy && can("preparePayroll") && (p.preparedBy?.uid !== me || isAdmin()))}
            ${btn("approve", "Approve & finalize", "ok", p.status === "For Review" && p.reviewedBy && can("approvePayroll"))}
            ${btn("release", "Record release…", "ok", p.status === "Approved" && can("releasePayroll"))}
            ${btn("archive", "Archive", "", p.status === "Released" && can("approvePayroll"))}
            ${btn("void", "Void…", "danger", ACTIVE.includes(p.status) && can("approvePayroll"))}
          </div>
          ${p.status === "For Review" && p.preparedBy?.uid === me && !isAdmin() ? `<p class="xs muted">A different staff member must review a payroll you prepared.</p>` : ""}
        </div>
        <div class="card"><h3>Activity</h3><ul class="timeline small">${(p.history || []).slice().reverse().map(h => `<li><b>${esc(ACTION_NAMES[h.action] || h.action)}</b><div class="when">${fmtDateTime(h.at)} · ${esc(h.by)}${h.reason ? ` · ${esc(h.reason)}` : ""}${h.dvNo ? ` · DV No. ${esc(h.dvNo)}` : ""}${h.paymentRef ? ` · Ref. ${esc(h.paymentRef)}` : ""}</div></li>`).join("")}</ul></div>
      </div></div>`;

  $$("[data-act]", main).forEach(b => b.onclick = async () => {
    const action = b.dataset.act;
    let extra = {};
    if (action === "submitReview") {
      const v = await confirmBox({ title: "Forward to the Accounting Office", body: `${lines.length} line(s), ${money(total)}. Enter the Disbursement Voucher number assigned to this payroll. The DV number shows that the document is with the Accounting Office for processing.`, confirmText: "Forward with DV No.", fields: [
        { name: "dvNo", label: "DV No.", placeholder: "e.g. 2026-10-0012", required: true }] });
      if (!v) return; extra = v;
    } else if (action === "release") {
      const v = await confirmBox({ title: "Record payroll release", body: "Enter the actual payment details. Students are notified that their allowance was released.", confirmText: "Record release", fields: [
        { name: "paymentDate", label: "Actual payment date", type: "date", max: manilaToday(), required: true },
        { name: "paymentRef", label: "Payment reference (check, LDDAP-ADA or DV number)", required: true }] });
      if (!v) return; extra = v;
    } else if (action === "void") {
      const v = await confirmBox({ title: "Void this payroll?", body: "Its allowances return to the waiting list for a future payroll. This can't be undone.", danger: true, confirmText: "Void payroll", fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }] });
      if (!v) return; extra = v;
    } else if (action === "approve") {
      if (!(await confirmBox({ title: "Approve and finalize?", body: `${lines.length} line(s), ${money(total)}. Amounts are locked after approval.`, confirmText: "Approve" }))) return;
    }
    busy(b, () => call("payrollAction", { payrollNo: no, action, ...extra }), "Payroll updated.").then(() => detail(main, [no])).catch(() => {});
  });
  $$("[data-rm]", main).forEach(b => b.onclick = async () => {
    const v = await confirmBox({ title: "Remove this line?", body: "The allowance goes back to the waiting list.", danger: true, confirmText: "Remove", fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }] });
    if (v) busy(b, () => call("payrollAction", { payrollNo: no, action: "removeItem", itemId: b.dataset.rm, reason: v.reason }), "Line removed.").then(() => detail(main, [no])).catch(() => {});
  });
  const headers = ["No.", "Payroll No.", "Payroll Month", "School Year", "Allowance Period", "Student Name", "TOSCAN ID", "Batch", "Classification", "Current School", "Allowance Type", "ATM Number", "Amount"];
  const rows = lines.map((i, n) => [n + 1, p.payrollNo, p.month, i.academicYear, PERIOD_NAMES[i.period], i.studentName, i.studentId, i.batch, CLASS_SHORT[i.classification] || "", i.school, i.typeName, i.atmNumber, Number(i.amount)]);
  const totalRow = ["", "", "", "", "", "TOTAL", "", "", "", "", "", "", total];
  $("#csv").onclick = () => downloadCSV(`${p.payrollNo}`, headers, [...rows, totalRow]);
  $("#xlsx").onclick = e => busy(e.target, () => downloadXLSX(p.payrollNo, [{ name: p.payrollNo, headers, rows: [...rows, totalRow] }])).catch(() => {});
  $("#print").onclick = () => printPayroll(p, lines, total);
}
detail.deps = ["r:payrolls"];

function printPayroll(p, lines, total) {
  const cfg = settings().payroll;
  const sig = p.signatories || cfg.signatories, titles = p.signatoryTitles || cfg.signatoryTitles || {};
  const T = { a: titles.a || "Authorized Personnel", b: titles.b || "Head, Accounting Division", c: titles.c || "Head, Treasury Division", d: titles.d || "Local Chief Executive" };
  printHtml(`${printHeader("TOSCAN ALLOWANCE PAYROLL", `Ten Outstanding Students of Candoni — Payroll No. ${p.payrollNo}`)}
    <div class="pmeta"><span>Payroll month: <b>${esc(p.month)}</b></span><span>School year(s): <b>${esc((p.academicYears || []).join(", "))}</b></span><span>Allowance period(s): <b>${esc((p.periods || []).map(x => PERIOD_NAMES[x]).join(", "))}</b></span><span>DV No.: <b>${esc(p.dvNo || "—")}</b></span><span>Status: <b>${esc(p.status)}</b></span></div>
    <table class="pt"><thead><tr><th>No.</th><th>Student Name</th><th>TOSCAN ID</th><th>Batch</th><th>Class.</th><th>Current School</th><th>Allowance Type</th><th>Period / SY</th><th>ATM Number</th><th style="text-align:right">Amount</th><th>Signature</th></tr></thead>
    <tbody>${lines.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.studentName)}</td><td>${esc(i.studentId)}</td><td>${esc(i.batch)}</td><td>${esc(CLASS_SHORT[i.classification] || "")}</td><td>${esc(i.school)}</td><td>${esc(i.typeName)}</td><td>${esc(PERIOD_NAMES[i.period])} ${esc(i.academicYear)}</td><td>${esc(i.atmNumber)}</td><td style="text-align:right">${money(i.amount)}</td><td style="width:90px"></td></tr>`).join("")}
      <tr><td colspan="9" style="text-align:right;font-weight:700">TOTAL</td><td style="text-align:right;font-weight:700">${money(total)}</td><td></td></tr></tbody></table>
    <div class="pmeta" style="margin-top:8px"><span>Prepared by: ${esc(p.preparedBy?.name || "")}</span><span>Reviewed by: ${esc(p.reviewedBy?.name || "")}</span><span>Approved by: ${esc(p.approvedBy?.name || "")}</span><span>Released: ${p.releasedAt ? `${esc(p.releasedAt)} · Ref. ${esc(p.paymentRef)}` : "—"}</span></div>
    <div class="sigs">
      <div>A. Certified: Services duly rendered as stated.<div class="nm">${esc(sig.a)}</div><div class="tt">${esc(T.a)}</div></div>
      <div>B. Certified: Supporting documents complete and proper.<div class="nm">${esc(sig.b)}</div><div class="tt">${esc(T.b)}</div></div>
      <div>C. Certified: Cash available.<div class="nm">${esc(sig.c)}</div><div class="tt">${esc(T.c)}</div></div>
      <div>D. Approved for payment.<div class="nm">${esc(sig.d)}</div><div class="tt">${esc(T.d)}</div></div>
    </div>`);
}

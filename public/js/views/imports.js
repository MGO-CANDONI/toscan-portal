// Historical payment encoding/import, bulk student import, old-portal migration.
import { S, isAdmin } from "../state.js";
import { db, collection, getDocs, call, storage, ref, uploadBytes } from "../fb.js";
import {
  $, $$, esc, toast, busy, opts, fmtDateTime, money, TERM_NAMES, PERIOD_NAMES, fullName, datalist, downloadCSV, readSpreadsheet, confirmBox
} from "../ui.js";

const HIST_HEADERS = ["TOSCAN ID", "Student Name", "School Year", "Semester", "Allowance Period", "Category", "Amount", "Payroll Number", "Payroll Date", "Release Date", "Status", "Remarks"];
const STUDENT_HEADERS = ["TOSCAN ID", "Surname", "First Name", "Middle Name", "Extension", "Date of Birth", "Email", "Contact", "Address", "Batch", "Year Qualified", "School at Qualification", "Admission Date", "Classification", "Current School", "Program", "Year Level", "Educational Level", "Latin Honor", "ATM Number", "Program Status"];

function previewTable(res) {
  return `<div class="notice ${res.summary.invalid ? "warn" : "ok"}">${res.summary.valid} of ${res.summary.total} row(s) are valid${res.summary.invalid ? `; ${res.summary.invalid} have errors and will be skipped` : ""}.${res.dryRun ? " Nothing has been saved yet." : ""}</div>
    <div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Row</th><th>Result</th><th>Record</th><th>Messages</th></tr></thead><tbody>
    ${res.results.map(r => `<tr><td>${r.index + 2}</td><td>${r.ok ? `<span class="badge b-ok">${res.dryRun ? "Valid" : "Saved"}</span>` : `<span class="badge b-bad">Error</span>`}</td>
      <td class="small">${esc(r.studentId || r.value?.studentId || r.value?.toscanId || "")} ${esc(r.value?.surname ? `${r.value.surname}, ${r.value.firstName}` : "")} ${r.value?.academicYear ? `${esc(r.value.academicYear)} ${esc(PERIOD_NAMES[r.value.period] || "")} ${esc(r.value.typeCode || "")} ${r.value.amount != null ? money(r.value.amount) : ""}` : ""}</td>
      <td class="small">${[...(r.errors || []).map(e => `<span style="color:var(--bad)">${esc(e)}</span>`), ...(r.warnings || []).map(w => `<span class="muted">${esc(w)}</span>`)].join("<br>")}</td></tr>`).join("")}</tbody></table></div>`;
}

/** File → dry run → confirm → import. */
function importer(el, { kind, headers, templateName, extra = "", getExtra = () => ({}) }) {
  el.innerHTML = `<div class="grid g3" style="align-items:end">
      <div><label>CSV or Excel file</label><input type="file" accept=".csv,.xlsx,.xls" data-file data-nodirty></div>
      ${extra}
      <div class="btn-row"><button class="btn" data-tpl>Download template</button><button class="btn primary" data-preview disabled>Check file</button></div></div>
    <div data-out style="margin-top:1rem"></div>`;
  let rows = null;
  $("[data-tpl]", el).onclick = () => downloadCSV(templateName, headers, []);
  $("[data-file]", el).onchange = async e => {
    const f = e.target.files[0]; rows = null; $("[data-preview]", el).disabled = true; $("[data-out]", el).innerHTML = "";
    if (!f) return;
    try { rows = await readSpreadsheet(f); $("[data-preview]", el).disabled = !rows.length; $("[data-out]", el).innerHTML = `<p class="small muted">${rows.length} row(s) read from ${esc(f.name)}.</p>`; }
    catch (err) { toast(err.message, "err"); }
  };
  $("[data-preview]", el).onclick = e => busy(e.target, async () => {
    const extraData = await getExtra(false);
    const res = await call("importRecords", { kind, rows, dryRun: true, ...extraData });
    $("[data-out]", el).innerHTML = previewTable(res) + (res.summary.valid ? `<div class="btn-row end" style="margin-top:.8rem"><button class="btn ok" data-run>Import ${res.summary.valid} valid row(s)</button></div>` : "");
    $("[data-run]", el) && ($("[data-run]", el).onclick = ev => busy(ev.target, async () => {
      if (!(await confirmBox({ title: `Import ${res.summary.valid} row(s)?`, body: "Rows are checked again before saving. Duplicates are never saved.", confirmText: "Import" }))) return;
      const done = await call("importRecords", { kind, rows, dryRun: false, ...(await getExtra(true)) });
      $("[data-out]", el).innerHTML = previewTable(done);
      toast(`${done.summary.valid} row(s) imported.`, "ok");
    }).catch(() => {}));
  }).catch(() => {});
}

/* ---------------- Historical records ---------------- */
export function historical(main) {
  const students = S.d.students || [];
  const types = S.master.allowanceTypes;
  main.innerHTML = `
    <div class="page-head"><div><h1>Historical Records</h1><p>Encode allowances paid before the portal. Released records are marked as imported and are never paid again by a new payroll.</p></div></div>
    <div class="card"><h3>Encode one payment</h3>
      <form id="hf" class="grid g4">
        <div class="span2"><label class="req">Student</label><input type="text" name="TOSCAN ID" list="dl-st" placeholder="Type a name or TOSCAN ID" required>${datalist("dl-st", students.map(s => s.id))}
          <div class="xs muted" id="st-name"></div></div>
        <div><label class="req">School year</label><input type="text" name="School Year" placeholder="2024-2025" required></div>
        <div><label>Semester</label><select name="Semester">${opts(Object.entries(TERM_NAMES).map(([k, v]) => [v, v]), "", "—")}</select></div>
        <div><label>Allowance period</label><select name="Allowance Period">${opts(Object.entries(PERIOD_NAMES).map(([k, v]) => [v, v]), "", "From semester")}</select></div>
        <div><label class="req">Category</label><select name="Category">${opts(types.map(t => [t.code, t.name]), "REG")}</select></div>
        <div><label class="req">Amount (₱)</label><input type="number" name="Amount" min="0" step="0.01" required></div>
        <div><label>Payroll number</label><input type="text" name="Payroll Number"></div>
        <div><label>Payroll date</label><input type="date" name="Payroll Date"></div>
        <div><label>Release date</label><input type="date" name="Release Date"></div>
        <div><label>Payment status</label><select name="Status">${opts([["Released", "Released (paid)"], ["Unpaid", "Unpaid (queue for next payroll)"]], "Released")}</select></div>
        <div class="span2"><label>Remarks</label><input type="text" name="Remarks"></div>
        <div class="span2 btn-row end" style="align-self:end"><button class="btn primary" type="submit">Save record</button></div>
        <div class="spanall form-msg err" id="hmsg"></div>
      </form></div>
    <div class="card"><h3>Import a spreadsheet</h3><p class="small muted">Columns: ${esc(HIST_HEADERS.join(", "))}. Use the TOSCAN ID where possible; names must match exactly one student. Dates as YYYY-MM-DD or MM/DD/YYYY.</p><div id="imp"></div></div>
    <div class="card"><h3>Recent imports</h3><div id="recent" class="loading">Loading…</div></div>`;
  const nameEl = $("#st-name");
  const inp = $("#hf input[name='TOSCAN ID']");
  inp.oninput = () => {
    const v = inp.value.trim().toLowerCase();
    const hit = students.find(s => s.id.toLowerCase() === v) || (v.length > 2 ? students.filter(s => fullName(s).toLowerCase().includes(v)) : []);
    if (Array.isArray(hit)) nameEl.innerHTML = hit.slice(0, 5).map(s => `<button type="button" class="link" data-pick="${esc(s.id)}">${esc(fullName(s))} (${esc(s.id)})</button>`).join(" · ");
    else nameEl.textContent = hit ? fullName(hit) : "";
    $$("[data-pick]", nameEl).forEach(b => b.onclick = () => { inp.value = b.dataset.pick; inp.oninput(); });
  };
  $("#hf").onsubmit = ev => {
    ev.preventDefault();
    const row = Object.fromEntries(new FormData(ev.target).entries());
    busy(ev.target.querySelector("[type=submit]"), async () => {
      const r = await call("importRecords", { kind: "historical", rows: [row], dryRun: false, sourceName: "Manual entry" });
      const res = r.results[0];
      if (!res.ok) { $("#hmsg").textContent = res.errors.join(" "); throw new Error(res.errors[0]); }
      $("#hmsg").textContent = ""; ev.target.reset(); nameEl.textContent = "";
      toast("Historical record saved.", "ok");
    }).catch(() => {});
  };
  importer($("#imp"), {
    kind: "historical", headers: HIST_HEADERS, templateName: "toscan-historical-template",
    extra: `<div><label>Source description</label><input type="text" id="src" placeholder="e.g. 2023 payroll binder" data-nodirty></div><div><label>Supporting payroll file (optional)</label><input type="file" id="att" accept=".pdf,.xlsx,.xls,.csv,image/*" data-nodirty></div>`,
    getExtra: async final => {
      const out = { sourceName: $("#src").value.trim() };
      const f = $("#att").files[0];
      if (final && f) {
        const path = `historical/${Date.now()}-${Math.random().toString(36).slice(2, 8)}/${f.name.replace(/[^\w.\- ]+/g, "_")}`;
        await uploadBytes(ref(storage, path), f, { contentType: f.type || "application/octet-stream" });
        out.attachmentPath = path;
      }
      return out;
    }
  });
  getDocs(collection(db, "imports")).then(s => {
    const list = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0)).slice(0, 20);
    $("#recent").className = "";
    $("#recent").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Source</th><th>Saved</th><th>Skipped</th><th>By</th></tr></thead><tbody>${list.map(i => `<tr><td>${fmtDateTime(i.at)}</td><td>${esc(i.kind)}</td><td>${esc(i.sourceName || "")}</td><td>${i.valid}</td><td>${i.invalid}</td><td>${esc(i.by?.name || "")}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No imports yet.</td></tr>`}</tbody></table></div>`;
  }).catch(() => { $("#recent").textContent = ""; });
}
historical.deps = [];

/* ---------------- Data import & migration (admin) ---------------- */
export function migration(main) {
  main.innerHTML = `
    <div class="page-head"><div><h1>Data Import &amp; Migration</h1><p>Bring records from the old portal and from spreadsheets into the new structure. Every step has a preview, and nothing existing is deleted or overwritten.</p></div></div>
    <div class="card"><h3>1. Old-portal student records</h3>
      <p class="small">Upgrades each record in <span class="mono">students</span> in place, adding the new structured fields beside the old ones, and copies <span class="mono">archivedStudents</span> into the directory with program status <b>Ended</b>. Old amounts are not treated as payments: encode past payments under Historical Records.</p>
      <div class="btn-row"><button class="btn" id="mprev">Preview migration</button></div><div id="mout" style="margin-top:1rem"></div></div>
    <div class="card"><h3>2. Bulk student import</h3><p class="small muted">Columns: ${esc(STUDENT_HEADERS.join(", "))}. Classification: Top 10 or Top 20. Duplicates (same TOSCAN ID, email, or name and birth date) are rejected.</p><div id="simp"></div></div>
    <div class="card"><h3>3. Historical payments</h3><p class="small">Use <a href="#/history">Historical Records</a>.</p></div>`;
  $("#mprev").onclick = e => busy(e.target, async () => {
    const r = await call("migrateLegacy", { dryRun: true });
    const n = k => r.plan.filter(p => p.action === k).length;
    $("#mout").innerHTML = `<div class="notice info">${n("upgrade")} record(s) to upgrade, ${n("copyArchived")} archived record(s) to copy, ${n("skip")} skipped. Nothing has been changed yet.</div>
      <div class="table-wrap" style="max-height:360px;overflow:auto"><table><thead><tr><th>TOSCAN ID</th><th>Name</th><th>Action</th><th>Classification</th><th>Program</th><th>Note</th></tr></thead><tbody>
      ${r.plan.map(p => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.name || "")}</td><td>${esc({ upgrade: "Upgrade in place", copyArchived: "Copy from archive", skip: "Skip" }[p.action])}</td><td>${esc(p.classification || "—")}</td><td>${esc(p.programStatus || "")}</td><td class="small">${esc(p.reason || "")}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">Nothing to migrate — all records are already up to date.</td></tr>`}</tbody></table></div>
      ${n("upgrade") + n("copyArchived") ? `<div class="btn-row end" style="margin-top:.8rem"><button class="btn ok" id="mrun">Run migration</button></div>` : ""}`;
    $("#mrun") && ($("#mrun").onclick = ev => busy(ev.target, async () => {
      if (!(await confirmBox({ title: "Run the migration?", body: "Adds the new fields to old records. Existing values are kept.", confirmText: "Run migration" }))) return;
      await call("migrateLegacy", { dryRun: false });
      $("#mout").innerHTML = `<div class="notice ok">Migration complete. Review the <a href="#/students">Student Directory</a>.</div>`;
    }, "Migration complete.").catch(() => {}));
  }).catch(() => {});
  importer($("#simp"), { kind: "students", headers: STUDENT_HEADERS, templateName: "toscan-students-template" });
}
migration.deps = [];
export { isAdmin };

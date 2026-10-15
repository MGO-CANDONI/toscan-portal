// Staff: TOSCAN search applications — screening, Top 20 finalists, bidbooks, results.
import { S } from "../state.js";
import { call, fileUrl, fileBlob, storageError } from "../fb.js";
import { $, $$, esc, busy, fmtDate, fmtDateTime, renderTable, openModal, confirmBox, downloadCSV, downloadXLSX, downloadBlob } from "../ui.js";
import { APP_STATUS, APP_TRANSITIONS, CORE_FIELDS } from "../core/applications.js";
import { appBadge, loadApplicationConfig } from "./apply.js";

const name = a => `${a.lastName}, ${a.firstName}${a.middleName && a.middleName.toUpperCase() !== "N/A" ? " " + a.middleName : ""}`;
const created = a => a.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0;

export function list(main) {
  const all = (S.d.applications || []).slice().sort((a, b) => created(b) - created(a));
  const searches = [...new Set(all.map(a => a.searchTitle))];
  const count = st => all.filter(a => st.includes(a.status)).length;
  const stat = (n, l, alert) => `<div class="stat ${alert ? "alert" : ""}"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  main.innerHTML = `
    <div class="page-head"><div><h1>Applications</h1><p>Applications from the public form on the sign-in page. Select an application to screen it, mark Top 20 finalists, open bidbooks and record results.</p></div>
      <div class="btn-row">${S.claims.role === "admin" ? `<a class="btn" href="#/settings" id="cfg">Form settings</a>` : ""}<a class="btn" href="#/apply" target="_blank" rel="noopener">Open public form</a></div></div>
    <div class="stats">
      ${stat(all.length, "Applications received")}
      ${stat(count([APP_STATUS.SUBMITTED]), "Not yet screened", count([APP_STATUS.SUBMITTED]))}
      ${stat(count([APP_STATUS.FINALIST, APP_STATUS.BIDBOOK, APP_STATUS.TOP10, APP_STATUS.TOP20]), "Top 20 finalists")}
      ${stat(count([APP_STATUS.BIDBOOK, APP_STATUS.TOP10, APP_STATUS.TOP20]), "Bidbooks received")}
    </div>
    <div class="card" id="t"></div>`;
  const cfgBtn = $("#cfg", main); if (cfgBtn) cfgBtn.onclick = () => { try { sessionStorage.setItem("toscan.stab", "application"); } catch { /* ignore */ } };
  const t = renderTable($("#t", main), {
    id: "applications", rows: all,
    searchText: a => `${a.ref} ${name(a)} ${a.school} ${a.email} ${a.contact}`,
    searchPlaceholder: "Reference, name, school, email",
    filters: [
      { key: "st", label: "Status", options: Object.values(APP_STATUS), test: (a, v) => a.status === v },
      ...(searches.length > 1 ? [{ key: "se", label: "Search", options: searches, value: searches[0], test: (a, v) => a.searchTitle === v }] : [])
    ],
    tools: `<div class="btn-row" style="align-self:end"><button class="btn sm" id="x-xlsx">Excel</button><button class="btn sm" id="x-csv">CSV</button></div>`,
    columns: [
      { label: "Reference", render: a => `<span class="mono">${esc(a.ref)}</span>`, sort: a => a.ref },
      { label: "Applicant", render: a => `<b>${esc(name(a))}</b><div class="xs muted">${esc(a.email)} · ${esc(a.contact)}</div>`, sort: a => name(a).toLowerCase() },
      { label: "School", key: "school", sort: a => a.school.toLowerCase() },
      { label: "Applied", render: a => fmtDate(a.createdAt), sort: created },
      { label: "Status", render: a => appBadge(a.status), sort: a => a.status },
      { label: "Bidbook", render: a => a.bidbook ? `<span class="badge b-ok">Received</span>${(a.bidbookHistory || []).length > 1 ? `<div class="xs muted">${a.bidbookHistory.length} copies</div>` : ""}` : "—", sort: a => a.bidbook?.at || "" }
    ],
    onRow: a => detail(a), empty: "No applications yet. Open the form in Settings & Master Data → Search applications."
  });
  const exportRows = () => {
    const rows = t.rows(), qs = [];
    rows.forEach(a => (a.questions || []).forEach(q => { if (!qs.find(x => x.id === q.id)) qs.push(q); }));
    const headers = ["Reference", "Search", ...CORE_FIELDS.map(f => f.label), ...qs.map(q => q.label), "Applied", "Status", "Message to applicant", "Bidbook file", "Bidbook uploaded"];
    return { headers, rows: rows.map(a => [a.ref, a.searchTitle, ...CORE_FIELDS.map(f => a[f.id] || ""), ...qs.map(q => a.answers?.[q.id] || ""), fmtDateTime(a.createdAt), a.status, a.publicMessage || "", a.bidbook?.fileName || "", a.bidbook ? fmtDateTime(a.bidbook.at) : ""]) };
  };
  $("#x-csv", main).onclick = () => { const x = exportRows(); downloadCSV("TOSCAN applications", x.headers, x.rows); };
  $("#x-xlsx", main).onclick = e => busy(e.target, async () => { const x = exportRows(); await downloadXLSX("TOSCAN applications", [{ name: "Applications", ...x }]); }).catch(() => {});
}
list.deps = ["r:applications"];

function detail(a0) {
  const a = (S.d.applications || []).find(x => x.ref === a0.ref) || a0;
  const next = APP_TRANSITIONS[a.status] || [];
  const files = [...(a.bidbookHistory || [])].reverse();
  const m = openModal(`
    <div class="card-head"><div><div class="xs muted mono">${esc(a.ref)} · ${esc(a.searchTitle)}</div><h2 style="margin:.2rem 0 0">${esc(name(a))}</h2></div>${appBadge(a.status)}</div>
    <dl class="kv small">
      ${CORE_FIELDS.map(f => `<dt>${esc(f.label)}</dt><dd>${f.id === "email" ? `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : esc(a[f.id])}${f.id === "school" && a.schoolOther ? ` <span class="badge b-warn">Not in master list</span>` : ""}</dd>`).join("")}
      ${(a.questions || []).map(q => `<dt>${esc(q.label)}</dt><dd>${esc(a.answers?.[q.id] || "—")}</dd>`).join("")}
      <dt>Applied</dt><dd>${fmtDateTime(a.createdAt)}</dd></dl>
    <h3 style="margin-top:1rem">Bidbook</h3>
    ${files.length ? `<div class="req-grid">${files.map((f, i) => `<div class="req-row"><div><div class="name">${esc(f.fileName)} ${i === 0 ? `<span class="badge b-gold">Latest</span>` : `<span class="badge">Earlier copy</span>`}</div><div class="xs muted">${(f.size / 1048576).toFixed(1)} MB · uploaded ${fmtDateTime(f.at)}</div></div>
      <div class="btn-row"><button class="btn sm" data-open="${i}">Open</button><button class="btn sm" data-dl="${i}">Download</button></div></div>`).join("")}</div>`
      : `<p class="small muted">${[APP_STATUS.FINALIST].includes(a.status) ? "Waiting for the finalist to upload the bidbook." : "Bidbooks are requested from Top 20 finalists."}</p>`}
    <h3 style="margin-top:1rem">Decision</h3>
    <form class="grid g2" id="df">
      <div><label>Status</label><select name="status"><option value="${esc(a.status)}">${esc(a.status)} (no change)</option>${next.map(s => `<option>${esc(s)}</option>`).join("")}</select></div>
      <div><label>Remarks (internal; required for Not Selected / Withdrawn)</label><input type="text" name="remarks"></div>
      <div class="spanall"><label>Message shown to the applicant on the status page</label><textarea name="message" rows="2">${esc(a.publicMessage || "")}</textarea><div class="xs muted">Marking someone a Top 20 Finalist opens the bidbook upload for them.</div></div>
      <div class="spanall modal-actions" style="justify-content:space-between"><button type="button" class="btn" id="reset">Issue new access code…</button><span class="btn-row"><button type="button" class="btn" data-c>Close</button><button class="btn primary">Save</button></span></div>
    </form>
    <h3 style="margin-top:1rem">History</h3>
    <ul class="small">${(a.statusHistory || []).map(h => `<li>${fmtDateTime(h.at)} — <b>${esc(h.status)}</b> by ${esc(h.by)}${h.remarks ? `: ${esc(h.remarks)}` : ""}</li>`).join("")}</ul>`, { size: "wide" });
  $("[data-c]", m).onclick = () => m.close();
  $$("[data-open]", m).forEach(b => b.onclick = () => busy(b, async () => {
    const f = files[+b.dataset.open];
    try { const url = await fileUrl(f.path); window.open(url, "_blank"); } catch (e) { throw new Error(storageError(e)); }
  }).catch(() => {}));
  $$("[data-dl]", m).forEach(b => b.onclick = () => busy(b, async () => {
    const f = files[+b.dataset.dl];
    try { downloadBlob(`${a.ref} ${f.fileName}`, await fileBlob(f.path)); } catch (e) { throw new Error(storageError(e)); }
  }).catch(() => {}));
  const f = $("#df", m);
  f.onsubmit = ev => {
    ev.preventDefault();
    busy(f.querySelector(".btn.primary"), () => call("reviewApplication", { ref: a.ref, action: "status", status: f.status.value, message: f.message.value, remarks: f.remarks.value }), "Application updated.")
      .then(() => m.close()).catch(() => {});
  };
  $("#reset", m).onclick = async e => {
    const ok = await confirmBox({ title: "Issue a new access code?", body: "The old code stops working. Give the new code to the applicant after confirming their identity.", fields: [{ name: "remarks", label: "Reason", required: true }], confirmText: "Issue new code" });
    if (!ok) return;
    const r = await busy(e.target, () => call("reviewApplication", { ref: a.ref, action: "resetCode", remarks: ok.remarks })).catch(() => null);
    if (r) openModal(`<h2>New access code</h2><p>Reference <b class="mono">${esc(a.ref)}</b></p><div class="code-box" style="grid-template-columns:1fr"><div><span>Access code</span><b>${esc(r.code)}</b></div></div><p class="small muted">It is shown only now${a.email ? " (it was also emailed to the applicant if email notifications are on)" : ""}.</p>`, { size: "narrow" });
  };
}

/* ---------------- Settings tab: the public form ---------------- */
export async function formSettings(el, save) {
  el.innerHTML = `<div class="card"><div class="loading">Loading…</div></div>`;
  const c = await loadApplicationConfig(true) || (await import("../core/applications.js")).DEFAULT_APPLICATION_CONFIG;
  const qs = (c.questions || []).map(q => ({ ...q }));
  const qRow = (q, i) => `<div class="q-row" data-q="${i}">
      <div><label>Question</label><input type="text" data-k="label" value="${esc(q.label)}"></div>
      <div><label>Answer type</label><select data-k="type">${[["text", "Short answer"], ["textarea", "Paragraph"], ["select", "Choose one"], ["date", "Date"], ["number", "Number"]].map(([v, l]) => `<option value="${v}" ${q.type === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label>Choices (one per line)</label><textarea data-k="options" rows="2" ${q.type === "select" ? "" : "disabled"}>${esc((q.options || []).join("\n"))}</textarea></div>
      <label class="check" style="margin-top:1.6rem"><input type="checkbox" data-k="required" ${q.required ? "checked" : ""}> Required</label>
      <div class="btn-row" style="margin-top:1.4rem"><button type="button" class="btn sm" data-up="${i}" ${i ? "" : "disabled"} aria-label="Move up">↑</button><button type="button" class="btn sm danger" data-del="${i}" aria-label="Remove">✕</button></div>
      <div class="q-help"><input type="text" data-k="help" placeholder="Hint shown under the question (optional)" value="${esc(q.help || "")}"></div></div>`;
  el.innerHTML = `<form id="apf">
    <div class="card"><div class="card-head"><h3>TOSCAN search application form</h3>${c.open ? `<span class="badge b-ok">Accepting applications</span>` : `<span class="badge">Closed</span>`}</div>
      <p class="small muted">This form is public: anyone can open it from the sign-in page without an account. Only the settings below are public; applications are visible only to staff.</p>
      <div class="grid g2">
        <label class="check spanall"><input type="checkbox" name="open" ${c.open ? "checked" : ""}> Accept applications (shows “Apply now” on the sign-in page)</label>
        <div><label class="req">Form title</label><input type="text" name="title" value="${esc(c.title)}"></div>
        <div><label>Last day to apply (blank = until closed)</label><input type="date" name="closesOn" value="${esc(c.closesOn)}"></div>
        <div class="spanall"><label>Introduction</label><textarea name="intro" rows="5">${esc(c.intro)}</textarea></div>
        <div><label>General Guidelines link</label><input type="url" name="guidelinesUrl" placeholder="https://…" value="${esc(c.guidelinesUrl)}"></div>
        <div><label>Contact email</label><input type="email" name="contactEmail" value="${esc(c.contactEmail)}"></div>
      </div></div>
    <div class="card"><h3>Schools</h3>
      <p class="small muted">The schools applicants can choose from — the high schools in the search area. This list is separate from the schools in master data (which are the colleges and universities of current students). One per line; applicants whose school is not listed can choose “Other” and type it.</p>
      <textarea name="schools" rows="8" placeholder="Candoni National High School">${esc((c.schools || []).join("\n"))}</textarea></div>
    <div class="card"><h3>Questions</h3>
      <p class="small muted">Always asked: ${CORE_FIELDS.map(f => esc(f.label)).join(", ")}, and the data privacy consent. Add any other questions below. Changing questions doesn't alter applications already received.</p>
      <div id="qs"></div><button type="button" class="btn" id="addq">+ Add question</button></div>
    <div class="card"><h3>Bidbook (Top 20 finalists)</h3><div class="grid g2">
      <div class="spanall"><label>Bidbook form link (shown on the sign-in page)</label><input type="url" name="bidbookTemplateUrl" value="${esc(c.bidbookTemplateUrl)}"><div class="xs muted">Share the file as “Anyone with the link can view” so applicants can download it.</div></div>
      <div><label>Last day to upload bidbooks (blank = no deadline)</label><input type="date" name="bidbookDeadline" value="${esc(c.bidbookDeadline)}"></div></div>
      <p class="small muted">Applicants receive an email when they apply, when they are selected as finalists, and when results are recorded. Emails are sent through the “Trigger Email from Firestore” extension (see DEPLOYMENT.md §3). Finalists upload one PDF (up to 25 MB) using their reference number and access code. Uploads need <b>Anonymous</b> sign-in switched on in Firebase → Authentication → Sign-in method.</p></div>
    <div class="btn-row end"><a class="btn" href="#/apply" target="_blank" rel="noopener">Preview form</a><button class="btn primary" type="submit">Save application form</button></div></form>`;
  const f = $("#apf", el);
  const read = () => $$(".q-row", el).forEach(r => {
    const q = qs[+r.dataset.q];
    q.label = $("[data-k=label]", r).value; q.type = $("[data-k=type]", r).value; q.help = $("[data-k=help]", r).value;
    q.options = $("[data-k=options]", r).value.split("\n").map(x => x.trim()).filter(Boolean); q.required = $("[data-k=required]", r).checked;
  });
  const draw = () => {
    $("#qs", el).innerHTML = qs.map(qRow).join("") || `<p class="small muted">No extra questions.</p>`;
    $$("[data-k=type]", el).forEach(s => s.onchange = () => { s.closest(".q-row").querySelector("[data-k=options]").disabled = s.value !== "select"; });
    $$("[data-del]", el).forEach(b => b.onclick = () => { read(); qs.splice(+b.dataset.del, 1); draw(); });
    $$("[data-up]", el).forEach(b => b.onclick = () => { read(); const i = +b.dataset.up; [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; draw(); });
  };
  draw();
  $("#addq", el).onclick = () => { read(); qs.push({ id: `q_${Date.now().toString(36)}`, label: "", type: "text", options: [], required: false, help: "" }); draw(); $$(".q-row [data-k=label]", el).pop().focus(); };
  f.onsubmit = ev => {
    ev.preventDefault(); read();
    const data = {
      open: f.open.checked, title: f.title.value, closesOn: f.closesOn.value, intro: f.intro.value, guidelinesUrl: f.guidelinesUrl.value.trim(),
      contactEmail: f.contactEmail.value.trim(), bidbookTemplateUrl: f.bidbookTemplateUrl.value.trim(), bidbookDeadline: f.bidbookDeadline.value,
      schools: f.schools.value.split("\n").map(x => x.trim()).filter(Boolean),
      questions: qs.filter(q => q.label.trim())
    };
    save("applicationForm", null, data, f.querySelector("[type=submit]"), "Application form saved.").then(() => formSettings(el, save)).catch(() => {});
  };
}

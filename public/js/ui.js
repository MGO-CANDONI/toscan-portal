// UI helpers shared by every screen.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const TERM_NAMES = { T1: "First Semester", T2: "Second Semester", T3: "Third Semester" };
export const TERM_SHORT = { T1: "1st Sem", T2: "2nd Sem", T3: "3rd Sem" };
export const PERIOD_NAMES = { P1: "First Allowance", P2: "Second Allowance" };
export const CLASS_NAMES = { top10: "Top 10 — Awardee", top20: "Top 20 — Qualifier" };
export const CLASS_SHORT = { top10: "Top 10", top20: "Top 20" };
export const ROLE_NAMES = { student: "Student", staff: "Staff", admin: "Administrator" };
export const PERMISSION_NAMES = {
  reviewDocuments: "Review documents", verifyRecords: "Verify enrollment and profile changes",
  decideEligibility: "Decide allowance eligibility", preparePayroll: "Prepare and review payroll",
  approvePayroll: "Approve / finalize payroll", releasePayroll: "Record payroll release",
  encodeHistory: "Encode historical records", viewReports: "View reports"
};
export const LATIN = ["", "Summa Cum Laude", "Magna Cum Laude", "Cum Laude"];

/* ---------- formatting ---------- */
export function toDate(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d); }
  const d = new Date(v); return isNaN(d) ? null : d;
}
const MANILA = { timeZone: "Asia/Manila" };
export function fmtDate(v) {
  const d = toDate(v); if (!d) return "—";
  return d.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric", ...(typeof v === "string" && v.length === 10 ? {} : MANILA) });
}
export function fmtDateTime(v) {
  const d = toDate(v); if (!d) return "—";
  return d.toLocaleString("en-PH", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...MANILA });
}
export function money(n) { return "₱" + (Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
export function manilaToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}
export function fullName(s) {
  if (!s) return "";
  return [s.surname ? s.surname + "," : "", s.firstName, s.middleName, s.extName].filter(Boolean).join(" ").trim() || s.displayName || s.email || "";
}
export function initials(s) {
  if (s?.firstName || s?.surname) return `${(s.firstName || "")[0] || ""}${(s.surname || "")[0] || ""}`.toUpperCase() || "?";
  const words = String(s?.displayName || s?.email || "?").split(/[\s@.]+/).filter(Boolean);
  return words.slice(0, 2).map(w => w[0]).join("").toUpperCase();
}
export function daysUntil(date) { return Math.ceil((toDate(date) - Date.now()) / 86400000); }

/* ---------- badges ---------- */
const B = (txt, cls = "") => `<span class="badge ${cls}">${esc(txt)}</span>`;
export const docBadge = s => B(s === "Returned" ? "Returned for Correction" : s || "Not Submitted", { Submitted: "b-info", "Under Review": "b-warn", Returned: "b-bad", Approved: "b-ok", Superseded: "" }[s] || "");
export const eligBadge = s => B(s || "Not started", { "Pending Documents": "", "For Review": "b-info", "Returned for Correction": "b-bad", Qualified: "b-gold", "Not Qualified": "b-bad", "Included in Payroll": "b-warn", Released: "b-ok" }[s] || "");
export const entBadge = s => B(s === "Awaiting Payroll" ? "Qualified / Awaiting Payroll" : s, { "Awaiting Payroll": "b-gold", "Payroll In Progress": "b-info", "Included in Payroll": "b-warn", Released: "b-ok", Cancelled: "" }[s] || "");
export const payrollBadge = s => B(s, { Draft: "", Generated: "b-info", "For Review": "b-warn", Approved: "b-gold", Released: "b-ok", Archived: "b-dark", Voided: "b-bad" }[s] || "");
export const userBadge = s => B({ pending: "Pending approval", approved: "Approved", declined: "Declined", disabled: "Disabled" }[s] || s, { pending: "b-warn", approved: "b-ok", declined: "b-bad", disabled: "" }[s] || "");
export const programBadge = s => B(s || "Active", s === "Ended" ? "b-bad" : "b-ok");
export const classBadge = c => c ? B(CLASS_NAMES[c] || c, "b-gold") : B("Unclassified");
export const recordBadge = s => B(s, { Verified: "b-ok", "For Verification": "b-warn", Rejected: "b-bad" }[s] || "");

export function avatar(person, url, size = "") {
  if (url) return `<img class="avatar ${size}" src="${esc(url)}" alt="">`;
  return `<span class="avatar ${size}" aria-hidden="true">${esc(initials(person))}</span>`;
}

/* ---------- toast, modal, confirm ---------- */
export function toast(msg, kind = "") {
  const d = document.createElement("div");
  d.textContent = msg; if (kind) d.className = kind;
  $("#toasts").appendChild(d);
  setTimeout(() => d.remove(), kind === "err" ? 8000 : 4000);
}

export function openModal(html, { size = "", onClose } = {}) {
  const root = $("#modal-root");
  const wrap = document.createElement("div");
  wrap.className = "modal-back";
  wrap.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true"><button class="x" aria-label="Close">×</button>${html}</div>`;
  root.appendChild(wrap);
  const m = $(".modal", wrap);
  const close = () => { wrap.remove(); onClose && onClose(); };
  $(".x", wrap).onclick = close;
  wrap.addEventListener("mousedown", e => { if (e.target === wrap) close(); });
  m.close = close;
  const first = m.querySelector("input,select,textarea,button:not(.x)"); first && setTimeout(() => first.focus(), 30);
  return m;
}
export function closeModals() { $("#modal-root").innerHTML = ""; }
document.addEventListener("keydown", e => { if (e.key === "Escape") { const last = $$("#modal-root .modal-back").at(-1); last && $(".x", last).click(); } });

/**
 * Confirmation dialog. fields: [{name, label, type, required, options, value, placeholder, hint}]
 * Resolves to the field values (or {}) when confirmed, null when cancelled.
 */
export function confirmBox({ title, body = "", confirmText = "Confirm", danger = false, fields = [] }) {
  return new Promise(resolve => {
    const m = openModal(`
      <h2>${esc(title)}</h2>${body ? `<div class="muted" style="margin-bottom:.8rem">${body}</div>` : ""}
      <form class="grid">${fields.map(fieldHtml).join("")}<div class="form-msg err" id="cb-msg"></div>
      <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn ${danger ? "danger solid" : "primary"}">${esc(confirmText)}</button></div></form>`,
      { size: "narrow", onClose: () => resolve(null) });
    $("[data-cancel]", m).onclick = () => m.close();
    $("form", m).onsubmit = e => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(e.target).entries());
      const missing = fields.filter(f => f.required && !String(values[f.name] || "").trim());
      if (missing.length) { $("#cb-msg", m).textContent = `${missing[0].label} is required.`; return; }
      m.parentElement.remove(); resolve(values);
    };
  });
}
export function fieldHtml(f) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const lab = `<label for="${id}" class="${f.required ? "req" : ""}">${esc(f.label)}</label>`;
  const common = `id="${id}" name="${esc(f.name)}" ${f.required ? "required" : ""} ${f.disabled ? "disabled" : ""}`;
  let input;
  if (f.type === "select") input = `<select ${common}>${(f.options || []).map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(f.value ?? "") ? "selected" : ""}>${esc(l)}</option>`; }).join("")}</select>`;
  else if (f.type === "textarea") input = `<textarea ${common} placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`;
  else if (f.type === "checkbox") return `<label class="check"><input type="checkbox" ${common} ${f.value ? "checked" : ""} value="1"> ${esc(f.label)}</label>`;
  else input = `<input type="${f.type || "text"}" ${common} value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}" ${f.list ? `list="${esc(f.list)}"` : ""} ${f.max ? `max="${esc(f.max)}"` : ""} ${f.min ? `min="${esc(f.min)}"` : ""} ${f.step ? `step="${esc(f.step)}"` : ""}>`;
  return `<div class="${f.span || ""}">${lab}${input}${f.hint ? `<div class="xs muted" style="margin-top:.2rem">${esc(f.hint)}</div>` : ""}</div>`;
}
export const opts = (list, selected, blank) => (blank !== undefined ? `<option value="">${esc(blank)}</option>` : "") +
  list.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(selected ?? "") ? "selected" : ""}>${esc(l)}</option>`; }).join("");
export const datalist = (id, list) => `<datalist id="${esc(id)}">${list.map(v => `<option value="${esc(v)}">`).join("")}</datalist>`;

/** Runs an async action with the button disabled; shows errors as toasts. */
export async function busy(btn, fn, okMsg) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = "Working…"; }
  try { const r = await fn(); if (okMsg) toast(okMsg, "ok"); return r; }
  catch (e) { toast(e.message || String(e), "err"); throw e; }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}
export const quiet = p => p.catch(() => {});

/* ---------- data table ---------- */
/**
 * renderTable(el, { columns:[{key,label,render(row),sort(row),cls,headCls}], rows, searchText(row), filters:[{key,label,options,test(row,val)}],
 *   pageSize, onRow(row), empty, tools: extra html, footer(rows) })
 */
const tableState = new Map();
export function renderTable(el, cfg) {
  const fresh = !cfg.id || !tableState.has(cfg.id);
  const st = (cfg.id && tableState.get(cfg.id)) || { q: "", sort: cfg.defaultSort ?? null, dir: cfg.defaultDir || 1, page: 0, filters: {} };
  if (cfg.id) tableState.set(cfg.id, st);
  const pageSize = cfg.pageSize || 25;
  el.innerHTML = `
    <div class="table-tools">
      ${cfg.searchText ? `<div class="grow"><label>Search</label><input type="search" data-q placeholder="${esc(cfg.searchPlaceholder || "Search")}"></div>` : ""}
      ${(cfg.filters || []).map(f => `<div><label>${esc(f.label)}</label><select data-f="${esc(f.key)}">${opts(f.options, f.value ?? "", "All")}</select></div>`).join("")}
      ${cfg.tools || ""}
    </div>
    <div class="table-wrap"><table><thead><tr>${cfg.columns.map((c, i) => `<th class="${c.sort ? "sortable" : ""} ${c.headCls || ""}" data-i="${i}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody></tbody><tfoot></tfoot></table></div>
    <div class="pager"></div>`;
  if (fresh) (cfg.filters || []).forEach(f => { if (f.value) st.filters[f.key] = f.value; });
  const q0 = $("[data-q]", el); if (q0) q0.value = st.q;
  $$("[data-f]", el).forEach(s => { if (st.filters[s.dataset.f] !== undefined) s.value = st.filters[s.dataset.f]; });
  let rows = cfg.rows || [];
  const draw = () => {
    let list = rows.filter(r => (!st.q || cfg.searchText(r).toLowerCase().includes(st.q)) &&
      (cfg.filters || []).every(f => !st.filters[f.key] || f.test(r, st.filters[f.key])));
    if (st.sort != null) {
      const c = cfg.columns[st.sort];
      list = [...list].sort((a, b) => { const x = c.sort(a), y = c.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * st.dir; });
    }
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    st.page = Math.min(st.page, pages - 1);
    const view = list.slice(st.page * pageSize, (st.page + 1) * pageSize);
    $("tbody", el).innerHTML = view.length ? view.map((r, i) => `<tr data-r="${i}" class="${cfg.onRow ? "click" : ""}">${cfg.columns.map(c => `<td class="${c.cls || ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("")
      : `<tr><td colspan="${cfg.columns.length}" class="empty">${esc(rows.length ? "No records match these filters." : cfg.empty || "No records yet.")}</td></tr>`;
    $("tfoot", el).innerHTML = cfg.footer && list.length ? cfg.footer(list) : "";
    $$("th", el).forEach((th, i) => { th.classList.toggle("asc", st.sort === i && st.dir === 1); th.classList.toggle("desc", st.sort === i && st.dir === -1); });
    if (cfg.onRow) $$("tbody tr[data-r]", el).forEach(tr => tr.onclick = e => { if (!e.target.closest("button,a,input,select")) cfg.onRow(view[+tr.dataset.r]); });
    cfg.afterDraw && cfg.afterDraw(el, view);
    $(".pager", el).innerHTML = list.length > pageSize
      ? `<span>${st.page * pageSize + 1}–${Math.min(list.length, (st.page + 1) * pageSize)} of ${list.length}</span><span class="btn-row"><button class="btn sm" data-p="-1" ${st.page ? "" : "disabled"}>Previous</button><button class="btn sm" data-p="1" ${st.page < pages - 1 ? "" : "disabled"}>Next</button></span>`
      : `<span>${list.length} record${list.length === 1 ? "" : "s"}</span>`;
    $$(".pager [data-p]", el).forEach(b => b.onclick = () => { st.page += +b.dataset.p; draw(); });
    el.currentRows = list;
  };
  const q = $("[data-q]", el); if (q) q.oninput = () => { st.q = q.value.trim().toLowerCase(); st.page = 0; draw(); };
  $$("[data-f]", el).forEach(s => s.onchange = () => { st.filters[s.dataset.f] = s.value; st.page = 0; draw(); });
  $$("th.sortable", el).forEach(th => th.onclick = () => { const i = +th.dataset.i; st.dir = st.sort === i ? -st.dir : 1; st.sort = i; draw(); });
  draw();
  return { update(newRows) { rows = newRows; draw(); }, rows: () => el.currentRows || [] };
}

/* ---------- export, import, print ---------- */
export function downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
export function downloadCSV(name, headers, rows) {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.map(q).join(","), ...rows.map(r => r.map(q).join(","))].join("\r\n");
  downloadBlob(name.endsWith(".csv") ? name : name + ".csv", new Blob(["﻿" + csv], { type: "text/csv" }));
}
let xlsxLoading = null;
export function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => res(window.XLSX); s.onerror = () => { xlsxLoading = null; rej(new Error("Could not load the spreadsheet library. Check your internet connection.")); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}
/** sheets: [{ name, headers, rows }] */
export async function downloadXLSX(name, sheets) {
  const X = await loadXLSX();
  const wb = X.utils.book_new();
  for (const s of sheets) X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([s.headers, ...s.rows]), s.name.slice(0, 31));
  X.writeFile(wb, name.endsWith(".xlsx") ? name : name + ".xlsx");
}
/** Reads the first sheet of a CSV or Excel file into objects keyed by header. */
export async function readSpreadsheet(file) {
  const X = await loadXLSX();
  const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
  // CSV is read as plain text so dates and amounts arrive exactly as typed;
  // Excel date cells are converted to YYYY-MM-DD.
  const wb = isCsv ? X.read(await file.text(), { type: "string", raw: true }) : X.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: true });
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? ymd(v) : typeof v === "number" ? String(v) : v])));
}
export function printHtml(html) {
  $("#print-area").innerHTML = html;
  setTimeout(() => window.print(), 200);
}
export function printHeader(title, subtitle = "") {
  return `<div class="ph"><img src="assets/municipal-seal.png" alt="">
    <div class="l1">MUNICIPAL GOVERNMENT OF CANDONI</div>
    <div class="l2">Municipal Building, Rizal St., Candoni, Negros Occidental, 6110</div>
    <div class="l3">${esc(title)}</div>${subtitle ? `<div class="l4">${esc(subtitle)}</div>` : ""}</div>`;
}

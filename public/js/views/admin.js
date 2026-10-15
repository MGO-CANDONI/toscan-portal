// Administration: registrations, users & permissions, settings & master data, audit trail.
import { S, settings, studentById } from "../state.js";
import { db, collection, query, orderBy, limit, getDocs, call, storage, ref, uploadBytes } from "../fb.js";
import {
  $, $$, esc, toast, busy, opts, fmtDate, fmtDateTime, money, userBadge, classBadge, TERM_NAMES, TERM_SHORT, PERIOD_NAMES, CLASS_NAMES,
  ROLE_NAMES, fullName, renderTable, confirmBox, openModal, fieldHtml, datalist
} from "../ui.js";
import { clean } from "./common.js";
import { LATIN_LEVELS } from "../core/policy.js";
import { formSettings as applicationForm } from "./applications.js";

/* ---------------- Registrations ---------------- */
export function approvals(main) {
  const pend = (S.d.users || []).filter(u => u.status === "pending").sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  const unlinked = (S.d.students || []).filter(s => !s.uid);
  main.innerHTML = `
    <div class="page-head"><div><h1>Registrations</h1><p>Confirm each person, link students to their TOSCAN record, and set their access.</p></div></div>
    ${datalist("dl-unlinked", unlinked.map(s => s.id))}
    ${pend.map(u => {
      const r = u.registration || {}, sug = u.suggestedStudentId && studentById(u.suggestedStudentId);
      return `<div class="card" data-uid="${esc(u.uid)}">
        <div class="card-head"><div><h3>${esc(fullName(r) || u.email)}</h3><div class="small muted">${esc(u.email)} · registered ${fmtDateTime(u.createdAt)} · as ${esc(r.accountType || "student")}</div></div></div>
        <dl class="kv small" style="margin-bottom:.8rem">
          ${r.accountType !== "staff" ? `<dt>Date of birth</dt><dd>${r.dateOfBirth ? fmtDate(r.dateOfBirth) : "—"}</dd><dt>Address</dt><dd>${esc(r.address)}</dd><dt>School / program</dt><dd>${esc(r.school)} ${esc(r.program)} ${esc(r.yearLevel)}</dd><dt>Says TOSCAN ID / batch</dt><dd>${esc(r.toscanId || "—")} / ${esc(r.batch || "—")}</dd>` : ""}
          <dt>Contact</dt><dd>${esc(r.contact)}</dd></dl>
        ${sug ? `<div class="notice info small">Matching record found: <b>${esc(fullName(sug))}</b> (${esc(sug.id)}, ${esc(sug.qualification?.batch || sug.batch || "")}, ${esc(CLASS_NAMES[sug.classification] || "unclassified")}).</div>` : ""}
        <form class="grid g4" style="align-items:end" data-nodirty>
          <div><label>Access level</label><select name="role">${opts(Object.entries(ROLE_NAMES), r.accountType === "staff" ? "staff" : "student")}</select></div>
          <div data-for="student"><label>Student record</label><select name="mode">${opts([["existing", "Link existing record"], ["new", "Create new record"]], sug || r.toscanId && studentById(r.toscanId) ? "existing" : "new")}</select></div>
          <div data-for="student" data-existing><label>TOSCAN ID to link</label><input type="text" name="studentId" list="dl-unlinked" value="${esc(sug?.id || (r.toscanId && studentById(r.toscanId) ? r.toscanId : ""))}"></div>
          <div data-for="student"><label>Classification</label><select name="classification">${opts(Object.entries(CLASS_NAMES), sug?.classification || "", "Keep / set later")}</select></div>
          <div class="spanall btn-row end"><button type="button" class="btn danger" data-decline>Decline…</button><button type="button" class="btn ok" data-approve>Approve</button></div>
        </form></div>`;
    }).join("") || `<div class="card empty">No registrations are waiting.</div>`}`;
  $$("[data-uid]", main).forEach(card => {
    const f = $("form", card), uid = card.dataset.uid;
    const sync = () => {
      const role = f.role.value;
      $$("[data-for=student]", f).forEach(x => x.classList.toggle("hidden", role !== "student"));
            $("[data-existing]", f).classList.toggle("hidden", role !== "student" || f.mode.value !== "existing");
    };
    f.role.onchange = sync; f.mode.onchange = sync; sync();
    $("[data-approve]", f).onclick = async e => {
      const role = f.role.value;
      const data = { uid, decision: "approve", role, classification: f.classification.value };
      if (role === "student") {
        data.studentLink = f.mode.value === "existing" ? { mode: "existing", studentId: f.studentId.value.trim() } : { mode: "new" };
        if (data.studentLink.mode === "existing" && !data.studentLink.studentId) return toast("Enter the TOSCAN ID to link.", "err");
      }
      if (role === "admin" && !(await confirmBox({ title: "Grant administrator access?", body: "Administrators can change master data, approve payrolls and manage every account.", confirmText: "Grant", danger: true }))) return;
      busy(e.target, () => call("decideUser", data), "Approved. The person was notified.").catch(() => {});
    };
    $("[data-decline]", f).onclick = async e => {
      const v = await confirmBox({ title: "Decline this registration?", fields: [{ name: "note", label: "Reason (shown to the person)", type: "textarea", required: true }], confirmText: "Decline", danger: true });
      if (v) busy(e.target, () => call("decideUser", { uid, decision: "decline", note: v.note }), "Registration declined.").catch(() => {});
    };
  });
}
approvals.deps = ["r:users", "r:students"];

/* ---------------- Users & permissions ---------------- */
export function users(main) {
  const rows = (S.d.users || []).filter(u => u.status !== "pending");
  main.innerHTML = `<div class="page-head"><div><h1>Users &amp; Permissions</h1><p>Staff can do everything except the Administration pages. Roles are enforced by the server and the database rules; changes take effect within a minute.</p></div></div><div class="card" id="t"></div>`;
  renderTable($("#t", main), {
    id: "users", rows,
    searchText: u => `${u.displayName || ""} ${u.email} ${u.studentId || ""}`,
    filters: [{ key: "role", label: "Role", options: Object.entries(ROLE_NAMES), test: (u, v) => u.role === v }, { key: "st", label: "Status", options: [["approved", "Approved"], ["disabled", "Disabled"], ["declined", "Declined"]], test: (u, v) => u.status === v }],
    columns: [
      { label: "Name", render: u => `${esc(u.displayName || fullName(u.registration) || "")}<div class="xs muted">${esc(u.email)}</div>`, sort: u => u.displayName || u.email },
      { label: "Role", render: u => esc(ROLE_NAMES[u.role] || u.role), sort: u => u.role },
      { label: "Student record", render: u => u.studentId ? `<a class="mono" href="#/students/${esc(u.studentId)}">${esc(u.studentId)}</a>` : "—" },
      { label: "Status", render: u => userBadge(u.status), sort: u => u.status },
      { label: "Since", render: u => fmtDate(u.decidedAt || u.createdAt), sort: u => u.decidedAt?.seconds || 0 }
    ],
    onRow: u => editUser(u)
  });
}
users.deps = ["r:users"];

function editUser(u) {
  if (u.uid === S.user.uid) return toast("You can't change your own access. Ask another administrator.", "err");
  if (u.status === "declined") return toast("Declined registrations can resubmit from their own account.");
  const m = openModal(`<h2>${esc(u.displayName || u.email)}</h2><p class="muted small">${esc(u.email)}</p>
    <form class="grid" id="uf">
      <div class="grid g2">
        <div><label>Role</label><select name="role">${opts(Object.entries(ROLE_NAMES).filter(([k]) => k !== "student" || u.studentId), u.role)}</select></div>
        <div><label>Account</label><select name="status">${opts([["approved", "Active"], ["disabled", "Disabled (cannot sign in)"]], u.status)}</select></div></div>
      <div><label>Reason for the change</label><input type="text" name="reason"></div>
      <div class="modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary">Save</button></div></form>`, { size: "narrow" });
  const f = $("#uf", m);
  $("[data-c]", m).onclick = () => m.close();
  f.onsubmit = ev => {
    ev.preventDefault();
    busy(f.querySelector(".btn.primary"), async () => {
      await call("updateAccess", { uid: u.uid, role: f.role.value, status: f.status.value, reason: f.reason.value });
      m.close();
    }, "Access updated.").catch(() => {});
  };
}

/* ---------------- Settings & master data ---------------- */
let stab = "general";
const save = (kind, id, data, btn, msg = "Saved.") => busy(btn, async () => { await call("saveMasterData", { kind, id, data }); clean(); }, msg);

export function settingsView(main) {
  const tabs = [["general", "General & policies"], ["years", "Academic years"], ["schools", "Schools"], ["requirements", "Document requirements"], ["allowances", "Allowance types & rates"], ["lists", "Lists"], ["payroll", "Payroll & signatories"], ["application", "Search applications"]];
  try { const want = sessionStorage.getItem("toscan.stab"); if (want) { stab = want; sessionStorage.removeItem("toscan.stab"); } } catch { /* ignore */ }
  main.innerHTML = `<div class="page-head"><div><h1>Settings &amp; Master Data</h1><p>Every change is recorded in the audit trail.</p></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-st="${k}" class="${stab === k ? "active" : ""}">${esc(l)}</button>`).join("")}</div><div id="sbody"></div>`;
  $$("[data-st]", main).forEach(b => b.onclick = () => { stab = b.dataset.st; clean(); settingsView(main); });
  const application = el => applicationForm(el, save);
  ({ general, years, schools, requirements, allowances, lists, payroll, application })[stab]($("#sbody", main));
}
export { settingsView as settings };
settingsView.deps = ["settings", "academicYears", "schools", "requirements", "allowanceTypes"];

function general(el) {
  const s = settings(), d = s.deadline, map = s.termPeriodMap, n = s.notifications;
  el.innerHTML = `<form id="gf">
    <div class="card"><h3>Current academic year</h3><div class="grid g3">
      <div><label>Current academic year</label><select name="ay">${opts(S.master.academicYears.map(a => a.id), s.currentAcademicYear, "—")}</select><div class="xs muted">Add years under “Academic years”.</div></div></div></div>
    <div class="card"><h3>Document submission deadline</h3><div class="grid g4">
      <div><label>Policy</label><select name="policy">${opts([["within", "Submit WITHIN N months of the term opening"], ["after", "Submit only AFTER N months from the term opening"]], d.policy)}</select></div>
      <div><label>Months (N)</label><input type="number" name="months" min="1" max="24" value="${esc(d.months)}"></div>
      <div><label>Cutoff on the deadline date</label><select name="cutoff">${opts([["end-of-day", "End of that day (11:59 PM)"], ["start-of-day", "Start of that day (12:00 AM)"]], d.cutoff)}</select></div>
      <div><label>Reminder (days before)</label><input type="number" name="reminderDays" min="0" max="60" value="${esc(d.reminderDays)}"></div></div>
      <p class="small muted">Example: a term opening on Aug 1 with “within 5 months” closes on Jan 1 of the next year. Times are Asia/Manila. Opening dates come from the student's verified term record, then the school calendar, then the academic-year default.</p></div>
    <div class="card"><h3>Academic terms → allowance periods</h3><p class="small muted">Only two allowance periods are paid per year. Map each academic term to one of them; two terms mapped to the same period produce a single allowance.</p>
      <div class="grid g3">${["T1", "T2", "T3"].map(t => `<div><label>${esc(TERM_NAMES[t])}</label><select name="map_${t}">${opts(Object.entries(PERIOD_NAMES), map[t], "Not paid (monitoring only)")}</select></div>`).join("")}</div></div>
    <div class="card"><h3>Notifications</h3><div class="grid g2">
      <label class="check"><input type="checkbox" name="emailEnabled" ${n.emailEnabled ? "checked" : ""}> Also send notifications by email (needs the “Trigger Email from Firestore” extension)</label>
      <div><label>Office email addresses (comma-separated)</label><input type="text" name="officeEmails" value="${esc((n.officeEmails || []).join(", "))}"></div></div></div>
    <div class="card"><h3>Login page photo</h3><p class="small muted">An approved photograph (for example, the Municipal Hall façade or a program activity) shown on the sign-in page. JPG, at most 5 MB.</p>
      <div class="btn-row"><input type="file" id="hero" accept="image/jpeg" data-nodirty><button type="button" class="btn" id="hero-up">Upload photo</button></div></div>
    <div class="btn-row end"><button class="btn primary" type="submit">Save settings</button></div></form>`;
  const f = $("#gf", el);
  f.onsubmit = ev => {
    ev.preventDefault();
    const data = {
      ...(f.ay.value ? { currentAcademicYear: f.ay.value } : {}),
      deadline: { policy: f.policy.value, months: Number(f.months.value), cutoff: f.cutoff.value, reminderDays: Number(f.reminderDays.value) },
      termPeriodMap: Object.fromEntries(["T1", "T2", "T3"].map(t => [t, f[`map_${t}`].value])),
      notifications: { emailEnabled: f.emailEnabled.checked, officeEmails: f.officeEmails.value.split(",").map(x => x.trim()).filter(Boolean) }
    };
    save("settings", null, data, f.querySelector("[type=submit]"), "Settings saved.").catch(() => {});
  };
  $("#hero-up", el).onclick = e => busy(e.target, async () => {
    const file = $("#hero", el).files[0]; if (!file) throw new Error("Choose a JPG photo first.");
    await uploadBytes(ref(storage, "branding/login.jpg"), file, { contentType: "image/jpeg" });
    await call("saveMasterData", { kind: "settings", data: { branding: { loginImagePath: "branding/login.jpg" } } });
  }, "Login photo updated.").catch(() => {});
}

function years(el) {
  const list = S.master.academicYears;
  el.innerHTML = `<div class="card"><div class="card-head"><h3>Academic years</h3><button class="btn primary" id="add">Add academic year</button></div>
    <div class="table-wrap"><table><thead><tr><th>Academic year</th><th>1st semester opens</th><th>2nd semester opens</th><th>3rd term opens</th><th></th></tr></thead><tbody>
    ${list.map(a => `<tr><td><b>${esc(a.id)}</b>${a.id === settings().currentAcademicYear ? ` <span class="badge b-gold">Current</span>` : ""}</td>${["T1", "T2", "T3"].map(t => `<td>${a.terms?.[t]?.openingDate ? fmtDate(a.terms[t].openingDate) : "—"}</td>`).join("")}<td><button class="btn sm" data-e="${esc(a.id)}">Edit</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty">No academic years yet.</td></tr>`}</tbody></table></div>
    <p class="small muted">These are the default opening dates. Schools with different calendars are set under “Schools”, and staff can set an individual student's opening date when verifying the term record.</p></div>`;
  const edit = a => {
    const m = openModal(`<h2>${a ? `Academic year ${esc(a.id)}` : "Add academic year"}</h2><form class="grid g2" id="yf">
      ${fieldHtml({ name: "ayid", label: "Academic year", value: a?.id || "", placeholder: "2026-2027", required: true, disabled: !!a })}<div></div>
      ${["T1", "T2", "T3"].map(t => fieldHtml({ name: t, label: `${TERM_NAMES[t]} opening date`, type: "date", value: a?.terms?.[t]?.openingDate || "" })).join("")}
      <div class="spanall modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary">Save</button></div></form>`, { size: "narrow" });
    $("[data-c]", m).onclick = () => m.close();
    $("#yf", m).onsubmit = ev => { ev.preventDefault(); const f = ev.target; const id = a?.id || f.elements.ayid.value.trim();
      save("academicYear", id, { terms: Object.fromEntries(["T1", "T2", "T3"].map(t => [t, { openingDate: f[t].value }])) }, f.querySelector(".btn.primary")).then(() => m.close()).catch(() => {}); };
  };
  $("#add", el).onclick = () => edit(null);
  $$("[data-e]", el).forEach(b => b.onclick = () => edit(list.find(a => a.id === b.dataset.e)));
}

function schools(el) {
  const list = S.master.schools, ays = S.master.academicYears.map(a => a.id);
  el.innerHTML = `<div class="card"><div class="card-head"><h3>Schools</h3><button class="btn primary" id="add">Add school</button></div>
    <div class="table-wrap"><table><thead><tr><th>School</th><th>Address</th><th>Terms / year</th><th>Own calendar</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="small">${esc(s.address)}</td><td>${s.termsPerYear}</td><td class="small">${Object.keys(s.calendars || {}).join(", ") || "Uses defaults"}</td><td>${s.active === false ? "<span class='badge'>Inactive</span>" : "<span class='badge b-ok'>Active</span>"}</td><td><button class="btn sm" data-e="${esc(s.id)}">Edit</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">No schools yet.</td></tr>`}</tbody></table></div></div>`;
  const edit = s => {
    const m = openModal(`<h2>${s ? esc(s.name) : "Add school"}</h2><form class="grid g2" id="sf">
      ${fieldHtml({ name: "name", label: "School name", value: s?.name, required: true, span: "spanall" })}
      ${fieldHtml({ name: "address", label: "Address", value: s?.address, span: "spanall" })}
      ${fieldHtml({ name: "termsPerYear", label: "Academic terms per year", type: "select", options: [[2, "2 semesters"], [3, "3 terms (trimester)"]], value: s?.termsPerYear || 2 })}
      ${fieldHtml({ name: "active", label: "Active", type: "checkbox", value: s?.active !== false })}
      <fieldset class="spanall"><legend>School calendar (optional)</legend><p class="xs muted">Only if this school opens on different dates from the academic-year defaults.</p>
        ${ays.map(ay => `<div class="grid g4" style="margin-bottom:.4rem;align-items:end"><b>${esc(ay)}</b>${["T1", "T2", "T3"].map(t => `<div><label>${TERM_SHORT[t]}</label><input type="date" name="cal_${ay}_${t}" value="${esc(s?.calendars?.[ay]?.[t] || "")}"></div>`).join("")}</div>`).join("") || "<p class='muted small'>Add academic years first.</p>"}</fieldset>
      <div class="spanall modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary">Save</button></div></form>`);
    $("[data-c]", m).onclick = () => m.close();
    $("#sf", m).onsubmit = ev => { ev.preventDefault(); const f = ev.target;
      const calendars = {}; ays.forEach(ay => ["T1", "T2", "T3"].forEach(t => { const v = f[`cal_${ay}_${t}`]?.value; if (v) (calendars[ay] ||= {})[t] = v; }));
      save("school", s?.id || null, { name: f.elements.name.value, address: f.address.value, termsPerYear: Number(f.termsPerYear.value), active: f.active.checked, calendars }, f.querySelector(".btn.primary")).then(() => m.close()).catch(() => {}); };
  };
  $("#add", el).onclick = () => edit(null);
  $$("[data-e]", el).forEach(b => b.onclick = () => edit(list.find(x => x.id === b.dataset.e)));
}

function requirements(el) {
  const list = S.master.requirements;
  el.innerHTML = `<div class="card"><div class="card-head"><h3>Document requirements</h3><button class="btn primary" id="add">Add requirement</button></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Code</th><th>Name</th><th>Terms</th><th>Required for allowance</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(r => `<tr><td>${r.order || ""}</td><td class="mono">${esc(r.code)}</td><td><b>${esc(r.name)}</b><div class="xs muted">${esc(r.description)}</div></td><td>${(r.terms || []).map(t => TERM_SHORT[t]).join(", ")}</td><td>${r.requiredForAllowance !== false ? "Yes" : "No (optional)"}</td><td>${r.active === false ? "<span class='badge'>Inactive</span>" : "<span class='badge b-ok'>Active</span>"}</td><td><button class="btn sm" data-e="${esc(r.code)}">Edit</button></td></tr>`).join("")}</tbody></table></div>
    <p class="small muted">Requirements can't be deleted once used; make them inactive instead. Submissions already made are kept.</p></div>`;
  const edit = r => {
    const m = openModal(`<h2>${r ? esc(r.name) : "Add requirement"}</h2><form class="grid g2" id="rf">
      ${fieldHtml({ name: "code", label: "Code", value: r?.code, placeholder: "e.g. MEDICAL_CERT", required: true, disabled: !!r })}
      ${fieldHtml({ name: "order", label: "Display order", type: "number", value: r?.order || list.length + 1 })}
      ${fieldHtml({ name: "name", label: "Name", value: r?.name, required: true, span: "spanall" })}
      ${fieldHtml({ name: "description", label: "Instructions for students", type: "textarea", value: r?.description, span: "spanall" })}
      <div class="spanall"><label>Applies to terms</label><div class="btn-row">${["T1", "T2", "T3"].map(t => `<label class="check"><input type="checkbox" name="t_${t}" ${!r || (r.terms || []).includes(t) ? "checked" : ""}> ${TERM_NAMES[t]}</label>`).join("")}</div></div>
      ${fieldHtml({ name: "requiredForAllowance", label: "Required for allowance eligibility", type: "checkbox", value: r ? r.requiredForAllowance !== false : true })}
      ${fieldHtml({ name: "active", label: "Active", type: "checkbox", value: r ? r.active !== false : true })}
      <div class="spanall modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary">Save</button></div></form>`, { size: "narrow" });
    $("[data-c]", m).onclick = () => m.close();
    $("#rf", m).onsubmit = ev => { ev.preventDefault(); const f = ev.target; const code = r?.code || f.code.value.trim().toUpperCase();
      save("requirement", code, { name: f.elements.name.value, description: f.description.value, order: Number(f.order.value), terms: ["T1", "T2", "T3"].filter(t => f[`t_${t}`].checked), requiredForAllowance: f.requiredForAllowance.checked, active: f.active.checked }, f.querySelector(".btn.primary")).then(() => m.close()).catch(() => {}); };
  };
  $("#add", el).onclick = () => edit(null);
  $$("[data-e]", el).forEach(b => b.onclick = () => edit(list.find(x => x.code === b.dataset.e)));
}

function allowances(el) {
  const list = S.master.allowanceTypes;
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const rateNow = (t, level = "") => (t.rates || []).find(r => (r.level || "") === level && r.effectiveFrom <= today && (!r.effectiveTo || today <= r.effectiveTo));
  const rateCell = t => {
    if (t.appliesTo !== "latinHonor") { const r = rateNow(t); return r ? `${money(r.amount)}<div class="xs muted">since ${fmtDate(r.effectiveFrom)}</div>` : `<span class="badge b-bad">No rate</span>`; }
    return LATIN_LEVELS.map(l => { const r = rateNow(t, l); return `<div class="nowrap"><span class="xs muted">${esc(l)}</span> ${r ? `<b>${money(r.amount)}</b>` : `<span class="badge b-bad">No rate</span>`}</div>`; }).join("");
  };
  el.innerHTML = `<div class="card"><div class="card-head"><h3>Allowance types</h3><button class="btn primary" id="add">Add allowance type</button></div>
    <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Applies to</th><th class="right">Current rate</th><th>Max periods</th><th>Combinable with</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(t => { return `<tr><td class="mono">${esc(t.code)}</td><td><b>${esc(t.name)}</b><div class="xs muted">${esc(t.eligibility)}</div></td><td class="small">${t.appliesTo === "latinHonor" ? "Students with a Latin honor" : "All qualified students"}<br>${(t.classifications || []).map(c => CLASS_NAMES[c]).join(", ")}</td><td class="right">${rateCell(t)}</td><td>${t.maxPeriods || "No limit"}</td><td>${(t.combinableWith || []).join(", ") || "—"}</td><td>${t.active === false ? "<span class='badge'>Inactive</span>" : "<span class='badge b-ok'>Active</span>"}</td><td><button class="btn sm" data-e="${esc(t.code)}">Edit</button></td></tr>`; }).join("")}</tbody></table></div>
    <p class="small muted">Rates are dated. To change an amount, end the current rate and add a new one; amounts already approved or paid never change.</p></div>`;
  const edit = t => {
    const order = l => (l ? LATIN_LEVELS.indexOf(l) : -1);
    const rates = [...(t?.rates || [])].sort((a, b) => order(a.level) - order(b.level) || a.effectiveFrom.localeCompare(b.effectiveFrom));
    const locked = !!(t && (t.rates || []).length);
    const m = openModal(`<h2>${t ? esc(t.name) : "Add allowance type"}</h2><form class="grid g2" id="af">
      ${fieldHtml({ name: "code", label: "Code", value: t?.code, placeholder: "e.g. REG", required: true, disabled: !!t })}
      ${fieldHtml({ name: "name", label: "Name", value: t?.name, required: true })}
      ${fieldHtml({ name: "description", label: "Description", type: "textarea", value: t?.description, span: "spanall" })}
      ${fieldHtml({ name: "eligibility", label: "Eligibility criteria", type: "textarea", value: t?.eligibility, span: "spanall" })}
      ${fieldHtml({ name: "appliesTo", label: "Applies to", type: "select", options: [["all", "All qualified students"], ["latinHonor", "Only students with a verified Latin honor"]], value: t?.appliesTo || "all", disabled: locked, hint: locked ? "Fixed once rates exist." : "" })}
      <div><label>Classifications</label><div class="btn-row">${Object.entries(CLASS_NAMES).map(([k, l]) => `<label class="check"><input type="checkbox" name="c_${k}" ${!t || (t.classifications || []).includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div></div>
      ${fieldHtml({ name: "maxPeriods", label: "Maximum payable periods (blank = no limit)", type: "number", value: t?.maxPeriods ?? "" })}
      ${fieldHtml({ name: "combinableWith", label: "Can be paid together with (codes, comma-separated)", value: (t?.combinableWith || []).join(", "), hint: "Both types must list each other." })}
      ${fieldHtml({ name: "effectiveDate", label: "Type effective from", type: "date", value: t?.effectiveDate })}
      ${fieldHtml({ name: "endDate", label: "Type ends on", type: "date", value: t?.endDate })}
      ${fieldHtml({ name: "active", label: "Active", type: "checkbox", value: t ? t.active !== false : true })}
      ${fieldHtml({ name: "remarks", label: "Remarks", value: t?.remarks })}
      <fieldset class="spanall"><legend>Rates (₱)</legend>
        <p class="xs muted lvl-only">Latin honor allowances have a separate rate for each honor level.</p>
        <table><thead><tr><th class="lvl-only">Honor level</th><th>Effective from</th><th>Effective to</th><th class="right">Amount</th></tr></thead><tbody>
          ${rates.map((r, i) => `<tr><td class="lvl-only">${esc(r.level || "—")}</td><td>${fmtDate(r.effectiveFrom)}</td><td>${r.effectiveTo ? fmtDate(r.effectiveTo) : `<input type="date" name="end_${i}" title="End this rate">`}</td><td class="right">${money(r.amount)}</td></tr>`).join("")}
          <tr><td class="lvl-only"><select name="newLevel">${LATIN_LEVELS.map(l => `<option>${esc(l)}</option>`).join("")}</select></td><td><input type="date" name="newFrom"></td><td><input type="date" name="newTo"></td><td><input type="number" step="0.01" min="0" name="newAmount" placeholder="New rate"></td></tr>
        </tbody></table><p class="xs muted">Existing rates can only be given an end date. End the current rate the day before a new one starts.</p></fieldset>
      <div class="spanall modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn primary">Save</button></div></form>`, { size: "wide" });
    $("[data-c]", m).onclick = () => m.close();
    const af = $("#af", m);
    const syncLevels = () => $$(".lvl-only", m).forEach(x => x.classList.toggle("hidden", af.appliesTo.value !== "latinHonor"));
    af.appliesTo.onchange = syncLevels; syncLevels();
    af.onsubmit = ev => {
      ev.preventDefault(); const f = ev.target; const latin = f.appliesTo.value === "latinHonor";
      const newRates = rates.map((r, i) => ({ ...r, ...(f[`end_${i}`]?.value ? { effectiveTo: f[`end_${i}`].value } : {}) }));
      if (f.newFrom.value || f.newAmount.value) {
        if (!f.newFrom.value || f.newAmount.value === "") return toast("A new rate needs an effective date and an amount.", "err");
        newRates.push({ amount: Number(f.newAmount.value), effectiveFrom: f.newFrom.value, ...(f.newTo.value ? { effectiveTo: f.newTo.value } : {}), ...(latin ? { level: f.newLevel.value } : {}) });
      }
      const code = t?.code || f.code.value.trim().toUpperCase();
      save("allowanceType", code, {
        name: f.elements.name.value, description: f.description.value, eligibility: f.eligibility.value, appliesTo: f.appliesTo.value,
        classifications: Object.keys(CLASS_NAMES).filter(k => f[`c_${k}`].checked), maxPeriods: f.maxPeriods.value,
        combinableWith: f.combinableWith.value.split(",").map(x => x.trim().toUpperCase()).filter(Boolean),
        effectiveDate: f.effectiveDate.value, endDate: f.endDate.value, active: f.active.checked, remarks: f.remarks.value, rates: newRates
      }, f.querySelector(".btn.primary")).then(() => m.close()).catch(() => {});
    };
  };
  $("#add", el).onclick = () => edit(null);
  $$("[data-e]", el).forEach(b => b.onclick = () => edit(list.find(x => x.code === b.dataset.e)));
}

function lists(el) {
  const l = settings().lists;
  const box = (k, label) => `<div><label>${esc(label)} <span class="muted">(one per line)</span></label><textarea name="${k}" rows="8">${esc((l[k] || []).join("\n"))}</textarea></div>`;
  el.innerHTML = `<form class="card" id="lf"><h3>Lists used in forms</h3><div class="grid g2">${box("batches", "TOSCAN batches")}${box("levels", "Educational levels")}${box("yearLevels", "Year levels")}${box("programs", "Courses and strands")}</div>
    <div class="btn-row end" style="margin-top:.8rem"><button class="btn primary">Save lists</button></div></form>`;
  $("#lf", el).onsubmit = ev => { ev.preventDefault(); const f = ev.target; const g = k => f[k].value.split("\n").map(x => x.trim()).filter(Boolean);
    save("settings", null, { lists: { batches: g("batches"), levels: g("levels"), yearLevels: g("yearLevels"), programs: g("programs") } }, f.querySelector(".btn.primary"), "Lists saved.").catch(() => {}); };
}

function payroll(el) {
  const p = settings().payroll, sg = p.signatories, tt = p.signatoryTitles || {};
  const DEF = { a: ["A. Certified: Services duly rendered", "Authorized Personnel"], b: ["B. Certified: Supporting documents complete", "Head, Accounting Division"], c: ["C. Certified: Cash available", "Head, Treasury Division"], d: ["D. Approved for payment", "Local Chief Executive"] };
  el.innerHTML = `<form class="card" id="pf"><h3>Payroll generation</h3><div class="grid g3">
      <label class="check"><input type="checkbox" name="auto" ${p.autoGenerate ? "checked" : ""}> Generate a payroll draft automatically each month</label>
      <div><label>Day of the month (1–28)</label><input type="number" name="day" min="1" max="28" value="${esc(p.dayOfMonth)}"></div></div>
      <p class="small muted">The scheduled job runs daily at 6:00 AM (Asia/Manila). On the chosen day it creates one draft containing every qualified allowance that is not yet in a payroll. Generating a payroll never marks anything as paid.</p>
    <h3 style="margin-top:1rem">Signatories</h3><div class="grid g2">${Object.entries(DEF).map(([k, [cert, title]]) => `<fieldset><legend>${esc(cert)}</legend><div class="grid g2"><div><label>Name</label><input type="text" name="s_${k}" value="${esc(sg[k] || "")}"></div><div><label>Position</label><input type="text" name="t_${k}" value="${esc(tt[k] || title)}"></div></div></fieldset>`).join("")}</div>
    <p class="small muted">Approved payrolls keep the signatories in force when they were approved.</p>
    <div class="btn-row end"><button class="btn primary">Save payroll settings</button></div></form>`;
  $("#pf", el).onsubmit = ev => { ev.preventDefault(); const f = ev.target;
    save("settings", null, { payroll: { autoGenerate: f.auto.checked, dayOfMonth: Number(f.day.value), signatories: Object.fromEntries("abcd".split("").map(k => [k, f[`s_${k}`].value])), signatoryTitles: Object.fromEntries("abcd".split("").map(k => [k, f[`t_${k}`].value])) } }, f.querySelector(".btn.primary"), "Payroll settings saved.").catch(() => {}); };
}

/* ---------------- Audit trail ---------------- */
export async function audit(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Audit Trail</h1><p>The latest 500 privileged actions. Entries are written by the server and can't be edited.</p></div></div><div class="card" id="t"><div class="loading">Loading…</div></div>`;
  const snap = await getDocs(query(collection(db, "auditLogs"), orderBy("at", "desc"), limit(500)));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const actions = [...new Set(rows.map(r => r.action))].sort();
  const people = [...new Set(rows.map(r => r.actor?.name).filter(Boolean))].sort();
  renderTable($("#t", main), {
    id: "audit", rows, pageSize: 40,
    searchText: r => `${r.action} ${r.targetId} ${r.actor?.name} ${r.reason}`,
    filters: [{ key: "a", label: "Action", options: actions, test: (r, v) => r.action === v }, { key: "p", label: "By", options: people, test: (r, v) => r.actor?.name === v }],
    columns: [
      { label: "When", render: r => `<span class="nowrap">${fmtDateTime(r.at)}</span>`, sort: r => r.at?.seconds || 0 },
      { label: "By", render: r => `${esc(r.actor?.name || "")}<div class="xs muted">${esc(ROLE_NAMES[r.actor?.role] || r.actor?.role || "")}</div>` },
      { label: "Action", render: r => `<span class="mono small">${esc(r.action)}</span>` },
      { label: "Record", render: r => `<span class="small">${esc(r.targetType)}</span> <span class="mono small">${esc(r.targetId)}</span>` },
      { label: "Reason", render: r => `<span class="small">${esc(r.reason || "")}</span>` }
    ],
    onRow: r => openModal(`<h2>${esc(r.action)}</h2><p class="muted small">${fmtDateTime(r.at)} · ${esc(r.actor?.name)} · ${esc(r.targetType)} ${esc(r.targetId)}</p>
      ${r.reason ? `<p><b>Reason:</b> ${esc(r.reason)}</p>` : ""}<div class="grid g2"><div><h4>Before</h4><pre class="small" style="white-space:pre-wrap;background:#f6f4ef;padding:.6rem;border-radius:6px">${esc(JSON.stringify(r.before, null, 2))}</pre></div>
      <div><h4>After</h4><pre class="small" style="white-space:pre-wrap;background:#f6f4ef;padding:.6rem;border-radius:6px">${esc(JSON.stringify(r.after, null, 2))}</pre></div></div>`)
  });
}
audit.deps = [];

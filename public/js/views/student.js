// Student screens: dashboard, documents, allowance ledger, enrollment records, profile.
import { S, settings } from "../state.js";
import { db, doc, collection, call, storage, ref, uploadBytesResumable } from "../fb.js";
import {
  $, $$, esc, toast, busy, opts, fmtDate, fmtDateTime, money, docBadge, eligBadge, entBadge, classBadge, programBadge, recordBadge,
  TERM_NAMES, TERM_SHORT, PERIOD_NAMES, CLASS_NAMES, fullName, datalist, confirmBox
} from "../ui.js";
import { termWindow, windowText, requirementsFor, latestByRequirement, openViewer, avatarFor, hydratePhotos, uploadPhoto, clean } from "./common.js";
import { periodForTerm, termsForPeriod, PERIODS } from "../core/policy.js";

const MAX_MB = 15;
const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const ENROLLMENT = ["Enrolled", "Not Enrolled", "On Leave", "Graduated", "Transferred"];

const st = () => S.student || {};
const subs = () => S.d.submissions || [];
const curAY = () => settings().currentAcademicYear || S.master.academicYears[0]?.id || "";
function termsOfStudent(ay) {
  const recs = (S.d.studentAcademicHistory || []).filter(r => r.academicYear === ay);
  const school = S.master.schools.find(s => s.id === (recs[0]?.schoolId || st().current?.schoolId));
  const terms = ["T1", "T2"];
  if (school?.termsPerYear === 3 || recs.some(r => r.term === "T3") || subs().some(s => s.academicYear === ay && s.term === "T3")) terms.push("T3");
  return terms;
}
const recordFor = (ay, term) => (S.d.studentAcademicHistory || []).find(r => r.academicYear === ay && r.term === term) || null;

function waiting(main) {
  if (!S.student) { main.innerHTML = `<div class="loading">Loading your record…</div>`; return true; }
  return false;
}

function termStatus(ay, term) {
  const reqs = requirementsFor(term).filter(r => r.requiredForAllowance !== false);
  const tSubs = subs().filter(s => s.academicYear === ay && s.term === term);
  const latest = latestByRequirement(tSubs);
  const approved = new Set(tSubs.filter(s => s.status === "Approved").map(s => s.requirementCode));
  const rows = reqs.map(r => ({ r, s: latest[r.code] || null, ok: approved.has(r.code) }));
  return { rows, done: rows.filter(x => x.ok).length, total: rows.length };
}

/* ---------------- Dashboard ---------------- */
export function dashboard(main) {
  if (waiting(main)) return;
  const s = st(), cur = s.current || {}, ay = curAY();
  const ents = (S.d.allowances || []).filter(e => e.status !== "Cancelled");
  const released = ents.filter(e => e.status === "Released").reduce((t, e) => t + Number(e.amount || 0), 0);
  const pending = ents.filter(e => e.status !== "Released").reduce((t, e) => t + Number(e.amount || 0), 0);
  const latest = Object.values(latestByRequirementAllLocal(subs()));
  const returned = latest.filter(x => x.status === "Returned");
  const pend = Object.keys(s.pendingChanges || {});
  main.innerHTML = `
    ${s.programStatus === "Ended" ? `<div class="notice bad"><b>Program ended</b> effective ${fmtDate(s.programEnded?.effectiveDate)}: ${esc(s.programEnded?.reason || "")}. Your records and allowance history remain available.</div>` : ""}
    ${returned.length ? `<div class="notice bad">${returned.length} document${returned.length > 1 ? "s were" : " was"} returned for correction. <a href="#/documents">Review the remarks and upload a corrected version.</a></div>` : ""}
    ${pend.length ? `<div class="notice info">Waiting for the TOSCAN Office to verify your change to: ${pend.map(k => k === "atmNumber" ? "ATM number" : "date of birth").join(", ")}.</div>` : ""}
    <div class="card"><div class="profile">${avatarFor(s, s.photoPath, "lg")}
      <div class="info"><h2>${esc(fullName(s))}</h2>
        <div class="small muted">TOSCAN ID <b class="mono">${esc(s.studentId)}</b> · ${esc(s.qualification?.batch || s.batch || "Batch not set")}</div>
        <div class="chips" style="margin-top:.4rem">${classBadge(s.classification)}${programBadge(s.programStatus)}${s.latinHonor ? `<span class="badge b-info">${esc(s.latinHonor)}</span>` : ""}</div>
      </div>
      <dl class="kv small" style="min-width:260px">
        <dt>School</dt><dd>${esc(cur.school || "—")}</dd><dt>Program</dt><dd>${esc(cur.program || "—")} ${esc(cur.yearLevel || "")}</dd>
        <dt>Current term</dt><dd>${cur.term ? `${esc(TERM_NAMES[cur.term])}, AY ${esc(cur.academicYear)}` : "Not recorded"}</dd>
      </dl></div></div>
    <div class="stats">
      <div class="stat"><div class="n">${money(released)}</div><div class="l">Allowance received</div></div>
      <div class="stat"><div class="n">${money(pending)}</div><div class="l">Approved, not yet released</div></div>
      <a class="stat" href="#/documents"><div class="n">${subs().filter(x => x.status === "Approved").length}</div><div class="l">Documents approved</div></a>
      <a class="stat ${returned.length ? "alert" : ""}" href="#/documents"><div class="n">${returned.length}</div><div class="l">Returned for correction</div></a>
    </div>
    <div class="split">
      <div>
        <div class="card"><div class="card-head"><h3>Document compliance — AY ${esc(ay)}</h3><a class="btn sm" href="#/documents">Open my documents</a></div>
          ${termsOfStudent(ay).map(t => complianceBlock(ay, t)).join("")}</div>
        <div class="card"><div class="card-head"><h3>Allowance progress — AY ${esc(ay)}</h3><a class="btn sm" href="#/allowance">Full ledger</a></div>
          <div class="grid g2">${PERIODS.map(p => periodTimeline(ay, p)).join("")}</div></div>
      </div>
      <div class="card"><div class="card-head"><h3>Notifications</h3><a href="#/notifications" class="small">All</a></div>
        ${S.notifications.slice(0, 6).map(n => `<div style="padding:.5rem 0;border-bottom:1px solid var(--line)"><b class="small">${esc(n.title)}</b><div class="xs muted">${fmtDateTime(n.createdAt)}</div><div class="small">${esc(n.body)}</div></div>`).join("") || `<div class="empty">Nothing yet.</div>`}</div>
    </div>`;
  hydratePhotos(main);
}
dashboard.deps = ["r:student", "r:submissions", "r:allowances", "r:eligibility", "r:studentAcademicHistory", "notifications", "settings", "requirements", "academicYears", "schools", "r:deadlineExtensions"];

function latestByRequirementAllLocal(list) {
  const out = {};
  for (const s of list) { if (s.status === "Superseded") continue; const k = `${s.requirementCode}|${s.academicYear}|${s.term}`; if (!out[k] || (s.version || 1) > (out[k].version || 1)) out[k] = s; }
  return out;
}

function complianceBlock(ay, term) {
  const { rows, done, total } = termStatus(ay, term);
  const w = termWindow({ studentId: st().studentId, academicYear: ay, term, record: recordFor(ay, term), extensions: S.d.deadlineExtensions || [] });
  const wt = windowText(w);
  return `<div style="margin-bottom:.9rem"><div class="card-head" style="margin-bottom:.3rem"><b>${esc(TERM_NAMES[term])}</b><span class="small muted">${done} of ${total} approved</span></div>
    <div class="progress"><div style="width:${total ? done / total * 100 : 0}%"></div></div>
    <div class="chips" style="margin:.4rem 0">${rows.map(x => `<span class="small">${esc(x.r.name)}</span> ${x.ok ? docBadge("Approved") : docBadge(x.s?.status)}`).join(" &nbsp; ")}</div>
    <div class="xs muted">${esc(wt.text)}</div></div>`;
}

/** Documents → Qualified → Payroll → Released, for one allowance period. */
function periodTimeline(ay, period) {
  const e = (S.d.eligibility || []).find(x => x.academicYear === ay && x.period === period);
  const ents = (S.d.allowances || []).filter(x => x.academicYear === ay && x.period === period && x.status !== "Cancelled");
  const terms = termsForPeriod(settings().termPeriodMap, period).map(t => TERM_SHORT[t]).join(" / ");
  const st = e?.status;
  const steps = [
    { label: "Documents approved", done: e?.docsComplete, bad: st === "Returned for Correction", note: e ? (e.docsComplete ? "Complete" : st) : "Not started" },
    { label: "Eligibility decided", done: ["Qualified", "Included in Payroll", "Released"].includes(st), bad: st === "Not Qualified", note: st === "Not Qualified" ? `Not qualified: ${e.decision?.reason || ""}` : ["Qualified", "Included in Payroll", "Released"].includes(st) ? "Qualified" : "Waiting" },
    { label: "Payroll", done: ents.some(x => ["Included in Payroll", "Released"].includes(x.status)), cur: ents.some(x => x.status === "Payroll In Progress"), note: ents.map(x => `${x.payrollNo || "Awaiting payroll"} · ${money(x.amount)}`).join("; ") || "—" },
    { label: "Released", done: ents.length && ents.every(x => x.status === "Released"), note: ents.filter(x => x.releasedAt).map(x => `${fmtDate(x.releasedAt)} (${x.paymentRef || ""})`).join("; ") || "—" }
  ];
  return `<div><b>${esc(PERIOD_NAMES[period])}</b> <span class="xs muted">${esc(terms)}</span> ${eligBadge(st)}
    <ul class="timeline small" style="margin-top:.6rem">${steps.map(s => `<li class="${s.done ? "done" : s.bad ? "bad" : s.cur ? "current" : ""}"><b>${esc(s.label)}</b><div class="when">${esc(s.note)}</div></li>`).join("")}</ul></div>`;
}

/* ---------------- Documents ---------------- */
let docAY = null, docTerm = null;
export function documents(main) {
  if (waiting(main)) return;
  const years = S.master.academicYears.map(a => a.id);
  docAY = docAY && years.includes(docAY) ? docAY : (years.includes(curAY()) ? curAY() : years[0]);
  if (!docAY) { main.innerHTML = `<div class="page-head"><h1>My Documents</h1></div><div class="notice info">The TOSCAN Office has not set up an academic year yet.</div>`; return; }
  const terms = termsOfStudent(docAY);
  docTerm = terms.includes(docTerm) ? docTerm : (st().current?.academicYear === docAY && terms.includes(st().current?.term) ? st().current.term : terms[0]);
  const record = recordFor(docAY, docTerm);
  const w = termWindow({ studentId: st().studentId, academicYear: docAY, term: docTerm, record, extensions: S.d.deadlineExtensions || [] });
  const wt = windowText(w);
  const canSubmitWindow = ["open", "no-calendar"].includes(w.state);
  const { rows } = termStatus(docAY, docTerm);
  const extra = requirementsFor(docTerm).filter(r => r.requiredForAllowance === false);
  const tSubs = subs().filter(s => s.academicYear === docAY && s.term === docTerm).sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
  const period = periodForTerm(settings().termPeriodMap, docTerm);
  main.innerHTML = `
    <div class="page-head"><div><h1>My Documents</h1><p>Upload the required documents for each term. Approved documents are kept permanently and can't be changed.</p></div>
      <div class="btn-row" data-nodirty><div><label>Academic year</label><select id="ay">${opts(years, docAY)}</select></div></div></div>
    <div class="tabs" role="tablist">${terms.map(t => `<button data-t="${t}" class="${t === docTerm ? "active" : ""}">${esc(TERM_NAMES[t])}</button>`).join("")}</div>
    ${!record ? `<div class="notice warn">You haven't recorded your enrollment for ${esc(TERM_NAMES[docTerm])}, AY ${esc(docAY)}. <a href="#/enrollment">Add it</a> so the Office can confirm your deadline.</div>` : ""}
    <div class="notice ${wt.cls}">${esc(wt.text)}</div>
    ${docTerm === "T3" ? `<div class="notice info">Third-term documents are used for academic monitoring and count toward the ${esc(PERIOD_NAMES[period] || "")} only — a third term never creates a third allowance.</div>` : ""}
    <div class="req-grid">${[...rows.map(x => ({ ...x, required: true })), ...extra.map(r => ({ r, s: latestByRequirement(tSubs)[r.code] || null, ok: false, required: false }))].map(x => reqRow(x, canSubmitWindow)).join("")}</div>
    <div class="card" style="margin-top:1rem"><div class="card-head"><h3>Submission history — ${esc(TERM_NAMES[docTerm])}, AY ${esc(docAY)}</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Submitted</th><th>Document</th><th>Version</th><th>Status</th><th>Remarks</th><th></th></tr></thead><tbody>
      ${tSubs.map((s, i) => `<tr><td class="nowrap">${fmtDateTime(s.submittedAt)}</td><td>${esc(s.requirementName)}</td><td>v${s.version || 1}</td><td>${docBadge(s.status)}</td><td class="small">${esc(s.remarks || "")}</td><td><button class="btn sm" data-view="${i}">View</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">No documents submitted for this term yet.</td></tr>`}
      </tbody></table></div></div>`;
  $("#ay").onchange = e => { docAY = e.target.value; documents(main); };
  $$("[data-t]", main).forEach(b => b.onclick = () => { docTerm = b.dataset.t; documents(main); });
  $$("[data-view]", main).forEach(b => b.onclick = () => openViewer(tSubs, +b.dataset.view));
  $$("[data-up]", main).forEach(inp => inp.onchange = () => uploadDoc(inp, main));
  $$("[data-open]", main).forEach(b => b.onclick = () => { const list = tSubs.filter(s => s.requirementCode === b.dataset.open); openViewer(list, 0); });
}
documents.deps = ["r:student", "r:submissions", "r:studentAcademicHistory", "r:deadlineExtensions", "requirements", "academicYears", "schools", "settings"];

function reqRow({ r, s, ok, required }, windowOpen) {
  const status = ok ? "Approved" : s?.status;
  const correcting = ok && s && s.status !== "Approved";
  const approvedOpen = s?.status === "Approved" && s.supersession?.open;
  const canUpload = windowOpen && (!s || s.status === "Returned" || approvedOpen) && !correcting;
  const label = !s ? "Upload" : s.status === "Returned" ? "Upload corrected version" : approvedOpen ? "Upload replacement" : "";
  return `<div class="req-row">
    <div><div class="name">${esc(r.name)} ${required ? "" : `<span class="badge">Optional</span>`}</div>
      <div class="small muted">${esc(r.description || "")}</div>
      <div class="chips" style="margin-top:.35rem">${docBadge(status)}${s ? `<span class="xs muted">v${s.version || 1} · ${fmtDateTime(s.submittedAt)}</span>` : ""}${ok ? `<span class="xs muted">🔒 Locked</span>` : ""}</div>
      ${s?.status === "Returned" ? `<div class="notice bad small" style="margin:.5rem 0 0">Returned: ${esc(s.remarks)}</div>` : ""}
      ${approvedOpen ? `<div class="notice warn small" style="margin:.5rem 0 0">The Office asked for a corrected copy: ${esc(s.supersession.reason)}</div>` : ""}
      <div class="progress hidden" data-prog="${esc(r.code)}"><div></div></div></div>
    <div class="btn-row">
      ${s ? `<button class="btn sm" data-open="${esc(r.code)}">View</button>` : ""}
      ${canUpload ? `<label class="btn sm primary" style="margin:0">${label}<input type="file" class="hidden" accept="application/pdf,image/jpeg,image/png,image/webp" data-up="${esc(r.code)}" data-nodirty></label>` : ""}
    </div></div>`;
}

async function uploadDoc(input, main) {
  const file = input.files[0]; if (!file) return;
  const code = input.dataset.up, req = S.master.requirements.find(r => r.code === code);
  if (!TYPES.includes(file.type)) return toast("Only PDF, JPG, PNG or WEBP files are accepted.", "err");
  if (file.size > MAX_MB * 1048576) return toast(`The file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_MB} MB.`, "err");
  const ok = await confirmBox({ title: `Submit ${req.name}?`, body: `${esc(file.name)} for ${esc(TERM_NAMES[docTerm])}, AY ${esc(docAY)}. Once approved it is locked and can't be replaced.`, confirmText: "Submit" });
  if (!ok) { input.value = ""; return; }
  const id = doc(collection(db, "submissions")).id;
  const safe = file.name.replace(/[^\w.\- ]+/g, "_").slice(-120);
  const bar = $(`[data-prog="${code}"]`, main);
  bar?.classList.remove("hidden");
  try {
    const task = uploadBytesResumable(ref(storage, `documents/${st().studentId}/${id}/${safe}`), file, { contentType: file.type });
    task.on("state_changed", s2 => { if (bar) $("div", bar).style.width = (s2.bytesTransferred / s2.totalBytes * 100).toFixed(0) + "%"; });
    await task;
    await call("submitDocument", { submissionId: id, requirementCode: code, academicYear: docAY, term: docTerm, fileName: safe });
    toast(`${req.name} submitted for review.`, "ok");
  } catch (e) {
    toast(e.code === "storage/unauthorized" ? "Upload not allowed. Your account may not be active yet." : e.message, "err");
  } finally { bar?.classList.add("hidden"); input.value = ""; }
}

/* ---------------- Allowance ledger ---------------- */
export function allowance(main) {
  if (waiting(main)) return;
  const ents = [...(S.d.allowances || [])].sort((a, b) => `${b.academicYear}${b.period}`.localeCompare(`${a.academicYear}${a.period}`));
  const live = ents.filter(e => e.status !== "Cancelled");
  const released = live.filter(e => e.status === "Released").reduce((t, e) => t + Number(e.amount || 0), 0);
  const pending = live.filter(e => e.status !== "Released").reduce((t, e) => t + Number(e.amount || 0), 0);
  const years = [...new Set([curAY(), ...ents.map(e => e.academicYear), ...(S.d.eligibility || []).map(e => e.academicYear)].filter(Boolean))].sort().reverse();
  main.innerHTML = `
    <div class="page-head"><div><h1>My Allowance</h1><p>Every allowance period, from eligibility to release, including records from earlier years.</p></div></div>
    <div class="stats">
      <div class="stat"><div class="n">${money(released)}</div><div class="l">Total received</div></div>
      <div class="stat"><div class="n">${money(pending)}</div><div class="l">Approved, not yet released</div></div>
      <div class="stat"><div class="n">${live.filter(e => e.status === "Released").length}</div><div class="l">Periods paid</div></div>
    </div>
    ${years.map(ay => `<div class="card"><h3>AY ${esc(ay)}</h3><div class="grid g2">${PERIODS.map(p => periodTimeline(ay, p)).join("")}</div></div>`).join("")}
    <div class="card"><div class="card-head"><h3>Allowance ledger</h3></div><div class="table-wrap"><table>
      <thead><tr><th>School year</th><th>Period</th><th>Allowance</th><th class="right">Amount</th><th>Status</th><th>Payroll</th><th>Released</th><th>Reference</th><th>Source</th></tr></thead>
      <tbody>${ents.map(e => `<tr><td>${esc(e.academicYear)}</td><td>${esc(PERIOD_NAMES[e.period])}</td><td>${esc(e.typeName || e.typeCode)}</td><td class="right">${money(e.amount)}</td><td>${entBadge(e.status)}</td><td class="mono">${esc(e.payrollNo || "—")}</td><td>${e.releasedAt ? fmtDate(e.releasedAt) : "—"}</td><td class="small">${esc(e.paymentRef || "")}</td><td class="small">${e.source === "imported" ? "Historical record" : "Portal"}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">No allowance has been recorded yet.</td></tr>`}</tbody>
      ${ents.length ? `<tfoot><tr><td colspan="3">Total received</td><td class="right">${money(released)}</td><td colspan="5"></td></tr></tfoot>` : ""}
    </table></div></div>`;
}
allowance.deps = ["r:allowances", "r:eligibility", "settings"];

/* ---------------- Enrollment records ---------------- */
export function enrollment(main) {
  if (waiting(main)) return;
  const recs = [...(S.d.studentAcademicHistory || [])].sort((a, b) => `${b.academicYear}${b.term}`.localeCompare(`${a.academicYear}${a.term}`));
  const s = st(), cur = s.current || {}, lists = settings().lists;
  const years = S.master.academicYears.map(a => a.id);
  main.innerHTML = `
    <div class="page-head"><div><h1>Enrollment Records</h1><p>One record per term. Earlier terms are kept as your academic history. A change of school, level or program is verified by the TOSCAN Office.</p></div></div>
    <div class="card"><h3>Add or update a term</h3>
      <form id="ef" class="grid g3">
        <div><label class="req">Academic year</label><select name="academicYear" required>${opts(years, curAY())}</select></div>
        <div><label class="req">Term</label><select name="term" required>${opts(Object.entries(TERM_NAMES), cur.term || "T1")}</select></div>
        <div><label class="req">School</label><select name="schoolId" id="sch">${opts(S.master.schools.filter(x => x.active !== false).map(x => [x.id, x.name]), cur.schoolId || "", "— Other (type below) —")}</select></div>
        <div id="other-school" class="span2"><label>School name (if not in the list)</label><input type="text" name="school" value="${esc(cur.schoolId ? "" : cur.school || "")}"></div>
        <div><label>School address</label><input type="text" name="schoolAddress" value="${esc(cur.schoolAddress || "")}"></div>
        <div><label>Educational level</label><select name="level">${opts(lists.levels, cur.level, "—")}</select></div>
        <div><label>Course, strand or program</label><input type="text" name="program" list="dl-programs" value="${esc(cur.program || "")}">${datalist("dl-programs", lists.programs)}</div>
        <div><label>Year level</label><select name="yearLevel">${opts(lists.yearLevels, cur.yearLevel, "—")}</select></div>
        <div><label>Enrollment status</label><select name="enrollmentStatus">${opts(ENROLLMENT, cur.enrollmentStatus || "Enrolled")}</select></div>
        <div><label>Expected graduation</label><input type="date" name="expectedGraduation" value="${esc(cur.expectedGraduation || "")}"></div>
        <div class="spanall btn-row end"><button class="btn primary" type="submit">Save term record</button></div>
      </form></div>
    <div class="card"><div class="card-head"><h3>Academic history</h3></div><div class="table-wrap"><table>
      <thead><tr><th>Academic year</th><th>Term</th><th>School</th><th>Program</th><th>Year level</th><th>Enrollment</th><th>Term opened</th><th>Status</th></tr></thead>
      <tbody>${recs.map(r => `<tr><td>${esc(r.academicYear)}</td><td>${esc(TERM_NAMES[r.term])}</td><td>${esc(r.school)}</td><td>${esc(r.program)}</td><td>${esc(r.yearLevel)}</td><td>${esc(r.enrollmentStatus)}</td><td>${r.openingDate ? fmtDate(r.openingDate) : "<span class='muted'>School calendar</span>"}</td><td>${recordBadge(r.status)}${r.remarks ? `<div class="xs muted">${esc(r.remarks)}</div>` : ""}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">No term records yet.</td></tr>`}</tbody></table></div></div>
    <div class="card"><h3>At TOSCAN qualification</h3><dl class="kv"><dt>School</dt><dd>${esc(s.qualification?.schoolAtQualification || "—")}</dd><dt>Batch</dt><dd>${esc(s.qualification?.batch || "—")}</dd><dt>Year qualified</dt><dd>${esc(s.qualification?.yearQualified || "—")}</dd></dl></div>`;
  const sch = $("#sch"), other = $("#other-school");
  const sync = () => other.classList.toggle("hidden", !!sch.value); sch.onchange = sync; sync();
  $("#ef").onsubmit = ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target).entries());
    busy(ev.target.querySelector("[type=submit]"), async () => {
      const r = await call("submitAcademicRecord", d);
      clean();
      toast(r.status === "Verified" ? "Term record saved." : "Saved. The TOSCAN Office will verify this change.", "ok");
    }).catch(() => {});
  };
}
enrollment.deps = ["r:studentAcademicHistory", "academicYears", "schools", "settings"];

/* ---------------- Profile ---------------- */
export function profile(main) {
  if (waiting(main)) return;
  const s = st(), q = s.qualification || {}, pend = s.pendingChanges || {};
  const hist = [...(S.d.programStatusHistory || [])].sort((a, b) => (b.changedAt?.seconds || 0) - (a.changedAt?.seconds || 0));
  main.innerHTML = `
    <div class="page-head"><div><h1>My Profile</h1><p>Contact details update immediately. Identity and payment details are verified by the TOSCAN Office first.</p></div></div>
    <div class="card"><div class="profile">${avatarFor(s, s.photoPath, "lg")}
      <div class="info"><h2>${esc(fullName(s))}</h2><div class="small muted">${esc(s.email || "")}</div>
        <div class="btn-row" style="margin-top:.7rem"><label class="btn" style="margin:0">Change photo<input type="file" accept="image/*" class="hidden" id="ph" data-nodirty></label><span class="xs muted">A clear, front-facing photo. It is resized automatically.</span></div></div></div></div>
    <div class="split"><div class="card"><h3>Personal information</h3>
      <form id="pf" class="grid g2">
        <div><label>Surname</label><input type="text" value="${esc(s.surname)}" disabled></div>
        <div><label>First name</label><input type="text" value="${esc(s.firstName)}" disabled></div>
        <div><label>Middle name</label><input type="text" value="${esc(s.middleName)}" disabled></div>
        <div><label>Date of birth ${pend.dateOfBirth ? `<span class="badge b-warn">Change pending</span>` : ""}</label><input type="date" name="dateOfBirth" value="${esc(pend.dateOfBirth?.value || s.dateOfBirth || "")}"></div>
        <div><label class="req">Contact number</label><input type="tel" name="contact" value="${esc(s.contact || "")}" required></div>
        <div><label>ATM number ${pend.atmNumber ? `<span class="badge b-warn">Change pending</span>` : ""}</label><input type="text" name="atmNumber" value="${esc(pend.atmNumber?.value || s.atmNumber || "")}"></div>
        <div class="spanall"><label class="req">Complete address</label><input type="text" name="address" value="${esc(s.address || "")}" required></div>
        <div class="spanall btn-row end"><button class="btn primary" type="submit">Save changes</button></div>
      </form></div>
      <div><div class="card"><h3>TOSCAN qualification</h3><dl class="kv small">
        <dt>TOSCAN ID</dt><dd class="mono">${esc(s.studentId)}</dd><dt>Classification</dt><dd>${esc(CLASS_NAMES[s.classification] || "Not set")}</dd>
        <dt>Batch</dt><dd>${esc(q.batch || s.batch || "—")}</dd><dt>Year qualified</dt><dd>${esc(q.yearQualified || "—")}</dd>
        <dt>School at qualification</dt><dd>${esc(q.schoolAtQualification || "—")}</dd><dt>Admitted</dt><dd>${q.admissionDate ? fmtDate(q.admissionDate) : "—"}</dd>
        <dt>Latin honor</dt><dd>${esc(s.latinHonor || "None")}</dd></dl>
        <p class="xs muted">Only the TOSCAN Office can change these details.</p></div>
      <div class="card"><h3>Program membership</h3><p>${programBadge(s.programStatus)}</p>
        <ul class="timeline small">${hist.map(h => `<li class="${h.to === "Ended" ? "bad" : "done"}"><b>${esc(h.from)} → ${esc(h.to)}</b><div class="when">Effective ${fmtDate(h.effectiveDate)} · ${esc(h.reason)}</div></li>`).join("") || "<li>Active since admission.</li>"}</ul></div></div></div>`;
  hydratePhotos(main);
  $("#ph").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await uploadPhoto(f); toast("Photo updated.", "ok"); } catch (err) { toast(err.message, "err"); } };
  $("#pf").onsubmit = ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target).entries());
    busy(ev.target.querySelector("[type=submit]"), async () => {
      const r = await call("updateMyProfile", d);
      clean();
      toast(r.pending?.length ? "Saved. Your identity or payment change is waiting for verification." : "Profile saved.", "ok");
    }).catch(() => {});
  };
}
profile.deps = ["r:student", "r:programStatusHistory"];

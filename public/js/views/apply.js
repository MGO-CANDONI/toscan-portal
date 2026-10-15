// Public pages (no sign-in): TOSCAN search application, status check and bidbook upload.
import { auth, db, doc, getDoc, call, storage, ref, uploadBytesResumable, signInAnonymously, signOut } from "../fb.js";
import { $, $$, esc, toast, fmtDate, manilaToday, printHtml, printHeader } from "../ui.js";
import { CORE_FIELDS, OTHER_SCHOOL, mergeApplicationConfig, applicationsOpen, APP_STATUS, BIDBOOK_MAX_MB } from "../core/applications.js";

let cached = null;
/** The public form settings (readable without signing in). */
export async function loadApplicationConfig(fresh = false) {
  if (cached && !fresh) return cached;
  try { const s = await getDoc(doc(db, "publicConfig", "application")); cached = s.exists() ? mergeApplicationConfig(s.data()) : null; }
  catch { cached = null; }
  return cached;
}

const STATUS_CLASS = {
  [APP_STATUS.SUBMITTED]: "b-info", [APP_STATUS.SCREENING]: "b-warn", [APP_STATUS.FINALIST]: "b-gold", [APP_STATUS.BIDBOOK]: "b-gold",
  [APP_STATUS.NOT_SELECTED]: "", [APP_STATUS.TOP10]: "b-ok", [APP_STATUS.TOP20]: "b-ok", [APP_STATUS.WITHDRAWN]: ""
};
export const appBadge = s => `<span class="badge ${STATUS_CLASS[s] || ""}">${esc(s)}</span>`;
const paras = t => esc(t || "").split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
const header = (title, sub = "") => `<header class="pub-head"><a href="#/" class="pub-brand"><img src="assets/toscan-seal.png" alt=""><span><b>TOSCAN</b><small>Municipal Government of Candoni</small></span></a>${sub}</header>`;

/** Card on the sign-in page. */
export async function loginCard(el) {
  const c = await loadApplicationConfig(true);
  if (!c || !el.isConnected) return;
  const open = applicationsOpen(c, manilaToday());
  el.innerHTML = `<div class="apply-card">
    <div class="apply-kicker">${open ? "Now accepting applications" : "TOSCAN search"}</div>
    <h3>${esc(c.title)}</h3>
    <p class="small">${open ? `Grade 10 students may apply${c.closesOn ? ` until <b>${fmtDate(c.closesOn)}</b>` : ""}. No account is needed.` : "Applicants can check their status and Top 20 finalists can upload their bidbook here."}</p>
    <div class="btn-row">${open ? `<a class="btn gold" href="#/apply">Apply now</a>` : ""}<a class="btn" href="#/track">Check status / upload bidbook</a></div>
    ${c.bidbookTemplateUrl ? `<a class="apply-dl" href="${esc(c.bidbookTemplateUrl)}" target="_blank" rel="noopener">⤓ Download the bidbook form (for Top 20 finalists)</a>` : ""}
  </div>`;
}

/* ---------------- Application form ---------------- */
export async function applyPage(root) {
  root.innerHTML = `<div class="pub">${header("")}<main class="pub-main"><div class="loading">Loading the application form…</div></main></div>`;
  const c = await loadApplicationConfig(true);
  const schools = c?.schools || [];
  const main = $(".pub-main", root);
  if (!c || !applicationsOpen(c, manilaToday())) {
    main.innerHTML = `<div class="card pub-card"><h1>Applications are closed</h1><p class="muted">The TOSCAN Office is not accepting applications right now.${c?.contactEmail ? ` For questions, write to <a href="mailto:${esc(c.contactEmail)}">${esc(c.contactEmail)}</a>.` : ""}</p><div class="btn-row"><a class="btn" href="#/track">Check an application</a><a class="btn" href="#/">Back to sign in</a></div></div>`;
    return;
  }
  const input = (f, name) => {
    const req = f.required ? "required" : "";
    if (f.type === "textarea") return `<textarea name="${name}" rows="4" ${req}></textarea>`;
    if (f.type === "select") return `<select name="${name}" ${req}><option value="">Choose…</option>${f.options.map(o => `<option>${esc(o)}</option>`).join("")}</select>`;
    if (f.type === "school") return `<select name="${name}" ${req}><option value="">Choose your school…</option>${schools.map(o => `<option>${esc(o)}</option>`).join("")}<option value="${OTHER_SCHOOL}">Other — my school is not listed</option></select>
      <input type="text" name="schoolOther" class="hidden" placeholder="Type the full name of your school" style="margin-top:.4rem">`;
    const t = { tel: "tel", email: "email", date: "date", number: "number" }[f.type] || "text";
    return `<input type="${t}" name="${name}" ${t === "number" ? 'step="any"' : ""} ${req} autocomplete="${{ lastName: "family-name", firstName: "given-name", middleName: "additional-name", email: "email", contact: "tel" }[f.id] || "off"}">`;
  };
  const q = (f, name) => `<div class="pub-q ${f.type === "textarea" ? "spanall" : ""}"><label class="${f.required ? "req" : ""}">${esc(f.label)}</label>${f.help ? `<div class="xs muted pub-help">${esc(f.help)}</div>` : ""}${input(f, name)}</div>`;
  main.innerHTML = `<form class="card pub-card" id="af" novalidate>
      <div class="pub-title"><div class="apply-kicker">Application form</div><h1>${esc(c.title)}</h1></div>
      <div class="pub-intro">${paras(c.intro)}
        ${c.guidelinesUrl ? `<p><i>Read the <a href="${esc(c.guidelinesUrl)}" target="_blank" rel="noopener">General Guidelines</a>.</i></p>` : ""}
        ${c.contactEmail ? `<p class="small muted">Contact us at <a href="mailto:${esc(c.contactEmail)}">${esc(c.contactEmail)}</a>${c.closesOn ? ` · Applications close on <b>${fmtDate(c.closesOn)}</b>` : ""}</p>` : ""}</div>
      <div class="grid g2 pub-fields">${CORE_FIELDS.map(f => q(f, f.id)).join("")}${c.questions.map(f => q(f, `a_${f.id}`)).join("")}</div>
      <input type="text" name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">
      <label class="check pub-consent"><input type="checkbox" name="consent"> <span>I certify that the information above is true and correct. I agree that the Municipal Government of Candoni may process my personal information for the TOSCAN search under the Data Privacy Act of 2012 (RA 10173).</span></label>
      <div class="form-msg err" id="am" role="alert"></div>
      <div class="btn-row end"><a class="btn" href="#/">Cancel</a><button class="btn primary" type="submit">Submit application</button></div>
    </form>`;
  const f = $("#af", main);
  f.school.onchange = () => { f.schoolOther.classList.toggle("hidden", f.school.value !== OTHER_SCHOOL); if (f.school.value === OTHER_SCHOOL) f.schoolOther.focus(); };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $("#am", main); msg.textContent = "";
    const missing = [...CORE_FIELDS.map(x => [x, x.id]), ...c.questions.map(x => [x, `a_${x.id}`])].filter(([x, n]) => x.required && !f.elements[n].value.trim());
    $$(".pub-q", f).forEach(d => d.classList.remove("invalid"));
    missing.forEach(([, n]) => f.elements[n].closest(".pub-q").classList.add("invalid"));
    if (missing.length) { msg.textContent = `Please answer: ${missing.map(([x]) => x.label).join(", ")}.`; f.elements[missing[0][1]].focus(); return; }
    if (f.school.value === OTHER_SCHOOL && !f.schoolOther.value.trim()) { msg.textContent = "Type the name of your school."; f.schoolOther.focus(); return; }
    if (!f.consent.checked) { msg.textContent = "Please tick the certification and data privacy box."; return; }
    const data = { consent: true, website: f.website.value, schoolOther: f.schoolOther.value.trim(), answers: {} };
    CORE_FIELDS.forEach(x => { data[x.id] = f.elements[x.id].value.trim(); });
    c.questions.forEach(x => { data.answers[x.id] = f.elements[`a_${x.id}`].value.trim(); });
    const btn = f.querySelector("[type=submit]"); btn.disabled = true; btn.textContent = "Submitting…";
    try {
      const r = await call("submitApplication", data);
      done(main, r, data, c);
      window.scrollTo(0, 0);
    } catch (e) { msg.textContent = e.message; btn.disabled = false; btn.textContent = "Submit application"; }
  };
}

function done(main, r, data, c) {
  main.innerHTML = `<div class="card pub-card pub-done">
    <div class="pub-check" aria-hidden="true">✓</div>
    <h1>Application received</h1>
    <p>Thank you, ${esc(data.firstName)}. Your application to the <b>${esc(r.title)}</b> was received.</p>
    <div class="code-box"><div><span>Reference number</span><b>${esc(r.ref)}</b></div><div><span>Access code</span><b>${esc(r.code)}</b></div></div>
    <p class="small muted">A confirmation with these details was also sent to <b>${esc(data.email)}</b>. Check your Spam folder if it doesn't arrive.</p>
    <div class="notice warn small"><b>Save these now</b> — take a screenshot or write them down. You need both to check your status and, if you are selected as a Top 20 finalist, to upload your bidbook. The access code is shown only once.</div>
    <div class="btn-row"><button class="btn" id="pr">Print / save as PDF</button><a class="btn primary" href="#/track">Check status</a><a class="btn" href="#/">Back to sign in</a></div>
  </div>`;
  lastCreds = { ref: r.ref, code: r.code };
  $("#pr", main).onclick = () => printHtml(`${printHeader(r.title, "Application acknowledgment")}
    <p style="font-size:14pt">Applicant: <b>${esc(`${data.lastName}, ${data.firstName} ${data.middleName}`)}</b> — ${esc(data.school)}</p>
    <p style="font-size:14pt">Reference number: <b>${esc(r.ref)}</b><br>Access code: <b>${esc(r.code)}</b></p>
    <p>Keep this. Use the reference number and access code on the TOSCAN Portal sign-in page under “Check status / upload bidbook”.</p>`);
}
let lastCreds = null;

/* ---------------- Status and bidbook ---------------- */
export async function trackPage(root) {
  root.innerHTML = `<div class="pub">${header("")}<main class="pub-main">
    <form class="card pub-card" id="tf">
      <div class="pub-title"><div class="apply-kicker">TOSCAN search</div><h1>Check your application</h1></div>
      <p class="muted">Enter the reference number and access code you received after applying.</p>
      <div class="grid g2"><div><label for="t-ref">Reference number</label><input id="t-ref" name="ref" placeholder="TS2027-0001" autocapitalize="characters" required></div>
        <div><label for="t-code">Access code</label><input id="t-code" name="code" placeholder="XXXXX-XXXXX" autocapitalize="characters" autocomplete="off" required></div></div>
      <div class="form-msg err" id="tm" role="alert"></div>
      <div class="btn-row end"><a class="btn" href="#/">Back to sign in</a><button class="btn primary" type="submit">Check status</button></div>
      <p class="xs muted">Lost your access code? Write to the TOSCAN Office with your full name and school; they can issue a new one.</p>
    </form><div id="tres"></div></main></div>`;
  const f = $("#tf", root);
  if (lastCreds) { f.ref.value = lastCreds.ref; f.code.value = lastCreds.code; }
  f.onsubmit = async ev => {
    ev.preventDefault(); $("#tm", root).textContent = "";
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try { showStatus($("#tres", root), await call("applicationStatus", { ref: f.ref.value.trim(), code: f.code.value.trim() }), { ref: f.ref.value.trim().toUpperCase(), code: f.code.value.trim() }); }
    catch (e) { $("#tm", root).textContent = e.message; $("#tres", root).innerHTML = ""; }
    finally { btn.disabled = false; }
  };
  if (lastCreds) f.requestSubmit();
}

function showStatus(el, s, creds) {
  el.innerHTML = `<div class="card pub-card">
    <div class="card-head"><div><div class="xs muted">${esc(s.ref)} · ${esc(s.title)}</div><h2 style="margin:.15rem 0 0">${esc(s.name)}</h2><div class="small muted">${esc(s.school)}</div></div>${appBadge(s.status)}</div>
    <p>${esc(s.statusText)}</p>
    ${s.message ? `<div class="notice info"><b>Message from the TOSCAN Office:</b> ${esc(s.message)}</div>` : ""}
    ${s.bidbook ? `<div class="notice ok small">Bidbook received: <b>${esc(s.bidbook.fileName)}</b> (${(s.bidbook.size / 1048576).toFixed(1)} MB) on ${fmtDate(s.bidbook.at)}.</div>` : ""}
    ${s.bidbookOpen ? `<div class="bidbook-box">
        <h3>${s.bidbook ? "Upload a corrected bidbook" : "Upload your bidbook"}</h3>
        <ol class="small">
          <li>${s.bidbookTemplateUrl ? `<a href="${esc(s.bidbookTemplateUrl)}" target="_blank" rel="noopener">Download the bidbook form</a>` : "Get the bidbook form from the TOSCAN Office"} and fill in every section.</li>
          <li>Attach the proofs of veracity and your scanned Form 137-A, and sign the certifications.</li>
          <li>Save or scan everything as <b>one PDF</b> (at most ${s.maxMB || BIDBOOK_MAX_MB} MB) and upload it below${s.bidbookDeadline ? ` on or before <b>${fmtDate(s.bidbookDeadline)}</b>` : ""}.</li></ol>
        <div class="btn-row"><input type="file" id="bb" accept="application/pdf,.pdf"><button class="btn gold" id="bb-up">Upload bidbook</button></div>
        <div class="progress hidden" id="bb-p"><div></div></div><div class="form-msg" id="bb-m"></div></div>` : ""}
  </div>`;
  const up = $("#bb-up", el); if (!up) return;
  up.onclick = async () => {
    const file = $("#bb", el).files[0], m = $("#bb-m", el);
    const setMsg = (t, ok) => { m.textContent = t; m.className = "form-msg " + (ok ? "ok" : "err"); };
    if (!file) return setMsg("Choose your bidbook PDF first.");
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return setMsg("The bidbook must be a PDF file.");
    if (file.size > (s.maxMB || BIDBOOK_MAX_MB) * 1048576) return setMsg(`The file is larger than ${s.maxMB || BIDBOOK_MAX_MB} MB. Compress the scans and try again.`);
    up.disabled = true; setMsg("");
    const bar = $("#bb-p", el); bar.classList.remove("hidden");
    try {
      const cred = await signInAnonymously(auth);
      const safe = file.name.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60) || "bidbook";
      const path = `searchApplications/${creds.ref}/${cred.user.uid}/${Date.now()}_${safe}.pdf`;
      await new Promise((res, rej) => {
        const task = uploadBytesResumable(ref(storage, path), file, { contentType: "application/pdf" });
        task.on("state_changed", t => { $("div", bar).style.width = `${Math.round(100 * t.bytesTransferred / t.totalBytes)}%`; }, rej, res);
      });
      const r = await call("submitBidbook", { ...creds, path, fileName: file.name });
      await signOut(auth).catch(() => {});
      showStatus(el, r, creds);
      toast("Bidbook uploaded. Thank you!", "ok");
    } catch (e) {
      await signOut(auth).catch(() => {});
      bar.classList.add("hidden"); up.disabled = false;
      setMsg(e.code === "auth/operation-not-allowed" ? "Bidbook uploads are not switched on yet. Please contact the TOSCAN Office." : e.code?.startsWith?.("storage/") ? "The upload failed. Check your connection and try again." : e.message);
    }
  };
}

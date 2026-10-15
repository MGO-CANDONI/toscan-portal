// App entry: sign-in lifecycle, role claims, shell, navigation and routing.
import { auth, onAuthStateChanged, signOut, getRedirectResult, authError } from "./fb.js";
import { S, startCommon, startRole, stop, onChange, isAdmin, isStaff, can } from "./state.js";
import { $, $$, esc, toast, avatar, fullName, ROLE_NAMES, closeModals } from "./ui.js";
import * as Auth from "./views/auth.js";
import * as Student from "./views/student.js";
import * as Staff from "./views/staff.js";
import * as Students from "./views/students.js";
import * as Payroll from "./views/payroll.js";
import * as Reports from "./views/reports.js";
import * as Imports from "./views/imports.js";
import * as Admin from "./views/admin.js";
import * as Common from "./views/common.js";
import * as Apply from "./views/apply.js";
import * as Applications from "./views/applications.js";

let screen = "", current = null, dirty = false, claimsStamp = null, renderTimer = null, anonActive = false;

/* Pages anyone can open without signing in. */
const PUBLIC = { apply: Apply.applyPage, track: Apply.trackPage };
const publicPage = () => PUBLIC[(location.hash.replace(/^#\/?/, "") || "").split("/")[0]];
function renderSignedOut() {
  const page = publicPage();
  if (page) { screen = "public"; page($("#app")); window.scrollTo(0, 0); }
  else { screen = "login"; Auth.renderLogin($("#app")); }
}

getRedirectResult(auth).catch(e => setTimeout(() => toast(authError(e), "err"), 400));

onAuthStateChanged(auth, async user => {
  // A short anonymous sign-in is used only to upload a bidbook from a public page: leave that page alone.
  if (user?.isAnonymous) { anonActive = true; if (!screen) signOut(auth); return; }
  if (!user && anonActive) { anonActive = false; if (screen) return; }
  stop(); closeModals();
  Object.assign(S, { user, claims: {}, account: undefined, student: null, settings: null, d: {}, notifications: [] });
  S.ready.clear(); claimsStamp = null; screen = "";
  if (!user) { renderSignedOut(); return; }
  $("#app").innerHTML = `<div class="center-screen"><div class="loading">Loading your account…</div></div>`;
  startCommon(user.uid);
});

onChange(async key => {
  if (key === "account") return onAccount();
  if (screen !== "shell") return;
  updateChrome();
  if (current?.deps && (current.deps.includes(key) || current.deps.includes("*"))) scheduleRender();
});

async function onAccount() {
  const acc = S.account;
  if (!acc || acc.status !== "approved") {
    stop("r:");
    if (screen === "register-form" || (!acc && screen === "awaiting")) return;
    screen = "auth"; Auth.renderAccountState($("#app"), acc, () => { screen = "register-form"; });
    return;
  }
  const stamp = acc.claimsUpdatedAt?.seconds || 0;
  if (stamp !== claimsStamp) {
    claimsStamp = stamp;
    const tok = await auth.currentUser.getIdTokenResult(true);
    S.claims = tok.claims || {};
    if (!S.claims.role) {
      // Approved in Firestore but no role on the sign-in token yet (e.g. approved by the
      // previous version of the portal). Keep checking, and offer the ways out.
      screen = "activating";
      $("#app").innerHTML = `<div class="center-screen"><div class="card" style="max-width:480px">
        <h2>Activating your access…</h2>
        <p class="muted">This page refreshes on its own. If nothing happens within a minute, your account was approved in the earlier version of the portal and needs to be activated again:</p>
        <ul class="small"><li><b>TOSCAN Office administrator:</b> click <b>Claim administrator access</b>.</li><li><b>Everyone else:</b> ask an administrator to open <b>Users &amp; Permissions</b>, select your account and click <b>Save</b>.</li></ul>
        <div class="btn-row" style="margin-top:1rem"><button class="btn primary" id="act-claim">Claim administrator access</button><button class="btn" id="act-out">Sign out</button></div>
        <div class="form-msg err" id="act-msg"></div></div></div>`;
      $("#act-out").onclick = () => signOut(auth);
      $("#act-claim").onclick = async e => {
        e.target.disabled = true; $("#act-msg").textContent = "";
        try { await (await import("./fb.js")).call("bootstrapAdmin"); claimsStamp = null; onAccount(); }
        catch (err) { $("#act-msg").textContent = err.message; e.target.disabled = false; }
      };
      const retry = async () => {
        if (screen !== "activating" || !auth.currentUser) return;
        const t = await auth.currentUser.getIdTokenResult(true);
        if (t.claims.role) { claimsStamp = null; onAccount(); } else setTimeout(retry, 5000);
      };
      setTimeout(retry, 5000);
      return;
    }
    startRole(S.claims);
    screen = "";
  }
  if (screen !== "shell") renderShell();
  else updateChrome();
}

/* ---------------- navigation ---------------- */
function navGroups() {
  const counts = Common.counts();
  if (S.claims.role === "student") return [
    { items: [["home", "Dashboard"], ["documents", "My Documents", counts.returned], ["allowance", "My Allowance"], ["enrollment", "Enrollment Records"], ["profile", "My Profile"], ["notifications", "Notifications", counts.unread]] }
  ];
  const groups = [
    { items: [["home", "Overview"], ["notifications", "Notifications", counts.unread]] },
    { label: "Students", items: [["students", "Student Directory"], can("reviewDocuments") && ["review", "Document Review", counts.queue], can("verifyRecords") && ["verify", "Verifications", counts.verify], can("decideEligibility") && ["eligibility", "Eligibility", counts.decide]] },
    { label: "TOSCAN Search", items: [can("reviewApplications") && ["applications", "Applications", counts.applications]] },
    { label: "Allowance", items: [(can("preparePayroll") || can("approvePayroll") || can("releasePayroll")) && ["payroll", "Payroll"], can("encodeHistory") && ["history", "Historical Records"], can("viewReports") && ["reports", "Reports"]] }
  ];
  if (isAdmin()) groups.push({ label: "Administration", items: [["approvals", "Registrations", counts.pending], ["users", "Users & Permissions"], ["settings", "Settings & Master Data"], ["migration", "Data Import & Migration"], ["audit", "Audit Trail"]] });
  groups.push({ items: [["profile", "My Profile"]] });
  return groups.map(g => ({ ...g, items: g.items.filter(Boolean) })).filter(g => g.items.length);
}

const ROUTES = {
  home: () => S.claims.role === "student" ? Student.dashboard : Staff.overview,
  documents: () => Student.documents, allowance: () => Student.allowance, enrollment: () => Student.enrollment,
  profile: () => S.claims.role === "student" ? Student.profile : Common.staffProfile,
  notifications: () => Common.notifications,
  students: () => isStaff() && Students.directory, student: () => isStaff() && Students.detail,
  review: () => can("reviewDocuments") && Staff.review, verify: () => can("verifyRecords") && Staff.verify,
  eligibility: () => can("decideEligibility") && Staff.eligibility,
  payroll: () => isStaff() && Payroll.list, payrollDetail: () => isStaff() && Payroll.detail,
  history: () => can("encodeHistory") && Imports.historical, reports: () => can("viewReports") && Reports.reports,
  approvals: () => isAdmin() && Admin.approvals, users: () => isAdmin() && Admin.users, settings: () => isAdmin() && Admin.settings,
  migration: () => isAdmin() && Imports.migration, audit: () => isAdmin() && Admin.audit,
  applications: () => can("reviewApplications") && Applications.list
};

function parseHash() {
  const parts = (location.hash.replace(/^#\/?/, "") || "home").split("/").map(decodeURIComponent);
  let name = parts[0];
  if (name === "students" && parts[1]) name = "student";
  if (name === "payroll" && parts[1]) name = "payrollDetail";
  return { name, params: parts.slice(1) };
}

function renderShell() {
  screen = "shell";
  $("#app").innerHTML = `
    <header class="topbar">
      <button class="icon-btn menu-btn" id="menu-btn" aria-label="Menu">☰</button>
      <img class="seal" src="assets/toscan-seal.png" alt="">
      <div class="brand"><b>TOSCAN Portal</b><span>Municipal Government of Candoni</span></div>
      <div class="spacer"></div>
      <a class="icon-btn" href="#/notifications" aria-label="Notifications" id="bell">🔔<span class="dot hidden" id="bell-dot"></span></a>
      <div class="me" id="me"></div>
      <button class="icon-btn" id="logout">Log out</button>
    </header>
    <div class="layout"><nav class="side" id="nav" aria-label="Main"></nav><main class="main" id="main" tabindex="-1"></main></div>`;
  $("#logout").onclick = async () => { if (!dirty || confirm("Leave without saving your changes?")) await signOut(auth); };
  $("#menu-btn").onclick = () => document.body.classList.toggle("nav-open");
  const main = $("#main");
  main.addEventListener("input", e => { if (!e.target.closest("[data-nodirty]")) dirty = true; });
  updateChrome();
  route();
}

window.addEventListener("hashchange", () => {
  if (screen === "shell") route();
  else if (screen === "login" || screen === "public") renderSignedOut();
});
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

function markClean() { dirty = false; $("#refresh-bar")?.remove(); }
window.addEventListener("toscan:clean", markClean);
window.addEventListener("toscan:account-refresh", () => { screen = "awaiting"; if (S.account) onAccount(); });

function route() {
  const { name, params } = parseHash();
  const view = (ROUTES[name] || ROUTES.home)() || ROUTES.home();
  current = { view, params, name, deps: view.deps || ["*"] };
  dirty = false;
  document.body.classList.remove("nav-open");
  updateChrome();
  renderCurrent();
  window.scrollTo(0, 0);
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (!dirty) return renderCurrent();
    if ($("#refresh-bar")) return;
    $("#main").insertAdjacentHTML("afterbegin", `<div class="notice info btn-row" id="refresh-bar" style="justify-content:space-between"><span>New information is available.</span><button class="btn sm" id="rb">Refresh (unsaved changes on this page will be lost)</button></div>`);
    $("#rb").onclick = () => { markClean(); renderCurrent(); };
  }, 150);
}

async function renderCurrent() {
  const main = $("#main"); if (!main || !current) return;
  try { await current.view(main, current.params); }
  catch (e) { console.error(e); main.innerHTML = `<div class="notice bad">This page could not be displayed: ${esc(e.message)}</div>`; }
}

function updateChrome() {
  if (screen !== "shell") return;
  const acc = S.account || {}, who = S.claims.role === "student" ? S.student : acc.registration || acc;
  const name = S.claims.role === "student" ? fullName(S.student) : (acc.displayName || fullName(acc.registration) || acc.email);
  Common.photoUrl(S.claims.role === "student" ? S.student?.photoPath : acc.photoPath).then(url => {
    const me = $("#me"); if (me) me.innerHTML = `${avatar(who, url, "sm")}<div class="who"><div>${esc(name || "")}</div><div class="role">${esc(ROLE_NAMES[S.claims.role] || "")}</div></div>`;
  });
  const unread = S.notifications.filter(n => !n.read).length;
  const dot = $("#bell-dot"); if (dot) { dot.textContent = unread; dot.classList.toggle("hidden", !unread); }
  const active = current?.name === "student" ? "students" : current?.name === "payrollDetail" ? "payroll" : current?.name;
  $("#nav").innerHTML = navGroups().map(g => `${g.label ? `<div class="group">${esc(g.label)}</div>` : ""}${g.items.map(([k, l, c]) =>
    `<a href="#/${k}" class="${active === k ? "active" : ""}">${esc(l)}${c ? `<span class="count">${c}</span>` : ""}</a>`).join("")}`).join("");
}

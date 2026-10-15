// Shared pieces: counters, photos, document viewer, notifications, staff profile, deadlines.
import { S, isStaff, settings } from "../state.js";
import { db, doc, updateDoc, serverTimestamp, call, fileUrl, fileBlob, storageError, storage, ref, uploadBytes, auth } from "../fb.js";
import { $, $$, esc, toast, openModal, busy, fmtDate, fmtDateTime, docBadge, TERM_NAMES, avatar, fullName, downloadBlob, ROLE_NAMES, PERMISSION_NAMES } from "../ui.js";
import { submissionWindow, windowState, resolveOpeningDate, latestByRequirement, requirementApplies } from "../core/policy.js";

export const clean = () => window.dispatchEvent(new Event("toscan:clean"));

export function counts() {
  const unread = S.notifications.filter(n => !n.read).length;
  if (S.claims.role === "student") {
    const latest = Object.values(latestByRequirementAll(S.d.submissions || []));
    return { unread, returned: latest.filter(s => s.status === "Returned").length };
  }
  return {
    unread,
    queue: (S.d.queue || []).length,
    verify: (S.d.verify || []).length + (S.d.students || []).filter(s => s.pendingChanges && Object.keys(s.pendingChanges).length).length,
    decide: (S.d.eligibility || []).filter(e => e.status === "For Review" && e.docsComplete).length,
    pending: (S.d.users || []).filter(u => u.status === "pending").length,
    applications: (S.d.applications || []).filter(a => ["Submitted", "Bidbook Submitted"].includes(a.status)).length
  };
}

/** Latest version per (requirement, year, term). */
export function latestByRequirementAll(subs) {
  const out = {};
  for (const s of subs) {
    if (s.status === "Superseded") continue;
    const k = `${s.requirementCode}|${s.academicYear}|${s.term}`;
    if (!out[k] || (s.version || 1) > (out[k].version || 1)) out[k] = s;
  }
  return out;
}

/* ---------------- photos ---------------- */
const photoCache = new Map();
export function photoUrl(path) {
  if (!path) return Promise.resolve("");
  if (!photoCache.has(path)) photoCache.set(path, fileUrl(path).catch(() => ""));
  return photoCache.get(path);
}
/** Renders avatars after the page is drawn: <span data-photo="path" data-name='{"firstName":..}'> */
export function hydratePhotos(root, size = "") {
  $$("[data-photo]", root).forEach(async el => {
    const url = await photoUrl(el.dataset.photo);
    if (url && el.isConnected) el.outerHTML = avatar({}, url, size || el.dataset.size || "");
  });
}
export function avatarFor(person, path, size = "") {
  return path ? `<span data-photo="${esc(path)}" data-size="${size}">${avatar(person, "", size)}</span>` : avatar(person, "", size);
}

export async function resizeImage(file, max = 640) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, "image/jpeg", 0.86));
}
export async function uploadPhoto(file) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  const blob = await resizeImage(file);
  const path = `photos/${auth.currentUser.uid}/profile-${Date.now()}.jpg`;
  await uploadBytes(ref(storage, path), blob, { contentType: "image/jpeg" });
  await call("updateMyProfile", { photoPath: path });
  return path;
}

/* ---------------- deadlines (same code as the server) ---------------- */
export function termWindow({ studentId, academicYear, term, record, extensions = [] }) {
  const ay = S.master.academicYears.find(a => a.id === academicYear) || null;
  const school = S.master.schools.find(s => s.id === (record?.schoolId)) || null;
  const openingDate = resolveOpeningDate({ record, school, academicYear: ay, ay: academicYear, term });
  const ext = extensions.find(e => e.studentId === studentId && e.academicYear === academicYear && e.term === term);
  const cfg = settings().deadline;
  const win = submissionWindow({ openingDate, months: cfg.months, policy: cfg.policy, cutoff: cfg.cutoff, extensionDeadline: ext?.deadline || null });
  return { win, state: windowState(win), openingDate, extension: ext || null };
}
export function windowText({ win, state, openingDate, extension }) {
  if (state === "no-calendar") return { cls: "info", text: "The opening date for this term has not been set yet. You can still submit; the TOSCAN Office will confirm the deadline." };
  const close = win.closesAt ? fmtDateTime(win.closesAt) : "";
  if (state === "not-yet") return { cls: "info", text: `Submission opens on ${fmtDateTime(win.opensAt)}.` };
  if (state === "closed") return { cls: "bad", text: `The submission deadline (${close}) has passed. Contact the TOSCAN Office if you need an extension.` };
  if (!win.closesAt) return { cls: "ok", text: "Submission is open." };
  const ms = win.closesAt - Date.now(), days = Math.floor(ms / 86400000), hours = Math.floor(ms % 86400000 / 3600000);
  return { cls: days < 14 ? "warn" : "ok", text: `Submission is open until ${close} — ${days} day${days === 1 ? "" : "s"} ${hours} hour${hours === 1 ? "" : "s"} left.${extension ? ` (Extended: ${extension.reason})` : ""} Term opened ${fmtDate(openingDate)}.` };
}

export function requirementsFor(term) {
  return S.master.requirements.filter(r => requirementApplies(r, term));
}
export { latestByRequirement };

/* ---------------- document viewer ---------------- */
/**
 * Opens a document with Previous/Next across `list` (submissions).
 * actions(sub) may return extra HTML for the side panel; onAction(sub, el) wires it.
 */
export function openViewer(list, index, { actions, onAction } = {}) {
  let i = index;
  const m = openModal(`<div id="vw"></div>`, { size: "wide" });
  const draw = async () => {
    const s = list[i];
    const st = S.d.students ? (S.d.students.find(x => x.id === s.studentId) || {}) : S.student || {};
    $("#vw", m).innerHTML = `
      <div class="card-head" style="margin-bottom:.6rem"><div><h2 style="margin:0">${esc(s.requirementName)} <span class="muted small">v${s.version || 1}</span></h2>
        <div class="small muted">${esc(fullName(st))} · ${esc(TERM_NAMES[s.term])}, AY ${esc(s.academicYear)}</div></div>
        <div class="btn-row"><button class="btn sm" id="vw-prev" ${i ? "" : "disabled"}>← Previous</button><span class="small muted">${i + 1} of ${list.length}</span><button class="btn sm" id="vw-next" ${i < list.length - 1 ? "" : "disabled"}>Next →</button></div></div>
      <div class="viewer">
        <div class="frame" id="vw-frame"><div class="loading" style="color:#ddd">Opening file…</div></div>
        <div>
          <dl class="kv small">
            <dt>Status</dt><dd>${docBadge(s.status)}</dd>
            <dt>File</dt><dd style="word-break:break-all">${esc(s.fileName)}</dd>
            <dt>Size</dt><dd>${((s.size || 0) / 1048576).toFixed(2)} MB</dd>
            <dt>Submitted</dt><dd>${fmtDateTime(s.submittedAt)}</dd>
            <dt>Reviewer</dt><dd>${esc(s.reviewer?.name || "—")}</dd>
            <dt>Reviewed</dt><dd>${fmtDateTime(s.reviewedAt)}</dd>
            ${s.remarks ? `<dt>Remarks</dt><dd>${esc(s.remarks)}</dd>` : ""}
            ${s.previousSubmissionId ? `<dt>Replaces</dt><dd>Version ${(s.version || 2) - 1}</dd>` : ""}
            ${s.supersededBy ? `<dt>Superseded</dt><dd>by a newer approved version</dd>` : ""}
          </dl>
          <div class="btn-row" style="margin:.8rem 0"><button class="btn sm" id="vw-dl">Download</button></div>
          ${actions ? `<div id="vw-actions">${actions(s)}</div>` : ""}
          <h4 style="margin-top:1rem">Review history</h4>
          <ul class="timeline small">${(s.history || []).map(h => `<li class="${h.action === "approved" || h.action === "approve" ? "done" : h.action === "return" ? "bad" : ""}"><div class="when">${fmtDateTime(h.at)} · ${esc(h.byName || "")}</div>${esc(historyLabel(h.action))}${h.remarks ? `: ${esc(h.remarks)}` : ""}</li>`).join("") || "<li>No history.</li>"}</ul>
        </div>
      </div>`;
    $("#vw-prev", m).onclick = () => { i--; draw(); };
    $("#vw-next", m).onclick = () => { i++; draw(); };
    $("#vw-dl", m).onclick = e => busy(e.target, async () => downloadBlob(s.fileName, await fileBlob(s.storagePath)));
    if (onAction) onAction(s, $("#vw-actions", m), () => { m.close(); });
    try {
      const url = await fileUrl(s.storagePath);
      const frame = $("#vw-frame", m); if (!frame) return;
      frame.innerHTML = s.contentType === "application/pdf"
        ? `<iframe src="${url}#toolbar=1" title="${esc(s.fileName)}"></iframe>`
        : `<img src="${url}" alt="${esc(s.requirementName)}">`;
    } catch (e) { const f = $("#vw-frame", m); if (f) f.innerHTML = `<div class="notice bad" style="margin:1rem">${esc(storageError(e))}</div>`; }
  };
  draw();
  return m;
}
const historyLabel = a => ({ submitted: "Submitted", start: "Review started", approve: "Approved", return: "Returned for correction", superseded: "Superseded", note: "Note" }[a] || a);

/* ---------------- notifications ---------------- */
export async function notifications(main) {
  const list = S.notifications;
  main.innerHTML = `
    <div class="page-head"><div><h1>Notifications</h1><p>The latest ${list.length} notifications.</p></div>
      <button class="btn" id="read-all" ${list.some(n => !n.read) ? "" : "disabled"}>Mark all as read</button></div>
    <div class="card flush">${list.length ? `<ul class="notes">${list.map(n => `
      <li class="${n.read ? "" : "unread"}" data-id="${esc(n.id)}"><span class="kind ${esc(n.kind || "")}"></span>
        <div style="flex:1"><b>${esc(n.title)}</b><div class="small">${esc(n.body)}</div><div class="xs muted">${fmtDateTime(n.createdAt)}</div></div>
        ${n.link && n.link.startsWith("#/") ? `<a class="btn sm" href="${esc(n.link)}">Open</a>` : ""}</li>`).join("")}</ul>` : `<div class="empty">No notifications yet.</div>`}</div>`;
  const mark = ids => Promise.all(ids.map(id => updateDoc(doc(db, "notifications", id), { read: true, readAt: serverTimestamp() })));
  $("#read-all").onclick = e => busy(e.target, () => mark(list.filter(n => !n.read).map(n => n.id)));
  $$(".notes li a", main).forEach(a => a.addEventListener("click", () => { const id = a.closest("li").dataset.id; const n = list.find(x => x.id === id); if (n && !n.read) mark([id]); }));
  // Opening the page marks what was shown as read after a moment.
  setTimeout(() => { const unread = list.filter(n => !n.read).map(n => n.id); if (unread.length && location.hash.startsWith("#/notifications")) mark(unread).catch(() => {}); }, 2500);
}
notifications.deps = ["notifications"];

/* ---------------- staff/admin profile ---------------- */
export async function staffProfile(main) {
  const a = S.account || {};
  main.innerHTML = `
    <div class="page-head"><div><h1>My Profile</h1><p>${esc(a.email)}</p></div></div>
    <div class="card"><div class="profile">${avatarFor(a.registration || a, a.photoPath, "lg")}
      <div class="info"><h2>${esc(a.displayName || fullName(a.registration))}</h2>
        <div class="chips"><span class="badge b-dark">${esc(ROLE_NAMES[a.role])}</span></div>
        <div class="btn-row" style="margin-top:.8rem"><label class="btn" style="margin:0">Change photo<input type="file" accept="image/*" class="hidden" id="ph" data-nodirty></label></div></div></div></div>
    <div class="card"><h3>What I can do</h3><ul>${Object.values(PERMISSION_NAMES).map(p => `<li>${esc(p)}</li>`).join("")}${a.role === "admin" ? "<li>Administration: registrations, users, settings and master data, data import, audit trail</li>" : ""}</ul></div>`;
  hydratePhotos(main);
  $("#ph").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await uploadPhoto(f); toast("Photo updated.", "ok"); } catch (err) { toast(err.message, "err"); }
  };
}
staffProfile.deps = ["account"];

export function isStaffUser() { return isStaff(); }

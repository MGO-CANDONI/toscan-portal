// Date helpers. All program dates are calendar dates in Asia/Manila (UTC+8,
// no daylight saving), stored as "YYYY-MM-DD" strings.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidYMD(s) {
  if (typeof s !== "string") return false;
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parts(ymd) {
  if (!isValidYMD(ymd)) throw new Error(`Invalid date "${ymd}" (expected YYYY-MM-DD)`);
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

function fmt(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Add calendar months; the day is clamped to the end of a shorter month (Aug 31 + 1 → Sep 30). */
export function addMonthsYMD(ymd, n) {
  const { y, m, d } = parts(ymd);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addDaysYMD(ymd, n) {
  const { y, m, d } = parts(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 00:00:00.000 Manila time on that date, as a JS Date (UTC instant). */
export function manilaStart(ymd) {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d) - MANILA_OFFSET_MS);
}

/** 23:59:59.999 Manila time on that date. */
export function manilaEnd(ymd) {
  return new Date(manilaStart(ymd).getTime() + 24 * 3600 * 1000 - 1);
}

/** Today's date in Manila as YYYY-MM-DD. */
export function manilaToday(now = new Date()) {
  const t = new Date(now.getTime() + MANILA_OFFSET_MS);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** "YYYY-MM" of the given instant in Manila. */
export function manilaMonth(now = new Date()) {
  return manilaToday(now).slice(0, 7);
}

export function manilaDayOfMonth(now = new Date()) {
  return Number(manilaToday(now).slice(8, 10));
}

export function compareYMD(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "2026-2027" style academic-year label check. */
export function isValidAY(ay) {
  const m = /^(\d{4})-(\d{4})$/.exec(ay || "");
  return !!m && Number(m[2]) === Number(m[1]) + 1;
}

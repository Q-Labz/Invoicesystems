// Calendar dates are plain "YYYY-MM-DD" strings, computed in UTC so no
// timezone or DST shift can move an invoice's due date.

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDate(s) {
  if (typeof s !== 'string' || !RE.test(s)) return false;
  const d = parse(s);
  return toISO(d) === s;
}

function parse(s) {
  const [, y, m, d] = RE.exec(s);
  return new Date(Date.UTC(+y, +m - 1, +d));
}

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

export function localToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(s, n) {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

// Adds calendar months, clamping to the month's last day: Jan 31 + 1 month = Feb 28/29.
// `anchorDay` keeps a schedule on its original day-of-month after a short month.
export function addMonths(s, n, anchorDay) {
  const [, y, m, d] = RE.exec(s);
  const day = anchorDay || +d;
  const total = +y * 12 + (+m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return toISO(new Date(Date.UTC(ny, nm, Math.min(day, last))));
}

export function diffDays(a, b) {
  return Math.round((parse(a) - parse(b)) / 86400000);
}

export function startOfMonth(s) {
  return `${s.slice(0, 7)}-01`;
}

export function formatDate(s, locale = 'en-US') {
  if (!s) return '';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parse(s));
}

import { esc } from './lib/doc-render.js';
import { formatMoney, fromMinor } from './lib/money.js';
import { formatDate } from './lib/dates.js';

export { esc };

// ---------- api ----------

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('auth:required'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
  }
  return data;
}

// ---------- state shared across views ----------

export const state = { settings: null, meta: null, taxRates: [] };

export async function loadBoot() {
  const [settings, meta, taxRates] = await Promise.all([api('/settings'), api('/meta'), api('/tax-rates')]);
  Object.assign(state, { settings, meta, taxRates });
}

export const locale = () => state.settings?.locale || 'en-US';
export const money = (minor, cur) => formatMoney(minor ?? 0, cur, locale());
export const date = (s) => (s ? formatDate(s, locale()) : '—');
export const today = () => state.meta?.today;
export { fromMinor };

// Several currencies in one cell: "$1,200.00 · €300.00".
export function moneyList(list, empty = '—') {
  if (!list?.length) return empty;
  return list.map((x) => money(x.amount, x.currency)).join(' · ');
}

// ---------- html ----------

export function statusChip(status) {
  return `<span class="status status-${esc(status)}">${esc(status)}</span>`;
}

export function field(label, control, { span = 6, hint = '', name = '' } = {}) {
  return `<label class="field span-${span}" ${name ? `data-field="${esc(name)}"` : ''}>
    <span>${esc(label)}</span>${control}${hint ? `<small class="hint">${esc(hint)}</small>` : ''}
  </label>`;
}

export function input(name, value = '', attrs = '') {
  return `<input name="${esc(name)}" value="${esc(value ?? '')}" ${attrs}>`;
}

export function textarea(name, value = '', attrs = '') {
  return `<textarea name="${esc(name)}" ${attrs}>${esc(value ?? '')}</textarea>`;
}

export function select(name, options, value, attrs = '') {
  return `<select name="${esc(name)}" ${attrs}>${options
    .map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(label)}</option>`)
    .join('')}</select>`;
}

export function empty(message, action = '') {
  return `<div class="empty"><p>${esc(message)}</p>${action}</div>`;
}

export function pageHead(eyebrow, title, actions = '') {
  return `<header class="page-head">
    <div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1></div>
    <div class="actions">${actions}</div>
  </header>`;
}

// ---------- forms ----------

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

export function clearErrors(root) {
  root.querySelectorAll('.field-error').forEach((e) => e.remove());
  root.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
}

// Maps API validation details ({ "lines.2.unit_price": "..." }) onto inputs.
export function showErrors(root, err) {
  clearErrors(root);
  if (!err.details) return toast(err.message, true);
  let first = null;
  const unplaced = [];
  for (const [key, msg] of Object.entries(err.details)) {
    const el = root.querySelector(`[name="${CSS.escape(key)}"]`) || root.querySelector(`[data-error="${CSS.escape(key)}"]`);
    if (!el) {
      unplaced.push(`${key.replace(/^lines\.(\d+)\./, (_, i) => `Line ${+i + 1} `)}: ${msg}`);
      continue;
    }
    el.classList.add('invalid');
    const note = document.createElement('small');
    note.className = 'field-error';
    note.textContent = msg;
    el.insertAdjacentElement('afterend', note);
    first ||= el;
  }
  first?.focus();
  toast(unplaced.length ? unplaced.join(' · ') : err.message, true);
}

// ---------- toast / dialogs ----------

// A toast can carry one follow-up action ("Copy link", "Open").
export function toast(message, isError = false, action = null) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      action.run();
      el.remove();
    });
    el.append(b);
  }
  box.append(el);
  setTimeout(() => el.remove(), isError ? 7000 : action ? 6000 : 3500);
}

// ---------- unsaved changes ----------

let leaveGuard = null;

// An editor registers a function that returns true while it holds unsaved work.
export function setLeaveGuard(fn) {
  leaveGuard = fn;
}

export function canLeave() {
  if (!leaveGuard || !leaveGuard()) return true;
  return window.confirm('Leave without saving? The changes on this page will be lost.');
}

export function clearLeaveGuard() {
  leaveGuard = null;
}

// True when a keystroke belongs to a text field, not to a global shortcut.
export function typing(e) {
  const t = e.target;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';

// Opens a <dialog> with a form. Resolves with the submit handler's result, or null on cancel.
export function dialog({ title, body, submit = 'Save', onSubmit, danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" novalidate>
      <div class="dialog-head"><h2>${esc(title)}</h2></div>
      <div class="dialog-body">${body}</div>
      <div class="dialog-foot">
        <button type="button" class="btn btn-quiet" data-cancel>Cancel</button>
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-solid'}">${esc(submit)}</button>
      </div>
    </form>`;
    document.body.append(dlg);
    const form = dlg.querySelector('form');
    let result = null;
    dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        result = onSubmit ? await onSubmit(formData(form), form) : true;
        dlg.close();
      } catch (err) {
        showErrors(form, err);
      } finally {
        btn.disabled = false;
      }
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    dlg.showModal();
    form.querySelector('input, select, textarea')?.focus();
  });
}

export function confirmDialog(title, message, submit = 'Confirm', danger = true) {
  return dialog({ title, body: `<p>${esc(message)}</p>`, submit, danger });
}

export async function download(path) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!res.ok) return toast('Export failed', true);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'export';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function go(hash) {
  location.hash = hash;
}

// Whole table rows act as links; the inner <a> stays for keyboard and middle-click.
export function rowLinks(e) {
  const row = e.target.closest('tr[data-href]');
  if (!row || e.target.closest('a, button, input, select, label')) return;
  location.hash = row.dataset.href;
}

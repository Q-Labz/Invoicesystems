import { api, state, loadBoot, esc, toast, canLeave, clearLeaveGuard, typing, modKey, go } from './ui.js';
import { openPalette, togglePalette } from './palette.js';
import { dashboardView } from './views/dashboard.js';
import { documentListView, documentDetailView, documentEditView } from './views/documents.js';
import { clientListView, clientDetailView, clientEditView } from './views/clients.js';
import { itemsView } from './views/items.js';
import { recurringListView, recurringEditView } from './views/recurring.js';
import { paymentsView } from './views/payments.js';
import { reportsView } from './views/reports.js';
import { settingsView } from './views/settings.js';

const root = document.getElementById('root');

const routes = [
  [/^\/$/, () => dashboardView],
  [/^\/(invoices|estimates)$/, (m) => (ctx) => documentListView(ctx, kindOf(m[1]))],
  [/^\/(invoices|estimates)\/new$/, (m) => (ctx) => documentEditView(ctx, kindOf(m[1]), null)],
  [/^\/(invoices|estimates)\/(\d+)$/, (m) => (ctx) => documentDetailView(ctx, kindOf(m[1]), +m[2])],
  [/^\/(invoices|estimates)\/(\d+)\/edit$/, (m) => (ctx) => documentEditView(ctx, kindOf(m[1]), +m[2])],
  [/^\/payments$/, () => paymentsView],
  [/^\/clients$/, () => clientListView],
  [/^\/clients\/new$/, () => (ctx) => clientEditView(ctx, null)],
  [/^\/clients\/(\d+)$/, (m) => (ctx) => clientDetailView(ctx, +m[1])],
  [/^\/clients\/(\d+)\/edit$/, (m) => (ctx) => clientEditView(ctx, +m[1])],
  [/^\/items$/, () => itemsView],
  [/^\/recurring$/, () => recurringListView],
  [/^\/recurring\/new$/, () => (ctx) => recurringEditView(ctx, null)],
  [/^\/recurring\/(\d+)$/, (m) => (ctx) => recurringEditView(ctx, +m[1])],
  [/^\/reports$/, () => reportsView],
  [/^\/settings$/, () => settingsView],
];

const NAV = [
  ['/', 'Overview'],
  ['/invoices', 'Invoices'],
  ['/estimates', 'Estimates'],
  ['/payments', 'Payments'],
  ['/recurring', 'Recurring'],
  'sep',
  ['/clients', 'Clients'],
  ['/items', 'Catalog'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
];

function kindOf(s) {
  return s === 'invoices' ? 'invoice' : 'estimate';
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(query)) };
}

const BADGE = { '/invoices': 'overdue', '/estimates': 'open_estimates' };

function shell(auth) {
  root.innerHTML = `
    <a class="skip" href="#main" data-skip>Skip to content</a>
    <div class="shell">
      <header class="topbar">
        <a href="#/" class="wordmark" aria-label="7LABZ invoicing, overview">7LABZ</a>
        <div class="topbar-actions">
          <button class="btn btn-quiet" type="button" data-palette aria-label="Search">Search</button>
          <button class="btn btn-quiet" type="button" data-menu aria-expanded="false" aria-controls="side">Menu</button>
        </div>
      </header>
      <aside class="side" id="side">
        <a href="#/" class="wordmark side-mark" aria-label="7LABZ invoicing, overview">7LABZ<small>Invoicing</small></a>
        <button class="search-trigger" type="button" data-palette>
          <span>Search</span><span><kbd>${esc(modKey)}</kbd><kbd>K</kbd></span>
        </button>
        <nav class="nav" aria-label="Main">
          ${NAV.map((n) => (n === 'sep'
            ? '<div class="sep" role="separator"></div>'
            : `<a href="#${n[0]}" data-nav="${n[0]}"><span>${esc(n[1])}</span>${BADGE[n[0]] ? `<span class="badge" data-badge="${BADGE[n[0]]}" hidden></span>` : ''}</a>`)).join('')}
        </nav>
        <div class="side-foot">
          <div class="side-date" id="today"></div>
          <div class="side-keys"><kbd>N</kbd> invoice <kbd>E</kbd> estimate <kbd>/</kbd> search</div>
          ${auth.required ? '<button type="button" id="logout">Sign out</button>' : ''}
        </div>
      </aside>
      <main id="main" tabindex="-1"></main>
    </div>`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  });
  root.querySelectorAll('[data-palette]').forEach((b) => b.addEventListener('click', () => openPalette()));
  const menu = root.querySelector('[data-menu]');
  menu.addEventListener('click', () => {
    const open = !document.body.classList.contains('nav-open');
    document.body.classList.toggle('nav-open', open);
    menu.setAttribute('aria-expanded', String(open));
  });
  root.querySelector('[data-skip]').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('main').focus();
  });
}

function paintBadges() {
  const b = state.meta?.badges || {};
  document.querySelectorAll('[data-badge]').forEach((el) => {
    const n = b[el.dataset.badge] || 0;
    el.hidden = !n;
    el.textContent = n;
    el.title = el.dataset.badge === 'overdue' ? `${n} overdue` : `${n} awaiting a reply`;
  });
  const t = document.getElementById('today');
  if (t && state.meta) t.textContent = state.meta.today;
}

let renderSeq = 0;
let lastHash = location.hash;
let skipNext = false;

async function render() {
  const main = document.getElementById('main');
  if (!main) return;
  const { path, query } = parseHash();
  const seq = ++renderSeq;
  document.body.classList.remove('nav-open');
  root.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'false');
  clearLeaveGuard();

  document.querySelectorAll('[data-nav]').forEach((a) => {
    const target = a.dataset.nav;
    const active = target === '/' ? path === '/' : path === target || path.startsWith(`${target}/`);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  // Counts and "today" stay fresh without blocking the view.
  api('/meta').then((m) => { state.meta = m; paintBadges(); }).catch(() => {});

  let view = null;
  for (const [re, make] of routes) {
    const m = re.exec(path);
    if (m) {
      view = make(m);
      break;
    }
  }
  // Keep the old view on screen for fast loads; show the loading line only if it takes a moment.
  const slow = setTimeout(() => {
    if (seq === renderSeq) main.innerHTML = '<p class="loading">loading —</p>';
  }, 180);
  if (!view) {
    clearTimeout(slow);
    main.innerHTML = '<div class="empty"><p>Nothing at this address.</p><a class="btn" href="#/">Back to overview</a></div>';
    return;
  }
  try {
    // A view gets a container and returns nothing; it owns its own DOM and listeners.
    const container = document.createElement('div');
    container.className = 'view';
    await view({ el: container, query, path, refresh: render, isCurrent: () => seq === renderSeq });
    clearTimeout(slow);
    if (seq !== renderSeq) return;
    main.replaceChildren(container);
    const title = container.querySelector('h1')?.textContent;
    document.title = title ? `${title} — 7LABZ` : 'Invoicing — 7LABZ';
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  } catch (err) {
    clearTimeout(slow);
    if (seq !== renderSeq) return;
    console.error(err);
    main.innerHTML = `<div class="empty"><p>${esc(err.message || 'Could not load this view.')}</p><a class="btn" href="#/">Back to overview</a></div>`;
  }
}

function onHashChange() {
  if (skipNext) {
    skipNext = false;
    return;
  }
  if (!canLeave()) {
    // Put the address back without re-rendering the editor.
    skipNext = true;
    location.hash = lastHash;
    return;
  }
  lastHash = location.hash;
  render();
}

// Global keys. Single letters act only outside text fields; "g" starts a two-key jump.
let pendingG = 0;
const JUMPS = { o: '/', i: '/invoices', e: '/estimates', p: '/payments', r: '/recurring', c: '/clients', k: '/items', a: '/reports', s: '/settings' };

function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    togglePalette();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || document.querySelector('dialog[open]')) return;
  if (!document.getElementById('main')) return;
  const k = e.key.toLowerCase();
  if (pendingG && Date.now() - pendingG < 1200 && JUMPS[k]) {
    pendingG = 0;
    e.preventDefault();
    go(JUMPS[k]);
    return;
  }
  pendingG = 0;
  if (k === 'g') pendingG = Date.now();
  else if (k === '/' || k === '?') { e.preventDefault(); openPalette(); }
  else if (k === 'n') go('/invoices/new');
  else if (k === 'e') go('/estimates/new');
  else if (k === 'c') go('/clients/new');
  else return;
}

async function loginScreen() {
  root.innerHTML = `
    <div class="cover">
      <div class="cover-inner">
        <div class="eyebrow">7LABZ · Invoicing</div>
        <h1>The ledger is <em>closed.</em></h1>
        <form id="login" novalidate>
          <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
          <button class="cta" type="submit">Open it</button>
        </form>
      </div>
    </div>`;
  const form = document.getElementById('login');
  form.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/login', { method: 'POST', body: { password: form.password.value } });
      start();
    } catch (err) {
      toast(err.message, true);
      form.password.select();
    }
  });
}

async function start() {
  const auth = await api('/auth/me');
  if (auth.required && !auth.signed_in) return loginScreen();
  await loadBoot();
  shell(auth);
  paintBadges();
  render();
}

window.addEventListener('hashchange', onHashChange);
window.addEventListener('keydown', onKey);
window.addEventListener('auth:required', () => loginScreen());
// Views call this after changing settings or tax rates.
window.addEventListener('boot:reload', () => loadBoot());

start().catch((err) => {
  root.innerHTML = `<div class="cover"><div class="empty"><p>${esc(err.message)}</p></div></div>`;
});

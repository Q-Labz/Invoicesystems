import { api, state, loadBoot, esc, toast } from './ui.js';
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

function shell(auth) {
  root.innerHTML = `
    <div class="shell">
      <aside class="side">
        <a href="#/" class="wordmark" aria-label="7LABZ invoicing, overview">7LABZ<small>Invoicing</small></a>
        <nav class="nav" aria-label="Main">
          ${NAV.map((n) => (n === 'sep' ? '<div class="sep" role="separator"></div>' : `<a href="#${n[0]}" data-nav="${n[0]}">${esc(n[1])}</a>`)).join('')}
        </nav>
        <div class="side-foot">
          <div id="today"></div>
          ${auth.required ? '<button type="button" id="logout">Sign out</button>' : ''}
        </div>
      </aside>
      <main id="main" tabindex="-1"></main>
    </div>`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  });
}

let renderSeq = 0;

async function render() {
  const main = document.getElementById('main');
  if (!main) return;
  const { path, query } = parseHash();
  const seq = ++renderSeq;

  document.querySelectorAll('[data-nav]').forEach((a) => {
    const target = a.dataset.nav;
    const active = target === '/' ? path === '/' : path === target || path.startsWith(`${target}/`);
    a.toggleAttribute('aria-current', active);
    if (active) a.setAttribute('aria-current', 'page');
  });

  let view = null;
  for (const [re, make] of routes) {
    const m = re.exec(path);
    if (m) {
      view = make(m);
      break;
    }
  }
  main.innerHTML = '<p class="loading">loading —</p>';
  if (!view) {
    main.innerHTML = '<div class="empty"><p>Nothing at this address.</p><a class="btn" href="#/">Back to overview</a></div>';
    return;
  }
  try {
    // A view gets a container and returns nothing; it owns its own DOM and listeners.
    const container = document.createElement('div');
    await view({ el: container, query, path, refresh: render, isCurrent: () => seq === renderSeq });
    if (seq !== renderSeq) return;
    main.replaceChildren(container);
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    main.innerHTML = `<div class="empty"><p>${esc(err.message || 'Could not load this view.')}</p><a class="btn" href="#/">Back to overview</a></div>`;
  }
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
  document.getElementById('today').textContent = state.meta.today;
  render();
}

window.addEventListener('hashchange', render);
window.addEventListener('auth:required', () => loginScreen());
// Views call this after changing settings or tax rates.
window.addEventListener('boot:reload', () => loadBoot());

start().catch((err) => {
  root.innerHTML = `<div class="cover"><div class="empty"><p>${esc(err.message)}</p></div></div>`;
});

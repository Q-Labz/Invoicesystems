// Command palette: ⌘K / Ctrl+K or "/". Jumps to any document, client or action by keyboard.
import { api, esc, money, statusChip, go, canLeave, modKey } from './ui.js';

const ACTIONS = [
  { label: 'New invoice', hint: 'N', run: () => go('/invoices/new'), words: 'create bill' },
  { label: 'New estimate', hint: 'E', run: () => go('/estimates/new'), words: 'create quote proposal' },
  { label: 'New client', hint: 'C', run: () => go('/clients/new'), words: 'create customer' },
  { label: 'Overview', hint: 'G O', run: () => go('/'), words: 'dashboard home' },
  { label: 'Invoices', hint: 'G I', run: () => go('/invoices'), words: 'list' },
  { label: 'Overdue invoices', hint: '', run: () => go('/invoices?status=overdue'), words: 'late chase unpaid' },
  { label: 'Draft invoices', hint: '', run: () => go('/invoices?status=draft'), words: 'unissued' },
  { label: 'Estimates', hint: 'G E', run: () => go('/estimates'), words: 'quotes' },
  { label: 'Payments', hint: 'G P', run: () => go('/payments'), words: 'cash received' },
  { label: 'Recurring', hint: 'G R', run: () => go('/recurring'), words: 'schedules retainers subscriptions' },
  { label: 'Clients', hint: 'G C', run: () => go('/clients'), words: 'customers' },
  { label: 'Catalog', hint: 'G K', run: () => go('/items'), words: 'items services products' },
  { label: 'Reports', hint: 'G A', run: () => go('/reports'), words: 'aging tax revenue export csv backup' },
  { label: 'Settings', hint: 'G S', run: () => go('/settings'), words: 'business numbering tax rates' },
];

let dlg = null;

export function openPalette(initial = '') {
  if (dlg) return;
  dlg = document.createElement('dialog');
  dlg.className = 'palette';
  dlg.setAttribute('aria-label', 'Search and commands');
  dlg.innerHTML = `
    <div class="palette-input">
      <span class="palette-glyph" aria-hidden="true">›</span>
      <input type="text" placeholder="Find an invoice, client or action" aria-label="Search" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="palette-list">
      <kbd>esc</kbd>
    </div>
    <ul class="palette-list" id="palette-list" role="listbox"></ul>
    <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>${esc(modKey)}</kbd><kbd>K</kbd> toggle</span></div>`;
  document.body.append(dlg);
  const input = dlg.querySelector('input');
  const list = dlg.querySelector('ul');
  let items = [];
  let active = 0;
  let seq = 0;
  let timer = null;

  function paint() {
    if (!items.length) {
      list.innerHTML = '<li class="palette-empty">No matches.</li>';
      return;
    }
    let group = '';
    list.innerHTML = items
      .map((it, i) => {
        const head = it.group !== group ? `<li class="palette-group" role="presentation">${esc((group = it.group))}</li>` : '';
        return `${head}<li role="option" id="pal-${i}" data-i="${i}" class="palette-item" aria-selected="${i === active}">
          <span class="palette-main">${it.html}</span><span class="palette-side">${it.side || ''}</span></li>`;
      })
      .join('');
    input.setAttribute('aria-activedescendant', `pal-${active}`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function actionItems(q) {
    const t = q.toLowerCase();
    return ACTIONS.filter((a) => !t || `${a.label} ${a.words}`.toLowerCase().includes(t)).map((a) => ({
      group: 'Actions',
      html: esc(a.label),
      side: a.hint ? a.hint.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('') : '',
      run: a.run,
    }));
  }

  async function update() {
    const q = input.value.trim();
    const mine = ++seq;
    const actions = actionItems(q);
    items = q ? actions.slice(0, 4) : actions;
    active = 0;
    paint();
    if (!q) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let res;
      try {
        res = await api(`/search?q=${encodeURIComponent(q)}`);
      } catch {
        return;
      }
      if (mine !== seq) return;
      const docs = res.documents.map((d) => ({
        group: 'Documents',
        html: `<span class="mono">${esc(d.number || `Draft ${d.kind}`)}</span> <span class="muted">${esc(d.client_name)}${d.title ? ` · ${esc(d.title)}` : ''}</span>`,
        side: `${esc(money(d.kind === 'invoice' && d.status !== 'draft' ? d.balance : d.total, d.currency))} ${statusChip(d.status)}`,
        run: () => go(`/${d.kind === 'invoice' ? 'invoices' : 'estimates'}/${d.id}`),
      }));
      const clients = res.clients.map((c) => ({
        group: 'Clients',
        html: `${esc(c.name)} <span class="muted">${esc(c.company || c.email || '')}</span>`,
        side: `<span class="muted mono">${esc(c.currency)}</span>`,
        run: () => go(`/clients/${c.id}`),
      }));
      items = [...docs, ...clients, ...actions.slice(0, 4)];
      active = 0;
      paint();
    }, 120);
  }

  function choose(i) {
    const it = items[i];
    if (!it) return;
    close();
    if (canLeave()) it.run();
  }

  function close() {
    if (dlg?.open) dlg.close();
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      active = Math.min(items.length - 1, active + 1);
      paint();
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      active = Math.max(0, active - 1);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && Number(li.dataset.i) !== active) {
      active = Number(li.dataset.i);
      list.querySelectorAll('[aria-selected]').forEach((x) => x.setAttribute('aria-selected', x === li));
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) choose(Number(li.dataset.i));
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close(); // backdrop
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    dlg = null;
  });

  dlg.showModal();
  input.value = initial;
  input.focus();
  update();
}

export function togglePalette() {
  if (dlg) dlg.close();
  else openPalette();
}

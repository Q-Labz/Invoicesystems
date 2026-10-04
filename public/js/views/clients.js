import { api, esc, money, moneyList, date, statusChip, pageHead, empty, state, toast, confirmDialog, showErrors, field, input, select, textarea, qs, go } from '../ui.js';
import { setLeaveGuard } from '../ui.js';
import { ppmToPercent, isCurrency } from '../lib/money.js';
import { rowLinks } from '../ui.js';
import { COMMON_CURRENCIES, bindSaveKeys } from './documents.js';

export async function clientListView({ el, query }) {
  const clients = await api(`/clients${qs({ q: query.q, archived: query.archived })}`);
  el.innerHTML = `
    ${pageHead('Directory', 'Clients', '<a class="cta" href="#/clients/new">Add client</a>')}
    <form class="filters" data-filters>
      <label class="field grow"><span>Search</span><input name="q" value="${esc(query.q || '')}" placeholder="Name, company, email"></label>
      <label class="check"><input type="checkbox" name="archived" ${query.archived ? 'checked' : ''}> Show archived</label>
      <button class="btn" type="submit">Filter</button>
    </form>
    ${clients.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Currency</th><th>Terms</th><th class="num">Open</th><th class="num">Outstanding</th></tr></thead>
      <tbody>${clients.map((c) => `<tr class="row-link" data-href="#/clients/${c.id}">
        <td><a href="#/clients/${c.id}">${esc(c.name)}</a>${c.company ? `<br><span class="muted">${esc(c.company)}</span>` : ''}${c.archived ? ' <span class="status">archived</span>' : ''}</td>
        <td class="muted">${esc(c.email || '—')}</td>
        <td>${esc(c.currency)}</td>
        <td class="muted">${c.payment_terms_days ? `Net ${c.payment_terms_days}` : 'On receipt'}</td>
        <td class="num">${c.open_invoices || '—'}</td>
        <td class="num">${esc(moneyList(c.outstanding))}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : empty(query.q ? 'No clients match.' : 'No clients yet.')}`;
  el.querySelector('[data-filters]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    go(`/clients${qs({ q: f.q.value, archived: f.archived.checked ? '1' : '' })}`);
  });
  el.addEventListener('click', rowLinks);
}

export async function clientDetailView({ el, query, refresh }, id) {
  const from = query.from || '';
  const to = query.to || '';
  const [c, docs, estimates, statement, recurring] = await Promise.all([
    api(`/clients/${id}`),
    api(`/documents${qs({ kind: 'invoice', client_id: id, limit: 100 })}`),
    api(`/documents${qs({ kind: 'estimate', client_id: id, limit: 100 })}`),
    api(`/clients/${id}/statement${qs({ from, to })}`),
    api(`/recurring?client_id=${id}`),
  ]);
  const addr = [c.address_line1, c.address_line2, [c.city, c.region, c.postal_code].filter(Boolean).join(', '), c.country].filter(Boolean).join('\n');
  const tax = state.taxRates.find((t) => t.id === c.default_tax_rate_id);

  el.innerHTML = `
    ${pageHead(c.company || 'Client', c.name, `
      <a class="btn" href="#/clients/${id}/edit">Edit</a>
      <a class="btn" href="#/estimates/new?client_id=${id}">New estimate</a>
      ${c.archived ? '' : '<button class="btn btn-quiet" type="button" data-archive>Archive</button>'}
      ${c.archived ? '' : `<a class="cta" href="#/invoices/new?client_id=${id}">New invoice</a>`}`)}

    <section class="section grid grid-3">
      <div class="panel">
        <h3>Contact</h3>
        <p class="mono">${esc(c.email || 'No email')}${c.cc_emails ? `<br><span class="muted">cc ${esc(c.cc_emails)}</span>` : ''}${c.phone ? `<br>${esc(c.phone)}` : ''}</p>
        ${addr ? `<p class="mono muted pre">${esc(addr)}</p>` : ''}
        ${c.tax_id ? `<p class="mono muted">Tax ID ${esc(c.tax_id)}</p>` : ''}
      </div>
      <div class="panel">
        <h3>Billing defaults</h3>
        <dl class="dl">
          <dt>Currency</dt><dd>${esc(c.currency)}</dd>
          <dt>Terms</dt><dd>${c.payment_terms_days ? `Net ${c.payment_terms_days}` : 'Due on receipt'}</dd>
          <dt>Tax</dt><dd>${tax ? `${esc(tax.name)} ${esc(ppmToPercent(tax.rate_ppm))}%` : 'None'}</dd>
        </dl>
        ${c.notes ? `<p class="hint mt-2 pre">${esc(c.notes)}</p>` : ''}
      </div>
      <div class="panel">
        <h3>Lifetime</h3>
        ${c.totals.length ? `<dl class="dl">${c.totals.map((t) => `
          <dt>Billed ${esc(t.currency)}</dt><dd>${esc(money(t.billed, t.currency))}</dd>
          <dt>Paid</dt><dd>${esc(money(t.paid, t.currency))}</dd>
          <dt>Outstanding</dt><dd>${esc(money(t.outstanding, t.currency))}</dd>`).join('')}</dl>` : '<p class="muted">Nothing billed yet.</p>'}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Invoices</h2><a class="btn btn-quiet" href="#/invoices?client_id=${id}">Open in list</a></div>
      ${docTable(docs.rows, 'invoices')}
    </section>

    ${estimates.rows.length ? `<section class="section"><div class="section-head"><h2>Estimates</h2></div>${docTable(estimates.rows, 'estimates')}</section>` : ''}

    ${recurring.length ? `<section class="section"><div class="section-head"><h2>Recurring</h2></div>
      <div class="table-wrap"><table><tbody>${recurring.map((r) => `<tr class="row-link" data-href="#/recurring/${r.id}">
        <td><a href="#/recurring/${r.id}">${esc(r.name)}</a></td><td class="muted">${r.active ? `Next ${esc(date(r.next_run))}` : 'Stopped'}</td>
        <td class="num">${esc(money(r.total, r.currency))}</td></tr>`).join('')}</tbody></table></div></section>` : ''}

    <section class="section">
      <div class="section-head"><h2>Statement</h2><button class="btn btn-quiet" type="button" data-print-statement>Print</button></div>
      <form class="filters" data-range>
        <label class="field"><span>From</span><input type="date" name="from" value="${esc(from)}"></label>
        <label class="field"><span>To</span><input type="date" name="to" value="${esc(to)}"></label>
        <button class="btn" type="submit">Apply</button>
      </form>
      ${statementTable(statement)}
    </section>`;

  el.addEventListener('click', rowLinks);
  el.querySelector('[data-range]').addEventListener('submit', (e) => {
    e.preventDefault();
    go(`/clients/${id}${qs({ from: e.target.from.value, to: e.target.to.value })}`);
  });
  el.querySelector('[data-print-statement]').addEventListener('click', () => window.print());
  el.querySelector('[data-archive]')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Archive ${c.name}?`, 'Their documents stay. Recurring schedules for this client stop. Clients with no history are deleted instead.', 'Archive'))) return;
    try {
      const out = await api(`/clients/${id}`, { method: 'DELETE' });
      toast(out.deleted ? 'Client deleted' : 'Client archived');
      go(out.deleted ? '/clients' : `/clients/${id}`);
      if (!out.deleted) refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function docTable(rows, plural) {
  if (!rows.length) return empty('None yet.');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Number</th><th>Issued</th><th>Due</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="row-link" data-href="#/${plural}/${r.id}">
      <td><a href="#/${plural}/${r.id}">${esc(r.number || 'Draft')}</a></td>
      <td class="muted">${esc(date(r.issue_date))}</td><td class="muted">${esc(date(r.due_date))}</td>
      <td class="num">${esc(money(r.total, r.currency))}</td>
      <td class="num">${r.kind === 'invoice' && r.state === 'issued' ? esc(money(r.balance, r.currency)) : '—'}</td>
      <td>${statusChip(r.status)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function statementTable(st) {
  const opening = Object.entries(st.opening);
  if (!st.lines.length && !opening.length) return empty('No issued invoices or payments in this range.');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th class="num">Charge</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
    <tbody>
      ${opening.map(([cur, bal]) => `<tr><td class="muted">${esc(date(st.from))}</td><td>Opening balance</td><td></td><td></td><td></td><td class="num">${esc(money(bal, cur))}</td></tr>`).join('')}
      ${st.lines.map((l) => `<tr>
        <td class="muted">${esc(date(l.date))}</td><td>${esc(l.type)}</td>
        <td><a href="#/invoices/${l.document_id}">${esc(l.ref)}</a></td>
        <td class="num">${l.charge ? esc(money(l.charge, l.currency)) : ''}</td>
        <td class="num">${l.credit ? esc(money(l.credit, l.currency)) : ''}</td>
        <td class="num">${esc(money(l.balance, l.currency))}</td></tr>`).join('')}
    </tbody>
    <tfoot>${Object.entries(st.closing).map(([cur, bal]) => `<tr><td colspan="5">Closing balance ${esc(cur)}</td><td class="num">${esc(money(bal, cur))}</td></tr>`).join('')}</tfoot>
  </table></div>`;
}

export async function clientEditView({ el }, id) {
  const c = id ? await api(`/clients/${id}`) : null;
  const d = state.settings.defaults;
  const v = c || { currency: d.currency, payment_terms_days: d.payment_terms_days };
  const currencies = [...new Set([v.currency, d.currency, ...COMMON_CURRENCIES])].filter(isCurrency);
  el.innerHTML = `
    ${pageHead(c ? 'Edit client' : 'New client', c ? c.name : 'Add a client', `
      <a class="btn btn-quiet" href="#/clients${c ? `/${c.id}` : ''}">Cancel</a>
      <button class="cta" type="submit" form="client-form" data-mode="save">${c ? 'Save client' : 'Add client'}</button>`)}
    <form id="client-form" class="form-grid" novalidate>
      ${field('Contact name', input('name', v.name, 'required maxlength="120"'), { span: 6 })}
      ${field('Company', input('company', v.company, 'maxlength="120"'), { span: 6 })}
      ${field('Email', input('email', v.email, 'type="email" maxlength="254"'), { span: 6 })}
      ${field('CC emails', input('cc_emails', v.cc_emails, 'maxlength="500" placeholder="ap@client.com, finance@client.com"'), { span: 6 })}
      ${field('Phone', input('phone', v.phone, 'maxlength="60"'), { span: 4 })}
      ${field('Tax / VAT ID', input('tax_id', v.tax_id, 'maxlength="60"'), { span: 4 })}
      ${field('Country', input('country', v.country, 'maxlength="100"'), { span: 4 })}
      ${field('Address', input('address_line1', v.address_line1, 'maxlength="200"'), { span: 6 })}
      ${field('Address line 2', input('address_line2', v.address_line2, 'maxlength="200"'), { span: 6 })}
      ${field('City', input('city', v.city, 'maxlength="100"'), { span: 4 })}
      ${field('State / region', input('region', v.region, 'maxlength="100"'), { span: 4 })}
      ${field('Postal code', input('postal_code', v.postal_code, 'maxlength="20"'), { span: 4 })}
      ${field('Currency', select('currency', currencies.map((x) => [x, x]), v.currency), { span: 4, hint: 'New documents for this client use it.' })}
      ${field('Payment terms (days)', input('payment_terms_days', v.payment_terms_days, 'type="number" min="0" max="365"'), { span: 4, hint: '0 means due on receipt.' })}
      ${field('Default tax', select('default_tax_rate_id', [['', 'None'], ...state.taxRates.map((t) => [t.id, `${t.name} ${ppmToPercent(t.rate_ppm)}%`])], v.default_tax_rate_id || ''), { span: 4 })}
      ${field('Internal notes', textarea('notes', v.notes, 'maxlength="4000" rows="4"'), { span: 12, hint: 'Never shown to the client.' })}
    </form>`;
  const form = el.querySelector('#client-form');
  let dirty = false;
  form.addEventListener('input', () => (dirty = true));
  setLeaveGuard(() => dirty);
  bindSaveKeys(form, 'save');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    body.payment_terms_days = body.payment_terms_days === '' ? undefined : Number(body.payment_terms_days);
    body.default_tax_rate_id = body.default_tax_rate_id ? Number(body.default_tax_rate_id) : null;
    try {
      const saved = await api(c ? `/clients/${c.id}` : '/clients', { method: c ? 'PUT' : 'POST', body });
      dirty = false;
      toast(c ? 'Client saved' : 'Client added');
      go(`/clients/${saved.id}`);
    } catch (err) {
      showErrors(form, err);
    }
  });
  form.elements.namedItem('name').focus();
}

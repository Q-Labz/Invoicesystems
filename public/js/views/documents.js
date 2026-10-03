import {
  api, esc, money, date, statusChip, pageHead, empty, state, toast, dialog, confirmDialog, showErrors,
  clearErrors, field, input, select, textarea, qs, go, download, fromMinor, locale,
} from '../ui.js';
import { renderDocument, methodLabel, METHOD_LABELS } from '../lib/doc-render.js';
import { isCurrency } from '../lib/money.js';
import { addDays, diffDays } from '../lib/dates.js';
import { rowLinks } from './dashboard.js';
import { linesMarkup, discountMarkup, mountLineEditor, linesToModel, discountToModel, blankLine } from './line-editor.js';

const PLURAL = { invoice: 'invoices', estimate: 'estimates' };
const LABEL = { invoice: 'Invoice', estimate: 'Estimate' };

const STATUS_TABS = {
  invoice: [['', 'All'], ['draft', 'Draft'], ['open', 'Open'], ['overdue', 'Overdue'], ['partial', 'Part paid'], ['paid', 'Paid'], ['void', 'Void']],
  estimate: [['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['expired', 'Expired'], ['converted', 'Invoiced']],
};

export const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'SGD', 'AED', 'INR', 'ZAR', 'NGN', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL'];

// ============================================================ list

export async function documentListView({ el, query }, kind) {
  const limit = 50;
  const offset = Number(query.offset) || 0;
  const [data, clients] = await Promise.all([
    api(`/documents${qs({ kind, status: query.status, client_id: query.client_id, q: query.q, from: query.from, to: query.to, sort: query.sort, order: query.order, limit, offset })}`),
    api('/clients?archived=1'),
  ]);
  const base = `#/${PLURAL[kind]}`;
  const link = (patch) => `${base}${qs({ ...query, offset: undefined, ...patch })}`;
  const isInvoice = kind === 'invoice';
  const sortLink = (key, label, cls = '') => {
    const active = (query.sort || 'issue_date') === key;
    const order = active && (query.order || 'desc') === 'desc' ? 'asc' : 'desc';
    return `<th class="${cls}"><a href="${link({ sort: key, order })}">${esc(label)}${active ? ((query.order || 'desc') === 'desc' ? ' ↓' : ' ↑') : ''}</a></th>`;
  };

  el.innerHTML = `
    ${pageHead(isInvoice ? 'Receivables' : 'Proposals', isInvoice ? 'Invoices' : 'Estimates', `
      <button class="btn btn-quiet" type="button" data-export>Export CSV</button>
      <a class="cta" href="${base}/new">New ${kind}</a>`)}

    <nav class="tabs" aria-label="Status">
      ${STATUS_TABS[kind].map(([v, l]) => `<a href="${link({ status: v || undefined })}" ${(query.status || '') === v ? 'aria-current="true"' : ''}>${esc(l)}</a>`).join('')}
    </nav>

    <form class="filters" data-filters>
      <label class="field grow"><span>Search</span><input name="q" value="${esc(query.q || '')}" placeholder="Number, client, PO, project"></label>
      <label class="field"><span>Client</span>${select('client_id', [['', 'All clients'], ...clients.map((c) => [c.id, c.name])], query.client_id)}</label>
      <label class="field"><span>Issued from</span><input type="date" name="from" value="${esc(query.from || '')}"></label>
      <label class="field"><span>to</span><input type="date" name="to" value="${esc(query.to || '')}"></label>
      <button class="btn" type="submit">Filter</button>
      ${query.q || query.client_id || query.from || query.to ? `<a class="btn btn-quiet" href="${base}${qs({ status: query.status })}">Clear</a>` : ''}
    </form>

    ${data.rows.length ? `
    <div class="table-wrap"><table>
      <thead><tr>
        ${sortLink('number', 'Number')}${sortLink('client_name', 'Client')}<th>Project</th>
        ${sortLink('issue_date', 'Issued')}${sortLink('due_date', isInvoice ? 'Due' : 'Valid until')}
        ${sortLink('total', 'Total', 'num')}${isInvoice ? sortLink('balance', 'Balance', 'num') : ''}<th>Status</th>
      </tr></thead>
      <tbody>${data.rows.map((r) => {
        const href = `${base}/${r.id}`;
        return `<tr class="row-link" data-href="${href}">
          <td><a href="${href}">${esc(r.number || 'Draft')}</a></td>
          <td>${esc(r.client_name)}</td>
          <td class="muted">${esc(r.title || '—')}</td>
          <td class="muted">${esc(date(r.issue_date))}</td>
          <td class="muted">${esc(date(r.due_date))}${r.status === 'overdue' ? ` · ${diffDays(state.meta.today, r.due_date)}d` : ''}</td>
          <td class="num">${esc(money(r.total, r.currency))}</td>
          ${isInvoice ? `<td class="num">${r.state === 'issued' ? esc(money(r.balance, r.currency)) : '<span class="muted">—</span>'}</td>` : ''}
          <td>${statusChip(r.status)}</td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot>${data.totals.map((t) => `<tr>
        <td colspan="5" class="muted">${data.count} ${PLURAL[kind]} · ${esc(t.currency)}</td>
        <td class="num">${esc(money(t.total, t.currency))}</td>
        ${isInvoice ? `<td class="num">${esc(money(t.balance, t.currency))}</td>` : ''}<td></td></tr>`).join('')}</tfoot>
    </table></div>
    ` : empty(query.status || query.q || query.client_id ? 'No matches for these filters.' : `No ${PLURAL[kind]} yet.`)}
    <div class="actions pager">
      ${offset > 0 ? `<a class="btn" href="${base}${qs({ ...query, offset: Math.max(0, offset - limit) })}">← Newer</a>` : ''}
      ${offset + limit < data.count ? `<a class="btn" href="${base}${qs({ ...query, offset: offset + limit })}">Older →</a>` : ''}
      ${data.count > limit ? `<span class="hint">${offset + 1}–${Math.min(offset + limit, data.count)} of ${data.count}</span>` : ''}
    </div>`;

  el.querySelector('[data-filters]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    go(`${base.slice(1)}${qs({ status: query.status, sort: query.sort, order: query.order, q: f.get('q'), client_id: f.get('client_id'), from: f.get('from'), to: f.get('to') })}`);
  });
  el.querySelector('[data-filters] select').addEventListener('change', (e) => e.target.form.requestSubmit());
  el.querySelector('[data-export]').addEventListener('click', () => download(`/export/${PLURAL[kind]}.csv${qs({ from: query.from, to: query.to })}`));
  el.addEventListener('click', rowLinks);
}

// ============================================================ detail

export async function documentDetailView(ctx, kind, id) {
  const { el, refresh } = ctx;
  const [doc, activity] = await Promise.all([api(`/documents/${id}`), api(`/documents/${id}/activity`)]);
  if (doc.kind !== kind) return go(`/${PLURAL[doc.kind]}/${id}`);
  const isInvoice = kind === 'invoice';
  const shareUrl = `${location.origin}/p/${doc.share_token}`;
  const today = state.meta.today;

  const a = []; // secondary actions
  let cta = '';
  const st = doc.state;
  if (st === 'draft') {
    cta = `<button class="cta" type="button" data-act="issue">Issue ${kind}</button>`;
    a.push(['edit', 'Edit'], ['duplicate', 'Duplicate'], ['delete', 'Delete']);
  } else if (isInvoice && st === 'issued') {
    if (doc.balance > 0) cta = '<button class="cta" type="button" data-act="pay">Record payment</button>';
    a.push(['send', 'Email'], ['print', 'Print / PDF'], ['copy', 'Copy link']);
    if (!doc.payments.length) a.push(['edit', 'Edit']);
    a.push(['duplicate', 'Duplicate']);
    if (doc.paid > 0) a.push(['refund', 'Refund']);
    if (doc.paid === 0) a.push(['void', 'Void']);
  } else if (!isInvoice && ['issued', 'accepted'].includes(st)) {
    cta = '<button class="cta" type="button" data-act="convert">Convert to invoice</button>';
    if (st === 'issued') a.push(['accept', 'Mark accepted']);
    a.push(['decline', 'Mark declined'], ['send', 'Email'], ['print', 'Print / PDF'], ['copy', 'Copy link']);
    if (st === 'issued') a.push(['edit', 'Edit']);
    a.push(['duplicate', 'Duplicate']);
  } else {
    if (st !== 'void') a.push(['print', 'Print / PDF'], ['copy', 'Copy link']);
    if (!isInvoice && st === 'declined') a.push(['accept', 'Mark accepted']);
    a.push(['duplicate', 'Duplicate']);
  }

  let dueLine = '';
  if (isInvoice && st === 'issued' && doc.balance > 0 && doc.due_date) {
    const n = diffDays(doc.due_date, today);
    dueLine = n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'Due today' : `Due in ${n} day${n === 1 ? '' : 's'}`;
  }

  el.innerHTML = `
    ${pageHead(`${LABEL[kind]} · ${doc.status}`, doc.number || `Draft ${kind}`, `
      ${a.map(([act, label]) => `<button class="btn${['delete', 'void'].includes(act) ? ' btn-quiet' : ''}" type="button" data-act="${act}">${esc(label)}</button>`).join('')}
      ${cta}`)}
    <div class="split">
      <div>${renderDocument(doc, { locale: locale() })}</div>
      <aside class="no-print">
        <div class="panel">
          <h3>${esc(doc.client.name)}</h3>
          <dl class="dl">
            <dt>Total</dt><dd>${esc(money(doc.total, doc.currency))}</dd>
            ${isInvoice ? `<dt>Paid</dt><dd>${esc(money(doc.paid, doc.currency))}</dd><dt>Balance</dt><dd>${esc(money(doc.balance, doc.currency))}</dd>` : ''}
            <dt>Status</dt><dd>${statusChip(doc.status)}</dd>
          </dl>
          ${dueLine ? `<p class="hint mt-2">${esc(dueLine)}</p>` : ''}
          ${doc.void_reason ? `<p class="hint">Void: ${esc(doc.void_reason)}</p>` : ''}
          <p class="hint"><a href="#/clients/${doc.client_id}">Client record →</a></p>
        </div>

        ${isInvoice && doc.payments.length ? `
        <div class="panel">
          <h3>Payments</h3>
          <table><tbody>${doc.payments.map((p) => `<tr>
            <td class="muted">${esc(date(p.date))}<br>${esc(methodLabel(p.method))}${p.reference ? ` · ${esc(p.reference)}` : ''}</td>
            <td class="num">${p.amount < 0 ? 'Refund ' : ''}${esc(money(Math.abs(p.amount), doc.currency))}${st === 'issued' ? `<br><button class="icon-btn" type="button" data-del-payment="${p.id}" aria-label="Remove payment">remove</button>` : ''}</td>
          </tr>`).join('')}</tbody></table>
        </div>` : ''}

        ${st !== 'draft' && st !== 'void' ? `
        <div class="panel">
          <h3>Client link</h3>
          <p class="hint">Read-only. Anyone with the link can view it.</p>
          <input readonly value="${esc(shareUrl)}" data-share-url aria-label="Share link">
          <div class="actions mt-1">
            <button class="btn btn-sm" type="button" data-act="copy">Copy</button>
            <a class="btn btn-sm" href="${esc(shareUrl)}" target="_blank" rel="noopener">Open</a>
            <button class="btn btn-sm btn-quiet" type="button" data-act="rotate">New link</button>
          </div>
        </div>` : ''}

        ${doc.related.source_estimate || doc.related.converted_invoice || doc.related.recurring ? `
        <div class="panel">
          <h3>Linked</h3>
          <dl class="dl">
            ${doc.related.source_estimate ? `<dt>From estimate</dt><dd><a href="#/estimates/${doc.related.source_estimate.id}">${esc(doc.related.source_estimate.number || 'draft')}</a></dd>` : ''}
            ${doc.related.converted_invoice ? `<dt>Invoice</dt><dd><a href="#/invoices/${doc.related.converted_invoice.id}">${esc(doc.related.converted_invoice.number || 'draft')}</a></dd>` : ''}
            ${doc.related.recurring ? `<dt>Schedule</dt><dd><a href="#/recurring/${doc.related.recurring.id}">${esc(doc.related.recurring.name)}</a></dd>` : ''}
          </dl>
        </div>` : ''}

        <div class="panel">
          <h3>Activity</h3>
          <ol class="timeline">${activity.map((ev) => `<li><time>${esc(new Date(ev.at).toLocaleString(locale()))}</time>${esc(describe(ev, doc.currency))}</li>`).join('')}</ol>
        </div>
      </aside>
    </div>`;

  const run = async (fn, okMsg) => {
    try {
      const out = await fn();
      if (okMsg) toast(okMsg);
      return out;
    } catch (err) {
      toast(err.message, true);
      return null;
    }
  };

  const handlers = {
    edit: () => go(`/${PLURAL[kind]}/${id}/edit`),
    print: () => window.print(),
    copy: async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        toast('Link copied');
      } catch {
        el.querySelector('[data-share-url]')?.select();
        toast('Select and copy the link', true);
      }
    },
    rotate: async () => {
      if (!(await confirmDialog('Replace the link?', 'The current link stops working. Anyone who has it loses access.', 'Replace link'))) return;
      if (await run(() => api(`/documents/${id}/share`, { method: 'POST' }), 'New link ready')) refresh();
    },
    issue: () => issueDialog(doc, refresh),
    pay: () => paymentDialog(doc, refresh, false),
    refund: () => paymentDialog(doc, refresh, true),
    send: () => sendDialog(doc, shareUrl, refresh),
    duplicate: async () => {
      const copy = await run(() => api(`/documents/${id}/duplicate`, { method: 'POST' }), 'Duplicated as a draft');
      if (copy) go(`/${PLURAL[kind]}/${copy.id}/edit`);
    },
    delete: async () => {
      if (!(await confirmDialog(`Delete this draft?`, 'Drafts have no number, so nothing is lost from the sequence.', 'Delete'))) return;
      if (await run(() => api(`/documents/${id}`, { method: 'DELETE' }), 'Draft deleted')) go(`/${PLURAL[kind]}`);
    },
    void: async () => {
      const ok = await dialog({
        title: `Void ${doc.number}?`,
        body: `<p>The number stays in the ledger, marked void. This cannot be undone.</p>${field('Reason', input('reason', '', 'maxlength="500" placeholder="Issued in error"'), { span: 12 })}`,
        submit: 'Void invoice',
        danger: true,
        onSubmit: (v) => api(`/documents/${id}/void`, { method: 'POST', body: { reason: v.reason } }),
      });
      if (ok) { toast('Invoice voided'); refresh(); }
    },
    accept: async () => { if (await run(() => api(`/documents/${id}/accept`, { method: 'POST' }), 'Marked accepted')) refresh(); },
    decline: async () => { if (await run(() => api(`/documents/${id}/decline`, { method: 'POST' }), 'Marked declined')) refresh(); },
    convert: async () => {
      const inv = await run(() => api(`/documents/${id}/convert`, { method: 'POST' }), 'Draft invoice created');
      if (inv) go(`/invoices/${inv.id}`);
    },
  };

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) return handlers[btn.dataset.act]?.();
    const del = e.target.closest('[data-del-payment]');
    if (del) {
      if (!(await confirmDialog('Remove this payment?', 'The balance goes back up by this amount. The removal is logged.', 'Remove'))) return;
      if (await run(() => api(`/payments/${del.dataset.delPayment}`, { method: 'DELETE' }), 'Payment removed')) refresh();
    }
  });
}

function describe(ev, currency) {
  const d = ev.detail || {};
  const amt = (v, c = d.currency || currency) => (v !== undefined && c ? money(v, c) : '');
  switch (ev.action) {
    case 'created': return d.duplicated_from ? `Created from ${d.duplicated_from}` : d.from_estimate ? `Created from estimate ${d.from_estimate}` : d.recurring ? `Generated by “${d.recurring}” for ${d.period}` : 'Created';
    case 'updated': return `Edited · ${amt(d.to_total)}`;
    case 'revised': return `Revised after issue · ${amt(d.from_total)} → ${amt(d.to_total)}`;
    case 'issued': return `Issued as ${d.number} · ${amt(d.total)}`;
    case 'recorded': return `Payment ${amt(d.amount)} · ${methodLabel(d.method)}`;
    case 'refunded': return `Refund ${amt(-d.amount)} · ${methodLabel(d.method)}`;
    case 'deleted': return d.amount !== undefined ? `Payment of ${amt(d.amount)} removed` : 'Deleted';
    case 'voided': return `Voided${d.reason ? ` · ${d.reason}` : ''}`;
    case 'sent': return `Emailed${d.to ? ` to ${d.to}` : ''}`;
    case 'converted': return 'Converted to an invoice';
    case 'share_link_rotated': return 'Share link replaced';
    default: return ev.action.replace(/_/g, ' ');
  }
}

async function issueDialog(doc, refresh) {
  const next = state.meta.next_numbers?.[doc.kind]?.next;
  const ok = await dialog({
    title: `Issue this ${doc.kind}?`,
    body: `<p>It receives the next number${next ? ` — likely <span class="mono">${esc(next)}</span>` : ''} — and the client and business details are frozen as they are now.</p>
      <div class="form-grid">${field('Issue date', input('date', doc.issue_date, 'type="date" required'), { span: 6, hint: doc.due_date ? 'The due date moves with it.' : '' })}</div>`,
    submit: `Issue ${doc.kind}`,
    onSubmit: (v) => api(`/documents/${doc.id}/issue`, { method: 'POST', body: { date: v.date } }),
  });
  if (ok) {
    toast(`Issued as ${ok.number}`);
    state.meta = await api('/meta');
    refresh();
  }
}

async function paymentDialog(doc, refresh, refund) {
  const max = refund ? doc.paid : doc.balance;
  const ok = await dialog({
    title: refund ? `Refund on ${doc.number}` : `Payment on ${doc.number}`,
    body: `<div class="form-grid">
      ${field(`Amount ${doc.currency}`, input('amount', fromMinor(max, doc.currency), `inputmode="decimal" required autocomplete="off"`), { span: 6, hint: `${refund ? 'Paid so far' : 'Balance'} ${money(max, doc.currency)}` })}
      ${field('Date', input('date', state.meta.today, 'type="date" required'), { span: 6 })}
      ${field('Method', select('method', Object.entries(METHOD_LABELS), 'bank_transfer'), { span: 6 })}
      ${field('Reference', input('reference', '', 'maxlength="120" placeholder="Transaction ID"'), { span: 6 })}
      ${field('Note', input('note', '', 'maxlength="1000"'), { span: 12 })}
    </div>`,
    submit: refund ? 'Record refund' : 'Record payment',
    onSubmit: (v) => api(`/documents/${doc.id}/payments`, { method: 'POST', body: { ...v, refund } }),
  });
  if (ok) {
    toast(refund ? 'Refund recorded' : ok.status === 'paid' ? 'Paid in full' : 'Payment recorded');
    refresh();
  }
}

async function sendDialog(doc, shareUrl, refresh) {
  const to = [doc.client.email, ...(doc.client.cc_emails || '').split(/[,;\s]+/)].filter(Boolean).join(', ');
  const biz = doc.from?.name || '7LABZ';
  const isInvoice = doc.kind === 'invoice';
  const subject = `${isInvoice ? 'Invoice' : 'Estimate'} ${doc.number} from ${biz}`;
  const amount = money(isInvoice ? doc.balance : doc.total, doc.currency);
  const body = isInvoice
    ? `Hi ${doc.bill_to?.name || ''},\n\nInvoice ${doc.number} for ${amount} is ready${doc.due_date ? `, due ${date(doc.due_date)}` : ''}.\n\nView or download it here:\n${shareUrl}\n\n${biz}`
    : `Hi ${doc.bill_to?.name || ''},\n\nEstimate ${doc.number} for ${amount} is ready${doc.due_date ? `, valid until ${date(doc.due_date)}` : ''}.\n\nView it here:\n${shareUrl}\n\n${biz}`;
  const ok = await dialog({
    title: 'Email the client',
    body: `<div class="form-grid">
      ${field('To', input('to', to, 'required'), { span: 12 })}
      ${field('Subject', input('subject', subject), { span: 12 })}
      ${field('Message', textarea('body', body, 'rows="9"'), { span: 12, hint: 'Opens in your mail app. The send is logged on the invoice.' })}
    </div>`,
    submit: 'Open in mail app',
    onSubmit: async (v) => {
      location.href = `mailto:${encodeURIComponent(v.to).replace(/%2C/g, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(v.subject)}&body=${encodeURIComponent(v.body)}`;
      await api(`/documents/${doc.id}/sent`, { method: 'POST', body: { to: v.to } });
      return true;
    },
  });
  if (ok) refresh();
}

// ============================================================ editor

const TERMS = [['', 'Custom'], ['0', 'Due on receipt'], ['7', 'Net 7'], ['15', 'Net 15'], ['30', 'Net 30'], ['45', 'Net 45'], ['60', 'Net 60'], ['90', 'Net 90']];
const VALIDITY = [['', 'Custom'], ['14', '14 days'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days']];

export async function documentEditView({ el, query }, kind, id) {
  const [doc, clients, items] = await Promise.all([
    id ? api(`/documents/${id}`) : null,
    api('/clients'),
    api('/items'),
  ]);
  if (doc && doc.kind !== kind) return go(`/${PLURAL[doc.kind]}/${id}/edit`);
  if (!clients.length && !doc) {
    el.innerHTML = `${pageHead(LABEL[kind], `New ${kind}`)}${empty('Add a client first. Every document is addressed to one.', '<a class="cta" href="#/clients/new">Add a client</a>')}`;
    return;
  }
  // An archived client can stay on an existing document but is not offered for new ones.
  if (doc && !clients.some((c) => c.id === doc.client_id)) clients.unshift(doc.client);

  const s = state.settings;
  const preset = clients.find((c) => c.id === Number(query.client_id)) || (clients.length === 1 ? clients[0] : null);
  const issueDate = doc?.issue_date || state.meta.today;
  const model = doc
    ? {
        ...doc,
        due_date: doc.due_date || '',
        discount_value: discountToModel(doc.discount_type, doc.discount_value, doc.currency),
        lines: linesToModel(doc.lines, doc.currency),
      }
    : {
        client_id: preset?.id || '',
        currency: preset?.currency || s.defaults.currency,
        issue_date: issueDate,
        due_date: addDays(issueDate, kind === 'estimate' ? s.defaults.estimate_valid_days : preset?.payment_terms_days ?? s.defaults.payment_terms_days),
        po_number: '', title: '', notes: s.defaults.notes, terms: s.defaults.terms,
        discount_type: 'none', discount_value: '',
        lines: [blankLine(preset)],
      };
  const termOptions = kind === 'invoice' ? TERMS : VALIDITY;
  const span = model.due_date ? String(diffDays(model.due_date, model.issue_date)) : '';
  const currencies = [...new Set([model.currency, ...clients.map((c) => c.currency), s.defaults.currency, ...COMMON_CURRENCIES])].filter(isCurrency);
  const locked = doc && doc.state !== 'draft';

  el.innerHTML = `
    ${pageHead(doc ? `${LABEL[kind]} · ${doc.number || 'draft'}` : LABEL[kind], doc ? `Edit ${doc.number || `draft ${kind}`}` : `New ${kind}`, `
      <a class="btn btn-quiet" href="#/${PLURAL[kind]}${doc ? `/${doc.id}` : ''}">Cancel</a>
      ${!locked ? '<button class="btn" type="submit" form="doc-form" data-mode="draft">Save draft</button>' : ''}
      <button class="cta" type="submit" form="doc-form" data-mode="${locked ? 'save' : 'issue'}">${locked ? 'Save changes' : 'Save and issue'}</button>`)}

    ${locked ? `<p class="hint">This ${kind} is issued. Changes are logged, and the client link shows the new version.</p>` : ''}

    <form id="doc-form" class="editor" novalidate autocomplete="off">
      <div>
        <section class="section form-grid">
          ${field('Client', select('client_id', [['', 'Choose a client'], ...clients.map((c) => [c.id, c.company ? `${c.name} — ${c.company}` : c.name])], model.client_id, 'required'), { span: 6 })}
          ${field('Currency', select('currency', currencies.map((c) => [c, c]), model.currency), { span: 2 })}
          ${field('PO number', input('po_number', model.po_number, 'maxlength="60"'), { span: 4 })}
          ${field('Issue date', input('issue_date', model.issue_date, 'type="date" required'), { span: 4 })}
          ${field(kind === 'invoice' ? 'Payment terms' : 'Valid for', select('terms_days', termOptions, termOptions.some(([v]) => v && v === span) ? span : ''), { span: 4 })}
          ${field(kind === 'invoice' ? 'Due date' : 'Valid until', input('due_date', model.due_date, 'type="date"'), { span: 4 })}
          ${field('Project', input('title', model.title, 'maxlength="200" placeholder="What this is for"'), { span: 12 })}
        </section>

        <section class="section">
          <div class="section-head"><h2>Lines</h2><span class="hint">Rates before tax</span></div>
          ${linesMarkup(items)}
        </section>

      </div>

      <aside class="editor-totals">
        <div class="panel">
          <h3>Totals</h3>
          ${discountMarkup(model)}
        </div>
      </aside>
      <div>
        <section class="section form-grid">
          ${field('Notes to client', textarea('notes', model.notes, 'maxlength="4000" rows="4"'), { span: 6 })}
          ${field('Terms', textarea('terms', model.terms, 'maxlength="8000" rows="4"'), { span: 6 })}
        </section>
      </div>
    </form>`;

  const form = el.querySelector('#doc-form');
  const f = (n) => form.elements.namedItem(n);
  let dirty = false;
  const editor = mountLineEditor(form, {
    lines: model.lines,
    items,
    onDirty: () => (dirty = true),
    extraTotals: (cur) => (doc?.paid ? `<div class="row muted"><span>Paid so far</span><span>${esc(money(doc.paid, cur))}</span></div>` : ''),
  });

  const syncDue = () => {
    const days = f('terms_days').value;
    if (days !== '' && f('issue_date').value) f('due_date').value = addDays(f('issue_date').value, Number(days));
  };
  f('terms_days').addEventListener('change', syncDue);
  f('issue_date').addEventListener('change', syncDue);
  f('due_date').addEventListener('change', () => (f('terms_days').value = ''));

  f('client_id').addEventListener('change', () => {
    const c = clients.find((x) => x.id === Number(f('client_id').value));
    if (!c) return;
    if (!locked || !doc.payments?.length) f('currency').value = c.currency;
    if (kind === 'invoice') {
      f('terms_days').value = TERMS.some(([v]) => v === String(c.payment_terms_days)) ? String(c.payment_terms_days) : '';
      f('due_date').value = addDays(f('issue_date').value, c.payment_terms_days);
    }
    editor.setDefaultTax(c.default_tax_rate_id);
    editor.recalc();
  });

  const beforeUnload = (e) => {
    if (dirty) e.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('hashchange', () => window.removeEventListener('beforeunload', beforeUnload), { once: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode || 'draft';
    clearErrors(form);
    const body = {
      client_id: Number(f('client_id').value) || null,
      currency: f('currency').value,
      issue_date: f('issue_date').value,
      due_date: f('due_date').value || null,
      po_number: f('po_number').value,
      title: f('title').value,
      notes: f('notes').value,
      terms: f('terms').value,
      discount_type: f('discount_type').value,
      discount_value: f('discount_type').value === 'none' ? '0' : f('discount_value').value,
      lines: editor.payload(),
    };
    if (!doc) body.kind = kind;
    const buttons = el.querySelectorAll('[form="doc-form"]');
    buttons.forEach((b) => (b.disabled = true));
    let saved = null;
    try {
      saved = await api(doc ? `/documents/${doc.id}` : '/documents', { method: doc ? 'PUT' : 'POST', body });
      if (mode === 'issue') {
        saved = await api(`/documents/${saved.id}/issue`, { method: 'POST', body: {} });
        state.meta = await api('/meta');
        toast(`Issued as ${saved.number}`);
      } else toast(mode === 'save' ? 'Changes saved' : 'Draft saved');
      dirty = false;
      go(`/${PLURAL[kind]}/${saved.id}`);
    } catch (err) {
      if (saved) {
        // Saved, but issuing failed: the draft exists now, so leave the form rather than create it twice.
        dirty = false;
        toast(`Saved as a draft. Not issued: ${err.message}`, true);
        go(`/${PLURAL[kind]}/${saved.id}`);
      } else showErrors(form, err);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}

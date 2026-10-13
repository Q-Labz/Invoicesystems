import {
  api, esc, money, date, statusChip, pageHead, empty, state, toast, dialog, confirmDialog, showErrors,
  clearErrors, field, input, select, textarea, qs, go, download, fromMinor, locale, rowLinks, setLeaveGuard, modKey,
} from '../ui.js';
import { renderDocument, methodLabel, METHOD_LABELS } from '../lib/doc-render.js';
import { isCurrency } from '../lib/money.js';
import { addDays, diffDays } from '../lib/dates.js';
import { linesMarkup, discountMarkup, mountLineEditor, linesToModel, discountToModel, blankLine } from './line-editor.js';

const PLURAL = { invoice: 'invoices', estimate: 'estimates' };
const LABEL = { invoice: 'Invoice', estimate: 'Estimate' };

const STATUS_TABS = {
  invoice: [['', 'All'], ['draft', 'Draft'], ['open', 'Open'], ['overdue', 'Overdue'], ['partial', 'Part paid'], ['paid', 'Paid'], ['void', 'Void']],
  estimate: [['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['expired', 'Expired'], ['converted', 'Invoiced']],
};

export const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'SGD', 'AED', 'INR', 'ZAR', 'NGN', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL'];

// ============================================================ list

export async function documentListView({ el, query, refresh }, kind) {
  const limit = 50;
  const offset = Number(query.offset) || 0;
  const [data, clients] = await Promise.all([
    api(`/documents${qs({ kind, status: query.status, client_id: query.client_id, q: query.q, from: query.from, to: query.to, sort: query.sort, order: query.order, limit, offset })}`),
    api('/clients?archived=1'),
  ]);
  const base = `#/${PLURAL[kind]}`;
  const link = (patch) => `${base}${qs({ ...query, offset: undefined, ...patch })}`;
  const isInvoice = kind === 'invoice';
  const counts = data.status_counts || {};
  const filtered = query.q || query.client_id || query.from || query.to;
  const sortLink = (key, label, cls = '') => {
    const active = (query.sort || 'issue_date') === key;
    const order = active && (query.order || 'desc') === 'desc' ? 'asc' : 'desc';
    const arrow = active ? ((query.order || 'desc') === 'desc' ? ' ↓' : ' ↑') : '';
    return `<th class="${cls}" ${active ? `aria-sort="${(query.order || 'desc') === 'desc' ? 'descending' : 'ascending'}"` : ''}><a href="${link({ sort: key, order })}">${esc(label)}${arrow}</a></th>`;
  };
  const quick = (r) => {
    if (isInvoice && ['sent', 'partial', 'overdue'].includes(r.status)) return `<button class="btn btn-sm row-act" type="button" data-quick="pay" data-id="${r.id}">Payment</button>`;
    if (r.status === 'draft') return `<button class="btn btn-sm row-act" type="button" data-quick="issue" data-id="${r.id}">Issue</button>`;
    return '';
  };

  el.innerHTML = `
    ${pageHead(isInvoice ? 'Receivables' : 'Proposals', isInvoice ? 'Invoices' : 'Estimates', `
      <button class="btn btn-quiet" type="button" data-export>Export CSV</button>
      <a class="cta" href="${base}/new">New ${kind}</a>`)}

    <nav class="tabs" aria-label="Status">
      ${STATUS_TABS[kind].map(([v, l]) => {
        const n = counts[v || 'all'] || 0;
        return `<a href="${link({ status: v || undefined })}" ${(query.status || '') === v ? 'aria-current="true"' : ''}>${esc(l)}${n ? `<span class="count">${n}</span>` : ''}</a>`;
      }).join('')}
    </nav>

    <form class="filters" data-filters role="search">
      <label class="field grow"><span>Search</span><input name="q" type="search" value="${esc(query.q || '')}" placeholder="Number, client, PO, project" autocomplete="off"></label>
      <label class="field"><span>Client</span>${select('client_id', [['', 'All clients'], ...clients.map((c) => [c.id, c.name])], query.client_id)}</label>
      <label class="field"><span>Issued from</span><input type="date" name="from" value="${esc(query.from || '')}"></label>
      <label class="field"><span>to</span><input type="date" name="to" value="${esc(query.to || '')}"></label>
      ${filtered ? `<a class="btn btn-quiet" href="${base}${qs({ status: query.status })}">Clear</a>` : ''}
    </form>

    ${data.rows.length ? `
    <div class="table-wrap"><table class="list">
      <thead><tr>
        ${sortLink('number', 'Number')}${sortLink('client_name', 'Client')}<th>Project</th>
        ${sortLink('issue_date', 'Issued')}${sortLink('due_date', isInvoice ? 'Due' : 'Valid until')}
        ${sortLink('total', 'Total', 'num')}${isInvoice ? sortLink('balance', 'Balance', 'num') : ''}<th>Status</th><th class="c-quick"><span class="sr-only">Quick action</span></th>
      </tr></thead>
      <tbody>${data.rows.map((r) => {
        const href = `${base}/${r.id}`;
        const late = r.status === 'overdue' ? diffDays(state.meta.today, r.due_date) : 0;
        return `<tr class="row-link" data-href="${href}">
          <td><a href="${href}" class="${r.number ? '' : 'muted'}">${esc(r.number || 'Draft')}</a></td>
          <td>${esc(r.client_name)}</td>
          <td class="muted clip">${esc(r.title || '—')}</td>
          <td class="muted">${esc(date(r.issue_date))}</td>
          <td class="${late ? '' : 'muted'}">${esc(date(r.due_date))}${late ? ` <span class="late">${late}d late</span>` : ''}</td>
          <td class="num">${esc(money(r.total, r.currency))}</td>
          ${isInvoice ? `<td class="num">${r.state === 'issued' ? esc(money(r.balance, r.currency)) : '<span class="muted">—</span>'}</td>` : ''}
          <td>${statusChip(r.status)}</td>
          <td class="c-quick">${quick(r)}</td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot>${data.totals.map((t) => `<tr>
        <td colspan="5" class="muted">${data.count} ${data.count === 1 ? kind : PLURAL[kind]} · ${esc(t.currency)}</td>
        <td class="num">${esc(money(t.total, t.currency))}</td>
        ${isInvoice ? `<td class="num">${esc(money(t.balance, t.currency))}</td>` : ''}<td></td><td></td></tr>`).join('')}</tfoot>
    </table></div>
    ` : (counts.all || filtered
      ? empty('No matches for these filters.', `<a class="btn" href="${base}">Show all ${PLURAL[kind]}</a>`)
      : firstRun(kind))}
    <div class="actions pager">
      ${offset > 0 ? `<a class="btn" href="${base}${qs({ ...query, offset: Math.max(0, offset - limit) })}">← Newer</a>` : ''}
      ${offset + limit < data.count ? `<a class="btn" href="${base}${qs({ ...query, offset: offset + limit })}">Older →</a>` : ''}
      ${data.count > limit ? `<span class="hint">${offset + 1}–${Math.min(offset + limit, data.count)} of ${data.count}</span>` : ''}
    </div>`;

  const form = el.querySelector('[data-filters]');
  const apply = () => {
    const f = new FormData(form);
    go(`${base.slice(1)}${qs({ status: query.status, sort: query.sort, order: query.order, q: f.get('q'), client_id: f.get('client_id'), from: f.get('from'), to: f.get('to') })}`);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  form.addEventListener('change', (e) => { if (e.target.name !== 'q') apply(); });
  // Search as you type, with the caret kept in place across the re-render.
  let t = null;
  form.q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      sessionStorage.setItem('focus-q', '1');
      apply();
    }, 350);
  });
  try {
    if (sessionStorage.getItem('focus-q')) {
      sessionStorage.removeItem('focus-q');
      requestAnimationFrame(() => {
        const q = document.querySelector('[data-filters] [name=q]');
        q?.focus();
        q?.setSelectionRange(q.value.length, q.value.length);
      });
    }
  } catch {}
  el.querySelector('[data-export]').addEventListener('click', () => download(`/export/${PLURAL[kind]}.csv${qs({ from: query.from, to: query.to })}`));
  el.addEventListener('click', async (e) => {
    const q = e.target.closest('[data-quick]');
    if (!q) return rowLinks(e);
    const doc = await api(`/documents/${q.dataset.id}`);
    if (q.dataset.quick === 'pay') paymentDialog(doc, refresh, false);
    else issueDialog(doc, refresh);
  });
}

function firstRun(kind) {
  const steps = kind === 'invoice'
    ? ['Add a client.', 'Write the lines. Totals and tax work themselves out.', 'Issue it. The number is assigned then, never before.']
    : ['Write the scope as lines.', 'Issue it and send the link.', 'Convert to an invoice once accepted.'];
  return `<div class="first-run">
    <ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <a class="btn btn-solid" href="#/${PLURAL[kind]}/new">Write the first ${kind}</a>
  </div>`;
}

// ============================================================ detail

export async function documentDetailView(ctx, kind, id) {
  const { el, refresh } = ctx;
  const [doc, activity] = await Promise.all([api(`/documents/${id}`), api(`/documents/${id}/activity`)]);
  if (doc.kind !== kind) return go(`/${PLURAL[doc.kind]}/${id}`);
  const isInvoice = kind === 'invoice';
  const shareUrl = `${location.origin}/p/${doc.share_token}`;
  const today = state.meta.today;
  const st = doc.state;
  const sentBefore = activity.some((a) => a.action === 'sent' || a.action === 'reminded');

  const a = []; // secondary actions
  let cta = '';
  if (st === 'draft') {
    cta = `<button class="cta" type="button" data-act="issue">Issue ${kind}</button>`;
    a.push(['edit', 'Edit'], ['duplicate', 'Duplicate'], ['delete', 'Delete']);
  } else if (isInvoice && st === 'issued') {
    if (doc.balance > 0) cta = '<button class="cta" type="button" data-act="pay">Record payment</button>';
    a.push(doc.status === 'overdue' ? ['remind', 'Send reminder'] : ['send', sentBefore ? 'Email again' : 'Email']);
    a.push(['print', 'Print / PDF'], ['copy', 'Copy link']);
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

  const next = nextStep(doc, sentBefore, today);
  const pct = isInvoice && doc.total > 0 ? Math.max(0, Math.min(100, Math.round((doc.paid / doc.total) * 100))) : 0;

  el.innerHTML = `
    ${pageHead(`${LABEL[kind]} · ${doc.client.name}`, doc.number || `Draft ${kind}`, `
      ${actionButtons(a)}
      ${cta}`)}
    <div class="split">
      <div>${renderDocument(doc, { locale: locale() })}</div>
      <aside class="no-print stack-panels">
        ${doc.reports?.length ? doc.reports.map((r) => `
        <div class="panel reported" role="status">
          <div class="eyebrow">Client reports a payment</div>
          <div class="summary-figure">${esc(money(r.amount, doc.currency))}</div>
          <p class="hint">${esc(methodLabel(r.method))}${r.payer ? ` · ${esc(r.payer)}` : ''}${r.reference ? ` · ${esc(r.reference)}` : ''} · ${esc(relTime(r.reported_at))}</p>
          <p class="next-step">Check that it arrived in your ${esc(methodLabel(r.method))} account, then confirm.</p>
          <div class="actions mt-1">
            <button class="btn btn-solid" type="button" data-report-confirm="${r.id}">Confirm received</button>
            <button class="btn btn-quiet" type="button" data-report-dismiss="${r.id}">Not received</button>
          </div>
        </div>`).join('') : ''}
        <div class="panel summary">
          <div class="summary-top">${statusChip(doc.status)}<span class="hint">${esc(next.when || '')}</span></div>
          <div class="summary-figure">${esc(money(isInvoice && st !== 'draft' ? doc.balance : doc.total, doc.currency))}</div>
          <div class="hint">${isInvoice && st !== 'draft' ? (doc.balance > 0 ? 'Balance due' : 'Settled') : 'Total'}</div>
          ${isInvoice && st === 'issued' ? `
          <svg class="meter" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${pct}% paid">
            <rect class="meter-track" x="0" y="0" width="100" height="4"></rect>
            <rect class="meter-fill" x="0" y="0" width="${pct}" height="4"></rect>
          </svg>
          <dl class="dl mt-1">
            <dt>Total</dt><dd>${esc(money(doc.total, doc.currency))}</dd>
            <dt>Paid · ${pct}%</dt><dd>${esc(money(doc.paid, doc.currency))}</dd>
          </dl>` : ''}
          ${next.text ? `<p class="next-step">${esc(next.text)}</p>` : ''}
          ${isInvoice && st !== 'draft' && state.meta.qbo?.connected ? qboLine(doc) : ''}
          ${doc.void_reason ? `<p class="hint">Void: ${esc(doc.void_reason)}</p>` : ''}
          <p class="hint mt-1"><a href="#/clients/${doc.client_id}">${esc(doc.client.name)} · client record</a></p>
        </div>

        ${isInvoice && doc.payments.length ? `
        <div class="panel">
          <h3>Payments</h3>
          <table><tbody>${doc.payments.map((p) => `<tr>
            <td class="muted">${esc(date(p.date))}<br>${esc(methodLabel(p.method))}${p.reference ? ` · ${esc(p.reference)}` : ''}</td>
            <td class="num">${p.amount < 0 ? 'Refund ' : ''}${esc(money(Math.abs(p.amount), doc.currency))}${st === 'issued' ? `<br><button class="icon-btn" type="button" data-del-payment="${p.id}" aria-label="Remove payment of ${esc(money(Math.abs(p.amount), doc.currency))}">remove</button>` : ''}</td>
          </tr>`).join('')}</tbody></table>
        </div>` : ''}

        ${st !== 'draft' && st !== 'void' ? `
        <div class="panel">
          <h3>Client link</h3>
          <p class="hint">Read-only. Anyone with the link can view it.</p>
          <div class="copy-field">
            <input readonly value="${esc(shareUrl)}" data-share-url aria-label="Share link">
            <button class="btn btn-sm" type="button" data-act="copy">Copy</button>
          </div>
          <div class="actions mt-1">
            <a class="btn btn-sm btn-quiet" href="${esc(shareUrl)}" target="_blank" rel="noopener">Preview as client ↗</a>
            <button class="btn btn-sm btn-quiet" type="button" data-act="rotate">Replace link</button>
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
          <ol class="timeline">${activity.map((ev) => `<li><time datetime="${esc(ev.at)}">${esc(relTime(ev.at))}</time>${esc(describe(ev, doc.currency))}</li>`).join('')}</ol>
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

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('Link copied');
    } catch {
      el.querySelector('[data-share-url]')?.select();
      toast('Select and copy the link', true);
    }
  };

  const handlers = {
    edit: () => go(`/${PLURAL[kind]}/${id}/edit`),
    print: () => window.print(),
    copy: copyLink,
    rotate: async () => {
      if (!(await confirmDialog('Replace the link?', 'The current link stops working. Anyone who has it loses access.', 'Replace link'))) return;
      if (await run(() => api(`/documents/${id}/share`, { method: 'POST' }), 'New link ready')) refresh();
    },
    issue: () => issueDialog(doc, refresh),
    pay: () => paymentDialog(doc, refresh, false),
    refund: () => paymentDialog(doc, refresh, true),
    send: () => sendDialog(doc, refresh),
    remind: () => sendDialog(doc, refresh, { reminder: true }),
    qbo: async () => {
      const after = await run(() => api(`/documents/${id}/qbo`, { method: 'POST' }));
      if (after) {
        toast(after.qbo_status === 'synced' ? 'Copied to QuickBooks' : after.qbo_error || 'QuickBooks did not accept it', after.qbo_status !== 'synced');
        refresh();
      }
    },
    duplicate: async () => {
      const copy = await run(() => api(`/documents/${id}/duplicate`, { method: 'POST' }), 'Duplicated as a draft');
      if (copy) go(`/${PLURAL[kind]}/${copy.id}/edit`);
    },
    delete: async () => {
      if (!(await confirmDialog('Delete this draft?', 'Drafts have no number, so nothing is lost from the sequence.', 'Delete'))) return;
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
      const inv = await run(() => api(`/documents/${id}/convert`, { method: 'POST' }), 'Draft invoice created from the estimate');
      if (inv) go(`/invoices/${inv.id}`);
    },
  };

  // Close the More menu on outside click, Escape, or after choosing.
  const more = el.querySelector('details.more');
  if (more) {
    const outside = (e) => {
      if (!more.isConnected) return document.removeEventListener('click', outside);
      if (!more.contains(e.target)) more.open = false;
    };
    document.addEventListener('click', outside);
    more.addEventListener('keydown', (e) => { if (e.key === 'Escape') { more.open = false; more.querySelector('summary').focus(); } });
  }

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      if (more) more.open = false;
      return handlers[btn.dataset.act]?.();
    }
    const rc = e.target.closest('[data-report-confirm]');
    if (rc) return confirmReportDialog(doc, doc.reports.find((r) => r.id === Number(rc.dataset.reportConfirm)), refresh);
    const rd = e.target.closest('[data-report-dismiss]');
    if (rd) {
      if (!(await confirmDialog('Mark as not received?', 'The report is closed and the balance stays as it is. The client is not notified.', 'Not received'))) return;
      if (await run(() => api(`/payment-reports/${rd.dataset.reportDismiss}/dismiss`, { method: 'POST' }), 'Report closed')) refresh();
      return;
    }
    const del = e.target.closest('[data-del-payment]');
    if (del) {
      if (!(await confirmDialog('Remove this payment?', 'The balance goes back up by this amount. The removal is logged.', 'Remove'))) return;
      if (await run(() => api(`/payments/${del.dataset.delPayment}`, { method: 'DELETE' }), 'Payment removed')) refresh();
    }
  });
}

// The first two actions stay in view; the rest fold into a "More" menu.
function actionButtons(list) {
  const shown = list.slice(0, 2);
  const rest = list.slice(2);
  const btn = ([act, label], cls = 'btn') => `<button class="${cls}${['delete', 'void'].includes(act) ? ' danger' : ''}" type="button" data-act="${act}">${esc(label)}</button>`;
  return `${shown.map((x) => btn(x)).join('')}${rest.length ? `
    <details class="more">
      <summary class="btn" aria-label="More actions">More</summary>
      <div class="more-menu" role="menu">${rest.map((x) => btn(x, 'more-item')).join('')}</div>
    </details>` : ''}`;
}

function qboLine(doc) {
  const base = state.meta.qbo.environment === 'production' ? 'https://app.qbo.intuit.com' : 'https://app.sandbox.qbo.intuit.com';
  const open = doc.qbo_invoice_id ? ` <a href="${base}/app/invoice?txnId=${encodeURIComponent(doc.qbo_invoice_id)}" target="_blank" rel="noopener">Open in QuickBooks ↗</a>` : '';
  if (doc.qbo_status === 'synced') {
    return `<p class="qbo-line"><span class="label">QuickBooks</span> ${doc.qbo_link ? 'Client can pay by card or bank.' : 'Copied.'}${open}</p>${doc.qbo_error ? `<p class="hint">${esc(doc.qbo_error)}</p>` : ''}`;
  }
  if (doc.qbo_status === 'void') return `<p class="qbo-line"><span class="label">QuickBooks</span> Voided there too.${open}</p>`;
  if (doc.qbo_status === 'skipped') return `<p class="qbo-line"><span class="label">QuickBooks</span> ${esc(doc.qbo_error || 'Not copied')}</p>`;
  if (doc.qbo_status === 'error') {
    return `<div class="qbo-line qbo-error"><span class="label">QuickBooks</span> <span>${esc(doc.qbo_error || 'Sync failed')}</span>${open}
      <button class="btn btn-sm mt-1" type="button" data-act="qbo">Retry</button></div>`;
  }
  return doc.state === 'issued'
    ? `<div class="qbo-line"><span class="label">QuickBooks</span> Not copied yet. <button class="btn btn-sm" type="button" data-act="qbo">Copy now</button></div>`
    : '';
}

// One plain sentence on what to do next, so the page always answers "now what?".
function nextStep(doc, sentBefore, today) {
  const isInvoice = doc.kind === 'invoice';
  if (doc.state === 'draft') return { text: `Next: issue it. The number is assigned then${isInvoice ? '' : ', and the client can open the link'}.` };
  if (doc.state === 'void') return { text: 'Voided. The number stays in the ledger.' };
  if (!isInvoice) {
    if (doc.status === 'accepted') return { text: 'Accepted. Convert it to an invoice when the work starts.' };
    if (doc.status === 'expired') return { text: 'Past its valid date. Duplicate it to re-quote.', when: `Expired ${date(doc.due_date)}` };
    if (doc.status === 'sent') return { text: sentBefore ? 'Waiting on the client.' : 'Next: email it to the client.', when: doc.due_date ? `Valid until ${date(doc.due_date)}` : '' };
    return { text: '' };
  }
  if (doc.status === 'paid') {
    const last = doc.payments.filter((p) => p.amount > 0).at(-1);
    return { text: last ? `Settled ${date(last.date)}, ${diffDays(last.date, doc.issue_date)} days after issue.` : 'Settled.' };
  }
  const n = doc.due_date ? diffDays(doc.due_date, today) : null;
  const when = n === null ? '' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'Due today' : `Due in ${n} day${n === 1 ? '' : 's'}`;
  if (doc.status === 'overdue') return { text: 'Past due. Send a reminder, or record the payment if it arrived.', when };
  if (!sentBefore) return { text: 'Next: email it to the client.', when };
  return { text: doc.status === 'partial' ? 'Part paid. Waiting on the rest.' : 'Sent. Waiting on payment.', when };
}

function relTime(iso) {
  const t = new Date(iso);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return t.toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
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
    case 'reminded': return `Reminder sent${d.to ? ` to ${d.to}` : ''}`;
    case 'converted': return 'Converted to an invoice';
    case 'accepted': return 'Marked accepted';
    case 'declined': return 'Marked declined';
    case 'share_link_rotated': return 'Share link replaced';
    case 'payment_reported': return `Client reported ${amt(d.amount)} by ${methodLabel(d.method)}`;
    case 'payment_report_confirmed': return 'Reported payment confirmed';
    case 'payment_report_dismissed': return 'Reported payment marked not received';
    default: return ev.action.replace(/_/g, ' ');
  }
}

export async function issueDialog(doc, refresh) {
  const next = state.meta.next_numbers?.[doc.kind]?.next;
  const ok = await dialog({
    title: `Issue this ${doc.kind}?`,
    body: `<p>It takes the next number${next ? `, <span class="mono">${esc(next)}</span>` : ''}. The client and business details are frozen as they are now.</p>
      <dl class="dl dialog-sum"><dt>${esc(doc.client.name)}</dt><dd>${esc(money(doc.total, doc.currency))}</dd></dl>
      <div class="form-grid">${field('Issue date', input('date', doc.issue_date, 'type="date" required'), { span: 6, hint: doc.due_date ? 'The due date moves with it.' : '' })}</div>`,
    submit: `Issue ${doc.kind}`,
    onSubmit: (v) => api(`/documents/${doc.id}/issue`, { method: 'POST', body: { date: v.date } }),
  });
  if (ok) {
    state.meta = await api('/meta');
    toast(`Issued as ${ok.number}`, false, { label: 'Email it', run: () => sendDialog(ok, refresh) });
    refresh();
  }
}

// Turns a client's report into a recorded payment, with the details still editable.
export async function confirmReportDialog(doc, r, refresh) {
  if (!r) return;
  const ok = await dialog({
    title: `Confirm payment on ${doc.number}`,
    body: `<dl class="dl dialog-sum"><dt>${esc(doc.client.name)} reported</dt><dd>${esc(money(r.amount, doc.currency))}</dd></dl>
    <div class="form-grid">
      ${field(`Amount received ${doc.currency}`, input('amount', fromMinor(Math.min(r.amount, doc.balance), doc.currency), 'inputmode="decimal" required'), { span: 6 })}
      ${field('Date received', input('date', state.meta.today, 'type="date" required'), { span: 6 })}
      ${field('Method', select('method', Object.entries(METHOD_LABELS), r.method), { span: 6 })}
      ${field('Reference', input('reference', r.reference, 'maxlength="120"'), { span: 6 })}
    </div>`,
    submit: 'Record payment',
    onSubmit: (v) => api(`/payment-reports/${r.id}/confirm`, { method: 'POST', body: v }),
  });
  if (ok) {
    toast(ok.status === 'paid' ? `${ok.number} paid in full` : `Payment recorded. ${money(ok.balance, ok.currency)} left.`);
    refresh();
  }
}

export async function paymentDialog(doc, refresh, refund) {
  const max = refund ? doc.paid : doc.balance;
  const ok = await dialog({
    title: refund ? `Refund on ${doc.number}` : `Payment on ${doc.number}`,
    body: `<dl class="dl dialog-sum"><dt>${esc(doc.client.name)} · ${refund ? 'paid so far' : 'balance'}</dt><dd>${esc(money(max, doc.currency))}</dd></dl>
    <div class="form-grid">
      ${field(`Amount ${doc.currency}`, input('amount', fromMinor(max, doc.currency), `inputmode="decimal" required autocomplete="off"`), { span: 6 })}
      ${field('Date received', input('date', state.meta.today, 'type="date" required'), { span: 6 })}
      ${field('Method', select('method', Object.entries(METHOD_LABELS), lastMethod()), { span: 6 })}
      ${field('Reference', input('reference', '', 'maxlength="120" placeholder="Transaction ID"'), { span: 6 })}
      ${field('Note', input('note', '', 'maxlength="1000"'), { span: 12 })}
    </div>`,
    submit: refund ? 'Record refund' : 'Record payment',
    onSubmit: (v) => {
      try { localStorage.setItem('last-method', v.method); } catch {}
      return api(`/documents/${doc.id}/payments`, { method: 'POST', body: { ...v, refund } });
    },
  });
  if (ok) {
    toast(refund ? 'Refund recorded' : ok.status === 'paid' ? `${ok.number} paid in full` : `Payment recorded. ${money(ok.balance, ok.currency)} left.`);
    refresh();
  }
}

function lastMethod() {
  try {
    return localStorage.getItem('last-method') || 'bank_transfer';
  } catch {
    return 'bank_transfer';
  }
}

export async function sendDialog(doc, refresh, { reminder = false } = {}) {
  const shareUrl = `${location.origin}/p/${doc.share_token}`;
  const to = [doc.client?.email, ...(doc.client?.cc_emails || '').split(/[,;\s]+/)].filter(Boolean).join(', ');
  const biz = doc.from?.name || state.settings.business.name || '7LABZ';
  const isInvoice = doc.kind === 'invoice';
  const name = doc.bill_to?.name || doc.client?.name || '';
  const amount = money(isInvoice ? doc.balance : doc.total, doc.currency);
  const late = doc.due_date ? diffDays(state.meta.today, doc.due_date) : 0;
  let subject, body;
  if (reminder) {
    subject = `Reminder: invoice ${doc.number}, ${amount} outstanding`;
    body = `Hi ${name},\n\nA reminder that invoice ${doc.number} for ${amount} was due ${date(doc.due_date)}${late > 0 ? `, ${late} days ago` : ''}.\n\nThe invoice and payment details are here:\n${shareUrl}\n\nIf it is already on its way, thank you, and ignore this note.\n\n${biz}`;
  } else if (isInvoice) {
    subject = `Invoice ${doc.number} from ${biz}`;
    body = `Hi ${name},\n\nInvoice ${doc.number} for ${amount} is ready${doc.due_date ? `, due ${date(doc.due_date)}` : ''}.\n\nView or download it here:\n${shareUrl}\n\n${biz}`;
  } else {
    subject = `Estimate ${doc.number} from ${biz}`;
    body = `Hi ${name},\n\nEstimate ${doc.number} for ${amount} is ready${doc.due_date ? `, valid until ${date(doc.due_date)}` : ''}.\n\nView it here:\n${shareUrl}\n\n${biz}`;
  }
  const ok = await dialog({
    title: reminder ? 'Send a reminder' : 'Email the client',
    body: `<div class="form-grid">
      ${field('To', input('to', to, 'required'), { span: 12, hint: to ? '' : 'This client has no email on file.' })}
      ${field('Subject', input('subject', subject), { span: 12 })}
      ${field('Message', textarea('body', body, 'rows="10"'), { span: 12, hint: 'Opens in your mail app. The send is logged on the document.' })}
    </div>`,
    submit: 'Open in mail app',
    onSubmit: async (v) => {
      location.href = `mailto:${encodeURIComponent(v.to).replace(/%2C/g, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(v.subject)}&body=${encodeURIComponent(v.body)}`;
      await api(`/documents/${doc.id}/sent`, { method: 'POST', body: { to: v.to, reminder } });
      return true;
    },
  });
  if (ok) refresh?.();
}

// ============================================================ editor

const TERMS = [['', 'Custom'], ['0', 'Due on receipt'], ['7', 'Net 7'], ['15', 'Net 15'], ['30', 'Net 30'], ['45', 'Net 45'], ['60', 'Net 60'], ['90', 'Net 90']];
const VALIDITY = [['', 'Custom'], ['14', '14 days'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days']];

export async function documentEditView({ el, query, refresh }, kind, id) {
  const [doc, clients, items] = await Promise.all([
    id ? api(`/documents/${id}`) : null,
    api('/clients'),
    api('/items'),
  ]);
  if (doc && doc.kind !== kind) return go(`/${PLURAL[doc.kind]}/${id}/edit`);
  if (!clients.length && !doc) {
    el.innerHTML = `${pageHead(LABEL[kind], `New ${kind}`)}${empty('Every document is addressed to a client. Add the first one here; it takes ten seconds.', '<button class="btn btn-solid" type="button" data-new-client>Add a client</button>')}`;
    el.querySelector('[data-new-client]').addEventListener('click', async () => {
      if (await quickClientDialog()) refresh();
    });
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
      <a class="btn btn-quiet" href="#/${PLURAL[kind]}${doc ? `/${doc.id}` : ''}">Cancel</a>`)}

    ${locked ? `<p class="notice">This ${kind} is issued. Changes are logged, and the client link shows the new version.</p>` : ''}

    <form id="doc-form" class="editor" novalidate autocomplete="off">
      <div>
        <section class="section form-grid">
          ${field('Client', select('client_id', clientOptions(clients), model.client_id, 'required'), { span: 6 })}
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

      <div class="savebar" role="region" aria-label="Save">
        <div class="savebar-sum"><span class="label">Total</span> <span class="savebar-total" data-live-total>—</span> <span class="hint" data-live-meta></span></div>
        <div class="actions">
          <span class="hint savebar-keys"><kbd>${esc(modKey)}</kbd><kbd>S</kbd> save${locked ? '' : ` · <kbd>${esc(modKey)}</kbd><kbd>↵</kbd> issue`}</span>
          ${!locked ? '<button class="btn" type="submit" data-mode="draft">Save draft</button>' : ''}
          <button class="cta" type="submit" data-mode="${locked ? 'save' : 'issue'}">${locked ? 'Save changes' : 'Save and issue'}</button>
        </div>
      </div>
    </form>`;

  const form = el.querySelector('#doc-form');
  const f = (n) => form.elements.namedItem(n);
  let dirty = false;
  const editor = mountLineEditor(form, {
    lines: model.lines,
    items,
    onDirty: () => (dirty = true),
    onTotals: (t, cur, n) => {
      el.querySelector('[data-live-total]').textContent = money(t.total, cur);
      el.querySelector('[data-live-meta]').textContent = `${n} line${n === 1 ? '' : 's'}${t.tax_total ? ` · tax ${money(t.tax_total, cur)}` : ''}`;
    },
    extraTotals: (cur) => (doc?.paid ? `<div class="row muted"><span>Paid so far</span><span>${esc(money(doc.paid, cur))}</span></div>` : ''),
  });

  const syncDue = () => {
    const days = f('terms_days').value;
    if (days !== '' && f('issue_date').value) f('due_date').value = addDays(f('issue_date').value, Number(days));
  };
  f('terms_days').addEventListener('change', syncDue);
  f('issue_date').addEventListener('change', syncDue);
  f('due_date').addEventListener('change', () => (f('terms_days').value = ''));

  let prevClient = f('client_id').value;
  f('client_id').addEventListener('change', async () => {
    if (f('client_id').value === '__new') {
      const created = await quickClientDialog();
      if (!created) {
        f('client_id').value = prevClient;
        return;
      }
      clients.push(created);
      f('client_id').innerHTML = clientOptions(clients).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      f('client_id').value = String(created.id);
    }
    prevClient = f('client_id').value;
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
  setLeaveGuard(() => dirty);
  bindSaveKeys(form, locked ? 'save' : 'draft', locked ? null : 'issue');

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
    const buttons = form.querySelectorAll('[type=submit]');
    buttons.forEach((b) => (b.disabled = true));
    let saved = null;
    try {
      saved = await api(doc ? `/documents/${doc.id}` : '/documents', { method: doc ? 'PUT' : 'POST', body });
      if (mode === 'issue') {
        saved = await api(`/documents/${saved.id}/issue`, { method: 'POST', body: {} });
        state.meta = await api('/meta');
        const issued = saved;
        toast(`Issued as ${saved.number}`, false, { label: 'Email it', run: () => sendDialog(issued) });
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

function clientOptions(clients) {
  return [['', 'Choose a client'], ...clients.map((c) => [c.id, c.company ? `${c.name} — ${c.company}` : c.name]), ['__new', '+ New client…']];
}

// Add a client without leaving the editor. Resolves with the client, or null.
export function quickClientDialog() {
  const d = state.settings.defaults;
  const currencies = [...new Set([d.currency, ...COMMON_CURRENCIES])].filter(isCurrency);
  return dialog({
    title: 'New client',
    submit: 'Add client',
    body: `<div class="form-grid">
      ${field('Contact name', input('name', '', 'required maxlength="120"'), { span: 6 })}
      ${field('Company', input('company', '', 'maxlength="120"'), { span: 6 })}
      ${field('Email', input('email', '', 'type="email" maxlength="254"'), { span: 12, hint: 'Where invoices go.' })}
      ${field('Currency', select('currency', currencies.map((c) => [c, c]), d.currency), { span: 6 })}
      ${field('Terms (days)', input('payment_terms_days', d.payment_terms_days, 'type="number" min="0" max="365"'), { span: 6 })}
    </div>
    <p class="hint mt-1">Address and tax details can be added later on the client record.</p>`,
    onSubmit: (v) => api('/clients', { method: 'POST', body: { ...v, payment_terms_days: Number(v.payment_terms_days) } }),
  }).then((c) => {
    if (c) toast(`${c.name} added`);
    return c;
  });
}

// Cmd/Ctrl+S saves, Cmd/Ctrl+Enter issues. Bound to the form's own submit buttons.
export function bindSaveKeys(form, saveMode, issueMode) {
  const handler = (e) => {
    if (!(e.metaKey || e.ctrlKey) || document.querySelector('dialog[open]')) return;
    if (!document.body.contains(form)) return window.removeEventListener('keydown', handler);
    const mode = e.key.toLowerCase() === 's' ? saveMode : e.key === 'Enter' ? issueMode : null;
    if (!mode) return;
    e.preventDefault();
    [...document.querySelectorAll(`[type=submit][data-mode="${mode}"]`)].find((b) => b.form === form)?.click();
  };
  window.addEventListener('keydown', handler);
}

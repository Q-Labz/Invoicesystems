// Renders an invoice or estimate as HTML. Used in-app, on the public share page and for print.
import { formatMoney, bpsToPercent, ppmToPercent } from './money.js';
import { formatDate } from './dates.js';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const STAMPS = { paid: 'Paid', void: 'Void', overdue: 'Overdue', partial: 'Part paid', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', converted: 'Invoiced', draft: 'Draft' };

export function addressLines(p) {
  if (!p) return '';
  const cityLine = [p.city, p.region, p.postal_code].filter(Boolean).join(', ');
  return [p.company && p.company !== p.name ? p.company : '', p.address_line1, p.address_line2, cityLine, p.country, p.tax_id ? `Tax ID ${p.tax_id}` : '']
    .filter(Boolean)
    .join('\n');
}

export function renderDocument(doc, { locale = 'en-US' } = {}) {
  const m = (v) => esc(formatMoney(v, doc.currency, locale));
  const d = (v) => esc(formatDate(v, locale));
  const isInvoice = doc.kind === 'invoice';
  const from = doc.from || {};
  const to = doc.bill_to || {};
  const title = isInvoice ? 'Invoice' : 'Estimate';
  const stamp = STAMPS[doc.status];
  const showDiscCol = doc.lines.some((l) => l.discount_bps);
  const showTaxCol = doc.lines.some((l) => l.tax_rate_ppm);

  const rows = doc.lines
    .map(
      (l) => `
      <tr>
        <td class="desc">${esc(l.description)}</td>
        <td class="num">${esc(trimQty(l.quantity))}${l.unit ? ` <span class="sub">${esc(l.unit)}</span>` : ''}</td>
        <td class="num">${m(l.unit_price)}</td>
        ${showDiscCol ? `<td class="num">${l.discount_bps ? `${esc(bpsToPercent(l.discount_bps))}%` : '—'}</td>` : ''}
        ${showTaxCol ? `<td class="num">${l.tax_rate_ppm ? `${esc(ppmToPercent(l.tax_rate_ppm))}%` : '—'}</td>` : ''}
        <td class="num">${m(l.amount)}</td>
      </tr>`,
    )
    .join('');

  const discountLabel = doc.discount_type === 'percent' ? `Discount ${esc(bpsToPercent(doc.discount_value))}%` : 'Discount';
  const taxRows = (doc.taxes || [])
    .map((t) => `<dt>${esc(t.name)} ${esc(ppmToPercent(t.rate_ppm))}%</dt><dd>${m(t.amount)}</dd>`)
    .join('');
  const paidRow = isInvoice && doc.paid ? `<dt>Paid</dt><dd>−${m(doc.paid)}</dd>` : '';
  const dueLabel = isInvoice ? (doc.status === 'paid' ? 'Balance' : 'Balance due') : 'Total';
  const dueValue = isInvoice ? doc.balance : doc.total;

  const payments = isInvoice && doc.payments?.length
    ? `<div><span class="label">Payments</span><p>${doc.payments
        .map((p) => `${d(p.date)} · ${esc(methodLabel(p.method))} · ${p.amount < 0 ? 'refund ' : ''}${m(Math.abs(p.amount))}`)
        .join('\n')}</p></div>`
    : '';

  const notesBlock = [
    doc.notes ? `<div><span class="label">Notes</span><p>${esc(doc.notes)}</p></div>` : '',
    isInvoice && from.payment_instructions ? `<div><span class="label">How to pay</span><p>${esc(from.payment_instructions)}</p></div>` : '',
    doc.terms ? `<div><span class="label">Terms</span><p>${esc(doc.terms)}</p></div>` : '',
    payments,
  ].filter(Boolean).join('');

  return `
  <article class="doc" aria-label="${esc(title)} ${esc(doc.number || 'draft')}">
    <header class="doc-top">
      <div>
        <div class="doc-brand">${esc(from.name || '7LABZ')}</div>
        <div class="doc-from">${esc([from.address, from.email, from.phone, from.website, from.tax_id ? `Tax ID ${from.tax_id}` : ''].filter(Boolean).join('\n'))}</div>
      </div>
      <div class="doc-title">
        <h1>${title}</h1>
        <div class="doc-no">${esc(doc.number || 'Draft — not yet numbered')}</div>
        ${stamp && doc.status !== 'sent' ? `<div class="doc-stamp">${esc(stamp)}</div>` : ''}
      </div>
    </header>

    <section class="doc-meta">
      <div>
        <span class="label">Bill to</span>
        <address><strong>${esc(to.name)}</strong>${addressLines(to) ? `\n${esc(addressLines(to))}` : ''}${to.email ? `\n${esc(to.email)}` : ''}</address>
      </div>
      <div>
        <span class="label">Issued</span>${d(doc.issue_date)}
        ${doc.due_date ? `<span class="label spaced">${isInvoice ? 'Due' : 'Valid until'}</span>${d(doc.due_date)}` : ''}
      </div>
      <div>
        ${doc.po_number ? `<span class="label">PO number</span>${esc(doc.po_number)}` : ''}
        ${doc.title ? `<span class="label${doc.po_number ? ' spaced' : ''}">Project</span>${esc(doc.title)}` : ''}
      </div>
    </section>

    <table class="doc-lines">
      <thead><tr>
        <th>Description</th><th class="num">Qty</th><th class="num">Rate</th>
        ${showDiscCol ? '<th class="num">Disc.</th>' : ''}${showTaxCol ? '<th class="num">Tax</th>' : ''}
        <th class="num">Amount</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No lines yet.</td></tr>'}</tbody>
    </table>

    <div class="doc-sum">
      <dl class="dl">
        <dt>Subtotal</dt><dd>${m(doc.subtotal)}</dd>
        ${doc.discount_total ? `<dt>${discountLabel}</dt><dd>−${m(doc.discount_total)}</dd>` : ''}
        ${taxRows}
        <div class="rule"></div>
        <dt>Total ${esc(doc.currency)}</dt><dd>${m(doc.total)}</dd>
        ${paidRow}
        ${isInvoice ? `<div class="rule"></div>` : ''}
        <dt class="due">${dueLabel}</dt><dd class="due">${m(dueValue)}</dd>
      </dl>
    </div>

    ${notesBlock ? `<section class="doc-notes">${notesBlock}</section>` : ''}

    <footer class="doc-foot">
      <span>${esc(doc.number || '')}</span>
      <span>${esc(from.name || '7LABZ')}</span>
    </footer>
  </article>`;
}

export function trimQty(q) {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(q).replace(/\.?0+$/, '');
}

export const METHOD_LABELS = {
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cash: 'Cash',
  check: 'Check',
  crypto: 'Crypto',
  paypal: 'PayPal',
  stripe: 'Stripe',
  other: 'Other',
};

export function methodLabel(m) {
  return METHOD_LABELS[m] || m;
}

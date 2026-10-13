import { api, esc, money, date, pageHead, empty, qs, go, download } from '../ui.js';
import { methodLabel } from '../lib/doc-render.js';
import { rowLinks } from '../ui.js';
import { confirmReportDialog } from './documents.js';

export async function paymentsView({ el, query, refresh }) {
  const [rows, reports] = await Promise.all([
    api(`/payments${qs({ from: query.from, to: query.to, limit: 500 })}`),
    api('/payment-reports'),
  ]);
  const totals = rows.reduce((acc, p) => ((acc[p.currency] = (acc[p.currency] || 0) + p.amount), acc), {});
  el.innerHTML = `
    ${pageHead('Cash in', 'Payments', '<button class="btn" type="button" data-export>Export CSV</button>')}
    ${reports.length ? `
    <section class="section">
      <div class="section-head"><h2>Reported by clients</h2><span class="hint">Confirm once the money is in your account</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Reported</th><th>Invoice</th><th>Client</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${reports.map((r) => `<tr>
          <td class="muted">${esc(new Date(r.reported_at).toLocaleString())}</td>
          <td><a href="#/invoices/${r.document_id}">${esc(r.number)}</a></td>
          <td>${esc(r.client_name)}${r.payer ? `<br><span class="muted">${esc(r.payer)}</span>` : ''}</td>
          <td class="muted">${esc(methodLabel(r.method))}</td>
          <td class="muted">${esc(r.reference || '—')}</td>
          <td class="num">${esc(money(r.amount, r.currency))}</td>
          <td class="num"><button class="btn btn-sm btn-solid" type="button" data-confirm="${r.id}" data-doc="${r.document_id}">Confirm</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}
    <form class="filters" data-range>
      <label class="field"><span>From</span><input type="date" name="from" value="${esc(query.from || '')}"></label>
      <label class="field"><span>To</span><input type="date" name="to" value="${esc(query.to || '')}"></label>
      <button class="btn" type="submit">Apply</button>
    </form>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Invoice</th><th>Client</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="row-link" data-href="#/invoices/${p.document_id}">
        <td class="muted">${esc(date(p.date))}</td>
        <td><a href="#/invoices/${p.document_id}">${esc(p.number)}</a></td>
        <td>${esc(p.client_name)}</td>
        <td class="muted">${esc(methodLabel(p.method))}</td>
        <td class="muted">${esc(p.reference || '—')}</td>
        <td class="num">${p.amount < 0 ? 'Refund ' : ''}${esc(money(Math.abs(p.amount), p.currency))}</td>
      </tr>`).join('')}</tbody>
      <tfoot>${Object.entries(totals).map(([cur, t]) => `<tr><td colspan="5">Net received ${esc(cur)}</td><td class="num">${esc(money(t, cur))}</td></tr>`).join('')}</tfoot>
    </table></div>` : empty('No payments in this range.')}`;
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-confirm]');
    if (!b) return rowLinks(e);
    const doc = await api(`/documents/${b.dataset.doc}`);
    confirmReportDialog(doc, doc.reports.find((r) => r.id === Number(b.dataset.confirm)), refresh);
  });
  el.querySelector('[data-range]').addEventListener('submit', (e) => {
    e.preventDefault();
    go(`/payments${qs({ from: e.target.from.value, to: e.target.to.value })}`);
  });
  el.querySelector('[data-export]').addEventListener('click', () => download(`/export/payments.csv${qs({ from: query.from, to: query.to })}`));
}

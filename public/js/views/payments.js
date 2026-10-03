import { api, esc, money, date, pageHead, empty, qs, go, download } from '../ui.js';
import { methodLabel } from '../lib/doc-render.js';
import { rowLinks } from './dashboard.js';

export async function paymentsView({ el, query }) {
  const rows = await api(`/payments${qs({ from: query.from, to: query.to, limit: 500 })}`);
  const totals = rows.reduce((acc, p) => ((acc[p.currency] = (acc[p.currency] || 0) + p.amount), acc), {});
  el.innerHTML = `
    ${pageHead('Cash in', 'Payments', '<button class="btn" type="button" data-export>Export CSV</button>')}
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
  el.addEventListener('click', rowLinks);
  el.querySelector('[data-range]').addEventListener('submit', (e) => {
    e.preventDefault();
    go(`/payments${qs({ from: e.target.from.value, to: e.target.to.value })}`);
  });
  el.querySelector('[data-export]').addEventListener('click', () => download(`/export/payments.csv${qs({ from: query.from, to: query.to })}`));
}

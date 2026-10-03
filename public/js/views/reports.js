import { api, esc, money, pageHead, empty, state, qs, go, download } from '../ui.js';
import { ppmToPercent } from '../lib/money.js';
import { revenueChart, barRows } from './charts.js';

export async function reportsView({ el, query }) {
  const today = state.meta.today;
  const from = query.from || `${today.slice(0, 4)}-01-01`;
  const to = query.to || today;
  const months = Number(query.months) || 12;
  const [aging, revenue, tax, top] = await Promise.all([
    api('/reports/aging'),
    api(`/reports/revenue?months=${months}`),
    api(`/reports/tax${qs({ from, to })}`),
    api(`/reports/clients?months=${months}`),
  ]);
  const cur = query.currency || revenue.series[0]?.currency || state.settings.defaults.currency;
  const series = revenue.series.find((s) => s.currency === cur);
  const currencies = [...new Set([...revenue.series.map((s) => s.currency), ...aging.totals.map((t) => t.currency)])];

  el.innerHTML = `
    ${pageHead('Reports', 'Money in, money owed', `
      <button class="btn btn-quiet" type="button" data-dl="/export/invoices.csv">Invoices CSV</button>
      <button class="btn btn-quiet" type="button" data-dl="/export/payments.csv">Payments CSV</button>
      <button class="btn" type="button" data-dl="/export/backup.json">Full backup</button>`)}

    <section class="section">
      <div class="section-head">
        <h2>Invoiced and collected</h2>
        <form class="actions" data-rev>
          ${currencies.length > 1 ? `<select name="currency" aria-label="Currency">${currencies.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : ''}
          <select name="months" aria-label="Window">${[6, 12, 24, 36].map((m) => `<option value="${m}" ${m === months ? 'selected' : ''}>${m} months</option>`).join('')}</select>
        </form>
      </div>
      <div class="panel">${revenueChart(revenue.months, series)}</div>
      <p class="hint mt-1">Invoiced counts issued invoices by issue date. Collected counts payments by payment date, net of refunds. Currencies are never converted.</p>
    </section>

    <section class="section">
      <div class="section-head"><h2>Receivables aging</h2><span class="hint">Days past due, as of ${esc(aging.today)}</span></div>
      ${aging.totals.length ? aging.totals.map((t) => `
        <div class="grid grid-2 mt-2">
          <div class="panel">
            <h3>${esc(t.currency)} · ${esc(money(t.total, t.currency))} open</h3>
            ${barRows([
              { label: 'Not yet due', value: t.current },
              { label: '1–30', value: t.d1_30 },
              { label: '31–60', value: t.d31_60 },
              { label: '61–90', value: t.d61_90 },
              { label: '90+', value: t.d90_plus },
            ], t.currency)}
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Client</th><th class="num">Current</th><th class="num">1–30</th><th class="num">31–60</th><th class="num">61–90</th><th class="num">90+</th></tr></thead>
            <tbody>${aging.rows.filter((r) => r.currency === t.currency).map((r) => `<tr>
              <td><a href="#/clients/${r.client_id}">${esc(r.client_name)}</a></td>
              ${['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].map((k) => `<td class="num">${r[k] ? esc(money(r[k], r.currency)) : '<span class="muted">—</span>'}</td>`).join('')}
            </tr>`).join('')}</tbody>
          </table></div>
        </div>`).join('') : empty('Nothing owed. Every issued invoice is settled.')}
    </section>

    <section class="section">
      <div class="section-head"><h2>Tax collected</h2>
        <form class="actions" data-tax>
          <input type="date" name="from" value="${esc(from)}" aria-label="From">
          <input type="date" name="to" value="${esc(to)}" aria-label="To">
          <button class="btn btn-sm" type="submit">Apply</button>
        </form>
      </div>
      ${tax.currencies.length ? tax.currencies.map((c) => `
        <div class="table-wrap mt-2"><table>
          <thead><tr><th>${esc(c.currency)} · ${c.invoices} invoice${c.invoices === 1 ? '' : 's'}</th><th class="num">Taxable base</th><th class="num">Tax</th></tr></thead>
          <tbody>
            ${c.rates.map((r) => `<tr><td>${esc(r.name)} ${esc(ppmToPercent(r.rate_ppm))}%</td><td class="num">${esc(money(r.base, c.currency))}</td><td class="num">${esc(money(r.amount, c.currency))}</td></tr>`).join('')}
            <tr><td class="muted">Untaxed sales</td><td class="num">${esc(money(c.untaxed_base, c.currency))}</td><td class="num muted">—</td></tr>
          </tbody>
          <tfoot><tr><td>Net sales ${esc(money(c.net_sales, c.currency))} · gross ${esc(money(c.gross, c.currency))}</td><td class="num">${esc(money(c.taxed_base, c.currency))}</td><td class="num">${esc(money(c.tax, c.currency))}</td></tr></tfoot>
        </table></div>`).join('') : empty('No issued invoices in this range.')}
      <p class="hint mt-1">Accrual basis: issued, non-void invoices dated ${esc(tax.from)} to ${esc(tax.to)}.</p>
    </section>

    <section class="section">
      <div class="section-head"><h2>Top clients · ${months} months</h2></div>
      ${Object.keys(top).length ? Object.entries(top).map(([c, rows]) => `
        <div class="table-wrap mt-2"><table>
          <thead><tr><th>${esc(c)}</th><th class="num">Invoices</th><th class="num">Billed</th><th class="num">Paid</th><th class="num">Outstanding</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td><a href="#/clients/${r.client_id}">${esc(r.client_name)}</a></td><td class="num">${r.invoices}</td>
            <td class="num">${esc(money(r.billed, c))}</td><td class="num">${esc(money(r.paid, c))}</td><td class="num">${esc(money(r.outstanding, c))}</td></tr>`).join('')}</tbody>
        </table></div>`).join('') : empty('No invoices in this window.')}
    </section>`;

  el.querySelector('[data-rev]').addEventListener('change', (e) => {
    const f = e.currentTarget;
    go(`/reports${qs({ ...query, months: f.months.value, currency: f.currency?.value })}`);
  });
  el.querySelector('[data-tax]').addEventListener('submit', (e) => {
    e.preventDefault();
    go(`/reports${qs({ ...query, from: e.target.from.value, to: e.target.to.value })}`);
  });
  el.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));
}

import { api, esc, money, date, statusChip, pageHead, empty, state } from '../ui.js';
import { revenueChart } from './charts.js';

export async function dashboardView({ el }) {
  const d = await api('/reports/dashboard');
  const primary = d.currencies[0];
  const cur = primary?.currency || state.settings.defaults.currency;
  const others = d.currencies.slice(1);
  const series = d.revenue.series.find((s) => s.currency === cur) || d.revenue.series[0];

  const docLink = (r) => `#/${r.kind === 'invoice' ? 'invoices' : 'estimates'}/${r.id}`;

  el.innerHTML = `
    ${pageHead(`Overview · ${d.today}`, state.settings.business.name || '7LABZ', '<a class="cta" href="#/invoices/new">New invoice</a>')}

    <section class="section grid grid-4" aria-label="Receivables">
      <div class="kpi">
        <span class="label">Outstanding</span>
        <div class="value focal">${esc(money(primary?.outstanding || 0, cur))}</div>
        <div class="sub">${primary?.open_count || 0} open invoice${primary?.open_count === 1 ? '' : 's'}</div>
      </div>
      <div class="kpi">
        <span class="label">Overdue</span>
        <div class="value">${esc(money(primary?.overdue || 0, cur))}</div>
        <div class="sub">${primary?.overdue_count || 0} past due</div>
      </div>
      <div class="kpi">
        <span class="label">Collected · 30 days</span>
        <div class="value">${esc(money(primary?.collected_30d || 0, cur))}</div>
        <div class="sub">Invoiced this month ${esc(money(primary?.invoiced_month || 0, cur))}</div>
      </div>
      <div class="kpi">
        <span class="label">Days to paid</span>
        <div class="value">${primary?.avg_days_to_pay ?? '—'}</div>
        <div class="sub">Average, last 12 months</div>
      </div>
    </section>

    ${others.length ? `
    <section class="section" aria-label="Other currencies">
      <div class="table-wrap"><table>
        <thead><tr><th>Currency</th><th class="num">Outstanding</th><th class="num">Overdue</th><th class="num">Collected · 30d</th></tr></thead>
        <tbody>${others.map((c) => `<tr><td>${esc(c.currency)}</td><td class="num">${esc(money(c.outstanding, c.currency))}</td><td class="num">${esc(money(c.overdue, c.currency))}</td><td class="num">${esc(money(c.collected_30d, c.currency))}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}

    <section class="section">
      <div class="section-head"><h2>Twelve months · ${esc(series?.currency || cur)}</h2><a class="btn btn-quiet" href="#/reports">Reports</a></div>
      <div class="panel">${revenueChart(d.revenue.months, series)}</div>
    </section>

    <section class="section grid grid-2">
      <div>
        <div class="section-head"><h2>Overdue</h2><a class="btn btn-quiet" href="#/invoices?status=overdue">All overdue</a></div>
        ${d.overdue.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th class="num">Balance</th></tr></thead>
          <tbody>${d.overdue.map((r) => `<tr class="row-link" data-href="${docLink(r)}">
            <td><a href="${docLink(r)}">${esc(r.number)}</a></td><td>${esc(r.client_name)}</td>
            <td class="muted">${esc(date(r.due_date))}</td><td class="num">${esc(money(r.balance, r.currency))}</td></tr>`).join('')}</tbody>
        </table></div>` : empty('Nothing overdue.')}
      </div>
      <div>
        <div class="section-head"><h2>Recent</h2></div>
        ${d.recent.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Document</th><th>Client</th><th class="num">Total</th><th>Status</th></tr></thead>
          <tbody>${d.recent.map((r) => `<tr class="row-link" data-href="${docLink(r)}">
            <td><a href="${docLink(r)}">${esc(r.number || `Draft ${r.kind}`)}</a></td><td>${esc(r.client_name)}</td>
            <td class="num">${esc(money(r.total, r.currency))}</td><td>${statusChip(r.status)}</td></tr>`).join('')}</tbody>
        </table></div>` : empty('No documents yet. Add a client, then write the first invoice.')}
      </div>
    </section>

    <section class="section grid grid-2">
      <div class="panel">
        <h3>Pipeline</h3>
        <dl class="dl">
          <dt>Draft invoices</dt><dd><a href="#/invoices?status=draft">${d.counts.draft_invoices || 0}</a></dd>
          <dt>Open estimates</dt><dd><a href="#/estimates?status=sent">${d.counts.open_estimates || 0}</a></dd>
          <dt>Active recurring</dt><dd><a href="#/recurring">${d.counts.active_recurring || 0}</a></dd>
          <dt>Clients</dt><dd><a href="#/clients">${d.counts.clients || 0}</a></dd>
        </dl>
      </div>
      <div class="panel">
        <h3>Next recurring runs</h3>
        ${d.upcoming.length ? `<dl class="dl">${d.upcoming.map((u) => `<dt><a href="#/recurring/${u.id}">${esc(u.name)}</a> <span class="muted">${esc(u.client_name)}</span></dt><dd>${esc(date(u.next_run))}</dd>`).join('')}</dl>` : '<p class="muted">No schedules running.</p>'}
      </div>
    </section>`;

  el.addEventListener('click', rowLinks);
}

// Whole table rows act as links; the inner <a> stays for keyboard and middle-click.
export function rowLinks(e) {
  const row = e.target.closest('tr[data-href]');
  if (!row || e.target.closest('a, button, input, select')) return;
  location.hash = row.dataset.href;
}

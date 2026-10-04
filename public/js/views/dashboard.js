import { api, esc, money, date, statusChip, empty, state, rowLinks } from '../ui.js';
import { diffDays } from '../lib/dates.js';
import { revenueChart } from './charts.js';
import { paymentDialog, issueDialog, sendDialog } from './documents.js';

export { rowLinks };

export async function dashboardView({ el, refresh }) {
  const d = await api('/reports/dashboard');
  const primary = d.currencies[0];
  const cur = primary?.currency || state.settings.defaults.currency;
  const others = d.currencies.slice(1).filter((c) => c.outstanding);
  const series = d.revenue.series.find((s) => s.currency === cur) || d.revenue.series[0];
  const docLink = (r) => `#/${r.kind === 'invoice' ? 'invoices' : 'estimates'}/${r.id}`;
  const today = d.today;

  // One queue of things that want a hand on them, most urgent first.
  const attention = [
    ...d.overdue.map((r) => ({ r, rank: 0, why: `${diffDays(today, r.due_date)} days late`, act: ['remind', 'Remind'], alt: ['pay', 'Payment'] })),
    ...d.due_soon.map((r) => {
      const n = diffDays(r.due_date, today);
      return { r, rank: 1, why: n === 0 ? 'Due today' : `Due in ${n} day${n === 1 ? '' : 's'}`, act: ['pay', 'Payment'] };
    }),
    ...d.drafts.map((r) => ({ r, rank: 2, why: 'Draft, not issued', act: ['issue', 'Issue'] })),
    ...d.awaiting.map((r) => {
      const n = diffDays(today, r.issue_date);
      return { r, rank: 3, why: n > 0 ? `Estimate out ${n} day${n === 1 ? '' : 's'}` : 'Estimate sent today', act: ['open', 'Open'] };
    }),
  ];

  const setupSteps = [
    ['business', 'Add your business address and email', '#/settings'],
    ['payment_instructions', 'Add payment instructions for invoices', '#/settings'],
    ['tax_rates', 'Add a tax rate, if you charge tax', '#/settings'],
    ['clients', 'Add the first client', '#/clients/new'],
    ['issued', 'Issue the first invoice', '#/invoices/new'],
  ];
  const setupLeft = setupSteps.filter(([k]) => !d.setup[k]);
  const setupDone = setupSteps.length - setupLeft.length;

  el.innerHTML = `
    <section class="hero" aria-labelledby="hero-figure">
      <div class="eyebrow">Outstanding · ${esc(cur)} · ${esc(date(today))}</div>
      <h1 class="hero-figure" id="hero-figure">${figure(primary?.outstanding || 0, cur)}</h1>
      <p class="hero-support">
        ${primary?.open_count ? `${primary.open_count} open invoice${primary.open_count === 1 ? '' : 's'}` : 'Nothing open'}${primary?.overdue ? ` · <a href="#/invoices?status=overdue">${esc(money(primary.overdue, cur))} overdue</a>` : ''}${others.length ? ` · also ${others.map((c) => esc(money(c.outstanding, c.currency))).join(', ')}` : ''}
      </p>
      <div class="hero-actions">
        <a class="cta" href="#/invoices/new">New invoice</a>
        <a class="btn btn-quiet" href="#/estimates/new">New estimate</a>
      </div>
    </section>

    <section class="proof" aria-label="This period">
      ${fact('Collected · 30 days', money(primary?.collected_30d || 0, cur))}
      ${fact('Invoiced this month', money(primary?.invoiced_month || 0, cur))}
      ${fact('Days to paid', primary?.avg_days_to_pay ?? '—')}
      ${fact('Open estimates', d.counts.open_estimates || 0, '#/estimates?status=sent')}
      ${fact('Active schedules', d.counts.active_recurring || 0, '#/recurring')}
    </section>

    ${setupLeft.length ? `
    <section class="section setup" aria-labelledby="setup-h">
      <div class="section-head"><h2 id="setup-h">Set up</h2><span class="hint">${setupDone} of ${setupSteps.length} done</span></div>
      <svg class="meter" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
        <rect class="meter-track" x="0" y="0" width="100" height="4"></rect>
        <rect class="meter-fill" x="0" y="0" width="${(setupDone / setupSteps.length) * 100}" height="4"></rect>
      </svg>
      <ol class="checklist">${setupSteps.map(([k, label, href]) => `<li class="${d.setup[k] ? 'done' : ''}">
        <span class="tick" aria-hidden="true">${d.setup[k] ? '✓' : ''}</span>
        ${d.setup[k] ? `<span>${esc(label)}</span>` : `<a href="${href}">${esc(label)}</a>`}
        <span class="sr-only">${d.setup[k] ? 'done' : 'to do'}</span></li>`).join('')}</ol>
    </section>` : ''}

    <section class="section" aria-labelledby="att-h">
      <div class="section-head"><h2 id="att-h">Needs attention</h2>${attention.length ? `<span class="hint">${attention.length} item${attention.length === 1 ? '' : 's'}</span>` : ''}</div>
      ${attention.length ? `<ul class="queue">${attention.map(({ r, why, act, alt, rank }) => `
        <li class="queue-item rank-${rank}">
          <a class="queue-main" href="${docLink(r)}">
            <span class="queue-why">${esc(why)}</span>
            <span class="queue-doc"><span class="mono">${esc(r.number || `Draft ${r.kind}`)}</span> <span class="muted">${esc(r.client_name)}${r.title ? ` · ${esc(r.title)}` : ''}</span></span>
          </a>
          <span class="queue-amt num">${esc(money(r.kind === 'invoice' && r.state === 'issued' ? r.balance : r.total, r.currency))}</span>
          <span class="queue-acts">
            ${alt ? `<button class="btn btn-sm btn-quiet" type="button" data-q="${alt[0]}" data-id="${r.id}">${esc(alt[1])}</button>` : ''}
            <button class="btn btn-sm" type="button" data-q="${act[0]}" data-id="${r.id}" data-kind="${r.kind}">${esc(act[1])}</button>
          </span>
        </li>`).join('')}</ul>` : `<div class="clear-state"><p>Nothing needs you. Every issued invoice is on time.</p></div>`}
    </section>

    <section class="section">
      <div class="section-head"><h2>Twelve months · ${esc(series?.currency || cur)}</h2><a class="btn btn-quiet" href="#/reports">Reports</a></div>
      <div class="panel">${revenueChart(d.revenue.months, series)}</div>
    </section>

    <section class="section grid grid-2">
      <div>
        <div class="section-head"><h2>Recent</h2><a class="btn btn-quiet" href="#/invoices">All invoices</a></div>
        ${d.recent.length ? `<div class="table-wrap"><table>
          <tbody>${d.recent.map((r) => `<tr class="row-link" data-href="${docLink(r)}">
            <td><a href="${docLink(r)}">${esc(r.number || `Draft ${r.kind}`)}</a><br><span class="muted">${esc(r.client_name)}</span></td>
            <td class="num">${esc(money(r.total, r.currency))}<br>${statusChip(r.status)}</td></tr>`).join('')}</tbody>
        </table></div>` : empty('No documents yet.')}
      </div>
      <div>
        <div class="section-head"><h2>Next recurring runs</h2><a class="btn btn-quiet" href="#/recurring">Schedules</a></div>
        ${d.upcoming.length ? `<div class="table-wrap"><table><tbody>${d.upcoming.map((u) => `<tr class="row-link" data-href="#/recurring/${u.id}">
          <td><a href="#/recurring/${u.id}">${esc(u.name)}</a><br><span class="muted">${esc(u.client_name)}</span></td>
          <td class="num muted">${esc(date(u.next_run))}</td></tr>`).join('')}</tbody></table></div>` : empty('No schedules running. Retainers bill themselves from Recurring.')}
      </div>
    </section>`;

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return rowLinks(e);
    const action = b.dataset.q;
    if (action === 'open') return (location.hash = `#/${b.dataset.kind === 'invoice' ? 'invoices' : 'estimates'}/${b.dataset.id}`);
    const doc = await api(`/documents/${b.dataset.id}`);
    if (action === 'pay') paymentDialog(doc, refresh, false);
    else if (action === 'issue') issueDialog(doc, refresh);
    else if (action === 'remind') sendDialog(doc, refresh, { reminder: true });
  });
}

// The headline amount: whole units large, minor units set smaller.
function figure(minor, currency) {
  const s = money(minor, currency);
  const m = /^(.*?)([.,]\d+)(\D*)$/.exec(s);
  return m ? `${esc(m[1])}<span class="cents">${esc(m[2])}</span>${esc(m[3])}` : esc(s);
}

function fact(label, value, href) {
  const v = `<span class="proof-value">${esc(value)}</span>`;
  return `<div class="proof-item"><span class="label">${esc(label)}</span>${href ? `<a href="${href}">${v}</a>` : v}</div>`;
}

import { esc, money } from '../ui.js';

// Grouped monthly bars: invoiced (outline) and collected (fill). Inline SVG, no library.
export function revenueChart(months, series) {
  if (!series) return '<div class="empty"><p>No invoices issued in this window.</p></div>';
  const W = 760, H = 220, padL = 8, padB = 28, padT = 12;
  const max = Math.max(1, ...series.invoiced, ...series.collected);
  const step = (W - padL) / months.length;
  const bw = Math.max(4, step / 3);
  const y = (v) => H - padB - (Math.max(v, 0) / max) * (H - padB - padT);
  const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const bars = months
    .map((m, i) => {
      const x = padL + i * step + step / 2 - bw;
      const now = i === months.length - 1;
      const inv = series.invoiced[i];
      const col = series.collected[i];
      return `<g>
        <title>${esc(m)} — invoiced ${esc(money(inv, series.currency))}, collected ${esc(money(col, series.currency))}</title>
        <rect class="bar" x="${x}" y="${y(inv)}" width="${bw - 2}" height="${H - padB - y(inv)}"></rect>
        <rect class="bar collected${now ? ' now' : ''}" x="${x + bw}" y="${y(col)}" width="${bw - 2}" height="${H - padB - y(col)}"></rect>
        <text x="${padL + i * step + step / 2}" y="${H - 8}" text-anchor="middle">${esc(label(m))}</text>
      </g>`;
    })
    .join('');
  const total = (k) => series[k].reduce((a, b) => a + b, 0);
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Invoiced and collected per month in ${esc(series.currency)}">
      <line class="axis" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"></line>
      ${bars}
    </svg>
    <div class="legend">
      <span><i class="lg-invoiced"></i>Invoiced ${esc(money(total('invoiced'), series.currency))}</span>
      <span><i class="lg-collected"></i>Collected ${esc(money(total('collected'), series.currency))}</span>
      <span>Peak month ${esc(money(max, series.currency))}</span>
    </div>`;
}

// Horizontal bar rows (aging buckets). SVG widths keep the strict CSP free of inline styles.
export function barRows(rows, currency) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="bars">${rows
    .map(
      (r) => `<div class="bar-row">
        <span class="muted">${esc(r.label)}</span>
        <svg class="bar-track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
          <rect class="bar-fill-svg" x="0" y="0" width="${(Math.max(r.value, 0) / max) * 100}" height="8"></rect>
        </svg>
        <span class="num">${esc(money(r.value, currency))}</span>
      </div>`,
    )
    .join('')}</div>`;
}

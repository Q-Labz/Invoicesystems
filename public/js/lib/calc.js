// The totals engine. One pure function, shared by the editor (live preview)
// and the server (the stored, authoritative numbers), so they never disagree.
//
// Order of operations, per line:
//   gross    = round(quantity × unit_price)
//   net      = gross − round(gross × line_discount%)
// Then per document:
//   subtotal = Σ net
//   discount = percent of subtotal, or a fixed amount capped at subtotal,
//              allocated back across positive lines (largest remainder)
//   tax      = Σ over each distinct rate of round(Σ taxable base × rate)
//   total    = subtotal − discount + tax
//
// Tax is rounded once per rate, not per line, so ten lines at 8.25% cannot
// drift by ten rounding errors.

import { mulDiv, allocate, parseScaled } from './money.js';

export const QTY_SCALE = 3;

export function quantityToMilli(q) {
  return parseScaled(q, QTY_SCALE);
}

export function computeDocument({ lines = [], discount_type = 'none', discount_value = 0 }) {
  const out = lines.map((line) => {
    const qtyMilli = quantityToMilli(line.quantity ?? 0) ?? 0;
    const gross = mulDiv(qtyMilli, line.unit_price || 0, 1000);
    const lineDiscount = mulDiv(gross, line.discount_bps || 0, 10000);
    return { ...line, gross, line_discount: lineDiscount, amount: gross - lineDiscount };
  });

  const subtotal = out.reduce((s, l) => s + l.amount, 0);

  let discount = 0;
  if (subtotal > 0) {
    if (discount_type === 'percent') discount = mulDiv(subtotal, discount_value || 0, 10000);
    else if (discount_type === 'fixed') discount = Math.min(Math.max(discount_value || 0, 0), subtotal);
  }
  const shares = allocate(discount, out.map((l) => l.amount));

  const taxes = new Map();
  out.forEach((l, i) => {
    l.allocated_discount = shares[i];
    l.taxable = l.amount - shares[i];
    if (!l.tax_rate_ppm) return;
    const key = `${l.tax_name || 'Tax'}|${l.tax_rate_ppm}`;
    const t = taxes.get(key) || { name: l.tax_name || 'Tax', rate_ppm: l.tax_rate_ppm, base: 0, amount: 0 };
    t.base += l.taxable;
    taxes.set(key, t);
  });

  const taxList = [...taxes.values()].map((t) => ({ ...t, amount: mulDiv(t.base, t.rate_ppm, 1000000) }));
  taxList.sort((a, b) => a.rate_ppm - b.rate_ppm || a.name.localeCompare(b.name));
  const taxTotal = taxList.reduce((s, t) => s + t.amount, 0);

  return {
    lines: out,
    subtotal,
    discount_total: discount,
    taxes: taxList,
    tax_total: taxTotal,
    total: subtotal - discount + taxTotal,
  };
}

// Display status, derived — never stored — so "overdue" can't go stale.
export function invoiceStatus({ state, total, paid = 0, due_date }, today) {
  if (state === 'draft') return 'draft';
  if (state === 'void') return 'void';
  const balance = total - paid;
  if (balance <= 0) return 'paid';
  if (due_date && due_date < today) return 'overdue';
  if (paid > 0) return 'partial';
  return 'sent';
}

export function estimateStatus({ state, due_date }, today) {
  if (state === 'issued') return due_date && due_date < today ? 'expired' : 'sent';
  return state;
}

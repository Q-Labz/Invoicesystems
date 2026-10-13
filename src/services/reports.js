import { Checker } from '../validate.js';
import { addDays, addMonths, startOfMonth } from '../../public/js/lib/dates.js';
import { DOC_VIEW } from './documents.js';

// Every figure is grouped by currency. Converting would need a rate source and a
// rate date, and a guessed rate on a financial report is worse than none.
export function reportsService(ctx) {
  const { db } = ctx;
  const view = () => `(${DOC_VIEW})`;

  function dashboard() {
    const today = ctx.today();
    const monthStart = startOfMonth(today);
    const byCurrency = new Map();
    const bucket = (cur) => {
      if (!byCurrency.has(cur)) {
        byCurrency.set(cur, { currency: cur, outstanding: 0, open_count: 0, overdue: 0, overdue_count: 0, collected_30d: 0, invoiced_month: 0, avg_days_to_pay: null });
      }
      return byCurrency.get(cur);
    };

    for (const r of db
      .prepare(
        `SELECT currency, SUM(balance) AS outstanding, COUNT(*) AS open_count,
           SUM(CASE WHEN status = 'overdue' THEN balance ELSE 0 END) AS overdue,
           SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue_count
         FROM ${view()} WHERE kind = 'invoice' AND status IN ('sent', 'partial', 'overdue') GROUP BY currency`,
      )
      .all({ today })) Object.assign(bucket(r.currency), r);

    for (const r of db
      .prepare(
        `SELECT d.currency, SUM(p.amount) AS collected FROM payments p JOIN documents d ON d.id = p.document_id
         WHERE p.date > ? AND p.date <= ? AND d.state = 'issued' GROUP BY d.currency`,
      )
      .all(addDays(today, -30), today)) bucket(r.currency).collected_30d = r.collected;

    for (const r of db
      .prepare(
        `SELECT currency, SUM(total) AS invoiced FROM documents
         WHERE kind = 'invoice' AND state = 'issued' AND issue_date >= ? AND issue_date <= ? GROUP BY currency`,
      )
      .all(monthStart, today)) bucket(r.currency).invoiced_month = r.invoiced;

    for (const r of db
      .prepare(
        `SELECT currency, ROUND(AVG(julianday(last_paid) - julianday(issue_date)), 1) AS avg_days FROM (
           SELECT v.currency, v.issue_date, (SELECT MAX(date) FROM payments WHERE document_id = v.id) AS last_paid
           FROM ${view()} v WHERE v.kind = 'invoice' AND v.status = 'paid' AND v.total > 0
         ) WHERE last_paid >= ? GROUP BY currency`,
      )
      .all({ today }, addDays(today, -365)).filter(Boolean)) bucket(r.currency).avg_days_to_pay = r.avg_days;

    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind = 'invoice' AND state = 'draft' THEN 1 ELSE 0 END) AS draft_invoices,
           SUM(CASE WHEN kind = 'estimate' AND state = 'issued' THEN 1 ELSE 0 END) AS open_estimates,
           (SELECT COUNT(*) FROM recurring WHERE active = 1) AS active_recurring,
           (SELECT COUNT(*) FROM clients WHERE archived = 0) AS clients
         FROM documents`,
      )
      .get();

    const overdue = db
      .prepare(`SELECT * FROM ${view()} v WHERE v.kind = 'invoice' AND v.status = 'overdue' ORDER BY v.due_date LIMIT 7`)
      .all({ today });
    const drafts = db
      .prepare(`SELECT * FROM ${view()} v WHERE v.kind = 'invoice' AND v.status = 'draft' ORDER BY v.updated_at DESC LIMIT 5`)
      .all({ today });
    const dueSoon = db
      .prepare(
        `SELECT * FROM ${view()} v WHERE v.kind = 'invoice' AND v.status IN ('sent', 'partial')
         AND v.due_date <= :soon ORDER BY v.due_date LIMIT 5`,
      )
      .all({ today, soon: addDays(today, 7) });
    const awaiting = db
      .prepare(`SELECT * FROM ${view()} v WHERE v.kind = 'estimate' AND v.status = 'sent' ORDER BY v.issue_date LIMIT 5`)
      .all({ today });
    const business = ctx.settings.get().business;
    const setup = {
      business: !!(business.email && business.address),
      payment_instructions: !!business.payment_instructions,
      tax_rates: db.prepare('SELECT COUNT(*) AS n FROM tax_rates WHERE archived = 0').get().n > 0,
      clients: db.prepare('SELECT COUNT(*) AS n FROM clients').get().n > 0,
      issued: db.prepare("SELECT COUNT(*) AS n FROM documents WHERE state <> 'draft'").get().n > 0,
    };

    const recent = db.prepare(`SELECT * FROM ${view()} v ORDER BY v.updated_at DESC, v.id DESC LIMIT 7`).all({ today });
    const upcoming = db
      .prepare(`SELECT r.id, r.name, r.next_run, r.currency, c.name AS client_name FROM recurring r JOIN clients c ON c.id = r.client_id WHERE r.active = 1 ORDER BY r.next_run LIMIT 5`)
      .all();

    const currencies = [...byCurrency.values()].sort((a, b) => b.outstanding - a.outstanding || a.currency.localeCompare(b.currency));
    return {
      today,
      currencies,
      counts,
      overdue,
      drafts,
      due_soon: dueSoon,
      reported: ctx.paymentReports.list(),
      awaiting,
      setup,
      recent,
      upcoming,
      revenue: revenue({ months: 12 }),
    };
  }

  function aging() {
    const today = ctx.today();
    const rows = db
      .prepare(
        `SELECT v.client_id, v.client_name, v.currency,
           SUM(CASE WHEN v.due_date IS NULL OR v.due_date >= :today THEN v.balance ELSE 0 END) AS current,
           SUM(CASE WHEN julianday(:today) - julianday(v.due_date) BETWEEN 1 AND 30 THEN v.balance ELSE 0 END) AS d1_30,
           SUM(CASE WHEN julianday(:today) - julianday(v.due_date) BETWEEN 31 AND 60 THEN v.balance ELSE 0 END) AS d31_60,
           SUM(CASE WHEN julianday(:today) - julianday(v.due_date) BETWEEN 61 AND 90 THEN v.balance ELSE 0 END) AS d61_90,
           SUM(CASE WHEN julianday(:today) - julianday(v.due_date) > 90 THEN v.balance ELSE 0 END) AS d90_plus,
           SUM(v.balance) AS total,
           COUNT(*) AS invoices
         FROM ${view()} v
         WHERE v.kind = 'invoice' AND v.status IN ('sent', 'partial', 'overdue')
         GROUP BY v.client_id, v.currency
         ORDER BY v.currency, total DESC`,
      )
      .all({ today });
    const keys = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'total', 'invoices'];
    const totals = {};
    for (const r of rows) {
      totals[r.currency] ||= Object.fromEntries(keys.map((k) => [k, 0]));
      for (const k of keys) totals[r.currency][k] += r[k];
    }
    return { today, rows, totals: Object.entries(totals).map(([currency, t]) => ({ currency, ...t })) };
  }

  // Monthly series. "invoiced" is accrual (issue date); "collected" is cash (payment date, net of refunds).
  function revenue(query = {}) {
    const v = new Checker(query).int('months', { min: 1, max: 60, def: 12 }).done();
    const today = ctx.today();
    const first = addMonths(startOfMonth(today), -(v.months - 1));
    const months = Array.from({ length: v.months }, (_, i) => addMonths(first, i).slice(0, 7));
    const series = new Map();
    const get = (cur) => {
      if (!series.has(cur)) {
        series.set(cur, { currency: cur, invoiced: months.map(() => 0), collected: months.map(() => 0), tax: months.map(() => 0) });
      }
      return series.get(cur);
    };
    for (const r of db
      .prepare(
        `SELECT currency, substr(issue_date, 1, 7) AS month, SUM(total) AS invoiced, SUM(tax_total) AS tax FROM documents
         WHERE kind = 'invoice' AND state = 'issued' AND issue_date >= ? AND issue_date <= ? GROUP BY currency, month`,
      )
      .all(first, today)) {
      const s = get(r.currency);
      const i = months.indexOf(r.month);
      s.invoiced[i] = r.invoiced;
      s.tax[i] = r.tax;
    }
    for (const r of db
      .prepare(
        `SELECT d.currency, substr(p.date, 1, 7) AS month, SUM(p.amount) AS collected
         FROM payments p JOIN documents d ON d.id = p.document_id
         WHERE d.state = 'issued' AND p.date >= ? AND p.date <= ? GROUP BY d.currency, month`,
      )
      .all(first, today)) get(r.currency).collected[months.indexOf(r.month)] = r.collected;
    return { months, series: [...series.values()] };
  }

  // Tax liability for issued invoices dated in the range (accrual basis).
  function tax(query = {}) {
    const today = ctx.today();
    const v = new Checker(query).date('from', { def: `${today.slice(0, 4)}-01-01` }).date('to', { def: today }).done();
    const docs = db
      .prepare(
        `SELECT currency, subtotal, discount_total, tax_total, total, taxes FROM documents
         WHERE kind = 'invoice' AND state = 'issued' AND issue_date >= ? AND issue_date <= ?`,
      )
      .all(v.from, v.to);
    const out = new Map();
    for (const d of docs) {
      if (!out.has(d.currency)) out.set(d.currency, { currency: d.currency, invoices: 0, net_sales: 0, taxed_base: 0, untaxed_base: 0, tax: 0, gross: 0, rates: new Map() });
      const o = out.get(d.currency);
      const taxes = JSON.parse(d.taxes);
      const taxedBase = taxes.reduce((s, t) => s + t.base, 0);
      o.invoices++;
      o.net_sales += d.subtotal - d.discount_total;
      o.taxed_base += taxedBase;
      o.untaxed_base += d.subtotal - d.discount_total - taxedBase;
      o.tax += d.tax_total;
      o.gross += d.total;
      for (const t of taxes) {
        const k = `${t.name}|${t.rate_ppm}`;
        const r = o.rates.get(k) || { name: t.name, rate_ppm: t.rate_ppm, base: 0, amount: 0 };
        r.base += t.base;
        r.amount += t.amount;
        o.rates.set(k, r);
      }
    }
    return {
      from: v.from,
      to: v.to,
      currencies: [...out.values()].map((o) => ({ ...o, rates: [...o.rates.values()].sort((a, b) => a.rate_ppm - b.rate_ppm) })),
    };
  }

  function topClients(query = {}) {
    const v = new Checker(query).int('months', { min: 1, max: 120, def: 12 }).int('limit', { min: 1, max: 100, def: 10 }).done();
    const since = addMonths(startOfMonth(ctx.today()), -(v.months - 1));
    return db
      .prepare(
        `SELECT v.client_id, v.client_name, v.currency, SUM(v.total) AS billed, SUM(v.paid) AS paid, SUM(v.balance) AS outstanding, COUNT(*) AS invoices
         FROM ${view()} v WHERE v.kind = 'invoice' AND v.state = 'issued' AND v.issue_date >= :since
         GROUP BY v.client_id, v.currency ORDER BY v.currency, billed DESC`,
      )
      .all({ today: ctx.today(), since })
      .reduce((acc, r) => {
        acc[r.currency] ||= [];
        if (acc[r.currency].length < v.limit) acc[r.currency].push(r);
        return acc;
      }, {});
  }

  return { dashboard, aging, revenue, tax, topClients };
}

import { fromMinor } from '../../public/js/lib/money.js';
import { DOC_VIEW } from './documents.js';

const TABLES = ['settings', 'tax_rates', 'clients', 'items', 'recurring', 'documents', 'document_lines', 'payments', 'sequences', 'activity'];

export function csv(rows, columns) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection from client-entered text.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(([label]) => cell(label)).join(',');
  const body = rows.map((r) => columns.map(([, get]) => cell(get(r))).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

export function exportsService(ctx) {
  const { db } = ctx;

  function documentsCsv({ kind = 'invoice', from, to } = {}) {
    const args = { kind: kind === 'estimate' ? 'estimate' : 'invoice', today: ctx.today(), from: from || '', to: to || '' };
    const rows = db
      .prepare(
        `SELECT * FROM (${DOC_VIEW}) v WHERE v.kind = :kind AND v.state <> 'draft'
         AND (:from = '' OR v.issue_date >= :from) AND (:to = '' OR v.issue_date <= :to)
         ORDER BY v.issue_date, v.number`,
      )
      .all(args);
    const m = (k) => (r) => fromMinor(r[k], r.currency);
    return csv(rows, [
      ['Number', (r) => r.number],
      ['Status', (r) => r.status],
      ['Client', (r) => r.client_name],
      ['Company', (r) => r.client_company],
      ['Issue date', (r) => r.issue_date],
      ['Due date', (r) => r.due_date],
      ['PO', (r) => r.po_number],
      ['Title', (r) => r.title],
      ['Currency', (r) => r.currency],
      ['Subtotal', m('subtotal')],
      ['Discount', m('discount_total')],
      ['Tax', m('tax_total')],
      ['Total', m('total')],
      ['Paid', m('paid')],
      ['Balance', m('balance')],
    ]);
  }

  function paymentsCsv({ from, to } = {}) {
    const rows = ctx.documents.listPayments({ from, to, limit: 1000 });
    return csv(rows.reverse(), [
      ['Date', (r) => r.date],
      ['Invoice', (r) => r.number],
      ['Client', (r) => r.client_name],
      ['Method', (r) => r.method],
      ['Reference', (r) => r.reference],
      ['Currency', (r) => r.currency],
      ['Amount', (r) => fromMinor(r.amount, r.currency)],
      ['Note', (r) => r.note],
    ]);
  }

  function backup() {
    const data = {};
    for (const t of TABLES) data[t] = db.prepare(`SELECT * FROM ${t}`).all();
    return {
      format: '7labz-invoicing-backup',
      version: db.prepare('PRAGMA user_version').get().user_version,
      exported_at: new Date().toISOString(),
      data,
    };
  }

  return { documentsCsv, paymentsCsv, backup };
}

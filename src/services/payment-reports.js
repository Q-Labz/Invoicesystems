import { Checker, HttpError, notFound, conflict } from '../validate.js';
import { PAYMENT_METHODS } from './documents.js';
import { fromMinor } from '../../public/js/lib/money.js';

const MAX_PENDING_PER_INVOICE = 5;

// A client says "I've paid" from the invoice link. Nothing is recorded as paid until
// the owner sees the money and confirms: a report is a claim, not a payment.
export function paymentReportsService(ctx) {
  const { db } = ctx;

  function report(token, input) {
    const s = ctx.settings.get();
    if (!s.payments.client_reports) throw new HttpError(403, 'Payment reports are turned off');
    const doc = ctx.documents.byToken(token);
    if (doc.kind !== 'invoice' || doc.state !== 'issued') throw conflict('This invoice is not open for payment');
    if (doc.balance <= 0) throw conflict('This invoice is already paid');
    const pending = db.prepare("SELECT COUNT(*) AS n FROM payment_reports WHERE document_id = ? AND status = 'pending'").get(doc.id).n;
    if (pending >= MAX_PENDING_PER_INVOICE) throw new HttpError(429, 'A payment is already waiting for confirmation');
    const c = new Checker(input)
      .oneOf('method', PAYMENT_METHODS.filter((m) => !['card', 'stripe', 'check', 'cash'].includes(m)), { required: true })
      .money('amount', doc.currency, { def: doc.balance })
      .str('payer', { max: 120 })
      .str('reference', { max: 120 })
      .str('note', { max: 500 });
    const v = c.done();
    if (v.amount <= 0) throw new HttpError(422, 'Check the highlighted fields', { amount: 'Must be more than zero' });
    if (v.amount > doc.balance) throw new HttpError(422, 'Check the highlighted fields', { amount: `The balance is ${fromMinor(doc.balance, doc.currency)}` });
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO payment_reports (document_id, method, amount, payer, reference, note) VALUES (?,?,?,?,?,?)')
      .run(doc.id, v.method, v.amount, v.payer ?? '', v.reference ?? '', v.note ?? '');
    ctx.log('document', doc.id, 'payment_reported', { amount: v.amount, currency: doc.currency, method: v.method, report_id: Number(id) });
    return { ok: true, status: 'pending' };
  }

  function list({ status = 'pending', document_id } = {}) {
    const args = [status];
    let extra = '';
    if (document_id) { extra = ' AND r.document_id = ?'; args.push(document_id); }
    return db
      .prepare(
        `SELECT r.*, d.number, d.currency, d.client_id, c.name AS client_name
         FROM payment_reports r JOIN documents d ON d.id = r.document_id JOIN clients c ON c.id = d.client_id
         WHERE r.status = ?${extra} ORDER BY r.reported_at DESC`,
      )
      .all(...args);
  }

  function get(id) {
    const r = db.prepare('SELECT * FROM payment_reports WHERE id = ?').get(id);
    if (!r) throw notFound('Payment report');
    return r;
  }

  // Records the real payment (owner may correct amount, date, reference) and closes the report.
  function confirm(id, input = {}) {
    return ctx.tx(() => {
      const r = get(id);
      if (r.status !== 'pending') throw conflict(`Already ${r.status}`);
      const doc = ctx.documents.get(r.document_id);
      const body = {
        amount: input.amount ?? fromMinor(Math.min(r.amount, doc.balance), doc.currency),
        date: input.date ?? ctx.today(),
        method: input.method ?? r.method,
        reference: input.reference ?? r.reference,
        note: input.note ?? (r.payer ? `Reported by ${r.payer}` : 'Reported by client'),
      };
      ctx.documents.addPayment(r.document_id, body);
      const paymentId = db.prepare('SELECT MAX(id) AS id FROM payments WHERE document_id = ?').get(r.document_id).id;
      db.prepare("UPDATE payment_reports SET status = 'confirmed', payment_id = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(paymentId, id);
      ctx.log('document', r.document_id, 'payment_report_confirmed', { report_id: id });
      return ctx.documents.get(r.document_id);
    });
  }

  function dismiss(id) {
    const r = get(id);
    if (r.status !== 'pending') throw conflict(`Already ${r.status}`);
    db.prepare("UPDATE payment_reports SET status = 'dismissed', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    ctx.log('document', r.document_id, 'payment_report_dismissed', { report_id: id });
    return ctx.documents.get(r.document_id);
  }

  return { report, list, confirm, dismiss };
}

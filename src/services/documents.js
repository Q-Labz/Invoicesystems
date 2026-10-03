import { randomBytes } from 'node:crypto';
import { Checker, HttpError, notFound, conflict } from '../validate.js';
import { computeDocument, invoiceStatus, estimateStatus, quantityToMilli } from '../../public/js/lib/calc.js';
import { addDays, isDate } from '../../public/js/lib/dates.js';
import { toMinor, percentToBps, fromMinor } from '../../public/js/lib/money.js';

export const PAYMENT_METHODS = ['bank_transfer', 'card', 'cash', 'check', 'crypto', 'paypal', 'stripe', 'other'];
const MAX_LINES = 200;

export const newToken = () => randomBytes(18).toString('base64url');

// Status is derived in SQL too, so lists can filter on it. Must mirror calc.js.
const STATUS_SQL = `
  CASE WHEN d.kind = 'invoice' THEN
    CASE
      WHEN d.state = 'draft' THEN 'draft'
      WHEN d.state = 'void' THEN 'void'
      WHEN d.total - IFNULL(p.paid, 0) <= 0 THEN 'paid'
      WHEN d.due_date IS NOT NULL AND d.due_date < :today THEN 'overdue'
      WHEN IFNULL(p.paid, 0) > 0 THEN 'partial'
      ELSE 'sent'
    END
  ELSE
    CASE WHEN d.state = 'issued' THEN
      CASE WHEN d.due_date IS NOT NULL AND d.due_date < :today THEN 'expired' ELSE 'sent' END
    ELSE d.state END
  END`;

export const DOC_VIEW = `
  SELECT d.*, IFNULL(p.paid, 0) AS paid, d.total - IFNULL(p.paid, 0) AS balance,
         c.name AS client_name, c.company AS client_company, c.email AS client_email,
         ${STATUS_SQL} AS status
  FROM documents d
  JOIN clients c ON c.id = d.client_id
  LEFT JOIN (SELECT document_id, SUM(amount) AS paid FROM payments GROUP BY document_id) p ON p.document_id = d.id`;

export function documentsService(ctx) {
  const { db } = ctx;

  // ---------- reads ----------

  function list(query = {}) {
    const c = new Checker(query)
      .oneOf('kind', ['invoice', 'estimate'], { def: 'invoice' })
      .oneOf('status', ['draft', 'sent', 'partial', 'paid', 'overdue', 'void', 'open', 'expired', 'accepted', 'declined', 'converted'])
      .int('client_id', { min: 1 })
      .int('recurring_id', { min: 1 })
      .str('q', { max: 100 })
      .date('from')
      .date('to')
      .oneOf('sort', ['issue_date', 'due_date', 'number', 'total', 'balance', 'client_name', 'created_at'], { def: 'issue_date' })
      .oneOf('order', ['asc', 'desc'], { def: 'desc' })
      .int('limit', { min: 1, max: 500, def: 50 })
      .int('offset', { min: 0, def: 0 });
    const v = c.done();

    const where = ['v.kind = :kind'];
    const args = { kind: v.kind, today: ctx.today() };
    if (v.status === 'open') where.push("v.status IN ('sent', 'partial', 'overdue')");
    else if (v.status) { where.push('v.status = :status'); args.status = v.status; }
    if (v.client_id) { where.push('v.client_id = :client_id'); args.client_id = v.client_id; }
    if (v.recurring_id) { where.push('v.recurring_id = :recurring_id'); args.recurring_id = v.recurring_id; }
    if (v.from) { where.push('v.issue_date >= :from'); args.from = v.from; }
    if (v.to) { where.push('v.issue_date <= :to'); args.to = v.to; }
    if (v.q) {
      where.push('(v.number LIKE :q OR v.title LIKE :q OR v.po_number LIKE :q OR v.client_name LIKE :q OR v.client_company LIKE :q)');
      args.q = `%${v.q}%`;
    }
    const sql = `FROM (${DOC_VIEW}) v WHERE ${where.join(' AND ')}`;
    // Drafts have no number; keep them on top of a newest-first list.
    const order = `${v.sort === 'number' ? 'v.number IS NULL DESC, ' : ''}v.${v.sort} ${v.order}, v.id ${v.order}`;
    const rows = db.prepare(`SELECT v.* ${sql} ORDER BY ${order} LIMIT :limit OFFSET :offset`).all({ ...args, limit: v.limit, offset: v.offset });
    const { count } = db.prepare(`SELECT COUNT(*) AS count ${sql}`).get(args);
    const totals = db
      .prepare(`SELECT v.currency, SUM(v.total) AS total, SUM(CASE WHEN v.state = 'issued' THEN v.balance ELSE 0 END) AS balance ${sql} GROUP BY v.currency`)
      .all(args);
    return { rows: rows.map(decode), count, totals, limit: v.limit, offset: v.offset };
  }

  function decode(row) {
    return {
      ...row,
      taxes: JSON.parse(row.taxes || '[]'),
      client_snapshot: row.client_snapshot ? JSON.parse(row.client_snapshot) : null,
      business_snapshot: row.business_snapshot ? JSON.parse(row.business_snapshot) : null,
    };
  }

  function row(id) {
    const r = db.prepare(`SELECT * FROM (${DOC_VIEW}) v WHERE v.id = :id`).get({ id, today: ctx.today() });
    if (!r) throw notFound('Document');
    return decode(r);
  }

  function get(id) {
    const doc = row(id);
    doc.lines = db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY position').all(id);
    doc.payments = db.prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY date, id').all(id);
    doc.client = db.prepare('SELECT * FROM clients WHERE id = ?').get(doc.client_id);
    // Issued documents show the client and business exactly as they were at issue.
    doc.bill_to = doc.client_snapshot || snapshotClient(doc.client);
    doc.from = doc.business_snapshot || ctx.settings.get().business;
    doc.related = {
      source_estimate: doc.source_estimate_id ? brief(doc.source_estimate_id) : null,
      converted_invoice: db.prepare('SELECT id, number, kind FROM documents WHERE source_estimate_id = ?').get(id) || null,
      recurring: doc.recurring_id ? db.prepare('SELECT id, name FROM recurring WHERE id = ?').get(doc.recurring_id) || null : null,
    };
    return doc;
  }

  function brief(id) {
    return db.prepare('SELECT id, number, kind, state FROM documents WHERE id = ?').get(id) || null;
  }

  function byToken(token) {
    const r = db.prepare('SELECT id FROM documents WHERE share_token = ?').get(token);
    if (!r) throw notFound('Document');
    const doc = get(r.id);
    if (doc.state === 'draft') throw notFound('Document');
    return doc;
  }

  function activity(id) {
    row(id);
    return db
      .prepare(
        `SELECT * FROM activity WHERE (entity = 'document' AND entity_id = ?)
         OR (entity = 'payment' AND json_extract(detail, '$.document_id') = ?) ORDER BY at DESC, id DESC`,
      )
      .all(id, id)
      .map((a) => ({ ...a, detail: JSON.parse(a.detail) }));
  }

  // ---------- validation ----------

  function validateLines(rawLines, currency) {
    if (!Array.isArray(rawLines)) throw new HttpError(422, 'Check the highlighted fields', { lines: 'Must be a list' });
    if (rawLines.length > MAX_LINES) throw new HttpError(422, 'Check the highlighted fields', { lines: `At most ${MAX_LINES} lines` });
    const errors = {};
    const taxStmt = db.prepare('SELECT * FROM tax_rates WHERE id = ?');
    const itemStmt = db.prepare('SELECT id FROM items WHERE id = ?');
    const lines = rawLines.map((raw, i) => {
      const c = new Checker(raw)
        .str('description', { required: true, max: 2000 })
        .str('unit', { max: 20, def: '' })
        .int('item_id', { min: 1, nullable: true })
        .int('tax_rate_id', { min: 1, nullable: true })
        .percent('discount_percent', { def: 0 })
        .money('unit_price', currency, { required: true });
      const qty = raw?.quantity ?? '1';
      const milli = quantityToMilli(typeof qty === 'number' ? qty : String(qty));
      if (milli === null) c.fail('quantity', 'Up to 3 decimals');
      else if (milli === 0) c.fail('quantity', 'Cannot be zero');
      else if (Math.abs(milli) > 1e9) c.fail('quantity', 'Too large');
      let tax = null;
      if (c.out.tax_rate_id) {
        tax = taxStmt.get(c.out.tax_rate_id);
        if (!tax) c.fail('tax_rate_id', 'Unknown tax rate');
      }
      if (c.out.item_id && !itemStmt.get(c.out.item_id)) c.fail('item_id', 'Unknown item');
      for (const [k, msg] of Object.entries(c.errors)) errors[`lines.${i}.${k}`] = msg;
      return {
        position: i,
        item_id: c.out.item_id ?? null,
        description: c.out.description,
        quantity: milli === null ? '0' : String(milli / 1000),
        unit: c.out.unit ?? '',
        unit_price: c.out.unit_price,
        discount_bps: c.out.discount_percent ?? 0,
        tax_rate_id: tax?.id ?? null,
        tax_name: tax?.name ?? '',
        tax_rate_ppm: tax?.rate_ppm ?? 0,
      };
    });
    if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields', errors);
    return lines;
  }

  function validateDoc(input, existing) {
    const s = ctx.settings.get();
    const c = new Checker(input);
    if (!existing) c.oneOf('kind', ['invoice', 'estimate'], { def: 'invoice' });
    c.int('client_id', { required: !existing, min: 1 })
      .currency('currency')
      .date('issue_date')
      .date('due_date', { nullable: true })
      .int('payment_terms_days', { min: 0, max: 365 })
      .str('po_number', { max: 60 })
      .str('title', { max: 200 })
      .str('notes', { max: 4000 })
      .str('terms', { max: 8000 })
      .oneOf('discount_type', ['none', 'percent', 'fixed']);
    const kind = existing?.kind || c.out.kind;
    const clientId = c.out.client_id ?? existing?.client_id;
    const client = clientId ? db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) : null;
    if (clientId && !client) c.fail('client_id', 'Unknown client');
    if (client?.archived && client.id !== existing?.client_id) c.fail('client_id', 'Client is archived');

    const currency = c.out.currency || existing?.currency || client?.currency || s.defaults.currency;
    const discountType = c.out.discount_type || existing?.discount_type || 'none';
    if (input?.discount_value !== undefined && input.discount_value !== '' && input.discount_value !== null) {
      const dv = discountType === 'percent' ? percentToBps(input.discount_value) : toMinor(input.discount_value, currency);
      if (dv === null || dv < 0 || (discountType === 'percent' && dv > 10000)) c.fail('discount_value', 'Not a valid discount');
      else c.out.discount_value = discountType === 'none' ? 0 : dv;
    } else if (c.out.discount_type === 'none') c.out.discount_value = 0;

    const issueDate = c.out.issue_date || existing?.issue_date || ctx.today();
    let dueDate = c.out.due_date !== undefined ? c.out.due_date : existing?.due_date;
    if (c.out.payment_terms_days !== undefined && c.out.due_date === undefined) {
      dueDate = addDays(issueDate, c.out.payment_terms_days);
    }
    if (!existing && dueDate === undefined) {
      const days = kind === 'estimate' ? s.defaults.estimate_valid_days : client?.payment_terms_days ?? s.defaults.payment_terms_days;
      dueDate = addDays(issueDate, days);
    }
    if (dueDate && dueDate < issueDate) c.fail('due_date', 'Cannot be before the issue date');
    const v = c.done();

    let lines;
    if (input.lines !== undefined) lines = validateLines(input.lines, currency);
    else if (existing && currency !== existing.currency) {
      // Currency switch without new lines: re-read each price in the new currency's minor units.
      lines = validateLines(existing.lines.map((l) => ({ ...l, unit_price: fromMinor(l.unit_price, existing.currency), discount_percent: l.discount_bps / 100 })), currency);
    }

    return {
      kind,
      client_id: clientId,
      currency,
      issue_date: issueDate,
      due_date: dueDate ?? null,
      po_number: v.po_number ?? existing?.po_number ?? '',
      title: v.title ?? existing?.title ?? '',
      notes: v.notes ?? existing?.notes ?? (existing ? '' : s.defaults.notes),
      terms: v.terms ?? existing?.terms ?? (existing ? '' : s.defaults.terms),
      discount_type: discountType,
      discount_value: v.discount_value ?? (discountType === 'none' ? 0 : existing?.discount_value ?? 0),
      lines,
    };
  }

  // ---------- writes ----------

  function writeLines(docId, lines) {
    db.prepare('DELETE FROM document_lines WHERE document_id = ?').run(docId);
    const ins = db.prepare(
      `INSERT INTO document_lines (document_id, position, item_id, description, quantity, unit, unit_price,
        discount_bps, tax_rate_id, tax_name, tax_rate_ppm, amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const l of lines) {
      ins.run(docId, l.position, l.item_id, l.description, l.quantity, l.unit, l.unit_price, l.discount_bps, l.tax_rate_id, l.tax_name, l.tax_rate_ppm, l.amount);
    }
  }

  function saveTotals(docId, totals) {
    db.prepare(
      `UPDATE documents SET subtotal = ?, discount_total = ?, tax_total = ?, total = ?, taxes = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(totals.subtotal, totals.discount_total, totals.tax_total, totals.total, JSON.stringify(totals.taxes), docId);
  }

  function create(input, { recurringId = null, sourceEstimateId = null, quiet = false } = {}) {
    return ctx.tx(() => {
      const v = validateDoc(input);
      const lines = v.lines || [];
      const totals = computeDocument({ lines, discount_type: v.discount_type, discount_value: v.discount_value });
      const { lastInsertRowid: id } = db
        .prepare(
          `INSERT INTO documents (kind, client_id, currency, issue_date, due_date, po_number, title, notes, terms,
            discount_type, discount_value, share_token, recurring_id, source_estimate_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(v.kind, v.client_id, v.currency, v.issue_date, v.due_date, v.po_number, v.title, v.notes, v.terms,
          v.discount_type, v.discount_value, newToken(), recurringId, sourceEstimateId);
      writeLines(id, totals.lines);
      saveTotals(id, totals);
      if (!quiet) ctx.log('document', id, 'created', { kind: v.kind, total: totals.total, currency: v.currency });
      return get(id);
    });
  }

  function update(id, input) {
    return ctx.tx(() => {
      const existing = get(id);
      assertEditable(existing);
      const v = validateDoc(input, existing);
      const lines = v.lines || existing.lines;
      const totals = computeDocument({ lines, discount_type: v.discount_type, discount_value: v.discount_value });
      if (existing.state === 'issued' && existing.kind === 'invoice' && totals.total < existing.paid) {
        throw conflict('The new total is below what has already been paid. Refund first.');
      }
      db.prepare(
        `UPDATE documents SET client_id = ?, currency = ?, issue_date = ?, due_date = ?, po_number = ?, title = ?,
         notes = ?, terms = ?, discount_type = ?, discount_value = ? WHERE id = ?`,
      ).run(v.client_id, v.currency, v.issue_date, v.due_date, v.po_number, v.title, v.notes, v.terms, v.discount_type, v.discount_value, id);
      writeLines(id, totals.lines);
      saveTotals(id, totals);
      if (existing.state === 'issued') {
        db.prepare('UPDATE documents SET client_snapshot = ? WHERE id = ?').run(
          JSON.stringify(snapshotClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(v.client_id))),
          id,
        );
      }
      ctx.log('document', id, existing.state === 'draft' ? 'updated' : 'revised', {
        from_total: existing.total,
        to_total: totals.total,
        currency: v.currency,
      });
      return get(id);
    });
  }

  function assertEditable(doc) {
    if (doc.state === 'draft') return;
    if (doc.kind === 'invoice' && doc.state === 'issued') {
      if (doc.payments.length) throw conflict('Invoices with payments are locked. Void and reissue, or remove the payments.');
      return;
    }
    if (doc.kind === 'estimate' && doc.state === 'issued') return;
    throw conflict(`A ${doc.state} ${doc.kind} cannot be edited`);
  }

  function remove(id) {
    const doc = row(id);
    if (doc.state !== 'draft') throw conflict('Only drafts can be deleted. Void an issued invoice instead.');
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    ctx.log('document', id, 'deleted', { kind: doc.kind });
    return { deleted: true };
  }

  function issue(id, { date } = {}) {
    return ctx.tx(() => {
      const doc = get(id);
      if (doc.state !== 'draft') throw conflict(`Already ${doc.state}`);
      if (!doc.lines.length) throw new HttpError(422, 'Add at least one line before issuing', { lines: 'Required' });
      if (doc.kind === 'invoice' && doc.total < 0) throw conflict('An invoice total cannot be negative');
      if (date !== undefined && !isDate(date)) throw new HttpError(422, 'Check the highlighted fields', { date: 'Use YYYY-MM-DD' });
      const issueDate = date || doc.issue_date;
      const number = ctx.numbering.next(doc.kind, issueDate);
      let dueDate = doc.due_date;
      if (date && doc.due_date) dueDate = addDays(date, Math.max(0, daysBetween(doc.issue_date, doc.due_date)));
      db.prepare(
        `UPDATE documents SET state = 'issued', number = ?, issue_date = ?, due_date = ?, issued_at = datetime('now'),
         client_snapshot = ?, business_snapshot = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(number, issueDate, dueDate, JSON.stringify(snapshotClient(doc.client)), JSON.stringify(ctx.settings.get().business), id);
      ctx.log('document', id, 'issued', { number, total: doc.total, currency: doc.currency });
      return get(id);
    });
  }

  function voidDoc(id, { reason = '' } = {}) {
    return ctx.tx(() => {
      const doc = get(id);
      if (doc.kind !== 'invoice') throw conflict('Only invoices are voided. Decline an estimate instead.');
      if (doc.state !== 'issued') throw conflict(`A ${doc.state} invoice cannot be voided`);
      if (doc.paid !== 0) throw conflict('Refund or remove payments before voiding');
      const r = String(reason || '').trim().slice(0, 500);
      db.prepare(`UPDATE documents SET state = 'void', voided_at = datetime('now'), void_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(r, id);
      ctx.log('document', id, 'voided', { number: doc.number, reason: r });
      return get(id);
    });
  }

  function duplicate(id) {
    const doc = get(id);
    const today = ctx.today();
    const span = doc.due_date ? daysBetween(doc.issue_date, doc.due_date) : null;
    const copy = create({
      kind: doc.kind,
      client_id: doc.client_id,
      currency: doc.currency,
      issue_date: today,
      due_date: span === null ? null : addDays(today, Math.max(0, span)),
      po_number: doc.po_number,
      title: doc.title,
      notes: doc.notes,
      terms: doc.terms,
      discount_type: doc.discount_type,
      discount_value: doc.discount_type === 'percent' ? doc.discount_value / 100 : fromMinor(doc.discount_value, doc.currency),
      lines: doc.lines.map(lineToInput(doc.currency)),
    }, { quiet: true });
    ctx.log('document', copy.id, 'created', { kind: doc.kind, duplicated_from: doc.number || `draft #${doc.id}` });
    return copy;
  }

  function setEstimateState(id, next) {
    return ctx.tx(() => {
      const doc = row(id);
      if (doc.kind !== 'estimate') throw conflict('Only estimates can be accepted or declined');
      if (!['issued', 'accepted', 'declined'].includes(doc.state)) throw conflict(`A ${doc.state} estimate cannot be ${next}`);
      if (doc.state === next) return get(id);
      db.prepare(`UPDATE documents SET state = ?, updated_at = datetime('now') WHERE id = ?`).run(next, id);
      ctx.log('document', id, next, { number: doc.number });
      return get(id);
    });
  }

  function convert(id) {
    return ctx.tx(() => {
      const est = get(id);
      if (est.kind !== 'estimate') throw conflict('Only estimates convert to invoices');
      if (!['issued', 'accepted'].includes(est.state)) throw conflict(`A ${est.state} estimate cannot be converted`);
      const client = est.client;
      const inv = create({
        kind: 'invoice',
        client_id: est.client_id,
        currency: est.currency,
        issue_date: ctx.today(),
        payment_terms_days: client.payment_terms_days,
        po_number: est.po_number,
        title: est.title,
        notes: est.notes,
        terms: est.terms,
        discount_type: est.discount_type,
        discount_value: est.discount_type === 'percent' ? est.discount_value / 100 : fromMinor(est.discount_value, est.currency),
        lines: est.lines.map(lineToInput(est.currency)),
      }, { sourceEstimateId: id, quiet: true });
      db.prepare(`UPDATE documents SET state = 'converted', updated_at = datetime('now') WHERE id = ?`).run(id);
      ctx.log('document', id, 'converted', { number: est.number, invoice_id: inv.id });
      ctx.log('document', inv.id, 'created', { kind: 'invoice', from_estimate: est.number });
      return get(inv.id);
    });
  }

  function rotateShare(id) {
    row(id);
    db.prepare('UPDATE documents SET share_token = ? WHERE id = ?').run(newToken(), id);
    ctx.log('document', id, 'share_link_rotated');
    return get(id);
  }

  function markSent(id, { to = '' } = {}) {
    const doc = row(id);
    if (doc.state === 'draft') throw conflict('Issue the document first');
    ctx.log('document', id, 'sent', { to: String(to).slice(0, 500) });
    return { ok: true };
  }

  // ---------- payments ----------

  function addPayment(id, input) {
    return ctx.tx(() => {
      const doc = get(id);
      if (doc.kind !== 'invoice') throw conflict('Payments apply to invoices');
      if (doc.state !== 'issued') throw conflict(`Cannot record a payment on a ${doc.state} invoice`);
      const c = new Checker(input)
        .money('amount', doc.currency, { required: true })
        .date('date', { def: ctx.today() })
        .oneOf('method', PAYMENT_METHODS, { def: 'bank_transfer' })
        .str('reference', { max: 120 })
        .str('note', { max: 1000 })
        .bool('refund');
      const v = c.done();
      let amount = v.amount;
      if (amount <= 0) throw new HttpError(422, 'Check the highlighted fields', { amount: 'Must be more than zero' });
      if (v.refund) {
        if (amount > doc.paid) throw new HttpError(422, 'Check the highlighted fields', { amount: `Refund cannot exceed ${fromMinor(doc.paid, doc.currency)} paid` });
        amount = -amount;
      } else if (amount > doc.balance) {
        throw new HttpError(422, 'Check the highlighted fields', { amount: `Exceeds the ${fromMinor(doc.balance, doc.currency)} balance` });
      }
      const { lastInsertRowid } = db
        .prepare('INSERT INTO payments (document_id, amount, date, method, reference, note) VALUES (?,?,?,?,?,?)')
        .run(id, amount, v.date, v.method, v.reference ?? '', v.note ?? '');
      ctx.log('payment', lastInsertRowid, amount < 0 ? 'refunded' : 'recorded', {
        document_id: id,
        number: doc.number,
        amount,
        currency: doc.currency,
        method: v.method,
      });
      return get(id);
    });
  }

  function listPayments(query = {}) {
    const v = new Checker(query).date('from').date('to').int('client_id', { min: 1 }).int('limit', { min: 1, max: 1000, def: 200 }).done();
    const where = ['1 = 1'];
    const args = [];
    if (v.from) { where.push('p.date >= ?'); args.push(v.from); }
    if (v.to) { where.push('p.date <= ?'); args.push(v.to); }
    if (v.client_id) { where.push('d.client_id = ?'); args.push(v.client_id); }
    return db
      .prepare(
        `SELECT p.*, d.number, d.currency, d.client_id, c.name AS client_name
         FROM payments p JOIN documents d ON d.id = p.document_id JOIN clients c ON c.id = d.client_id
         WHERE ${where.join(' AND ')} ORDER BY p.date DESC, p.id DESC LIMIT ?`,
      )
      .all(...args, v.limit);
  }

  function deletePayment(paymentId) {
    return ctx.tx(() => {
      const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
      if (!p) throw notFound('Payment');
      const doc = row(p.document_id);
      if (doc.state !== 'issued') throw conflict(`The invoice is ${doc.state}`);
      if (p.amount > 0 && doc.paid - p.amount < 0) throw conflict('Remove the refund first');
      db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
      ctx.log('payment', paymentId, 'deleted', { document_id: p.document_id, number: doc.number, amount: p.amount, currency: doc.currency });
      return get(p.document_id);
    });
  }

  return {
    list, get, byToken, activity, create, update, remove, issue, void: voidDoc, duplicate,
    accept: (id) => setEstimateState(id, 'accepted'),
    decline: (id) => setEstimateState(id, 'declined'),
    convert, rotateShare, markSent, addPayment, listPayments, deletePayment, validateLines,
    status: (d) => (d.kind === 'invoice' ? invoiceStatus(d, ctx.today()) : estimateStatus(d, ctx.today())),
  };
}

export function snapshotClient(c) {
  if (!c) return null;
  const { name, company, email, phone, tax_id, address_line1, address_line2, city, region, postal_code, country } = c;
  return { name, company, email, phone, tax_id, address_line1, address_line2, city, region, postal_code, country };
}

// Stored line -> API input shape (major-unit strings), for copying between documents.
export function lineToInput(currency) {
  return (l) => ({
    item_id: l.item_id,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unit_price: fromMinor(l.unit_price, currency),
    discount_percent: l.discount_bps / 100,
    tax_rate_id: l.tax_rate_id,
  });
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

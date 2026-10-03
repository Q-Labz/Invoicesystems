import { Checker, notFound } from '../validate.js';

const FIELDS = [
  'name', 'company', 'email', 'cc_emails', 'phone', 'tax_id', 'address_line1', 'address_line2',
  'city', 'region', 'postal_code', 'country', 'currency', 'payment_terms_days', 'default_tax_rate_id',
  'notes', 'archived',
];

export function clientsService(ctx) {
  const { db } = ctx;

  // Balances are grouped per currency — amounts in different currencies are never summed.
  function list({ q = '', include_archived = false } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (!include_archived) where.push('c.archived = 0');
    if (q) {
      where.push('(c.name LIKE ? OR c.company LIKE ? OR c.email LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id AND d.kind = 'invoice' AND d.state = 'issued') AS open_invoices
         FROM clients c WHERE ${where.join(' AND ')} ORDER BY c.archived, lower(c.name)`,
      )
      .all(...args);
    const balances = outstandingByClient();
    return rows.map((r) => ({ ...r, outstanding: balances.get(r.id) || [] }));
  }

  function outstandingByClient(clientId) {
    const rows = db
      .prepare(
        `SELECT d.client_id, d.currency, SUM(d.total - IFNULL(p.paid, 0)) AS balance
         FROM documents d
         LEFT JOIN (SELECT document_id, SUM(amount) AS paid FROM payments GROUP BY document_id) p ON p.document_id = d.id
         WHERE d.kind = 'invoice' AND d.state = 'issued' ${clientId ? 'AND d.client_id = ?' : ''}
         GROUP BY d.client_id, d.currency HAVING balance <> 0`,
      )
      .all(...(clientId ? [clientId] : []));
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.client_id)) map.set(r.client_id, []);
      map.get(r.client_id).push({ currency: r.currency, amount: r.balance });
    }
    return map;
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!row) throw notFound('Client');
    const totals = db
      .prepare(
        `SELECT d.currency,
           SUM(d.total) AS billed,
           SUM(IFNULL(p.paid, 0)) AS paid,
           SUM(d.total - IFNULL(p.paid, 0)) AS outstanding,
           COUNT(*) AS invoices
         FROM documents d
         LEFT JOIN (SELECT document_id, SUM(amount) AS paid FROM payments GROUP BY document_id) p ON p.document_id = d.id
         WHERE d.kind = 'invoice' AND d.state = 'issued' AND d.client_id = ?
         GROUP BY d.currency`,
      )
      .all(id);
    return { ...row, totals };
  }

  function validate(input, existing) {
    const defaults = ctx.settings.get().defaults;
    const c = new Checker(input);
    c.str('name', { required: !existing, max: 120 })
      .str('company', { max: 120 })
      .email('email')
      .str('cc_emails', { max: 500 })
      .str('phone', { max: 60 })
      .str('tax_id', { max: 60 })
      .str('address_line1', { max: 200 })
      .str('address_line2', { max: 200 })
      .str('city', { max: 100 })
      .str('region', { max: 100 })
      .str('postal_code', { max: 20 })
      .str('country', { max: 100 })
      .currency('currency', { def: existing ? undefined : defaults.currency })
      .int('payment_terms_days', { min: 0, max: 365, def: existing ? undefined : defaults.payment_terms_days })
      .int('default_tax_rate_id', { nullable: true, min: 1 })
      .str('notes', { max: 4000 })
      .bool('archived');
    if (c.out.cc_emails) {
      const bad = c.out.cc_emails.split(/[,;\s]+/).filter((e) => e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (bad.length) c.fail('cc_emails', `Not valid: ${bad.join(', ')}`);
    }
    if (c.out.default_tax_rate_id && !db.prepare('SELECT 1 FROM tax_rates WHERE id = ?').get(c.out.default_tax_rate_id)) {
      c.fail('default_tax_rate_id', 'Unknown tax rate');
    }
    return c.done();
  }

  function create(input) {
    const v = validate(input);
    const cols = FIELDS.filter((f) => v[f] !== undefined);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO clients (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((f) => v[f]));
    ctx.log('client', lastInsertRowid, 'created', { name: v.name });
    return get(lastInsertRowid);
  }

  function update(id, input) {
    const row = get(id);
    const v = validate(input, row);
    const cols = FIELDS.filter((f) => v[f] !== undefined);
    if (cols.length) {
      db.prepare(`UPDATE clients SET ${cols.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...cols.map((f) => v[f]),
        id,
      );
      ctx.log('client', id, 'updated', { fields: cols });
    }
    return get(id);
  }

  // Clients with history are archived, never deleted: their invoices must stay intact.
  function remove(id) {
    get(id);
    const used =
      db.prepare('SELECT 1 FROM documents WHERE client_id = ? LIMIT 1').get(id) ||
      db.prepare('SELECT 1 FROM recurring WHERE client_id = ? LIMIT 1').get(id);
    if (used) {
      db.prepare("UPDATE clients SET archived = 1, updated_at = datetime('now') WHERE id = ?").run(id);
      db.prepare('UPDATE recurring SET active = 0 WHERE client_id = ?').run(id);
      ctx.log('client', id, 'archived');
      return { archived: true };
    }
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    ctx.log('client', id, 'deleted');
    return { deleted: true };
  }

  // Chronological ledger of issued invoices and payments with a running balance per currency.
  function statement(id, { from, to } = {}) {
    const client = get(id);
    // ?1 client, ?2 from, ?3 to — empty strings mean "no bound".
    const args = [id, from || '', to || ''];
    const entries = db
      .prepare(
        `SELECT * FROM (
           SELECT d.issue_date AS date, 'invoice' AS type, d.id AS document_id, d.number AS ref,
                  d.currency, d.total AS charge, 0 AS credit, d.created_at AS seq
           FROM documents d WHERE d.kind = 'invoice' AND d.state = 'issued' AND d.client_id = ?1
           UNION ALL
           SELECT p.date, CASE WHEN p.amount < 0 THEN 'refund' ELSE 'payment' END, d.id,
                  d.number || CASE WHEN p.reference <> '' THEN ' · ' || p.reference ELSE '' END,
                  d.currency, CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END,
                  CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END, p.created_at
           FROM payments p JOIN documents d ON d.id = p.document_id
           WHERE d.client_id = ?1 AND d.state = 'issued'
         ) WHERE (?2 = '' OR date >= ?2) AND (?3 = '' OR date <= ?3)
         ORDER BY date, CASE type WHEN 'invoice' THEN 0 ELSE 1 END, seq`,
      )
      .all(...args);
    const running = {};
    const opening = {};
    if (from) {
      const prior = db
        .prepare(
          `SELECT currency, SUM(amt) AS bal FROM (
             SELECT d.currency, d.total AS amt FROM documents d
             WHERE d.kind = 'invoice' AND d.state = 'issued' AND d.client_id = ? AND d.issue_date < ?
             UNION ALL
             SELECT d.currency, -p.amount FROM payments p JOIN documents d ON d.id = p.document_id
             WHERE d.client_id = ? AND d.state = 'issued' AND p.date < ?
           ) GROUP BY currency`,
        )
        .all(id, from, id, from);
      for (const p of prior) opening[p.currency] = running[p.currency] = p.bal;
    }
    const lines = entries.map((e) => {
      running[e.currency] = (running[e.currency] || 0) + e.charge - e.credit;
      return { ...e, balance: running[e.currency] };
    });
    return { client, from: from || null, to: to || null, opening, closing: running, lines };
  }

  return { list, get, create, update, remove, statement, outstandingByClient };
}

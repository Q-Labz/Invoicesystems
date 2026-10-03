import { Checker, notFound, HttpError } from '../validate.js';
import { addDays, addMonths } from '../../public/js/lib/dates.js';
import { fromMinor, toMinor, percentToBps } from '../../public/js/lib/money.js';
import { lineToInput } from './documents.js';
import { computeDocument } from '../../public/js/lib/calc.js';

// A missed scheduler (server off for a month) catches up, but never floods.
const MAX_CATCH_UP = 24;

export function recurringService(ctx) {
  const { db } = ctx;

  function decode(r) {
    return { ...r, lines: JSON.parse(r.lines) };
  }

  function list({ client_id } = {}) {
    const rows = db
      .prepare(
        `SELECT r.*, c.name AS client_name,
           (SELECT COUNT(*) FROM documents d WHERE d.recurring_id = r.id) AS generated
         FROM recurring r JOIN clients c ON c.id = r.client_id
         ${client_id ? 'WHERE r.client_id = ?' : ''}
         ORDER BY r.active DESC, r.next_run`,
      )
      .all(...(client_id ? [client_id] : []));
    return rows.map(decode).map(withTotal);
  }

  function withTotal(r) {
    const t = computeDocument({ lines: r.lines, discount_type: r.discount_type, discount_value: r.discount_value });
    return { ...r, total: t.total, upcoming: upcoming(r, 3) };
  }

  function get(id) {
    const r = db
      .prepare('SELECT r.*, c.name AS client_name FROM recurring r JOIN clients c ON c.id = r.client_id WHERE r.id = ?')
      .get(id);
    if (!r) throw notFound('Recurring profile');
    return withTotal(decode(r));
  }

  function step(date, r) {
    if (r.interval_unit === 'week') return addDays(date, 7 * r.interval_count);
    const months = r.interval_unit === 'year' ? 12 * r.interval_count : r.interval_count;
    return addMonths(date, months, r.anchor_day);
  }

  function finished(r, date) {
    return (r.end_date && date > r.end_date) || (r.max_runs != null && r.runs_done >= r.max_runs);
  }

  function upcoming(r, n) {
    const out = [];
    let d = r.next_run;
    let done = r.runs_done;
    while (out.length < n && r.active) {
      if ((r.end_date && d > r.end_date) || (r.max_runs != null && done >= r.max_runs)) break;
      out.push(d);
      d = step(d, r);
      done++;
    }
    return out;
  }

  function validate(input, existing) {
    const c = new Checker(input)
      .str('name', { required: !existing, max: 120 })
      .int('client_id', { required: !existing, min: 1 })
      .currency('currency')
      .oneOf('interval_unit', ['week', 'month', 'year'], { required: !existing })
      .int('interval_count', { min: 1, max: 36, def: existing ? undefined : 1 })
      .date('start_date', { required: !existing })
      .date('end_date', { nullable: true })
      .int('max_runs', { min: 1, max: 1000, nullable: true })
      .bool('auto_issue')
      .bool('active')
      .int('payment_terms_days', { min: 0, max: 365 })
      .str('title', { max: 200 })
      .str('notes', { max: 4000 })
      .str('terms', { max: 8000 })
      .oneOf('discount_type', ['none', 'percent', 'fixed']);
    const clientId = c.out.client_id ?? existing?.client_id;
    const client = clientId ? db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) : null;
    if (clientId && !client) c.fail('client_id', 'Unknown client');
    const currency = c.out.currency || existing?.currency || client?.currency;
    const dtype = c.out.discount_type || existing?.discount_type || 'none';
    if (input.discount_value !== undefined && input.discount_value !== '' && input.discount_value !== null) {
      const dv = dtype === 'percent' ? percentToBps(input.discount_value) : toMinor(input.discount_value, currency);
      if (dv === null || dv < 0 || (dtype === 'percent' && dv > 10000)) c.fail('discount_value', 'Not a valid discount');
      else c.out.discount_value = dtype === 'none' ? 0 : dv;
    }
    const start = c.out.start_date || existing?.start_date;
    const end = c.out.end_date !== undefined ? c.out.end_date : existing?.end_date;
    if (start && end && end < start) c.fail('end_date', 'Cannot be before the start date');
    const v = c.done();
    let lines;
    if (input.lines !== undefined) {
      lines = ctx.documents.validateLines(input.lines, currency);
      if (!lines.length) throw new HttpError(422, 'Check the highlighted fields', { lines: 'Add at least one line' });
    }
    return { v, client, currency, dtype, lines };
  }

  function create(input) {
    const { v, client, currency, dtype, lines } = validate(input);
    if (!lines) throw new HttpError(422, 'Check the highlighted fields', { lines: 'Add at least one line' });
    const { lastInsertRowid: id } = db
      .prepare(
        `INSERT INTO recurring (name, client_id, currency, interval_unit, interval_count, start_date, next_run, anchor_day,
          end_date, max_runs, auto_issue, payment_terms_days, title, notes, terms, discount_type, discount_value, lines, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        v.name, v.client_id, currency, v.interval_unit, v.interval_count, v.start_date, v.start_date,
        +v.start_date.slice(8), v.end_date ?? null, v.max_runs ?? null, v.auto_issue ?? 0,
        v.payment_terms_days ?? client.payment_terms_days, v.title ?? '', v.notes ?? ctx.settings.get().defaults.notes,
        v.terms ?? ctx.settings.get().defaults.terms, dtype, dtype === 'none' ? 0 : v.discount_value ?? 0,
        JSON.stringify(lines), v.active ?? 1,
      );
    ctx.log('recurring', id, 'created', { name: v.name });
    return get(id);
  }

  function update(id, input) {
    const existing = get(id);
    const { v, currency, dtype, lines } = validate(input, existing);
    const m = { ...existing, ...v, currency, discount_type: dtype };
    if (dtype === 'none') m.discount_value = 0;
    // Moving the start date of a profile that has not run yet moves the schedule with it.
    if (v.start_date && existing.runs_done === 0) {
      m.next_run = v.start_date;
      m.anchor_day = +v.start_date.slice(8);
    }
    if (v.active === 1 && !existing.active && m.next_run < ctx.today()) {
      // Reactivating skips the dormant periods instead of back-billing them.
      while (m.next_run < ctx.today()) m.next_run = step(m.next_run, m);
    }
    db.prepare(
      `UPDATE recurring SET name = ?, client_id = ?, currency = ?, interval_unit = ?, interval_count = ?, start_date = ?,
       next_run = ?, anchor_day = ?, end_date = ?, max_runs = ?, auto_issue = ?, payment_terms_days = ?, title = ?,
       notes = ?, terms = ?, discount_type = ?, discount_value = ?, lines = ?, active = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      m.name, m.client_id, m.currency, m.interval_unit, m.interval_count, m.start_date, m.next_run, m.anchor_day,
      m.end_date ?? null, m.max_runs ?? null, m.auto_issue, m.payment_terms_days, m.title, m.notes, m.terms,
      m.discount_type, m.discount_value, JSON.stringify(lines || existing.lines), m.active, id,
    );
    ctx.log('recurring', id, 'updated', { fields: Object.keys(v) });
    return get(id);
  }

  function remove(id) {
    get(id);
    const used = db.prepare('SELECT 1 FROM documents WHERE recurring_id = ? LIMIT 1').get(id);
    if (used) {
      db.prepare("UPDATE recurring SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
      ctx.log('recurring', id, 'deactivated');
      return { deactivated: true };
    }
    db.prepare('DELETE FROM recurring WHERE id = ?').run(id);
    ctx.log('recurring', id, 'deleted');
    return { deleted: true };
  }

  // Generates the invoice for the profile's next_run date and advances the schedule.
  function generate(r) {
    const doc = ctx.documents.create(
      {
        kind: 'invoice',
        client_id: r.client_id,
        currency: r.currency,
        issue_date: r.next_run,
        due_date: addDays(r.next_run, r.payment_terms_days),
        title: r.title,
        notes: r.notes,
        terms: r.terms,
        discount_type: r.discount_type,
        discount_value: r.discount_type === 'percent' ? r.discount_value / 100 : fromMinor(r.discount_value, r.currency),
        lines: r.lines.map(lineToInput(r.currency)),
      },
      { recurringId: r.id, quiet: true },
    );
    ctx.log('document', doc.id, 'created', { kind: 'invoice', recurring: r.name, period: r.next_run });
    const issued = r.auto_issue ? ctx.documents.issue(doc.id) : doc;
    const next = step(r.next_run, r);
    const runs = r.runs_done + 1;
    const active = finished({ ...r, runs_done: runs }, next) ? 0 : 1;
    db.prepare(
      `UPDATE recurring SET next_run = ?, runs_done = ?, active = ?, last_run_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(next, runs, active, r.id);
    return { ...r, next_run: next, runs_done: runs, active, document: issued };
  }

  function runDue() {
    const today = ctx.today();
    const due = db.prepare('SELECT * FROM recurring WHERE active = 1 AND next_run <= ?').all(today).map(decode);
    const created = [];
    for (let r of due) {
      for (let i = 0; i < MAX_CATCH_UP && r.active && r.next_run <= today; i++) {
        if (finished(r, r.next_run)) {
          db.prepare('UPDATE recurring SET active = 0 WHERE id = ?').run(r.id);
          break;
        }
        const client = db.prepare('SELECT archived FROM clients WHERE id = ?').get(r.client_id);
        if (client.archived) {
          db.prepare('UPDATE recurring SET active = 0 WHERE id = ?').run(r.id);
          ctx.log('recurring', r.id, 'deactivated', { reason: 'client archived' });
          break;
        }
        r = ctx.tx(() => generate(r));
        created.push({ recurring_id: r.id, document_id: r.document.id, number: r.document.number, issue_date: r.document.issue_date });
      }
    }
    if (created.length) ctx.log('recurring', 0, 'run', { created: created.length });
    return { created };
  }

  function runNow(id) {
    const r = get(id);
    if (!r.active) throw new HttpError(409, 'Profile is paused or finished');
    const out = ctx.tx(() => generate(r));
    return ctx.documents.get(out.document.id);
  }

  return { list, get, create, update, remove, runDue, runNow };
}

import { Checker, notFound } from '../validate.js';
import { fromMinor } from '../../public/js/lib/money.js';

export function taxRatesService(ctx) {
  const { db } = ctx;

  function list({ include_archived = false } = {}) {
    const where = include_archived ? '' : 'WHERE archived = 0';
    return db.prepare(`SELECT * FROM tax_rates ${where} ORDER BY archived, rate_ppm, name`).all();
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM tax_rates WHERE id = ?').get(id);
    if (!row) throw notFound('Tax rate');
    return row;
  }

  function create(input) {
    const v = new Checker(input).str('name', { required: true, max: 60 }).percent('rate', { required: true, ppm: true }).done();
    const { lastInsertRowid } = db.prepare('INSERT INTO tax_rates (name, rate_ppm) VALUES (?, ?)').run(v.name, v.rate);
    ctx.log('tax_rate', lastInsertRowid, 'created', v);
    return get(lastInsertRowid);
  }

  // Renaming is safe: issued documents carry a snapshot of name and rate.
  function update(id, input) {
    const row = get(id);
    const v = new Checker(input).str('name', { max: 60 }).percent('rate', { ppm: true }).bool('archived').done();
    db.prepare('UPDATE tax_rates SET name = ?, rate_ppm = ?, archived = ? WHERE id = ?').run(
      v.name || row.name,
      v.rate ?? row.rate_ppm,
      v.archived ?? row.archived,
      id,
    );
    ctx.log('tax_rate', id, 'updated', v);
    return get(id);
  }

  function archive(id) {
    get(id);
    db.prepare('UPDATE tax_rates SET archived = 1 WHERE id = ?').run(id);
    ctx.log('tax_rate', id, 'archived');
    return { ok: true };
  }

  return { list, get, create, update, archive };
}

export function itemsService(ctx) {
  const { db } = ctx;

  function list({ q = '', include_archived = false } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (!include_archived) where.push('i.archived = 0');
    if (q) {
      where.push('(i.name LIKE ? OR i.description LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    return db
      .prepare(
        `SELECT i.*, t.name AS tax_name, t.rate_ppm AS tax_rate_ppm
         FROM items i LEFT JOIN tax_rates t ON t.id = i.tax_rate_id
         WHERE ${where.join(' AND ')} ORDER BY i.archived, i.name`,
      )
      .all(...args);
  }

  function get(id) {
    const row = db
      .prepare(
        `SELECT i.*, t.name AS tax_name, t.rate_ppm AS tax_rate_ppm
         FROM items i LEFT JOIN tax_rates t ON t.id = i.tax_rate_id WHERE i.id = ?`,
      )
      .get(id);
    if (!row) throw notFound('Item');
    return row;
  }

  function validate(input, existing) {
    const c = new Checker(input);
    c.str('name', { required: !existing, max: 120 })
      .str('description', { max: 2000 })
      .str('unit', { max: 20 })
      .currency('currency', { required: !existing })
      .int('tax_rate_id', { nullable: true, min: 1 })
      .bool('archived');
    const currency = c.out.currency || existing?.currency || ctx.settings.get().defaults.currency;
    c.money('unit_price', currency, { required: !existing });
    if (c.out.tax_rate_id) {
      const rate = db.prepare('SELECT id FROM tax_rates WHERE id = ?').get(c.out.tax_rate_id);
      if (!rate) c.fail('tax_rate_id', 'Unknown tax rate');
    }
    // A currency change on an existing item re-reads the price in the new currency's minor units.
    if (existing && c.out.currency && c.out.currency !== existing.currency && c.out.unit_price === undefined) {
      c.input.unit_price = fromMinor(existing.unit_price, existing.currency);
      c.money('unit_price', c.out.currency);
    }
    return c.done();
  }

  function create(input) {
    const v = validate(input);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO items (name, description, unit, unit_price, currency, tax_rate_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(v.name, v.description ?? '', v.unit ?? '', v.unit_price, v.currency, v.tax_rate_id ?? null);
    ctx.log('item', lastInsertRowid, 'created', { name: v.name });
    return get(lastInsertRowid);
  }

  function update(id, input) {
    const row = get(id);
    const v = validate(input, row);
    const merged = { ...row, ...v };
    db.prepare(
      `UPDATE items SET name = ?, description = ?, unit = ?, unit_price = ?, currency = ?,
       tax_rate_id = ?, archived = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(
      merged.name,
      merged.description,
      merged.unit,
      merged.unit_price,
      merged.currency,
      merged.tax_rate_id ?? null,
      merged.archived,
      id,
    );
    ctx.log('item', id, 'updated', { fields: Object.keys(v) });
    return get(id);
  }

  function remove(id) {
    get(id);
    const used = db.prepare('SELECT 1 FROM document_lines WHERE item_id = ? LIMIT 1').get(id);
    if (used) {
      db.prepare('UPDATE items SET archived = 1 WHERE id = ?').run(id);
      ctx.log('item', id, 'archived');
      return { archived: true };
    }
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    ctx.log('item', id, 'deleted');
    return { deleted: true };
  }

  return { list, get, create, update, remove };
}

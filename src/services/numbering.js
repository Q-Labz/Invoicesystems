import { HttpError } from '../validate.js';

// Gapless, sequential numbers assigned at issue time — drafts never consume one,
// so a deleted draft cannot leave a hole in the ledger.
export function numberingService(ctx) {
  const { db } = ctx;

  function sequenceName(kind, date) {
    const { numbering } = ctx.settings.get();
    return numbering.yearly ? `${kind}:${date.slice(0, 4)}` : kind;
  }

  function format(kind, date, seq) {
    const { numbering } = ctx.settings.get();
    const prefix = kind === 'invoice' ? numbering.invoice_prefix : numbering.estimate_prefix;
    const n = String(seq).padStart(numbering.padding, '0');
    return numbering.yearly ? `${prefix}${date.slice(0, 4)}-${n}` : `${prefix}${n}`;
  }

  function current(name) {
    return db.prepare('SELECT value FROM sequences WHERE name = ?').get(name)?.value ?? 0;
  }

  // Must run inside the caller's transaction.
  function next(kind, date) {
    const name = sequenceName(kind, date);
    let seq = current(name) + 1;
    // Skip any number already taken (e.g. after a prefix or padding change).
    while (db.prepare('SELECT 1 FROM documents WHERE number = ?').get(format(kind, date, seq))) seq++;
    db.prepare(
      'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
    ).run(name, seq);
    return format(kind, date, seq);
  }

  function preview(kind) {
    const date = ctx.today();
    return { kind, next: format(kind, date, current(sequenceName(kind, date)) + 1), next_sequence: current(sequenceName(kind, date)) + 1 };
  }

  // For moving over from another system: start numbering at N. Never backwards.
  function setNext(kind, value) {
    if (!['invoice', 'estimate'].includes(kind)) throw new HttpError(404, 'Unknown sequence');
    if (!Number.isInteger(value) || value < 1 || value > 99999999) {
      throw new HttpError(422, 'Check the highlighted fields', { next_sequence: 'Must be a whole number from 1' });
    }
    const name = sequenceName(kind, ctx.today());
    if (value <= current(name)) {
      throw new HttpError(409, `Numbers up to ${current(name)} are already used. Pick a higher start.`);
    }
    db.prepare(
      'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
    ).run(name, value - 1);
    ctx.log('settings', 0, 'sequence_set', { kind, next: value });
    return preview(kind);
  }

  return { next, preview, setNext };
}

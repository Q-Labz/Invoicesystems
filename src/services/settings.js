import { Checker, HttpError } from '../validate.js';

export const DEFAULT_SETTINGS = {
  business: {
    name: '7LABZ',
    email: '',
    phone: '',
    website: '',
    address: '',
    tax_id: '',
    payment_instructions: '',
  },
  numbering: {
    invoice_prefix: '7LZ-',
    estimate_prefix: 'EST-',
    padding: 4,
    yearly: true,
  },
  defaults: {
    currency: 'USD',
    payment_terms_days: 30,
    estimate_valid_days: 30,
    notes: 'Thank you for the work.',
    terms: '',
  },
  locale: 'en-US',
};

export function settingsService(ctx) {
  const { db } = ctx;

  function get() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    return {
      business: { ...DEFAULT_SETTINGS.business, ...stored.business },
      numbering: { ...DEFAULT_SETTINGS.numbering, ...stored.numbering },
      defaults: { ...DEFAULT_SETTINGS.defaults, ...stored.defaults },
      locale: stored.locale ?? DEFAULT_SETTINGS.locale,
    };
  }

  function update(input = {}) {
    const current = get();
    const errors = {};
    const next = { ...current };

    if (input.business !== undefined) {
      const c = new Checker(input.business);
      c.str('name', { required: true, max: 120 })
        .email('email')
        .str('phone', { max: 60 })
        .str('website', { max: 200 })
        .str('address', { max: 600 })
        .str('tax_id', { max: 60 })
        .str('payment_instructions', { max: 2000 });
      Object.entries(c.errors).forEach(([k, v]) => (errors[`business.${k}`] = v));
      next.business = { ...current.business, ...c.out };
    }
    if (input.numbering !== undefined) {
      const c = new Checker(input.numbering);
      c.str('invoice_prefix', { max: 16 })
        .str('estimate_prefix', { max: 16 })
        .int('padding', { min: 1, max: 8 })
        .bool('yearly');
      for (const k of ['invoice_prefix', 'estimate_prefix']) {
        if (c.out[k] !== undefined && !/^[A-Za-z0-9._/-]*$/.test(c.out[k])) c.fail(k, 'Letters, digits and . _ / - only');
      }
      if (c.out.yearly !== undefined) c.out.yearly = !!c.out.yearly;
      Object.entries(c.errors).forEach(([k, v]) => (errors[`numbering.${k}`] = v));
      next.numbering = { ...current.numbering, ...c.out };
    }
    if (input.defaults !== undefined) {
      const c = new Checker(input.defaults);
      c.currency('currency')
        .int('payment_terms_days', { min: 0, max: 365 })
        .int('estimate_valid_days', { min: 1, max: 365 })
        .str('notes', { max: 2000 })
        .str('terms', { max: 4000 });
      Object.entries(c.errors).forEach(([k, v]) => (errors[`defaults.${k}`] = v));
      next.defaults = { ...current.defaults, ...c.out };
    }
    if (input.locale !== undefined) {
      try {
        next.locale = Intl.getCanonicalLocales(input.locale)[0];
      } catch {
        errors.locale = 'Unknown locale';
      }
    }
    if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields', errors);

    const put = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const key of ['business', 'numbering', 'defaults', 'locale']) put.run(key, JSON.stringify(next[key]));
    ctx.log('settings', 0, 'updated', { sections: Object.keys(input) });
    return get();
  }

  return { get, update };
}

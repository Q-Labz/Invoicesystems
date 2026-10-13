import { Checker, HttpError } from '../validate.js';
import { PATTERNS, isIban, normalizeIban } from '../../public/js/lib/pay-links.js';

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
  // Direct payment options shown to clients. Each one sends money straight to the business.
  payments: {
    zelle: '',
    zelle_name: '',
    cash_app: '',
    venmo: '',
    paypal: '',
    sepa_name: '',
    sepa_iban: '',
    sepa_bic: '',
    upi_vpa: '',
    upi_name: '',
    crypto: [],
    client_reports: true,
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
      payments: { ...DEFAULT_SETTINGS.payments, ...stored.payments },
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
    if (input.payments !== undefined) {
      const c = new Checker(input.payments);
      c.str('zelle', { max: 120 }).str('zelle_name', { max: 80 })
        .str('cash_app', { max: 21 }).str('venmo', { max: 31 }).str('paypal', { max: 20 })
        .str('sepa_name', { max: 70 }).str('sepa_iban', { max: 42 }).str('sepa_bic', { max: 11 })
        .str('upi_vpa', { max: 256 }).str('upi_name', { max: 80 })
        .bool('client_reports');
      const o = c.out;
      const check = (k, re, msg) => { if (o[k] && !re.test(o[k])) c.fail(k, msg); };
      check('zelle', PATTERNS.zelle, 'Use the email or US phone number enrolled in Zelle');
      check('cash_app', PATTERNS.cashtag, 'A $Cashtag: letters, digits, underscores');
      check('venmo', PATTERNS.venmo, 'A Venmo username, 5–30 characters');
      check('paypal', PATTERNS.paypal, 'The name after paypal.me/');
      check('upi_vpa', PATTERNS.upi, 'A UPI ID like name@bank');
      if (o.sepa_iban) {
        o.sepa_iban = normalizeIban(o.sepa_iban);
        if (!isIban(o.sepa_iban)) c.fail('sepa_iban', 'This IBAN fails its checksum. Check for a typo.');
      }
      if (o.sepa_bic) {
        o.sepa_bic = o.sepa_bic.toUpperCase();
        check('sepa_bic', PATTERNS.bic, '8 or 11 characters');
      }
      if (o.sepa_iban && !(o.sepa_name ?? current.payments.sepa_name)) c.fail('sepa_name', 'The account holder name is required for SEPA');
      if (o.cash_app) o.cash_app = o.cash_app.replace(/^\$/, '');
      if (o.venmo) o.venmo = o.venmo.replace(/^@/, '');
      if (o.client_reports !== undefined) o.client_reports = !!o.client_reports;
      if (input.payments.crypto !== undefined) {
        const list = Array.isArray(input.payments.crypto) ? input.payments.crypto : [];
        if (list.length > 4) c.fail('crypto', 'Up to four wallets');
        o.crypto = list
          .map((w, i) => {
            const label = String(w?.label ?? '').trim().slice(0, 40);
            const address = String(w?.address ?? '').trim();
            if (!address && !label) return null;
            if (!PATTERNS.crypto.test(address)) c.fail(`crypto.${i}.address`, 'Not a wallet address');
            if (!label) c.fail(`crypto.${i}.label`, 'Name the coin and network, e.g. USDC on Ethereum');
            return { label, address };
          })
          .filter(Boolean)
          .slice(0, 4);
      }
      Object.entries(c.errors).forEach(([k, v]) => (errors[`payments.${k}`] = v));
      next.payments = { ...current.payments, ...o };
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
    for (const key of ['business', 'numbering', 'defaults', 'payments', 'locale']) put.run(key, JSON.stringify(next[key]));
    ctx.log('settings', 0, 'updated', { sections: Object.keys(input) });
    return get();
  }

  return { get, update };
}

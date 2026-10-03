import { isDate } from '../public/js/lib/dates.js';
import { isCurrency, toMinor, percentToBps, percentToPpm } from '../public/js/lib/money.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what) => new HttpError(404, `${what} not found`);
export const conflict = (msg) => new HttpError(409, msg);

// Collects field errors so a form gets every problem at once, not one per round trip.
export class Checker {
  constructor(input) {
    this.input = input && typeof input === 'object' ? input : {};
    this.errors = {};
    this.out = {};
  }

  has(key) {
    return this.input[key] !== undefined;
  }

  fail(key, msg) {
    this.errors[key] = msg;
    return this;
  }

  str(key, { required = false, max = 500, trim = true, def } = {}) {
    let v = this.input[key];
    if (v === undefined || v === null) {
      if (required) return this.fail(key, 'Required');
      if (def !== undefined) this.out[key] = def;
      return this;
    }
    if (typeof v !== 'string') return this.fail(key, 'Must be text');
    if (trim) v = v.trim();
    if (required && !v) return this.fail(key, 'Required');
    if (v.length > max) return this.fail(key, `At most ${max} characters`);
    this.out[key] = v;
    return this;
  }

  email(key, opts = {}) {
    this.str(key, { max: 254, ...opts });
    const v = this.out[key];
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) this.fail(key, 'Not a valid email');
    return this;
  }

  int(key, { required = false, min = -Infinity, max = Infinity, def, nullable = false } = {}) {
    const v = this.input[key];
    if (v === undefined || v === '' || (v === null && !nullable)) {
      if (required) return this.fail(key, 'Required');
      if (def !== undefined) this.out[key] = def;
      return this;
    }
    if (v === null) {
      this.out[key] = null;
      return this;
    }
    const n = typeof v === 'string' ? Number(v) : v;
    if (!Number.isInteger(n)) return this.fail(key, 'Must be a whole number');
    if (n < min || n > max) return this.fail(key, `Must be between ${min} and ${max}`);
    this.out[key] = n;
    return this;
  }

  bool(key, { def } = {}) {
    const v = this.input[key];
    if (v === undefined) {
      if (def !== undefined) this.out[key] = def;
      return this;
    }
    this.out[key] = v === true || v === 1 || v === 'true' || v === '1' ? 1 : 0;
    return this;
  }

  date(key, { required = false, nullable = false, def } = {}) {
    const v = this.input[key];
    if (v === undefined || v === '' || v === null) {
      if (required) return this.fail(key, 'Required');
      if (nullable && v !== undefined) this.out[key] = null;
      else if (def !== undefined) this.out[key] = def;
      return this;
    }
    if (!isDate(v)) return this.fail(key, 'Use YYYY-MM-DD');
    this.out[key] = v;
    return this;
  }

  oneOf(key, values, { required = false, def } = {}) {
    const v = this.input[key];
    if (v === undefined || v === null || v === '') {
      if (required) return this.fail(key, 'Required');
      if (def !== undefined) this.out[key] = def;
      return this;
    }
    if (!values.includes(v)) return this.fail(key, `Must be one of: ${values.join(', ')}`);
    this.out[key] = v;
    return this;
  }

  currency(key, opts = {}) {
    this.str(key, { max: 3, ...opts });
    const v = this.out[key];
    if (v !== undefined) {
      const up = v.toUpperCase();
      if (!isCurrency(up)) return this.fail(key, 'Unknown currency code');
      this.out[key] = up;
    }
    return this;
  }

  // Money arrives as a decimal string in major units ("1250.00") and leaves as minor units.
  money(key, currency, { required = false, min = -Infinity, def } = {}) {
    const v = this.input[key];
    if (v === undefined || v === null || v === '') {
      if (required) return this.fail(key, 'Required');
      if (def !== undefined) this.out[key] = def;
      return this;
    }
    const minor = toMinor(v, currency);
    if (minor === null) return this.fail(key, `Not a valid ${currency} amount`);
    if (minor < min) return this.fail(key, min === 1 ? 'Must be more than zero' : 'Too small');
    if (Math.abs(minor) > 1e13) return this.fail(key, 'Too large');
    this.out[key] = minor;
    return this;
  }

  // Percent in, basis points out (scale 2) — or parts per million with { ppm: true } (scale 4).
  percent(key, { min = 0, max = 100, def, required = false, ppm = false } = {}) {
    const v = this.input[key];
    if (v === undefined || v === null || v === '') {
      if (required) return this.fail(key, 'Required');
      if (def !== undefined) this.out[key] = def;
      return this;
    }
    const unit = ppm ? 10000 : 100;
    const n = ppm ? percentToPpm(v) : percentToBps(v);
    if (n === null) return this.fail(key, ppm ? 'Up to four decimals' : 'Up to two decimals');
    if (n < min * unit || n > max * unit) return this.fail(key, `Must be ${min}–${max}%`);
    this.out[key] = n;
    return this;
  }

  done() {
    if (Object.keys(this.errors).length) throw new HttpError(422, 'Check the highlighted fields', this.errors);
    return this.out;
  }
}

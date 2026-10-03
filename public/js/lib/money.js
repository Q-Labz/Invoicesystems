// Money is stored and computed as integer minor units (cents, pence, yen).
// Floats never touch a stored amount. Shared by server and browser.

const digitCache = new Map();

let known = null;

// Real ISO 4217 codes only. Intl.NumberFormat alone accepts any three letters.
export function isCurrency(code) {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  if (!known && typeof Intl.supportedValuesOf === 'function') known = new Set(Intl.supportedValuesOf('currency'));
  if (known) return known.has(code) && code !== 'XXX';
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

export function minorDigits(currency) {
  if (!digitCache.has(currency)) {
    const nf = new Intl.NumberFormat('en', { style: 'currency', currency });
    digitCache.set(currency, nf.resolvedOptions().maximumFractionDigits);
  }
  return digitCache.get(currency);
}

// round(a * b / d), half away from zero. BigInt inside so large products never lose precision.
export function mulDiv(a, b, d) {
  if (d === 0) throw new RangeError('division by zero');
  let n = BigInt(a) * BigInt(b);
  let den = BigInt(d);
  if (den < 0n) { n = -n; den = -den; }
  const neg = n < 0n;
  if (neg) n = -n;
  let q = n / den;
  if ((n % den) * 2n >= den) q += 1n;
  const out = Number(neg ? -q : q);
  return out === 0 ? 0 : out;
}

export function divRound(numerator, denominator) {
  return mulDiv(numerator, 1, denominator);
}

// Parse a decimal string ("1234.5", "-0.07", 12) into an integer scaled by 10^scale.
// Rejects anything with more precision than the scale allows.
export function parseScaled(value, scale) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    value = value.toFixed(Math.min(scale + 2, 20)).replace(/\.?0+$/, '');
  }
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/,/g, '');
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return null;
  const frac = (m[3] || '').replace(/0+$/, '');
  if (frac.length > scale) return null;
  const int = Number((m[2] || '0') + frac.padEnd(scale, '0'));
  if (!Number.isSafeInteger(int)) return null;
  return m[1] && int !== 0 ? -int : int;
}

export function toMinor(value, currency) {
  return parseScaled(value, minorDigits(currency));
}

// Integer minor units -> plain decimal string, e.g. 123456 USD -> "1234.56".
export function fromMinor(minor, currency) {
  const digits = minorDigits(currency);
  const neg = minor < 0;
  const abs = String(Math.abs(minor)).padStart(digits + 1, '0');
  const out = digits ? `${abs.slice(0, -digits)}.${abs.slice(-digits)}` : abs;
  return neg ? `-${out}` : out;
}

export function formatMoney(minor, currency, locale = 'en-US') {
  const digits = minorDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

// Basis points (1/100 of a percent) <-> percent string. 825 bps = "8.25".
export function bpsToPercent(bps) {
  return fromScaled(bps, 2);
}

export function percentToBps(value) {
  return parseScaled(value, 2);
}

// Tax rates need finer grain (NY: 8.875%): stored as parts per million. 8.875% = 88750.
export function ppmToPercent(ppm) {
  return fromScaled(ppm, 4);
}

export function percentToPpm(value) {
  return parseScaled(value, 4);
}

function fromScaled(n, scale) {
  const neg = n < 0;
  const abs = String(Math.abs(n)).padStart(scale + 1, '0');
  let out = `${abs.slice(0, -scale)}.${abs.slice(-scale)}`.replace(/\.?0+$/, '');
  return neg ? `-${out}` : out;
}

// Split `total` across `weights` proportionally so the parts sum exactly to `total`
// (largest-remainder method). Zero or negative weights receive nothing.
export function allocate(total, weights) {
  const w = weights.map((x) => BigInt(x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n || total === 0) return weights.map(() => 0);
  const sign = Math.sign(total);
  const abs = BigInt(Math.abs(total));
  const parts = w.map((x) => (abs * x) / sum);
  let left = Number(abs - parts.reduce((a, b) => a + b, 0n));
  const order = w
    .map((x, i) => ({ i, rem: (abs * x) % sum }))
    .filter((o) => w[o.i] > 0n)
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i] += 1n;
  return parts.map((p) => (p === 0n ? 0 : Number(p) * sign));
}

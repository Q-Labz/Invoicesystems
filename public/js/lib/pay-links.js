// Direct payment options: links and QR payloads that send money straight to the
// business's own account. No processor sits in the middle, so nothing here can
// confirm that money arrived; the client reports it and the owner confirms it.
import { fromMinor } from './money.js';

// Which methods can carry which currency.
const USD_ONLY = ['USD'];
const PAYPAL_CURRENCIES = ['AUD', 'BRL', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD', 'THB', 'TWD', 'USD'];

export const METHOD_INFO = {
  bank_transfer: { label: 'Bank transfer', speed: 'Same day on instant rails (FedNow, RTP, Faster Payments, SEPA Instant)' },
  zelle: { label: 'Zelle', speed: 'Usually within minutes' },
  cash_app: { label: 'Cash App', speed: 'Instant' },
  venmo: { label: 'Venmo', speed: 'Instant' },
  paypal: { label: 'PayPal', speed: 'Instant to PayPal balance' },
  sepa: { label: 'SEPA transfer', speed: 'Seconds with SEPA Instant' },
  upi: { label: 'UPI', speed: 'Instant' },
  crypto: { label: 'Crypto', speed: 'Minutes, depending on the network' },
};

// ---------- validation helpers (used by settings) ----------

export const PATTERNS = {
  cashtag: /^\$?[A-Za-z][A-Za-z0-9_]{0,19}$/,
  venmo: /^@?[A-Za-z0-9_-]{5,30}$/,
  paypal: /^[A-Za-z0-9]{1,20}$/,
  zelle: /^([^\s@]+@[^\s@]+\.[^\s@]+|\+?[0-9 ()-]{7,20})$/,
  upi: /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/,
  bic: /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
  crypto: /^[A-Za-z0-9:]{20,128}$/,
};

export function normalizeIban(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase();
}

// ISO 13616 mod-97 check, so a typo in the IBAN is caught before a client pays into it.
export function isIban(s) {
  const iban = normalizeIban(s);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function formatIban(s) {
  return normalizeIban(s).replace(/(.{4})/g, '$1 ').trim();
}

// ---------- payment options for one invoice ----------

/**
 * @param cfg  settings.payments
 * @param doc  { number, currency, balance (minor units), share }
 * Returns the options that fit this invoice's currency, each with:
 *   method, label, speed, fields [{label, value, copy}], href?, qr?
 */
export function paymentOptions(cfg, { number, currency, balance }) {
  if (!cfg || !(balance > 0)) return [];
  const amount = fromMinor(balance, currency);
  const memo = `Invoice ${number}`;
  const out = [];
  const add = (method, extra) => out.push({ method, label: METHOD_INFO[method].label, speed: METHOD_INFO[method].speed, ...extra });
  const amountField = { label: 'Amount', value: `${amount} ${currency}`, copy: amount };
  const memoField = { label: 'Reference', value: memo, copy: memo };

  if (cfg.cash_app && USD_ONLY.includes(currency)) {
    const tag = cfg.cash_app.replace(/^\$/, '');
    const href = `https://cash.app/$${encodeURIComponent(tag)}/${amount}`;
    add('cash_app', { href, qr: href, fields: [{ label: 'Cashtag', value: `$${tag}`, copy: `$${tag}` }, amountField, memoField] });
  }
  if (cfg.venmo && USD_ONLY.includes(currency)) {
    const user = cfg.venmo.replace(/^@/, '');
    const href = `https://venmo.com/${encodeURIComponent(user)}?txn=pay&amount=${amount}&note=${encodeURIComponent(memo)}`;
    add('venmo', { href, qr: href, fields: [{ label: 'Venmo', value: `@${user}`, copy: `@${user}` }, amountField, memoField] });
  }
  if (cfg.zelle && USD_ONLY.includes(currency)) {
    add('zelle', {
      fields: [{ label: `Send to${cfg.zelle_name ? ` (${cfg.zelle_name})` : ''}`, value: cfg.zelle, copy: cfg.zelle }, amountField, { ...memoField, label: 'Memo' }],
      note: 'Open your bank app, choose Zelle, and send to the address above.',
    });
  }
  if (cfg.paypal && PAYPAL_CURRENCIES.includes(currency)) {
    const href = `https://paypal.me/${encodeURIComponent(cfg.paypal)}/${amount}${currency}`;
    add('paypal', { href, qr: href, fields: [{ label: 'PayPal.me', value: `paypal.me/${cfg.paypal}`, copy: `https://paypal.me/${cfg.paypal}` }, amountField, memoField] });
  }
  if (cfg.sepa_iban && currency === 'EUR' && balance <= 99999999999) {
    const iban = normalizeIban(cfg.sepa_iban);
    // EPC069-12 "GiroCode": most European banking apps scan it into a filled transfer.
    const qr = ['BCD', '002', '1', 'SCT', cfg.sepa_bic || '', (cfg.sepa_name || '').slice(0, 70), iban, `EUR${amount}`, '', '', memo.slice(0, 140), ''].join('\n');
    add('sepa', {
      qr,
      fields: [
        { label: 'Account holder', value: cfg.sepa_name, copy: cfg.sepa_name },
        { label: 'IBAN', value: formatIban(iban), copy: iban },
        ...(cfg.sepa_bic ? [{ label: 'BIC', value: cfg.sepa_bic, copy: cfg.sepa_bic }] : []),
        amountField,
        memoField,
      ],
      note: 'Scan with your banking app, or enter the details by hand.',
    });
  }
  if (cfg.upi_vpa && currency === 'INR') {
    const href = `upi://pay?pa=${encodeURIComponent(cfg.upi_vpa)}&pn=${encodeURIComponent(cfg.upi_name || '')}&am=${amount}&cu=INR&tn=${encodeURIComponent(memo)}`;
    add('upi', { href, qr: href, fields: [{ label: 'UPI ID', value: cfg.upi_vpa, copy: cfg.upi_vpa }, amountField, memoField] });
  }
  for (const w of cfg.crypto || []) {
    if (!w?.address) continue;
    add('crypto', {
      label: w.label || 'Crypto',
      qr: w.address,
      fields: [{ label: 'Address', value: w.address, copy: w.address }, { label: 'Value', value: `${amount} ${currency}`, copy: amount }, memoField],
      note: `Send the ${currency} value on the network named above. Payments on any other network are lost.`,
    });
  }
  if (cfg.bank_details) {
    add('bank_transfer', {
      fields: [{ label: 'Details', value: cfg.bank_details, copy: cfg.bank_details }, amountField, memoField],
      note: 'Quote the reference so the payment matches this invoice.',
    });
  }
  return out;
}

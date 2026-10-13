// QuickBooks Online: card and bank payments through QuickBooks Payments.
//
// Issued invoices are copied to QBO with online card/ACH payment switched on, and the client's
// invoice link offers QBO's pay page. Payments made there are pulled back (webhook when one is
// configured, otherwise a poll every few minutes) and recorded here automatically. Payments
// recorded here are pushed to QBO so both ledgers carry the same balance.
//
// No SDK: plain fetch against Intuit's OAuth 2.0 and Accounting API v3.
import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { HttpError, conflict } from '../validate.js';
import { fromMinor, toMinor, minorDigits } from '../../public/js/lib/money.js';
import { trimQty } from '../../public/js/lib/doc-render.js';

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const API = { sandbox: 'https://sandbox-quickbooks.api.intuit.com', production: 'https://quickbooks.api.intuit.com' };
const APP = { sandbox: 'https://app.sandbox.qbo.intuit.com', production: 'https://app.qbo.intuit.com' };
const MINOR_VERSION = 75;
const SCOPE = 'com.intuit.quickbooks.accounting';
const ITEM_NAME = 'Invoiced services';

export function quickbooksService(ctx, config = {}) {
  const { db } = ctx;
  const cfg = {
    clientId: config.clientId || '',
    clientSecret: config.clientSecret || '',
    redirectUri: config.redirectUri || '',
    environment: config.environment === 'production' ? 'production' : 'sandbox',
    webhookVerifier: config.webhookVerifier || '',
    fetch: config.fetch || globalThis.fetch,
    now: config.now || (() => Date.now()),
  };
  const configured = !!(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
  const states = new Map(); // OAuth state -> expiry
  let refreshing = null;

  // ---------- token storage (AES-256-GCM, key derived from the client secret) ----------

  const key = () => createHash('sha256').update(`7labz-qbo:${cfg.clientSecret}`).digest();

  function seal(obj) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key(), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  function unseal(s) {
    const buf = Buffer.from(s, 'base64');
    const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  }

  function load() {
    const row = db.prepare("SELECT data FROM integrations WHERE name = 'qbo'").get();
    if (!row || !configured) return null;
    try {
      return unseal(row.data);
    } catch {
      return null; // secret changed: the stored connection can no longer be read
    }
  }

  function save(conn) {
    db.prepare(
      "INSERT INTO integrations (name, data) VALUES ('qbo', ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = datetime('now')",
    ).run(seal(conn));
  }

  // ---------- OAuth ----------

  function connectUrl() {
    if (!configured) throw new HttpError(409, 'QuickBooks is not configured on the server. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI.');
    const state = randomBytes(24).toString('base64url');
    states.set(state, cfg.now() + 10 * 60 * 1000);
    const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', scope: SCOPE, redirect_uri: cfg.redirectUri, state });
    return { url: `${AUTH_URL}?${q}` };
  }

  async function tokenRequest(form) {
    const res = await cfg.fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `QuickBooks sign-in failed: ${data.error_description || data.error || res.status}`);
    return data;
  }

  function withTokens(conn, t) {
    const now = cfg.now();
    return {
      ...conn,
      access_token: t.access_token,
      access_expires: now + (t.expires_in || 3600) * 1000,
      refresh_token: t.refresh_token,
      refresh_expires: now + (t.x_refresh_token_expires_in || 8640000) * 1000,
    };
  }

  // Intuit redirects here. The owner's session cookie is SameSite=Strict and is not sent on this
  // cross-site redirect, so the single-use state value is what proves the request is ours.
  async function callback({ code, state, realmId, error }) {
    if (!state || !states.has(state) || states.get(state) < cfg.now()) throw new HttpError(400, 'This QuickBooks sign-in link expired. Start again from Settings.');
    states.delete(state);
    if (error) throw new HttpError(400, `QuickBooks declined the connection: ${error}`);
    if (!code || !realmId) throw new HttpError(400, 'QuickBooks did not return a company');
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
    let conn = withTokens({ realm_id: String(realmId), environment: cfg.environment, connected_at: new Date(cfg.now()).toISOString() }, t);
    save(conn);
    const info = await api('GET', `/companyinfo/${conn.realm_id}`);
    const prefs = await query('select * from Preferences');
    conn = load();
    conn.company_name = info.CompanyInfo?.CompanyName || '';
    conn.country = info.CompanyInfo?.Country || '';
    conn.home_currency = prefs[0]?.CurrencyPrefs?.HomeCurrency?.value || 'USD';
    conn.multicurrency = !!prefs[0]?.CurrencyPrefs?.MultiCurrencyEnabled;
    save(conn);
    ctx.log('settings', 0, 'quickbooks_connected', { company: conn.company_name, realm_id: conn.realm_id });
    return conn;
  }

  async function accessToken() {
    const conn = load();
    if (!conn) throw new HttpError(409, 'QuickBooks is not connected');
    if (conn.access_expires - 60_000 > cfg.now()) return conn;
    if (conn.refresh_expires < cfg.now()) throw new HttpError(409, 'The QuickBooks connection expired. Reconnect it in Settings.');
    refreshing ||= (async () => {
      try {
        const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refresh_token });
        const next = withTokens(conn, t);
        save(next);
        return next;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function disconnect() {
    const conn = load();
    if (conn) {
      try {
        await cfg.fetch(REVOKE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ token: conn.refresh_token }),
        });
      } catch {
        // Revoking is courtesy; the local tokens are deleted either way.
      }
    }
    db.prepare("DELETE FROM integrations WHERE name = 'qbo'").run();
    ctx.log('settings', 0, 'quickbooks_disconnected');
    return status();
  }

  // ---------- API ----------

  async function api(method, path, body, params = {}) {
    const conn = await accessToken();
    const q = new URLSearchParams({ minorversion: String(MINOR_VERSION), ...params });
    const res = await cfg.fetch(`${API[conn.environment]}/v3/company/${conn.realm_id}${path}?${q}`, {
      method,
      headers: {
        Authorization: `Bearer ${conn.access_token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.Fault) {
      const e = data.Fault?.Error?.[0];
      const err = new HttpError(502, `QuickBooks: ${e?.Detail || e?.Message || `HTTP ${res.status}`}`);
      err.qboCode = e?.code;
      throw err;
    }
    return data;
  }

  async function query(sql) {
    const data = await api('GET', '/query', null, { query: sql });
    const r = data.QueryResponse || {};
    const k = Object.keys(r).find((x) => Array.isArray(r[x]));
    return k ? r[k] : [];
  }

  const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

  // ---------- customers and the service item ----------

  async function ensureCustomer(client) {
    if (client.qbo_customer_id) return client.qbo_customer_id;
    const base = (client.company || client.name).slice(0, 90);
    for (const name of [base, `${base} (client)`, `${base} (${client.id})`]) {
      const found = await query(`select * from Customer where DisplayName = ${quote(name)}`);
      if (found[0]) return link(found[0].Id);
      try {
        const addr = {
          Line1: client.address_line1 || undefined,
          Line2: client.address_line2 || undefined,
          City: client.city || undefined,
          CountrySubDivisionCode: client.region || undefined,
          PostalCode: client.postal_code || undefined,
          Country: client.country || undefined,
        };
        const created = await api('POST', '/customer', {
          DisplayName: name,
          CompanyName: client.company || undefined,
          PrimaryEmailAddr: client.email ? { Address: client.email } : undefined,
          PrimaryPhone: client.phone ? { FreeFormNumber: client.phone } : undefined,
          BillAddr: Object.values(addr).some(Boolean) ? addr : undefined,
          ...(load()?.multicurrency ? { CurrencyRef: { value: client.currency } } : {}),
        });
        return link(created.Customer.Id);
      } catch (err) {
        if (err.qboCode !== '6240') throw err; // 6240: name taken by a vendor or employee; try the next name
      }
    }
    throw new HttpError(502, `QuickBooks already uses the name "${base}" for someone who is not a customer`);

    function link(id) {
      db.prepare('UPDATE clients SET qbo_customer_id = ? WHERE id = ?').run(String(id), client.id);
      return String(id);
    }
  }

  async function ensureItem() {
    const conn = load();
    if (conn.item_id) return conn.item_id;
    let item = (await query(`select * from Item where Name = ${quote(ITEM_NAME)}`))[0];
    if (!item) {
      const income = (await query("select * from Account where AccountType = 'Income' and Active = true maxresults 1"))[0];
      if (!income) throw new HttpError(502, 'QuickBooks has no active income account to post sales to');
      item = (await api('POST', '/item', { Name: ITEM_NAME, Type: 'Service', IncomeAccountRef: { value: income.Id } })).Item;
    }
    save({ ...load(), item_id: String(item.Id) });
    return String(item.Id);
  }

  // ---------- invoices ----------

  const amt = (minor, cur) => Number(fromMinor(minor, cur));
  const fromAmt = (n, cur) => toMinor(Number(n).toFixed(minorDigits(cur)), cur);

  // The QBO copy must total exactly what the client sees here. Lines go over as amounts (the
  // quantity and rate ride in the description), tax as its own line, the discount as a
  // discount line, so QBO cannot recompute a different total.
  function invoiceBody(doc, customerId, itemId) {
    const cur = doc.currency;
    const lines = doc.lines.map((l) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: amt(l.amount, cur),
      Description: `${l.description}${trimQty(l.quantity) !== '1' || l.unit ? `\n${trimQty(l.quantity)}${l.unit ? ` ${l.unit}` : ''} × ${fromMinor(l.unit_price, cur)}${l.discount_bps ? ` less ${l.discount_bps / 100}%` : ''}` : ''}`.slice(0, 4000),
      SalesItemLineDetail: { ItemRef: { value: itemId }, TaxCodeRef: { value: 'NON' } },
    }));
    if (doc.discount_total) {
      lines.push({ DetailType: 'DiscountLineDetail', Amount: amt(doc.discount_total, cur), DiscountLineDetail: { PercentBased: false } });
    }
    for (const t of doc.taxes || []) {
      if (!t.amount) continue;
      lines.push({
        DetailType: 'SalesItemLineDetail',
        Amount: amt(t.amount, cur),
        Description: `${t.name} ${t.rate_ppm / 10000}% on ${fromMinor(t.base, cur)}`,
        SalesItemLineDetail: { ItemRef: { value: itemId }, TaxCodeRef: { value: 'NON' } },
      });
    }
    const email = doc.client?.email || doc.bill_to?.email;
    return {
      CustomerRef: { value: customerId },
      DocNumber: String(doc.number).slice(0, 21),
      TxnDate: doc.issue_date,
      DueDate: doc.due_date || undefined,
      Line: lines,
      BillEmail: email ? { Address: email } : undefined,
      CustomerMemo: doc.notes ? { value: doc.notes.slice(0, 1000) } : undefined,
      PrivateNote: `From 7LABZ invoicing #${doc.id}`,
      AllowOnlineCreditCardPayment: true,
      AllowOnlineACHPayment: true,
      ...(load()?.multicurrency ? { CurrencyRef: { value: cur } } : {}),
    };
  }

  function mark(id, fields) {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE documents SET ${cols.map((c) => `${c} = ?`).join(', ')}, qbo_synced_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => fields[c]), id);
  }

  // Copies or updates one invoice. Never throws: failures land on the document as qbo_error.
  async function pushInvoice(id) {
    const conn = load();
    if (!conn) return null;
    const doc = ctx.documents.get(id);
    if (doc.kind !== 'invoice' || doc.state === 'draft') return null;
    try {
      if (doc.state === 'void') {
        if (doc.qbo_invoice_id) {
          const cur = (await api('GET', `/invoice/${doc.qbo_invoice_id}`)).Invoice;
          await api('POST', '/invoice', { Id: doc.qbo_invoice_id, SyncToken: cur.SyncToken }, { operation: 'void' });
          mark(id, { qbo_status: 'void', qbo_error: null, qbo_link: null });
        }
        return ctx.documents.get(id);
      }
      if (doc.currency !== conn.home_currency && !conn.multicurrency) {
        mark(id, { qbo_status: 'skipped', qbo_error: `QuickBooks takes payments in ${conn.home_currency} only` });
        return ctx.documents.get(id);
      }
      const customerId = await ensureCustomer(doc.client);
      const itemId = await ensureItem();
      const body = invoiceBody(doc, customerId, itemId);
      let inv;
      if (doc.qbo_invoice_id) {
        const cur = (await api('GET', `/invoice/${doc.qbo_invoice_id}`)).Invoice;
        inv = (await api('POST', '/invoice', { ...body, Id: doc.qbo_invoice_id, SyncToken: cur.SyncToken })).Invoice;
      } else {
        // Adopt this customer's invoice with the same number instead of creating a duplicate.
        const existing = (await query(`select * from Invoice where DocNumber = ${quote(body.DocNumber)}`))
          .find((x) => String(x.CustomerRef?.value) === customerId);
        inv = existing
          ? (await api('POST', '/invoice', { ...body, Id: existing.Id, SyncToken: existing.SyncToken })).Invoice
          : (await api('POST', '/invoice', body)).Invoice;
      }
      const qboTotal = fromAmt(inv.TotalAmt, doc.currency);
      if (qboTotal !== doc.total) {
        mark(id, {
          qbo_invoice_id: String(inv.Id), qbo_sync_token: String(inv.SyncToken), qbo_link: null, qbo_status: 'error',
          qbo_error: `QuickBooks totals this invoice at ${fromMinor(qboTotal, doc.currency)}, not ${fromMinor(doc.total, doc.currency)}. Turn off automatic sales tax for it in QuickBooks, then retry.`,
        });
        return ctx.documents.get(id);
      }
      const withLink = (await api('GET', `/invoice/${inv.Id}`, null, { include: 'invoiceLink' })).Invoice;
      mark(id, {
        qbo_invoice_id: String(inv.Id),
        qbo_sync_token: String(withLink.SyncToken ?? inv.SyncToken),
        qbo_link: withLink.InvoiceLink || null,
        qbo_status: 'synced',
        qbo_error: withLink.InvoiceLink ? null : 'No pay link from QuickBooks. Check that QuickBooks Payments is active and the client has an email address.',
      });
      // Payments recorded here before the invoice reached QBO go over too.
      for (const p of ctx.documents.get(id).payments) if (!p.external_id && p.amount > 0) await pushPayment(id, p.id);
    } catch (err) {
      mark(id, { qbo_status: 'error', qbo_error: err.message.slice(0, 500) });
      ctx.log('document', id, 'quickbooks_error', { message: err.message.slice(0, 300) });
    }
    return ctx.documents.get(id);
  }

  // ---------- payments ----------

  // A payment recorded in this app goes to QBO, so the QBO pay page shows the right balance.
  async function pushPayment(docId, paymentId) {
    const doc = ctx.documents.get(docId);
    const p = doc.payments.find((x) => x.id === paymentId);
    if (!load() || !doc.qbo_invoice_id || !p || p.external_id) return;
    if (p.amount < 0) {
      ctx.log('document', docId, 'quickbooks_note', { message: 'Refund recorded here only. Record it in QuickBooks too.' });
      return;
    }
    try {
      const created = (
        await api('POST', '/payment', {
          CustomerRef: { value: doc.client.qbo_customer_id || (await ensureCustomer(doc.client)) },
          TotalAmt: amt(p.amount, doc.currency),
          TxnDate: p.date,
          PaymentRefNum: (p.reference || '').slice(0, 21) || undefined,
          PrivateNote: `${p.method}${p.note ? ` · ${p.note}` : ''} (recorded in 7LABZ invoicing)`.slice(0, 4000),
          Line: [{ Amount: amt(p.amount, doc.currency), LinkedTxn: [{ TxnId: doc.qbo_invoice_id, TxnType: 'Invoice' }] }],
        })
      ).Payment;
      ctx.documents.setExternalId(paymentId, `qbo:${created.Id}:${doc.qbo_invoice_id}`);
    } catch (err) {
      mark(docId, { qbo_error: `Payment not copied to QuickBooks: ${err.message}`.slice(0, 500) });
    }
  }

  // A QBO payment can cover several invoices; each linked line becomes one payment here.
  async function applyPayment(payment) {
    const created = [];
    for (const line of payment.Line || []) {
      for (const lt of line.LinkedTxn || []) {
        if (lt.TxnType !== 'Invoice') continue;
        const doc = db.prepare('SELECT id, currency FROM documents WHERE qbo_invoice_id = ?').get(String(lt.TxnId));
        if (!doc) continue;
        const out = ctx.documents.recordExternal(doc.id, {
          amount: fromAmt(line.Amount, doc.currency),
          date: payment.TxnDate,
          method: 'quickbooks',
          reference: `QBO ${payment.PaymentRefNum || payment.Id}`.slice(0, 120),
          note: 'Paid online through QuickBooks',
          external_id: `qbo:${payment.Id}:${lt.TxnId}`,
        });
        if (out.payment_id && !out.duplicate) created.push({ document_id: doc.id, ...out });
      }
    }
    return created;
  }

  // Pull: for every open linked invoice, any QBO payment we have not seen is recorded.
  let syncing = null;

  // One sync at a time; a second caller waits for the running one.
  function sync() {
    syncing ||= runSync().finally(() => (syncing = null));
    return syncing;
  }

  async function runSync() {
    const conn = load();
    if (!conn) return { connected: false };
    const pushed = [];
    const recorded = [];
    // Issued invoices not yet in QBO (including ones recurring schedules issued on their own).
    const pending = db
      .prepare(
        `SELECT id FROM documents WHERE kind = 'invoice' AND state = 'issued' AND qbo_invoice_id IS NULL
         AND (qbo_status IS NULL OR qbo_status = 'error') AND total > (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE document_id = documents.id)
         ORDER BY id LIMIT 20`,
      )
      .all();
    for (const { id } of pending) {
      const d = await pushInvoice(id);
      if (d?.qbo_status === 'synced') pushed.push(id);
    }
    const open = db
      .prepare(
        `SELECT id, qbo_invoice_id FROM documents WHERE kind = 'invoice' AND state = 'issued' AND qbo_invoice_id IS NOT NULL
         AND total > (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE document_id = documents.id)`,
      )
      .all();
    try {
      for (let i = 0; i < open.length; i += 30) {
        const batch = open.slice(i, i + 30);
        const invoices = await query(`select * from Invoice where Id in (${batch.map((b) => quote(b.qbo_invoice_id)).join(', ')})`);
        for (const inv of invoices) {
          for (const lt of inv.LinkedTxn || []) {
            if (lt.TxnType !== 'Payment') continue;
            if (db.prepare('SELECT 1 FROM payments WHERE external_id = ?').get(`qbo:${lt.TxnId}:${inv.Id}`)) continue;
            const payment = (await api('GET', `/payment/${lt.TxnId}`)).Payment;
            recorded.push(...(await applyPayment(payment)));
          }
        }
      }
      save({ ...load(), last_sync: new Date(cfg.now()).toISOString(), last_error: null });
    } catch (err) {
      save({ ...load(), last_error: err.message.slice(0, 300) });
      throw err;
    }
    return { connected: true, pushed: pushed.length, recorded: recorded.length };
  }

  // ---------- webhook ----------

  function verifyWebhook(raw, signature) {
    if (!cfg.webhookVerifier) throw new HttpError(404, 'Webhooks are not configured');
    const expected = createHmac('sha256', cfg.webhookVerifier).update(raw, 'utf8').digest();
    let given;
    try {
      given = Buffer.from(String(signature || ''), 'base64');
    } catch {
      given = Buffer.alloc(0);
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Bad signature');
  }

  // Intuit wants a reply within seconds, so the work runs after the response.
  function webhook(raw, signature) {
    verifyWebhook(raw, signature);
    const conn = load();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Malformed JSON');
    }
    const ids = new Set();
    // Classic format: { eventNotifications: [{ realmId, dataChangeEvent: { entities: [...] } }] }
    for (const n of body.eventNotifications || []) {
      if (conn && String(n.realmId) !== conn.realm_id) continue;
      for (const e of n.dataChangeEvent?.entities || []) if (e.name === 'Payment' && e.operation !== 'Delete') ids.add(String(e.id));
    }
    // CloudEvents format: [{ type: 'qbo.payment.created.v1', intuitentityid, intuitaccountid }]
    for (const e of Array.isArray(body) ? body : []) {
      if (conn && e.intuitaccountid && String(e.intuitaccountid) !== conn.realm_id) continue;
      if (/payment/i.test(e.type || '') && !/delete/i.test(e.type || '') && e.intuitentityid) ids.add(String(e.intuitentityid));
    }
    const work = (async () => {
      for (const id of ids) {
        try {
          await applyPayment((await api('GET', `/payment/${id}`)).Payment);
        } catch (err) {
          console.error('quickbooks webhook', err.message);
        }
      }
    })();
    return { accepted: ids.size, done: work };
  }

  // ---------- status ----------

  function status() {
    const conn = load();
    const counts = db
      .prepare(
        `SELECT SUM(CASE WHEN qbo_status = 'synced' THEN 1 ELSE 0 END) AS synced,
                SUM(CASE WHEN qbo_status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM documents WHERE kind = 'invoice'`,
      )
      .get();
    return {
      configured,
      environment: cfg.environment,
      webhooks: !!cfg.webhookVerifier,
      redirect_uri: cfg.redirectUri || null,
      connected: !!conn,
      company_name: conn?.company_name || null,
      realm_id: conn?.realm_id || null,
      home_currency: conn?.home_currency || null,
      connected_at: conn?.connected_at || null,
      refresh_expires: conn ? new Date(conn.refresh_expires).toISOString() : null,
      last_sync: conn?.last_sync || null,
      last_error: conn?.last_error || null,
      synced: counts.synced || 0,
      errors: counts.errors || 0,
    };
  }

  function appLink(qboInvoiceId) {
    return qboInvoiceId ? `${APP[cfg.environment]}/app/invoice?txnId=${encodeURIComponent(qboInvoiceId)}` : null;
  }

  function requireConnected() {
    if (!load()) throw conflict('Connect QuickBooks in Settings first');
  }

  return {
    configured, connectUrl, callback, disconnect, status, sync, pushInvoice, pushPayment, applyPayment, webhook,
    appLink, requireConnected, isConnected: () => !!load(),
  };
}

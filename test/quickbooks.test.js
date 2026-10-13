import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { fakeQbo } from './helpers/fake-qbo.js';

const qb = fakeQbo();
const clock = { now: Date.parse('2026-10-13T12:00:00Z') };
let app, server, base;

before(async () => {
  app = createApp({
    today: () => '2026-10-13',
    qbo: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://pay.7labz.example/api/qbo/callback', webhookVerifier: 'verifier', fetch: qb.fetch, now: () => clock.now },
  });
  server = createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : null };
};

test('not configured: explains instead of failing', () => {
  const bare = createApp({});
  assert.equal(bare.ctx.qbo.status().configured, false);
  assert.throws(() => bare.ctx.qbo.connectUrl(), /not configured/);
});

let customerInvoice;

test('connect: state is single-use, tokens stored encrypted', async () => {
  const { url } = (await call('POST', '/api/qbo/connect', {})).body;
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://appcenter.intuit.com/connect/oauth2');
  assert.equal(u.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  const state = u.searchParams.get('state');

  const forged = await call('GET', `/api/qbo/callback?code=x&state=forged&realmId=9130`);
  assert.equal(forged.status, 302);
  assert.match(forged.headers.get('location'), /qbo_error=/);

  const ok = await call('GET', `/api/qbo/callback?code=abc&state=${state}&realmId=9130`);
  assert.equal(ok.headers.get('location'), '/#/settings?qbo=connected');
  const replay = await call('GET', `/api/qbo/callback?code=abc&state=${state}&realmId=9130`);
  assert.match(replay.headers.get('location'), /qbo_error=/, 'state cannot be replayed');

  const st = (await call('GET', '/api/qbo/status')).body;
  assert.equal(st.connected, true);
  assert.equal(st.company_name, '7LABZ LLC');
  assert.equal(st.home_currency, 'USD');
  const raw = app.ctx.db.prepare("SELECT data FROM integrations WHERE name = 'qbo'").get().data;
  assert.ok(!raw.includes('rt-') && !raw.includes('at-'), 'tokens are not stored in the clear');
  const backup = (await call('GET', '/api/export/backup.json')).body;
  assert.equal(backup.data.integrations, undefined, 'tokens never leave in a backup');
});

test('issuing copies the invoice with the exact total and a pay link', async () => {
  await call('POST', '/api/tax-rates', { name: 'NY sales tax', rate: '8.875' });
  const client = (await call('POST', '/api/clients', { name: 'Mara Okafor', company: "Halden's Robotics", email: 'ap@halden.example', currency: 'USD' })).body;
  const d = (await call('POST', '/api/documents', {
    client_id: client.id,
    lines: [
      { description: 'Engineering', quantity: '12.5', unit: 'hr', unit_price: '185', tax_rate_id: 1 },
      { description: 'Hosting', quantity: '1', unit_price: '480', discount_percent: '10' },
    ],
    discount_type: 'fixed', discount_value: '100',
  })).body;
  customerInvoice = (await call('POST', `/api/documents/${d.id}/issue`, {})).body;
  assert.equal(customerInvoice.qbo_status, 'synced', customerInvoice.qbo_error);
  assert.equal(customerInvoice.qbo_link, `https://connect.intuit.com/pay/${customerInvoice.qbo_invoice_id}`);
  const inv = qb.invoices[0];
  assert.equal(Math.round(inv.TotalAmt * 100), customerInvoice.total, 'QuickBooks total matches to the cent');
  assert.equal(inv.DocNumber, customerInvoice.number);
  assert.equal(inv.AllowOnlineCreditCardPayment, true);
  assert.equal(inv.AllowOnlineACHPayment, true);
  assert.equal(qb.customers[0].DisplayName, "Halden's Robotics", 'quotes in names survive the query');

  const pub = (await call('GET', `/api/public/${customerInvoice.share_token}`)).body;
  assert.equal(pub.pay.options[0].method, 'quickbooks');
  assert.equal(pub.pay.options[0].href, customerInvoice.qbo_link);
  assert.equal(pub.document.qbo_invoice_id, undefined, 'QBO internals stay private');

  // A second invoice reuses the customer and the service item.
  const d2 = (await call('POST', '/api/documents', { client_id: client.id, lines: [{ description: 'Audit', unit_price: '900' }] })).body;
  await call('POST', `/api/documents/${d2.id}/issue`, {});
  assert.equal(qb.customers.length, 1);
  assert.equal(qb.items.length, 1);
});

test('a card payment in QuickBooks marks the invoice paid here, once', async () => {
  qb.pay(customerInvoice.qbo_invoice_id, customerInvoice.total / 100);
  const r1 = (await call('POST', '/api/qbo/sync', {})).body;
  assert.equal(r1.recorded, 1);
  const doc = (await call('GET', `/api/documents/${customerInvoice.id}`)).body;
  assert.equal(doc.status, 'paid');
  assert.equal(doc.payments[0].method, 'quickbooks');
  const r2 = (await call('POST', '/api/qbo/sync', {})).body;
  assert.equal(r2.recorded, 0, 'no double count');
  assert.equal((await call('GET', `/api/public/${doc.share_token}`)).body.pay, null);
});

test('webhook: signed events are applied, unsigned ones refused', async () => {
  const client = (await call('POST', '/api/clients', { name: 'Theo', email: 'theo@marlow.example', currency: 'USD' })).body;
  const d = (await call('POST', '/api/documents', { client_id: client.id, lines: [{ description: 'Sprint', unit_price: '2000' }] })).body;
  const issued = (await call('POST', `/api/documents/${d.id}/issue`, {})).body;
  const p = qb.pay(issued.qbo_invoice_id, 500);
  const raw = JSON.stringify({ eventNotifications: [{ realmId: '9130', dataChangeEvent: { entities: [{ name: 'Payment', id: p.Id, operation: 'Create' }] } }] });

  assert.equal((await call('POST', '/api/qbo/webhook', raw, { 'intuit-signature': 'bm9wZQ==' })).status, 401);
  const sig = createHmac('sha256', 'verifier').update(raw).digest('base64');
  const { done, accepted } = app.ctx.qbo.webhook(raw, sig);
  assert.equal(accepted, 1);
  await done;
  const after = (await call('GET', `/api/documents/${d.id}`)).body;
  assert.equal(after.status, 'partial');
  assert.equal(after.paid, 50000);
  assert.equal((await call('POST', '/api/qbo/webhook', raw, { 'intuit-signature': sig })).status, 200, 'retries are harmless');
});

test('payments recorded here are copied to QuickBooks, and not pulled back twice', async () => {
  const client = (await call('POST', '/api/clients', { name: 'Ines', email: 'ines@northwind.example', currency: 'USD' })).body;
  const d = (await call('POST', '/api/documents', { client_id: client.id, lines: [{ description: 'Retainer', unit_price: '1000' }] })).body;
  const issued = (await call('POST', `/api/documents/${d.id}/issue`, {})).body;
  const before = qb.payments.length;
  const doc = (await call('POST', `/api/documents/${d.id}/payments`, { amount: '400', method: 'zelle', reference: 'ZL-1' })).body;
  assert.equal(qb.payments.length, before + 1);
  assert.equal(qb.payments.at(-1).Line[0].LinkedTxn[0].TxnId, issued.qbo_invoice_id);
  assert.match(doc.payments[0].external_id, /^qbo:\d+:\d+$/);
  await call('POST', '/api/qbo/sync', {});
  const again = (await call('GET', `/api/documents/${d.id}`)).body;
  assert.equal(again.payments.length, 1);
  assert.equal(again.balance, 60000);
});

test('void, currency mismatch and tax mismatch are handled, never silent', async () => {
  const usd = (await call('POST', '/api/clients', { name: 'Void Co', email: 'v@x.example', currency: 'USD' })).body;
  const d = (await call('POST', '/api/documents', { client_id: usd.id, lines: [{ description: 'x', unit_price: '10' }] })).body;
  const issued = (await call('POST', `/api/documents/${d.id}/issue`, {})).body;
  const voided = (await call('POST', `/api/documents/${d.id}/void`, { reason: 'test' })).body;
  assert.equal(voided.qbo_status, 'void');
  assert.equal(qb.invoices.find((i) => i.Id === issued.qbo_invoice_id).voided, true);

  const eur = (await call('POST', '/api/clients', { name: 'Arden', email: 'a@arden.example', currency: 'EUR' })).body;
  const e = (await call('POST', '/api/documents', { client_id: eur.id, lines: [{ description: 'x', unit_price: '10' }] })).body;
  const skipped = (await call('POST', `/api/documents/${e.id}/issue`, {})).body;
  assert.equal(skipped.qbo_status, 'skipped');
  assert.match(skipped.qbo_error, /USD only/);

  qb.extraTax = 0.89; // QuickBooks automatic sales tax adds its own tax
  const t = (await call('POST', '/api/documents', { client_id: usd.id, lines: [{ description: 'x', unit_price: '10' }] })).body;
  const mismatch = (await call('POST', `/api/documents/${t.id}/issue`, {})).body;
  qb.extraTax = 0;
  assert.equal(mismatch.qbo_status, 'error');
  assert.match(mismatch.qbo_error, /automatic sales tax/);
  const pub = (await call('GET', `/api/public/${mismatch.share_token}`)).body;
  assert.ok(!pub.pay || !pub.pay.options.some((o) => o.method === 'quickbooks'), 'no card button when totals disagree');
  const retried = (await call('POST', `/api/documents/${t.id}/qbo`, {})).body;
  assert.equal(retried.qbo_status, 'synced');
});

test('expired access tokens refresh themselves; disconnect revokes', async () => {
  const before = qb.refreshes;
  clock.now += 2 * 3600 * 1000;
  await call('POST', '/api/qbo/sync', {});
  assert.equal(qb.refreshes, before + 1);
  await call('POST', '/api/qbo/sync', {});
  assert.equal(qb.refreshes, before + 1, 'one refresh per hour, not per call');
  const st = (await call('POST', '/api/qbo/disconnect', {})).body;
  assert.equal(st.connected, false);
  assert.equal(qb.revoked, true);
});

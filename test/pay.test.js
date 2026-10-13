import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { paymentOptions, isIban } from '../public/js/lib/pay-links.js';

test('pay links: exact amounts and invoice reference, per currency', () => {
  const cfg = { cash_app: 'sevenlabz', venmo: 'sevenlabz', zelle: 'pay@7labz.example', paypal: 'sevenlabz', sepa_name: '7LABZ', sepa_iban: 'DE89370400440532013000', upi_vpa: 'labz@okaxis', crypto: [{ label: 'USDC on Base', address: '0x52908400098527886E0F7030069857D2E4169EE7' }], bank_details: 'Acct 1' };
  const usd = paymentOptions(cfg, { number: '7LZ-2026-0001', currency: 'USD', balance: 123456 });
  assert.deepEqual(usd.map((o) => o.method), ['cash_app', 'venmo', 'zelle', 'paypal', 'crypto', 'bank_transfer']);
  assert.equal(usd[0].href, 'https://cash.app/$sevenlabz/1234.56');
  assert.match(usd[1].href, /amount=1234\.56&note=Invoice%207LZ-2026-0001/);
  assert.equal(usd.find((o) => o.method === 'paypal').href, 'https://paypal.me/sevenlabz/1234.56USD');

  const eur = paymentOptions(cfg, { number: 'X-1', currency: 'EUR', balance: 5000 });
  const sepa = eur.find((o) => o.method === 'sepa');
  assert.equal(sepa.qr, 'BCD\n002\n1\nSCT\n\n7LABZ\nDE89370400440532013000\nEUR50.00\n\n\nInvoice X-1\n');
  assert.ok(!eur.some((o) => ['cash_app', 'venmo', 'zelle'].includes(o.method)), 'USD-only rails are hidden');

  const inr = paymentOptions(cfg, { number: 'X-2', currency: 'INR', balance: 99900 });
  assert.match(inr.find((o) => o.method === 'upi').href, /^upi:\/\/pay\?pa=labz%40okaxis&pn=&am=999\.00&cu=INR&tn=Invoice%20X-2$/);

  assert.deepEqual(paymentOptions(cfg, { number: 'X', currency: 'USD', balance: 0 }), [], 'nothing to pay on a settled invoice');
});

test('IBAN checksum catches typos', () => {
  assert.ok(isIban('DE89 3704 0044 0532 0130 00'));
  assert.ok(isIban('GB82WEST12345698765432'));
  assert.ok(!isIban('DE89370400440532013001'));
});

let server, base, token, invId;
before(async () => {
  const app = createApp({ today: () => '2026-10-13' });
  server = createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('settings: payment methods validate before clients see them', async () => {
  const bad = await call('PUT', '/settings', { payments: { sepa_iban: 'DE89370400440532013001', cash_app: '$1bad', crypto: [{ label: '', address: 'nope' }] } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.details['payments.sepa_iban']);
  assert.ok(bad.body.details['payments.cash_app']);
  assert.ok(bad.body.details['payments.crypto.0.address']);
  const ok = await call('PUT', '/settings', { payments: { cash_app: '$sevenlabz', zelle: 'pay@7labz.example', venmo: '@seven-labz' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.payments.cash_app, 'sevenlabz');
  assert.equal(ok.body.payments.venmo, 'seven-labz');
});

test('client link shows pay options; report → confirm marks the invoice paid', async () => {
  const c = (await call('POST', '/clients', { name: 'Halden', currency: 'USD' })).body;
  const d = (await call('POST', '/documents', { client_id: c.id, lines: [{ description: 'Build', unit_price: '1500' }] })).body;
  const issued = (await call('POST', `/documents/${d.id}/issue`, {})).body;
  token = issued.share_token;
  invId = issued.id;

  const pub = (await call('GET', `/public/${token}`)).body;
  assert.deepEqual(pub.pay.options.map((o) => o.method), ['cash_app', 'venmo', 'zelle']);
  assert.equal(pub.pay.options[0].href, 'https://cash.app/$sevenlabz/1500.00');
  assert.equal(pub.pay.reported, false);

  const over = await call('POST', `/public/${token}/report`, { method: 'zelle', amount: '2000' });
  assert.equal(over.status, 422, 'cannot report more than the balance');
  const bogus = await call('POST', `/public/${token}/report`, { method: 'card' });
  assert.equal(bogus.status, 422, 'only direct methods can be reported');

  const rep = await call('POST', `/public/${token}/report`, { method: 'zelle', payer: 'Mara', reference: 'ZL-77' });
  assert.equal(rep.status, 201);
  assert.equal((await call('GET', `/public/${token}`)).body.pay.reported, true);

  // Nothing is paid until the owner confirms.
  let doc = (await call('GET', `/documents/${invId}`)).body;
  assert.equal(doc.status, 'sent');
  assert.equal(doc.reports.length, 1);
  assert.equal((await call('GET', '/meta')).body.badges.reported, 1);
  assert.equal((await call('GET', '/reports/dashboard')).body.reported.length, 1);

  doc = (await call('POST', `/payment-reports/${doc.reports[0].id}/confirm`, {})).body;
  assert.equal(doc.status, 'paid');
  assert.equal(doc.payments[0].method, 'zelle');
  assert.equal(doc.payments[0].reference, 'ZL-77');
  assert.equal(doc.reports.length, 0);
  assert.equal((await call('POST', `/payment-reports/${1}/confirm`, {})).status, 409, 'confirms once');
  assert.equal((await call('GET', `/public/${token}`)).body.pay, null, 'a paid invoice offers no payment');
});

test('dismissed reports leave the balance; reports can be switched off', async () => {
  const c = (await call('POST', '/clients', { name: 'Marlow', currency: 'USD' })).body;
  const d = (await call('POST', '/documents', { client_id: c.id, lines: [{ description: 'x', unit_price: '100' }] })).body;
  const t = (await call('POST', `/documents/${d.id}/issue`, {})).body.share_token;
  await call('POST', `/public/${t}/report`, { method: 'cash_app' });
  const doc = (await call('GET', `/documents/${d.id}`)).body;
  const after = (await call('POST', `/payment-reports/${doc.reports[0].id}/dismiss`, {})).body;
  assert.equal(after.balance, 10000);
  assert.equal(after.reports.length, 0);

  for (let i = 0; i < 5; i++) await call('POST', `/public/${t}/report`, { method: 'zelle' });
  assert.equal((await call('POST', `/public/${t}/report`, { method: 'zelle' })).status, 429, 'flood guard');

  await call('PUT', '/settings', { payments: { client_reports: false } });
  assert.equal((await call('POST', `/public/${t}/report`, { method: 'zelle' })).status, 403);
});

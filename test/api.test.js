import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';

// One server for the file; `clock.today` is moved forward by tests that need time to pass.
const clock = { today: '2026-03-01' };
let server, base, app;

async function start(opts = {}) {
  const a = createApp({ today: () => clock.today, ...opts });
  const s = createServer((req, res) => a.handle(req, res));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { app: a, server: s, base: `http://127.0.0.1:${s.address().port}` };
}

before(async () => ({ app, server, base } = await start()));
after(() => server.close());

async function call(method, path, body, { headers = {}, root = base } = {}) {
  const res = await fetch(`${root}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}
const get = (p, o) => call('GET', p, undefined, o);
const post = (p, b = {}, o) => call('POST', p, b, o);
const put = (p, b, o) => call('PUT', p, b, o);
const del = (p, o) => call('DELETE', p, undefined, o);

async function ok(promise, status = 200) {
  const r = await promise;
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
}

let vat, client, gbpClient;

test('setup: tax rate, clients, catalog', async () => {
  vat = await ok(post('/tax-rates', { name: 'VAT', rate: '20' }), 201);
  assert.equal(vat.rate_ppm, 200000);
  client = await ok(post('/clients', { name: 'Halden Robotics', email: 'ap@halden.test', currency: 'usd', payment_terms_days: 30 }), 201);
  assert.equal(client.currency, 'USD');
  gbpClient = await ok(post('/clients', { name: 'Marlow', currency: 'GBP', payment_terms_days: 14, default_tax_rate_id: vat.id }), 201);
  const item = await ok(post('/items', { name: 'Engineering', unit: 'hr', unit_price: '185.00', currency: 'USD' }), 201);
  assert.equal(item.unit_price, 18500);
});

test('validation: every bad field is reported at once', async () => {
  const r = await post('/clients', { email: 'nope', currency: 'XXX', payment_terms_days: -1 });
  assert.equal(r.status, 422);
  assert.deepEqual(Object.keys(r.body.details).sort(), ['currency', 'email', 'name', 'payment_terms_days']);

  const d = await post('/documents', { client_id: client.id, lines: [{ description: '', unit_price: 'abc', quantity: '1.0001' }] });
  assert.equal(d.status, 422);
  assert.ok(d.body.details['lines.0.description']);
  assert.ok(d.body.details['lines.0.unit_price']);
  assert.ok(d.body.details['lines.0.quantity']);
});

let inv;

test('invoice: draft has no number; due date follows client terms', async () => {
  inv = await ok(post('/documents', {
    client_id: client.id,
    title: 'Fleet console',
    lines: [
      { description: 'Design sprint', quantity: '1', unit_price: '12000' },
      { description: 'Engineering', quantity: '32.5', unit_price: '185', discount_percent: '10' },
    ],
    discount_type: 'fixed',
    discount_value: '500',
  }), 201);
  assert.equal(inv.number, null);
  assert.equal(inv.status, 'draft');
  assert.equal(inv.due_date, '2026-03-31');
  assert.equal(inv.currency, 'USD');
  // 12000 + 32.5 × 185 × 0.9 = 12000 + 5411.25 = 17411.25, minus 500
  assert.equal(inv.subtotal, 1741125);
  assert.equal(inv.total, 1691125);
});

test('invoice: payments are refused on drafts', async () => {
  const r = await post(`/documents/${inv.id}/payments`, { amount: '10' });
  assert.equal(r.status, 409);
});

test('invoice: issuing assigns gapless numbers and freezes the client', async () => {
  const draft2 = await ok(post('/documents', { client_id: client.id, lines: [{ description: 'x', unit_price: '1' }] }), 201);
  await ok(del(`/documents/${draft2.id}`)); // deleting a draft burns no number
  inv = await ok(post(`/documents/${inv.id}/issue`));
  assert.equal(inv.number, '7LZ-2026-0001');
  assert.equal(inv.status, 'sent');
  assert.equal(inv.bill_to.name, 'Halden Robotics');

  await ok(put(`/clients/${client.id}`, { name: 'Halden Robotics Inc.' }));
  const again = await ok(get(`/documents/${inv.id}`));
  assert.equal(again.bill_to.name, 'Halden Robotics', 'issued invoice keeps the snapshot');

  const r = await post(`/documents/${inv.id}/issue`);
  assert.equal(r.status, 409);
  const d = await del(`/documents/${inv.id}`);
  assert.equal(d.status, 409, 'issued invoices cannot be deleted');
});

test('payments: partial, overpayment refused, then paid', async () => {
  let d = await ok(post(`/documents/${inv.id}/payments`, { amount: '10000', method: 'bank_transfer', reference: 'WIRE 1' }), 201);
  assert.equal(d.status, 'partial');
  assert.equal(d.balance, 691125);

  const over = await post(`/documents/${inv.id}/payments`, { amount: '7000' });
  assert.equal(over.status, 422);
  assert.match(over.body.details.amount, /Exceeds/);

  const locked = await put(`/documents/${inv.id}`, { title: 'changed' });
  assert.equal(locked.status, 409, 'invoices with payments are locked');

  d = await ok(post(`/documents/${inv.id}/payments`, { amount: '6911.25', method: 'card' }), 201);
  assert.equal(d.status, 'paid');
  assert.equal(d.balance, 0);
});

test('refunds reduce paid; void requires zero paid', async () => {
  const v = await post(`/documents/${inv.id}/void`, { reason: 'test' });
  assert.equal(v.status, 409);
  const tooBig = await post(`/documents/${inv.id}/payments`, { amount: '20000', refund: true });
  assert.equal(tooBig.status, 422);
  const d = await ok(post(`/documents/${inv.id}/payments`, { amount: '100', refund: true }), 201);
  assert.equal(d.status, 'partial');
  assert.equal(d.paid, 1691125 - 10000);
});

test('status moves to overdue as time passes, and lists filter on it', async () => {
  clock.today = '2026-04-15';
  const d = await ok(get(`/documents/${inv.id}`));
  assert.equal(d.status, 'overdue');
  const list = await ok(get('/documents?kind=invoice&status=overdue'));
  assert.equal(list.count, 1);
  const open = await ok(get('/documents?kind=invoice&status=open'));
  assert.equal(open.count, 1);
  const aging = await ok(get('/reports/aging'));
  assert.equal(aging.totals[0].d1_30, 10000);
});

test('editing an issued invoice without payments is allowed and logged', async () => {
  const d = await ok(post('/documents', { client_id: gbpClient.id, lines: [{ description: 'Brand', unit_price: '1000', tax_rate_id: vat.id }] }), 201);
  assert.equal(d.currency, 'GBP');
  assert.equal(d.tax_total, 20000);
  const issued = await ok(post(`/documents/${d.id}/issue`));
  assert.equal(issued.number, '7LZ-2026-0002');
  const edited = await ok(put(`/documents/${d.id}`, { lines: [{ description: 'Brand', unit_price: '1200', tax_rate_id: vat.id }] }));
  assert.equal(edited.total, 144000);
  const log = await ok(get(`/documents/${d.id}/activity`));
  assert.ok(log.some((a) => a.action === 'revised' && a.detail.from_total === 120000));

  // Changing a tax rate never rewrites an issued document.
  await ok(put(`/tax-rates/${vat.id}`, { rate: '17.5' }));
  const still = await ok(get(`/documents/${d.id}`));
  assert.equal(still.tax_total, 24000);
  await ok(put(`/tax-rates/${vat.id}`, { rate: '20' }));

  const voided = await ok(post(`/documents/${d.id}/void`, { reason: 'Wrong entity' }));
  assert.equal(voided.status, 'void');
  assert.equal(voided.number, '7LZ-2026-0002', 'void keeps its number');
});

test('estimates: own sequence, accept, convert to a draft invoice', async () => {
  const est = await ok(post('/documents', { kind: 'estimate', client_id: client.id, lines: [{ description: 'Phase two', quantity: 2, unit_price: '5000' }] }), 201);
  assert.equal(est.due_date, '2026-05-15', 'valid for the default 30 days');
  const issued = await ok(post(`/documents/${est.id}/issue`));
  assert.equal(issued.number, 'EST-2026-0001');
  const pay = await post(`/documents/${est.id}/payments`, { amount: '1' });
  assert.equal(pay.status, 409);
  await ok(post(`/documents/${est.id}/accept`));
  const invoice = await ok(post(`/documents/${est.id}/convert`), 201);
  assert.equal(invoice.kind, 'invoice');
  assert.equal(invoice.state, 'draft');
  assert.equal(invoice.total, 1000000);
  assert.equal(invoice.related.source_estimate.id, est.id);
  const after = await ok(get(`/documents/${est.id}`));
  assert.equal(after.status, 'converted');
  assert.equal((await post(`/documents/${est.id}/convert`)).status, 409, 'converts once');
});

test('public share link: read-only, hides internals, dies on rotate', async () => {
  const d = await ok(get(`/documents/${inv.id}`));
  const pub = await ok(get(`/public/${d.share_token}`));
  assert.equal(pub.document.number, '7LZ-2026-0001');
  assert.equal(pub.document.client, undefined, 'client record (internal notes) is not exposed');
  assert.equal(pub.document.share_token, undefined);
  await ok(post(`/documents/${inv.id}/share`));
  assert.equal((await get(`/public/${d.share_token}`)).status, 404);

  const draft = await ok(post('/documents', { client_id: client.id, lines: [{ description: 'x', unit_price: '1' }] }), 201);
  assert.equal((await get(`/public/${draft.share_token}`)).status, 404, 'drafts are never public');
  await ok(del(`/documents/${draft.id}`));
});

test('recurring: month-end anchor, catch-up, max runs, auto-issue', async () => {
  clock.today = '2026-04-15';
  const r = await ok(post('/recurring', {
    name: 'Retainer', client_id: client.id, interval_unit: 'month', start_date: '2026-01-31',
    max_runs: 4, auto_issue: true, lines: [{ description: 'Retainer', unit_price: '2000' }],
  }), 201);
  assert.deepEqual(r.upcoming, ['2026-01-31', '2026-02-28', '2026-03-31']);
  const run = await ok(post('/recurring/run'));
  assert.deepEqual(run.created.map((c) => c.issue_date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.ok(run.created.every((c) => c.number), 'auto-issued');
  const again = await ok(post('/recurring/run'));
  assert.equal(again.created.length, 0, 'idempotent');

  clock.today = '2026-06-01';
  const later = await ok(post('/recurring/run'));
  assert.deepEqual(later.created.map((c) => c.issue_date), ['2026-04-30'], 'stops at max_runs');
  const done = await ok(get(`/recurring/${r.id}`));
  assert.equal(done.active, 0);
  assert.equal(done.runs_done, 4);
});

test('client statement keeps a running balance', async () => {
  const st = await ok(get(`/clients/${client.id}/statement`));
  const last = st.lines.at(-1);
  assert.equal(st.closing.USD, last.balance);
  const fromApril = await ok(get(`/clients/${client.id}/statement?from=2026-04-01`));
  assert.ok(fromApril.opening.USD > 0);
});

test('reports: dashboard, revenue, tax, CSV, backup', async () => {
  const dash = await ok(get('/reports/dashboard'));
  assert.ok(dash.currencies.find((c) => c.currency === 'USD').outstanding > 0);
  const rev = await ok(get('/reports/revenue?months=6'));
  assert.equal(rev.months.length, 6);
  const tax = await ok(get('/reports/tax?from=2026-01-01&to=2026-12-31'));
  assert.ok(Array.isArray(tax.currencies));
  const csv = await get('/export/invoices.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.match(csv.body, /^Number,Status,Client/);
  assert.match(csv.body, /7LZ-2026-0001/);
  const backup = await ok(get('/export/backup.json'));
  assert.equal(backup.format, '7labz-invoicing-backup');
  assert.ok(backup.data.documents.length > 0);
});

test('ux endpoints: search, tab counts, badges, reminders', async () => {
  const found = await ok(get('/search?q=7LZ-2026-0001'));
  assert.equal(found.documents[0].number, '7LZ-2026-0001');
  const byClient = await ok(get('/search?q=halden'));
  assert.ok(byClient.clients.length >= 1);
  assert.deepEqual(await ok(get('/search?q=')), { documents: [], clients: [] });

  const list = await ok(get('/documents?kind=invoice&status=paid'));
  assert.ok(list.status_counts.all >= list.count, 'tab counts ignore the status filter');
  assert.equal(list.status_counts.open, (list.status_counts.sent || 0) + (list.status_counts.partial || 0) + (list.status_counts.overdue || 0));

  const meta = await ok(get('/meta'));
  assert.equal(typeof meta.badges.overdue, 'number');

  await ok(post(`/documents/${inv.id}/sent`, { to: 'ap@halden.test', reminder: true }));
  const log = await ok(get(`/documents/${inv.id}/activity`));
  assert.equal(log[0].action, 'reminded');

  const dash = await ok(get('/reports/dashboard'));
  assert.ok(Array.isArray(dash.drafts) && Array.isArray(dash.due_soon) && Array.isArray(dash.awaiting));
  assert.equal(dash.setup.issued, true);
});

test('archiving a client with history keeps it, deleting an unused one removes it', async () => {
  const r1 = await ok(del(`/clients/${client.id}`));
  assert.equal(r1.archived, true);
  const tmp = await ok(post('/clients', { name: 'Temp' }), 201);
  const r2 = await ok(del(`/clients/${tmp.id}`));
  assert.equal(r2.deleted, true);
  const blocked = await post('/documents', { client_id: client.id, lines: [{ description: 'x', unit_price: '1' }] });
  assert.equal(blocked.status, 422, 'no new documents for archived clients');
});

test('numbering: prefix changes and a manual start never collide', async () => {
  await ok(put('/settings', { numbering: { invoice_prefix: 'INV-', yearly: false, padding: 5 } }));
  const back = await put('/sequences/invoice', { next_sequence: 1 });
  assert.equal(back.status, 200, 'non-yearly sequence starts fresh');
  const set = await ok(put('/sequences/invoice', { next_sequence: 1000 }));
  assert.equal(set.next, 'INV-01000');
  const refuse = await put('/sequences/invoice', { next_sequence: 5 });
  assert.equal(refuse.status, 409);
});

test('http: JSON only, cross-site refused, unknown routes, traversal', async () => {
  const res = await fetch(`${base}/api/clients`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
  assert.equal(res.status, 415);
  const xs = await post('/clients', { name: 'x' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(xs.status, 403);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await call('PATCH', '/clients')).status, 405);
  const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(trav.status, 404);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const share = await fetch(`${base}/p/abcdefghijklmnop`);
  assert.equal(share.status, 200, 'share shell is served; the API decides validity');
});

test('auth: password gate, cookie session, lockout', async () => {
  const s = await start({ password: 'correct horse', sessionSecret: 'k' });
  try {
    const opts = { root: s.base };
    assert.equal((await get('/clients', opts)).status, 401);
    assert.deepEqual((await get('/auth/me', opts)).body, { required: true, signed_in: false });
    assert.equal((await post('/auth/login', { password: 'nope' }, opts)).status, 401);
    const login = await post('/auth/login', { password: 'correct horse' }, opts);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await get('/clients', { ...opts, headers: { cookie } })).status, 200);
    assert.equal((await get('/clients', { ...opts, headers: { cookie: `${cookie}x` } })).status, 401, 'tampered cookie');
    for (let i = 0; i < 5; i++) await post('/auth/login', { password: 'wrong' }, opts);
    assert.equal((await post('/auth/login', { password: 'correct horse' }, opts)).status, 429);
  } finally {
    s.server.close();
  }
});

import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { openDatabase, transaction } from './db.js';
import { HttpError } from './validate.js';
import { localToday } from '../public/js/lib/dates.js';
import { settingsService } from './services/settings.js';
import { numberingService } from './services/numbering.js';
import { taxRatesService, itemsService } from './services/catalog.js';
import { clientsService } from './services/clients.js';
import { documentsService, PAYMENT_METHODS, DOC_VIEW } from './services/documents.js';
import { recurringService } from './services/recurring.js';
import { reportsService } from './services/reports.js';
import { exportsService } from './services/exports.js';
import { paymentReportsService } from './services/payment-reports.js';
import { paymentOptions } from '../public/js/lib/pay-links.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY = 1024 * 1024;
const SESSION_DAYS = 7;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function createApp({ dbPath = ':memory:', today, password, sessionSecret } = {}) {
  const db = openDatabase(dbPath);
  const ctx = {
    db,
    today: today || (() => localToday()),
    tx: (fn) => transaction(db, fn),
    log(entity, entityId, action, detail = {}) {
      db.prepare('INSERT INTO activity (entity, entity_id, action, detail) VALUES (?, ?, ?, ?)').run(
        entity,
        Number(entityId),
        action,
        JSON.stringify(detail),
      );
    },
  };
  ctx.settings = settingsService(ctx);
  ctx.numbering = numberingService(ctx);
  ctx.taxRates = taxRatesService(ctx);
  ctx.items = itemsService(ctx);
  ctx.clients = clientsService(ctx);
  ctx.documents = documentsService(ctx);
  ctx.recurring = recurringService(ctx);
  ctx.reports = reportsService(ctx);
  ctx.exports = exportsService(ctx);
  ctx.paymentReports = paymentReportsService(ctx);

  const auth = createAuth({ password, secret: sessionSecret });
  const routes = buildRoutes(ctx, auth);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    try {
      if (path.startsWith('/api/')) return await handleApi(req, res, url, path);
      return await serveStatic(req, res, path);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleApi(req, res, url, path) {
    const match = matchRoute(routes, req.method, path);
    if (!match) throw new HttpError(match === null ? 404 : 405, match === null ? 'No such endpoint' : 'Method not allowed');
    const { route, params } = match;
    if (!route.public && !auth.check(req)) throw new HttpError(401, 'Sign in required');
    let body;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      // JSON-only writes: a cross-site form cannot send application/json without a preflight.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused');
      const type = req.headers['content-type'] || '';
      const raw = await readBody(req);
      if (raw.length && !type.startsWith('application/json')) throw new HttpError(415, 'Send JSON');
      try {
        body = raw.length ? JSON.parse(raw) : {};
      } catch {
        throw new HttpError(400, 'Malformed JSON');
      }
    }
    const query = Object.fromEntries(url.searchParams);
    const result = await route.handler({ params, query, body, req, res });
    if (res.writableEnded) return;
    if (result && result.__file) {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': result.type,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      });
      return res.end(result.body);
    }
    sendJson(res, route.status || 200, result ?? { ok: true });
  }

  async function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let file;
    if (path === '/' || path === '/index.html') file = 'index.html';
    else if (/^\/p\/[A-Za-z0-9_-]{10,64}$/.test(path)) file = 'share.html';
    else file = path.slice(1);
    const full = resolve(PUBLIC_DIR, normalize(file));
    if (!full.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'Not found');
    let info;
    try {
      info = await stat(full);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!info.isFile()) throw new HttpError(404, 'Not found');
    const data = await readFile(full);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
      'Cache-Control': extname(full) === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  return { handle, ctx, db, close: () => db.close() };
}

// ---------- routing ----------

function compile(pattern) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([a-z_]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
  );
  return { re, keys };
}

function matchRoute(routes, method, path) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      params[k] = /^\d+$/.test(m[i + 1]) ? Number(m[i + 1]) : m[i + 1];
    });
    return { route: r, params };
  }
  return pathMatched ? undefined : null;
}

function buildRoutes(ctx, auth) {
  const r = [];
  const add = (method, pattern, handler, opts = {}) => r.push({ method, ...compile(pattern), handler, ...opts });
  const id = (p) => {
    if (!Number.isInteger(p.id)) throw new HttpError(404, 'Not found');
    return p.id;
  };
  const file = (filename, type, body) => ({ __file: true, filename, type, body });

  // auth
  add('GET', '/api/auth/me', ({ req }) => ({ required: auth.required, signed_in: auth.check(req) }), { public: true });
  add('POST', '/api/auth/login', ({ req, res, body }) => auth.login(req, res, body), { public: true });
  add('POST', '/api/auth/logout', ({ res }) => auth.logout(res), { public: true });

  // public share link — read-only, no internal fields
  add('GET', '/api/public/:token', ({ params }) => publicView(ctx, String(params.token)), { public: true });
  add('POST', '/api/public/:token/report', ({ params, body }) => ctx.paymentReports.report(String(params.token), body), { public: true, status: 201 });

  // meta
  add('GET', '/api/meta', () => ({
    today: ctx.today(),
    payment_methods: PAYMENT_METHODS,
    next_numbers: { invoice: ctx.numbering.preview('invoice'), estimate: ctx.numbering.preview('estimate') },
    badges: badges(ctx),
  }));
  add('GET', '/api/search', ({ query }) => ctx.documents.search(query.q));

  // settings
  add('GET', '/api/settings', () => ctx.settings.get());
  add('PUT', '/api/settings', ({ body }) => ctx.settings.update(body));
  add('PUT', '/api/sequences/:kind', ({ params, body }) => ctx.numbering.setNext(params.kind, Number(body?.next_sequence)));

  // tax rates
  add('GET', '/api/tax-rates', ({ query }) => ctx.taxRates.list({ include_archived: query.archived === '1' }));
  add('POST', '/api/tax-rates', ({ body }) => ctx.taxRates.create(body), { status: 201 });
  add('PUT', '/api/tax-rates/:id', ({ params, body }) => ctx.taxRates.update(id(params), body));
  add('DELETE', '/api/tax-rates/:id', ({ params }) => ctx.taxRates.archive(id(params)));

  // items
  add('GET', '/api/items', ({ query }) => ctx.items.list({ q: query.q, include_archived: query.archived === '1' }));
  add('POST', '/api/items', ({ body }) => ctx.items.create(body), { status: 201 });
  add('GET', '/api/items/:id', ({ params }) => ctx.items.get(id(params)));
  add('PUT', '/api/items/:id', ({ params, body }) => ctx.items.update(id(params), body));
  add('DELETE', '/api/items/:id', ({ params }) => ctx.items.remove(id(params)));

  // clients
  add('GET', '/api/clients', ({ query }) => ctx.clients.list({ q: query.q, include_archived: query.archived === '1' }));
  add('POST', '/api/clients', ({ body }) => ctx.clients.create(body), { status: 201 });
  add('GET', '/api/clients/:id', ({ params }) => ctx.clients.get(id(params)));
  add('PUT', '/api/clients/:id', ({ params, body }) => ctx.clients.update(id(params), body));
  add('DELETE', '/api/clients/:id', ({ params }) => ctx.clients.remove(id(params)));
  add('GET', '/api/clients/:id/statement', ({ params, query }) => ctx.clients.statement(id(params), query));

  // documents (invoices + estimates)
  add('GET', '/api/documents', ({ query }) => ctx.documents.list(query));
  add('POST', '/api/documents', ({ body }) => ctx.documents.create(body), { status: 201 });
  add('GET', '/api/documents/:id', ({ params }) => ctx.documents.get(id(params)));
  add('PUT', '/api/documents/:id', ({ params, body }) => ctx.documents.update(id(params), body));
  add('DELETE', '/api/documents/:id', ({ params }) => ctx.documents.remove(id(params)));
  add('GET', '/api/documents/:id/activity', ({ params }) => ctx.documents.activity(id(params)));
  add('POST', '/api/documents/:id/issue', ({ params, body }) => ctx.documents.issue(id(params), body));
  add('POST', '/api/documents/:id/void', ({ params, body }) => ctx.documents.void(id(params), body));
  add('POST', '/api/documents/:id/duplicate', ({ params }) => ctx.documents.duplicate(id(params)), { status: 201 });
  add('POST', '/api/documents/:id/accept', ({ params }) => ctx.documents.accept(id(params)));
  add('POST', '/api/documents/:id/decline', ({ params }) => ctx.documents.decline(id(params)));
  add('POST', '/api/documents/:id/convert', ({ params }) => ctx.documents.convert(id(params)), { status: 201 });
  add('POST', '/api/documents/:id/share', ({ params }) => ctx.documents.rotateShare(id(params)));
  add('POST', '/api/documents/:id/sent', ({ params, body }) => ctx.documents.markSent(id(params), body));
  add('POST', '/api/documents/:id/payments', ({ params, body }) => ctx.documents.addPayment(id(params), body), { status: 201 });

  // payments
  add('GET', '/api/payments', ({ query }) => ctx.documents.listPayments(query));
  add('DELETE', '/api/payments/:id', ({ params }) => ctx.documents.deletePayment(id(params)));
  add('GET', '/api/payment-reports', ({ query }) => ctx.paymentReports.list({ status: query.status || 'pending' }));
  add('POST', '/api/payment-reports/:id/confirm', ({ params, body }) => ctx.paymentReports.confirm(id(params), body));
  add('POST', '/api/payment-reports/:id/dismiss', ({ params }) => ctx.paymentReports.dismiss(id(params)));

  // recurring
  add('GET', '/api/recurring', ({ query }) => ctx.recurring.list({ client_id: Number(query.client_id) || undefined }));
  add('POST', '/api/recurring', ({ body }) => ctx.recurring.create(body), { status: 201 });
  add('POST', '/api/recurring/run', () => ctx.recurring.runDue());
  add('GET', '/api/recurring/:id', ({ params }) => ctx.recurring.get(id(params)));
  add('PUT', '/api/recurring/:id', ({ params, body }) => ctx.recurring.update(id(params), body));
  add('DELETE', '/api/recurring/:id', ({ params }) => ctx.recurring.remove(id(params)));
  add('POST', '/api/recurring/:id/run', ({ params }) => ctx.recurring.runNow(id(params)), { status: 201 });

  // reports
  add('GET', '/api/reports/dashboard', () => ctx.reports.dashboard());
  add('GET', '/api/reports/aging', () => ctx.reports.aging());
  add('GET', '/api/reports/revenue', ({ query }) => ctx.reports.revenue(query));
  add('GET', '/api/reports/tax', ({ query }) => ctx.reports.tax(query));
  add('GET', '/api/reports/clients', ({ query }) => ctx.reports.topClients(query));

  // activity
  add('GET', '/api/activity', ({ query }) =>
    ctx.db
      .prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(Number(query.limit) || 50, 1), 500))
      .map((a) => ({ ...a, detail: JSON.parse(a.detail) })),
  );

  // exports
  add('GET', '/api/export/invoices.csv', ({ query }) =>
    file(`invoices-${ctx.today()}.csv`, 'text/csv; charset=utf-8', ctx.exports.documentsCsv({ ...query, kind: 'invoice' })));
  add('GET', '/api/export/estimates.csv', ({ query }) =>
    file(`estimates-${ctx.today()}.csv`, 'text/csv; charset=utf-8', ctx.exports.documentsCsv({ ...query, kind: 'estimate' })));
  add('GET', '/api/export/payments.csv', ({ query }) =>
    file(`payments-${ctx.today()}.csv`, 'text/csv; charset=utf-8', ctx.exports.paymentsCsv(query)));
  add('GET', '/api/export/backup.json', () =>
    file(`7labz-invoicing-${ctx.today()}.json`, 'application/json', JSON.stringify(ctx.exports.backup(), null, 2)));

  return r;
}

// Small counts for the sidebar: what needs a hand on it today.
function badges(ctx) {
  return ctx.db
    .prepare(
      `SELECT
         SUM(CASE WHEN kind = 'invoice' AND status = 'overdue' THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN kind = 'invoice' AND status = 'draft' THEN 1 ELSE 0 END) AS drafts,
         SUM(CASE WHEN kind = 'estimate' AND status = 'sent' THEN 1 ELSE 0 END) AS open_estimates,
         (SELECT COUNT(*) FROM payment_reports WHERE status = 'pending') AS reported
       FROM (${DOC_VIEW}) v`,
    )
    .get({ today: ctx.today() });
}

function publicView(ctx, token) {
  const doc = ctx.documents.byToken(token);
  const settings = ctx.settings.get();
  const { client, client_snapshot, business_snapshot, recurring_id, related, share_token, reports, ...rest } = doc;
  const open = doc.kind === 'invoice' && doc.state === 'issued' && doc.balance > 0;
  return {
    document: {
      ...rest,
      client_id: undefined,
      source_estimate_id: undefined,
      payments: doc.payments.map(({ id, amount, date, method }) => ({ id, amount, date, method })),
    },
    pay: open
      ? {
          options: paymentOptions({ ...settings.payments, bank_details: doc.from?.payment_instructions || settings.business.payment_instructions }, doc),
          can_report: !!settings.payments.client_reports,
          reported: reports.length > 0,
        }
      : null,
    locale: settings.locale,
  };
}

// ---------- auth ----------

function createAuth({ password, secret }) {
  const required = !!password;
  const key = secret || randomBytes(32).toString('hex');
  const failures = new Map();

  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  function check(req) {
    if (!required) return true;
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('sid='));
    if (!cookie) return false;
    const [payload, mac] = cookie.slice(4).split('.');
    if (!payload || !mac) return false;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    return Number(Buffer.from(payload, 'base64url').toString()) > Date.now();
  }

  function login(req, res, body) {
    if (!required) return { signed_in: true };
    const ip = req.socket.remoteAddress || '?';
    const f = failures.get(ip) || { count: 0, until: 0 };
    if (f.until > Date.now()) throw new HttpError(429, 'Too many attempts. Wait a few minutes.');
    const given = Buffer.from(createHmac('sha256', key).update(String(body?.password ?? '')).digest());
    const want = Buffer.from(createHmac('sha256', key).update(password).digest());
    if (!timingSafeEqual(given, want)) {
      f.count++;
      if (f.count >= 5) Object.assign(f, { count: 0, until: Date.now() + 15 * 60 * 1000 });
      failures.set(ip, f);
      throw new HttpError(401, 'Wrong password');
    }
    failures.delete(ip);
    const payload = Buffer.from(String(Date.now() + SESSION_DAYS * 86400000)).toString('base64url');
    res.setHeader('Set-Cookie', cookieHeader(`${payload}.${sign(payload)}`, SESSION_DAYS * 86400));
    return { signed_in: true };
  }

  function logout(res) {
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return { signed_in: false };
  }

  function cookieHeader(value, maxAge) {
    const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    return `sid=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  return { required, check, login, logout };
}

// ---------- io ----------

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, err) {
  if (res.headersSent) return res.end();
  if (err instanceof HttpError || err?.status) {
    return sendJson(res, err.status, { error: err.message, details: err.details });
  }
  if (/UNIQUE constraint failed/.test(err?.message)) return sendJson(res, 409, { error: 'That already exists' });
  console.error(err);
  sendJson(res, 500, { error: 'Something failed on the server. It has been logged.' });
}

# 7LABZ Invoicing

Estimates, invoices, payments, recurring billing and receivables reporting for 7LABZ.
Node 22, SQLite, zero npm dependencies.

```sh
npm run seed     # optional: demo clients, invoices, payments, a retainer
npm start        # http://127.0.0.1:7777
npm test         # 44 tests: money math, lifecycle, payments, QuickBooks, HTTP, auth
```

## What it does

**Documents.** Invoices and estimates share one editor and one totals engine.
Lines carry quantity (three decimals), unit, rate, line discount and a tax rate.
A document takes a percent or fixed discount, spread back across the lines
before tax. Estimates convert into draft invoices.

**Lifecycle.** `draft → issued → void` for invoices. `draft → issued → accepted | declined → converted` for estimates.
Display status (`sent`, `partial`, `paid`, `overdue`, `expired`) is derived on
every read and never stored, so it cannot go stale.

- Numbers are assigned **at issue**, sequentially, with no gaps: `7LZ-2026-0001`, `EST-2026-0001`.
  Deleting a draft burns nothing. Prefix, padding and yearly reset are configurable, and the
  next number can be moved forward when moving over from another system.
- Issuing freezes the client's address and the business details onto the document.
- An issued invoice can be edited until it takes a payment. Every revision is logged with
  before and after totals. After a payment, void and reissue instead.
- Voiding needs a zero paid balance and keeps the number in the ledger.

**Payments.** Partial payments, refunds (negative entries, capped at what was paid),
eight methods, references, and removal with an audit entry. Overpayment is refused.

**Recurring.** Weekly, monthly or yearly schedules, every N periods. A schedule anchored
on the 31st bills Feb 28 and then Mar 31. It stops at an end date or after N invoices,
and creates drafts or issues them automatically. The server catches up on start (at most
24 periods) and checks hourly. Reactivating a paused schedule skips the dormant periods.

**Clients.** Billing defaults (currency, terms, tax), CC addresses, internal notes,
lifetime totals per currency, and a statement with a running balance and an opening
balance for any date range. Clients with history are archived, never deleted.

**Reports.** Dashboard KPIs, twelve-month invoiced vs. collected, AR aging
(current / 1–30 / 31–60 / 61–90 / 90+) by client, tax collected per rate (accrual
basis), top clients. CSV exports for invoices, estimates and payments, plus a full JSON backup.

**Sharing.** Each issued document has a read-only link (`/p/<token>`) for the client,
with print and save-as-PDF. Drafts are never public. The link can be replaced, which
kills the old one. The email action opens your mail app with the link and logs the send.

## Getting paid

The app takes no cut and holds no money. Each issued invoice's client link (`/p/<token>`)
carries a **Pay** panel built from Settings → Get paid. Every option is filled in with the exact
balance and the invoice number as the reference, so the money lands straight in your account:

| Method | Currencies | How the client pays | Arrives |
|---|---|---|---|
| Cash App | USD | One-tap link or QR, amount filled in | Instant |
| Venmo | USD | One-tap link or QR, amount and note filled in | Instant |
| Zelle | USD | Your email or phone, amount and memo to copy | Minutes |
| PayPal.me | 23 currencies | One-tap link or QR, amount filled in | Instant to PayPal |
| SEPA | EUR | GiroCode QR (EPC069-12) that banking apps scan into a filled transfer | Seconds on SEPA Instant |
| UPI | INR | `upi://` link or QR | Instant |
| Crypto | any | Wallet address and QR, value to send | Network time |
| Bank transfer | any | Your payment instructions, amount, reference | Depends on the rail |

Methods that don't fit an invoice's currency are hidden. Handles, IBANs (mod-97 checksum)
and wallet addresses are validated when you save them.

**Card payments need a processor.** Card networks only settle through a licensed acquirer, so
cards go through QuickBooks Payments (below).

**Confirming.** Because no processor sits in the middle, the app cannot see your accounts. The
client taps **I've paid**, picks the method and adds a transaction ID. The invoice then shows
under **Needs attention** on the overview and on Payments, with a sidebar badge. One click on
**Confirm received** (amount, date and reference stay editable) records the payment and marks the
invoice paid. **Not received** closes the report and leaves the balance alone. A report never
changes the balance on its own. Each invoice holds at most five pending reports, and reports can
be switched off in Settings.

## QuickBooks Online (card and bank payments)

With QuickBooks connected, every issued invoice is copied to your QuickBooks company with online
card and ACH payment switched on, and the client's link leads with **Pay by card or bank**, which
opens QuickBooks' secure checkout. When the client pays there, the payment is recorded here and the
invoice is marked paid on its own. No confirmation click is needed.

- **Both ledgers agree.** The QuickBooks copy carries the same total to the cent: lines go over as
  amounts, tax as its own line, the discount as a discount line. If QuickBooks computes a different
  total (usually because automatic sales tax added its own tax), the invoice is flagged with the
  reason and the card button is withheld until it matches.
- **Payments flow both ways.** Card or bank payments made in QuickBooks are pulled in by webhook
  (seconds) or, without one, a check every 3 minutes. Payments you record here (Zelle, cash, a
  confirmed report) are copied to QuickBooks so its pay page shows the right balance. Each
  QuickBooks payment is recorded once, keyed by its QuickBooks id.
- **Edits and voids follow.** Revising an issued invoice updates the QuickBooks copy, and voiding
  here voids it there. Refunds are recorded here only; record them in QuickBooks too.
- **Currency.** QuickBooks Payments takes your company's home currency. Other-currency invoices are
  skipped, say why, and keep the direct methods.
- **Existing invoices.** On connect, open invoices are copied over. An invoice already in
  QuickBooks with the same number for the same customer is linked rather than duplicated.
- **Money timing** is QuickBooks Payments' own: check your QuickBooks Payments account for deposit
  speed and fees, including any instant-deposit option.

**Setup**

1. At developer.intuit.com create an app with the Accounting scope. Add the redirect URI
   `https://YOUR-DOMAIN/api/qbo/callback` (Intuit requires HTTPS for production).
2. Set `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, and `QBO_ENVIRONMENT=production`
   for live money (the default `sandbox` uses Intuit's test company). Restart.
3. Settings → QuickBooks Online → **Connect QuickBooks**, and sign in on Intuit's site.
4. Optional, for near-instant updates: in the Intuit app add a webhook to
   `https://YOUR-DOMAIN/api/qbo/webhook` for Payment events, and set `QBO_WEBHOOK_VERIFIER` to
   its verifier token. Webhook bodies are checked against the `intuit-signature` HMAC.

QuickBooks Payments must be active on the company for the pay link to appear. Tokens are stored
encrypted (AES-256-GCM, keyed from the client secret), refreshed automatically, and never included
in backups. **Disconnect** revokes them at Intuit.

## Working in it

- **⌘K / Ctrl+K** or **/** opens the command palette: jump to any invoice, estimate or client by
  number, name, project or PO, or run an action.
- Single keys outside text fields: **N** new invoice, **E** new estimate, **C** new client.
  **G** then a letter jumps: **O** overview, **I** invoices, **E** estimates, **P** payments,
  **R** recurring, **C** clients, **K** catalog, **A** reports, **S** settings.
- In any editor, **⌘S / Ctrl+S** saves and **⌘↵ / Ctrl+Enter** saves and issues. A sticky bar
  keeps the live total in view. Leaving with unsaved changes asks first.
- The overview opens on the outstanding balance, then a **Needs attention** queue: overdue
  invoices (with a one-click reminder email), invoices due within a week, drafts not yet issued,
  and estimates waiting on a reply. Each item has its next action inline. New installs see a
  setup checklist until the basics are in place.
- Lists carry per-status counts on their tabs, search as you type, and a quick action on each row
  (record a payment, or issue a draft).
- Every document shows its next step in one sentence, a paid-progress bar, and an activity log.
  Secondary actions sit under **More**.
- A new client can be added from the client picker without leaving the invoice.

## Money rules

- Amounts are integers in the currency's minor unit (cents, pence; JPY has none, BHD has three).
  Floats never touch a stored amount. Products are computed in BigInt.
- Rounding is half away from zero, at three points only: line gross, line discount, and
  tax **once per rate** (not per line, so ten lines cannot drift by ten roundings).
- Tax rates are stored in parts per million, so 8.875% is exact. Line discounts use basis points.
- Currencies are never converted or summed together. Every report groups by currency.
- The totals engine (`public/js/lib/calc.js`) is one pure module, shared by the browser's
  live preview and the server's stored figures.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `7777` | |
| `HOST` | `127.0.0.1` | Any other host requires `INVOICE_PASSWORD`. |
| `DB_PATH` | `data/invoicing.db` | SQLite, WAL mode. Back up this file, or use Reports → Full backup. |
| `INVOICE_PASSWORD` | unset | Turns on sign-in. Sessions are HMAC-signed, HttpOnly, SameSite=Strict cookies, valid for 7 days. Five failures lock an IP out for 15 minutes. |
| `SESSION_SECRET` | random per start | Set it to keep sessions across restarts. |
| `COOKIE_SECURE` | unset | `1` behind HTTPS. |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | unset | Intuit app keys. Both are needed to connect QuickBooks. |
| `QBO_REDIRECT_URI` | unset | `https://YOUR-DOMAIN/api/qbo/callback`, registered in the Intuit app. |
| `QBO_ENVIRONMENT` | `sandbox` | `production` for real payments. |
| `QBO_WEBHOOK_VERIFIER` | unset | Intuit webhook verifier token, for instant payment updates. |

Writes accept JSON only and refuse cross-site requests (`Sec-Fetch-Site`). The CSP allows
only same-origin scripts, plus Google Fonts.

## Layout

```
src/
  server.js            entry: HTTP server, hourly recurring run
  app.js               router, auth, static files, error mapping
  db.js                schema migrations (PRAGMA user_version), nested transactions
  validate.js          field-level validation; every error reported at once
  services/            settings, numbering, catalog, clients, documents, recurring, reports, exports
public/
  index.html, share.html
  css/app.css          7LABZ tokens → base → components → document → print
  js/lib/              money, dates, calc, doc-render — shared with the server
  js/views/            one module per screen
scripts/seed.js        demo data
test/                  node:test suites
```

## API

JSON over `/api`. Money goes **in** as decimal strings in major units (`"1250.00"`) and comes
**out** as integers in minor units, next to a `currency`. Validation failures return `422`
with `details` keyed by field, using `lines.N.field` for line items.

| | |
|---|---|
| `GET/POST /documents`, `GET/PUT/DELETE /documents/:id` | `?kind=invoice\|estimate&status=open\|overdue\|…&client_id&q&from&to&sort&order&limit&offset` |
| `POST /documents/:id/{issue,void,duplicate,accept,decline,convert,share,sent}` | lifecycle actions |
| `POST /documents/:id/payments`, `DELETE /payments/:id`, `GET /payments` | `{ amount, date, method, reference, note, refund }` |
| `GET /documents/:id/activity` | audit trail |
| `GET /search?q=` | documents and clients for the command palette |
| `/clients`, `/clients/:id/statement`, `/items`, `/tax-rates` | CRUD; deletes archive when there is history |
| `/recurring`, `POST /recurring/run`, `POST /recurring/:id/run` | schedules |
| `/reports/{dashboard,aging,revenue,tax,clients}` | reporting |
| `/export/{invoices,estimates,payments}.csv`, `/export/backup.json` | exports |
| `GET/PUT /settings`, `PUT /sequences/:kind` | business profile, numbering, defaults |
| `GET /public/:token` | the client-facing view and its pay options (no auth, no internal fields) |
| `POST /public/:token/report` | client reports a direct payment: `{ method, amount?, payer, reference }` |
| `GET /payment-reports`, `POST /payment-reports/:id/{confirm,dismiss}` | owner reviews reported payments |
| `GET /qbo/status`, `POST /qbo/{connect,sync,disconnect}`, `POST /documents/:id/qbo` | QuickBooks connection, sync, retry one invoice |
| `GET /qbo/callback`, `POST /qbo/webhook` | Intuit's OAuth redirect and signed webhook (public) |

## Brand

The UI follows the 7LABZ system: near-black `#0A0A0A` surfaces, hairline borders, gold kept
to one element per section (the primary action's arrow, the outstanding figure, the balance
due), and Syne with DM Mono. Status is shown in weight and line style, not color. Documents
print on brand surfaces with `print-color-adjust: exact`.

// Fills a database with realistic demo data relative to today.
// Usage: npm run seed            (uses DB_PATH or data/invoicing.db)
//        npm run seed -- --force (wipes an existing database first)
import { existsSync, rmSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { addDays, addMonths, localToday } from '../public/js/lib/dates.js';

const DB_PATH = process.env.DB_PATH || 'data/invoicing.db';
const force = process.argv.includes('--force');

if (existsSync(DB_PATH)) {
  if (!force) {
    console.error(`${DB_PATH} exists. Re-run with --force to replace it.`);
    process.exit(1);
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
}

const today = localToday();
const { ctx, close } = createApp({ dbPath: DB_PATH, today: () => today });
const { settings, taxRates, items, clients, documents: docs, recurring } = ctx;

settings.update({
  business: {
    name: '7LABZ',
    email: 'billing@7labz.example',
    website: '7labz.example',
    address: '7 Foundry Lane\nSuite 4\nBrooklyn, NY 11201',
    tax_id: 'EIN 00-0000000',
    payment_instructions: 'Bank transfer\nAccount 000123456 · Routing 021000021\nReference the invoice number.',
  },
  defaults: { notes: 'Thank you for the work.', terms: 'Payment due by the date shown. Late balances accrue 1.5% per month.' },
  // Demo handles only. Replace with your own in Settings → Get paid.
  payments: {
    zelle: 'pay@7labz.example',
    zelle_name: '7LABZ LLC',
    cash_app: 'sevenlabzdemo',
    venmo: 'sevenlabz-demo',
    sepa_name: '7LABZ',
    sepa_iban: 'DE89370400440532013000',
    crypto: [{ label: 'USDC on Base', address: '0x0000000000000000000000000000000000007777' }],
  },
});

const salesTax = taxRates.create({ name: 'NY sales tax', rate: '8.875' });
const vat = taxRates.create({ name: 'VAT', rate: '20' });

const sprint = items.create({ name: 'Design sprint', description: 'Five-day product sprint. Research, prototype, test.', unit: 'sprint', unit_price: '12000', currency: 'USD' });
const eng = items.create({ name: 'Engineering', description: 'Senior engineering time.', unit: 'hr', unit_price: '185', currency: 'USD' });
const hosting = items.create({ name: 'Hosting and monitoring', unit: 'month', unit_price: '480', currency: 'USD', tax_rate_id: salesTax.id });
items.create({ name: 'Brand system', description: 'Identity, type system, motion rules.', unit: 'project', unit_price: '18500', currency: 'USD' });
items.create({ name: 'Engineering (GBP)', unit: 'day', unit_price: '1150', currency: 'GBP', tax_rate_id: vat.id });

const halden = clients.create({
  name: 'Mara Okafor', company: 'Halden Robotics', email: 'ap@halden.example', currency: 'USD',
  payment_terms_days: 30, address_line1: '410 Harbor Road', city: 'Oakland', region: 'CA', postal_code: '94607', country: 'United States',
});
const marlow = clients.create({
  name: 'Theo Marlow', company: 'Marlow & Finch', email: 'accounts@marlowfinch.example', currency: 'GBP',
  payment_terms_days: 14, default_tax_rate_id: vat.id, address_line1: '22 Clerkenwell Close', city: 'London',
  postal_code: 'EC1R 0AA', country: 'United Kingdom', tax_id: 'GB000000000',
});
const northwind = clients.create({
  name: 'Ines Duarte', company: 'Northwind Labs', email: 'finance@northwind.example', currency: 'USD',
  payment_terms_days: 15, default_tax_rate_id: salesTax.id, address_line1: '88 Wythe Ave', city: 'Brooklyn',
  region: 'NY', postal_code: '11249', country: 'United States',
});
clients.create({ name: 'Sol Arden', company: 'Arden Audio', email: 'sol@arden.example', currency: 'EUR', payment_terms_days: 30, country: 'Portugal' });

function invoice(client, daysAgo, lines, extra = {}) {
  const issue = addDays(today, -daysAgo);
  const d = docs.create({ client_id: client.id, issue_date: issue, payment_terms_days: client.payment_terms_days, lines, ...extra });
  return docs.issue(d.id);
}

const line = (item, quantity = 1, extra = {}) => ({
  item_id: item.id, description: item.name, quantity, unit: item.unit,
  unit_price: (item.unit_price / 100).toFixed(2), tax_rate_id: item.tax_rate_id, ...extra,
});

// Paid in full, a while back.
const a = invoice(halden, 120, [line(sprint), line(eng, 32)], { title: 'Fleet console — discovery', po_number: 'HR-2231' });
docs.addPayment(a.id, { amount: (a.total / 100).toFixed(2), date: addDays(today, -96), method: 'bank_transfer', reference: 'WIRE 88123' });

// Part paid, now overdue.
const b = invoice(halden, 75, [line(eng, 96, { description: 'Engineering — telemetry pipeline' })], { title: 'Fleet console — build', po_number: 'HR-2240' });
docs.addPayment(b.id, { amount: '8000', date: addDays(today, -40), method: 'bank_transfer', reference: 'WIRE 90455' });

// Overdue, unpaid, GBP with VAT.
invoice(marlow, 44, [
  { description: 'Brand system — phase one', quantity: 1, unit: 'project', unit_price: '9400', tax_rate_id: vat.id },
  { description: 'Type licensing (pass-through)', quantity: 1, unit_price: '640' },
], { title: 'Identity refresh' });

// Open, not yet due, with a 5% discount.
invoice(northwind, 6, [line(sprint), line(hosting, 3)], { title: 'Onboarding flows', discount_type: 'percent', discount_value: '5' });

// Paid by card this month.
const c = invoice(marlow, 20, [{ description: 'Motion guidelines', quantity: 4, unit: 'day', unit_price: '1150', tax_rate_id: vat.id }]);
docs.addPayment(c.id, { amount: (c.total / 100).toFixed(2), date: addDays(today, -3), method: 'card', reference: 'ch_3PZ' });

// A voided invoice keeps its number.
const v = invoice(northwind, 30, [line(eng, 10)]);
docs.void(v.id, { reason: 'Issued to the wrong entity' });

// A draft.
docs.create({ client_id: halden.id, title: 'Fleet console — support', lines: [line(eng, 20)] });

// Estimates: one accepted, one open.
const e1 = docs.issue(docs.create({ kind: 'estimate', client_id: northwind.id, title: 'Mobile app — phase two', lines: [line(sprint, 2), line(eng, 160)] }).id);
docs.accept(e1.id);
docs.issue(docs.create({ kind: 'estimate', client_id: marlow.id, title: 'Website rebuild', lines: [{ description: 'Site architecture and build', quantity: 1, unit_price: '24000', tax_rate_id: vat.id }] }).id);

// A monthly hosting retainer that started four months ago and issues itself.
recurring.create({
  name: 'Hosting retainer', client_id: northwind.id, interval_unit: 'month', interval_count: 1,
  start_date: addMonths(today, -4), auto_issue: true, title: 'Hosting and monitoring',
  lines: [line(hosting, 1)],
});
const { created } = recurring.runDue();

// Most retainer invoices get paid on time.
for (const r of created.slice(0, -2)) {
  const doc = docs.get(r.document_id);
  docs.addPayment(doc.id, { amount: (doc.total / 100).toFixed(2), date: addDays(doc.issue_date, 9), method: 'stripe' });
}

const counts = ctx.db.prepare("SELECT kind, COUNT(*) AS n FROM documents GROUP BY kind").all();
console.log(`Seeded ${DB_PATH}: ${counts.map((r) => `${r.n} ${r.kind}s`).join(', ')}, ${created.length} from recurring.`);
close();

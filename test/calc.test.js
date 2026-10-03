import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDocument, invoiceStatus, estimateStatus } from '../public/js/lib/calc.js';
import { allocate, divRound, mulDiv, toMinor, fromMinor, parseScaled, percentToPpm, ppmToPercent, formatMoney } from '../public/js/lib/money.js';
import { addMonths, addDays, isDate, diffDays } from '../public/js/lib/dates.js';

test('money: parses decimal strings exactly, without floats', () => {
  assert.equal(toMinor('1234.56', 'USD'), 123456);
  assert.equal(toMinor('0.1', 'USD'), 10);
  assert.equal(toMinor('-0.07', 'USD'), -7);
  assert.equal(toMinor('1,000', 'USD'), 100000);
  assert.equal(toMinor(19.99, 'USD'), 1999);
  assert.equal(toMinor('1.005', 'USD'), null, 'more precision than the currency allows');
  assert.equal(toMinor('500', 'JPY'), 500);
  assert.equal(toMinor('500.5', 'JPY'), null, 'JPY has no minor unit');
  assert.equal(toMinor('1.234', 'BHD'), 1234, 'BHD has three');
  for (const bad of ['', 'abc', '1.2.3', '--1', '.', null, NaN]) assert.equal(toMinor(bad, 'USD'), null, String(bad));
});

test('money: formats back', () => {
  assert.equal(fromMinor(123456, 'USD'), '1234.56');
  assert.equal(fromMinor(-5, 'USD'), '-0.05');
  assert.equal(fromMinor(500, 'JPY'), '500');
  assert.equal(formatMoney(123456, 'USD'), '$1,234.56');
});

test('money: rounding is half away from zero, BigInt-safe', () => {
  assert.equal(divRound(5, 2), 3);
  assert.equal(divRound(-5, 2), -3);
  assert.equal(divRound(4, 3), 1);
  assert.equal(mulDiv(9_000_000_000_000, 9_000_000, 1_000_000), 81_000_000_000_000_000 / 1000);
});

test('money: tax rates keep four decimals', () => {
  assert.equal(percentToPpm('8.875'), 88750);
  assert.equal(ppmToPercent(88750), '8.875');
  assert.equal(ppmToPercent(200000), '20');
  assert.equal(parseScaled('8.87501', 4), null);
});

test('allocate: parts always sum to the total', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(10, [0, 5, 5]), [0, 5, 5]);
  assert.deepEqual(allocate(10, [-5, 5]), [0, 10], 'negative weights get nothing');
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  for (let i = 0; i < 200; i++) {
    const w = Array.from({ length: 1 + (i % 7) }, (_, k) => ((i * 37 + k * 101) % 997) + 1);
    const total = (i * 7919) % 100000;
    assert.equal(allocate(total, w).reduce((a, b) => a + b, 0), total);
  }
});

test('calc: quantity × rate, line discount, document discount, tax per rate', () => {
  const t = computeDocument({
    lines: [
      { quantity: '12.5', unit_price: 15000, tax_rate_ppm: 82500, tax_name: 'Sales tax' },
      { quantity: '1', unit_price: 4999, discount_bps: 1000 },
    ],
    discount_type: 'percent',
    discount_value: 500,
  });
  assert.equal(t.lines[0].amount, 187500);
  assert.equal(t.lines[1].line_discount, 500, '10% of 49.99 rounds to 5.00');
  assert.equal(t.lines[1].amount, 4499);
  assert.equal(t.subtotal, 191999);
  assert.equal(t.discount_total, 9600);
  assert.equal(t.lines[0].allocated_discount + t.lines[1].allocated_discount, 9600);
  assert.deepEqual(t.taxes, [{ name: 'Sales tax', rate_ppm: 82500, base: 178125, amount: 14695 }]);
  assert.equal(t.total, 191999 - 9600 + 14695);
});

test('calc: tax rounds once per rate, not once per line', () => {
  const lines = Array.from({ length: 10 }, () => ({ quantity: '1', unit_price: 101, tax_rate_ppm: 82500, tax_name: 'T' }));
  const t = computeDocument({ lines });
  // Per line 8.3325 → 8 each = 80. Per rate: 1010 × 8.25% = 83.325 → 83.
  assert.equal(t.tax_total, 83);
});

test('calc: fixed discount is capped at the subtotal', () => {
  const t = computeDocument({ lines: [{ quantity: 1, unit_price: 1000 }], discount_type: 'fixed', discount_value: 5000 });
  assert.equal(t.discount_total, 1000);
  assert.equal(t.total, 0);
});

test('calc: fractional quantities and credit lines', () => {
  const t = computeDocument({
    lines: [
      { quantity: '0.333', unit_price: 10000 },
      { quantity: '1', unit_price: -2500 },
    ],
  });
  assert.equal(t.lines[0].amount, 3330);
  assert.equal(t.subtotal, 830);
});

test('calc: separate rates stay separate', () => {
  const t = computeDocument({
    lines: [
      { quantity: 1, unit_price: 10000, tax_rate_ppm: 200000, tax_name: 'VAT' },
      { quantity: 1, unit_price: 10000, tax_rate_ppm: 50000, tax_name: 'VAT' },
      { quantity: 1, unit_price: 10000 },
    ],
  });
  assert.deepEqual(t.taxes.map((x) => [x.rate_ppm, x.amount]), [[50000, 500], [200000, 2000]]);
  assert.equal(t.total, 32500);
});

test('status: derived from state, balance and due date', () => {
  const today = '2026-10-03';
  assert.equal(invoiceStatus({ state: 'draft', total: 100 }, today), 'draft');
  assert.equal(invoiceStatus({ state: 'void', total: 100 }, today), 'void');
  assert.equal(invoiceStatus({ state: 'issued', total: 100, paid: 0, due_date: '2026-10-03' }, today), 'sent');
  assert.equal(invoiceStatus({ state: 'issued', total: 100, paid: 0, due_date: '2026-10-02' }, today), 'overdue');
  assert.equal(invoiceStatus({ state: 'issued', total: 100, paid: 40, due_date: '2026-10-09' }, today), 'partial');
  assert.equal(invoiceStatus({ state: 'issued', total: 100, paid: 100, due_date: '2026-01-01' }, today), 'paid');
  assert.equal(estimateStatus({ state: 'issued', due_date: '2026-10-01' }, today), 'expired');
  assert.equal(estimateStatus({ state: 'accepted', due_date: '2026-10-01' }, today), 'accepted');
});

test('dates: month arithmetic clamps and keeps the anchor day', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2026-03-15', -3), '2025-12-15');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(diffDays('2026-03-01', '2026-02-01'), 28);
  assert.ok(isDate('2028-02-29'));
  assert.ok(!isDate('2026-02-29'));
  assert.ok(!isDate('2026-2-1'));
});

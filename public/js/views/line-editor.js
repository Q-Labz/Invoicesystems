// Line-item editor shared by the invoice/estimate editor and the recurring template editor.
import { esc, money, state, toast, select, fromMinor, field, input } from '../ui.js';
import { computeDocument } from '../lib/calc.js';
import { toMinor, percentToBps, bpsToPercent, ppmToPercent, minorDigits } from '../lib/money.js';

export function linesMarkup(items) {
  return `
    <div class="table-wrap">
      <table class="lines">
        <thead><tr>
          <th class="c-desc">Description</th><th class="c-qty num">Qty</th><th class="c-unit">Unit</th>
          <th class="c-price num">Rate</th><th class="c-disc num">Disc %</th><th class="c-tax">Tax</th>
          <th class="c-amt num">Amount</th><th class="c-ctl"><span class="sr-only">Order</span></th>
        </tr></thead>
        <tbody data-lines></tbody>
      </table>
    </div>
    <div class="actions mt-1">
      <button class="btn btn-sm" type="button" data-add-line>Add line</button>
      ${items.length
        ? `<select data-add-item aria-label="Add from catalog"><option value="">Add from catalog…</option>${items.map((it) => `<option value="${it.id}">${esc(it.name)} · ${esc(money(it.unit_price, it.currency))}</option>`).join('')}</select>`
        : '<a class="hint" href="#/items">Build a catalog to add saved services in one click.</a>'}
    </div>`;
}

export function discountMarkup(model) {
  return `<div class="form-grid">
    ${field('Discount', select('discount_type', [['none', 'None'], ['percent', 'Percent'], ['fixed', 'Fixed amount']], model.discount_type), { span: 6 })}
    ${field('Value', input('discount_value', model.discount_value, `inputmode="decimal" ${model.discount_type === 'none' ? 'disabled' : ''}`), { span: 6 })}
  </div>
  <div class="totals mt-2" data-totals></div>`;
}

// Stored lines (minor units) -> editable values (major-unit strings).
export function linesToModel(lines, currency) {
  return lines.map((l) => ({
    item_id: l.item_id,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unit_price: fromMinor(l.unit_price, currency),
    discount_percent: l.discount_bps ? bpsToPercent(l.discount_bps) : '',
    tax_rate_id: l.tax_rate_id || '',
  }));
}

export function discountToModel(type, value, currency) {
  return type === 'percent' ? bpsToPercent(value) : type === 'fixed' ? fromMinor(value, currency) : '';
}

export function blankLine(client) {
  return { description: '', quantity: '1', unit: '', unit_price: '', discount_percent: '', tax_rate_id: client?.default_tax_rate_id || '' };
}

/**
 * Wires up the editor inside `form`. Inputs are named lines.N.field so API
 * validation errors (keyed the same way) land on the right cell.
 */
export function mountLineEditor(form, { lines, items, extraTotals = () => '', onDirty = () => {} }) {
  const tbody = form.querySelector('[data-lines]');
  const itemById = new Map(items.map((it) => [it.id, it]));
  const currency = () => form.elements.namedItem('currency').value;
  const taxOptions = () => [['', 'No tax'], ...state.taxRates.map((t) => [t.id, `${t.name} ${ppmToPercent(t.rate_ppm)}%`])];

  function row(l) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="c-desc"><textarea name="description" rows="1" maxlength="2000" placeholder="Service or deliverable" aria-label="Description">${esc(l.description || '')}</textarea><input type="hidden" name="item_id" value="${esc(l.item_id || '')}"></td>
      <td class="c-qty"><input name="quantity" value="${esc(l.quantity ?? '1')}" inputmode="decimal" class="num" aria-label="Quantity"></td>
      <td class="c-unit"><input name="unit" value="${esc(l.unit || '')}" maxlength="20" placeholder="hr" aria-label="Unit"></td>
      <td class="c-price"><input name="unit_price" value="${esc(l.unit_price ?? '')}" inputmode="decimal" class="num" placeholder="0.00" aria-label="Rate"></td>
      <td class="c-disc"><input name="discount_percent" value="${esc(l.discount_percent ?? '')}" inputmode="decimal" class="num" placeholder="0" aria-label="Line discount percent"></td>
      <td class="c-tax">${select('tax_rate_id', taxOptions(), l.tax_rate_id ?? '', 'aria-label="Tax"')}</td>
      <td class="c-amt num" data-amount>—</td>
      <td class="c-ctl"><button class="icon-btn" type="button" data-move="-1" aria-label="Move line up">↑</button><button class="icon-btn" type="button" data-move="1" aria-label="Move line down">↓</button><button class="icon-btn" type="button" data-remove aria-label="Remove line">×</button></td>`;
    return tr;
  }

  function renumber() {
    [...tbody.rows].forEach((tr, i) => {
      tr.querySelectorAll('[name]').forEach((el) => {
        el.name = `lines.${i}.${el.name.split('.').pop()}`;
      });
    });
  }

  function read() {
    return [...tbody.rows].map((tr) => {
      const v = (n) => tr.querySelector(`[name$=".${n}"]`)?.value ?? '';
      return {
        item_id: v('item_id') ? Number(v('item_id')) : null,
        description: v('description'),
        quantity: v('quantity'),
        unit: v('unit'),
        unit_price: v('unit_price'),
        discount_percent: v('discount_percent'),
        tax_rate_id: v('tax_rate_id') ? Number(v('tax_rate_id')) : null,
      };
    });
  }

  // Lines to send: drop untouched blank rows, but keep one so the server can say what is missing.
  function payload() {
    const all = read();
    const kept = all.filter((l) => l.description || l.unit_price);
    return kept.length ? kept : all.slice(0, 1);
  }

  function recalc() {
    const cur = currency();
    const taxById = new Map(state.taxRates.map((t) => [t.id, t]));
    const lines = read().map((l) => {
      const t = taxById.get(l.tax_rate_id);
      return {
        quantity: l.quantity === '' ? '0' : l.quantity.replace(/,/g, ''),
        unit_price: toMinor(l.unit_price || '0', cur) ?? 0,
        discount_bps: percentToBps(l.discount_percent || '0') ?? 0,
        tax_rate_ppm: t?.rate_ppm || 0,
        tax_name: t?.name || '',
      };
    });
    const dtypeEl = form.elements.namedItem('discount_type');
    const dvalEl = form.elements.namedItem('discount_value');
    const dtype = dtypeEl.value;
    dvalEl.disabled = dtype === 'none';
    const dval = dtype === 'percent' ? percentToBps(dvalEl.value || '0') ?? 0 : dtype === 'fixed' ? toMinor(dvalEl.value || '0', cur) ?? 0 : 0;
    const t = computeDocument({ lines, discount_type: dtype, discount_value: dval });
    [...tbody.rows].forEach((tr, i) => {
      tr.querySelector('[data-amount]').textContent = money(t.lines[i].amount, cur);
    });
    form.querySelector('[data-totals]').innerHTML = `
      <div class="row"><span>Subtotal</span><span>${esc(money(t.subtotal, cur))}</span></div>
      ${t.discount_total ? `<div class="row"><span>Discount</span><span>−${esc(money(t.discount_total, cur))}</span></div>` : ''}
      ${t.taxes.map((x) => `<div class="row"><span>${esc(x.name)} ${esc(ppmToPercent(x.rate_ppm))}%</span><span>${esc(money(x.amount, cur))}</span></div>`).join('')}
      <div class="row grand"><span>Total ${esc(cur)}</span><span>${esc(money(t.total, cur))}</span></div>
      ${extraTotals(cur)}
      ${minorDigits(cur) === 0 ? `<p class="hint mt-1">${esc(cur)} has no minor unit. Whole amounts only.</p>` : ''}`;
    return t;
  }

  function add(l, focus = true) {
    const tr = row(l);
    tbody.append(tr);
    renumber();
    recalc();
    autoGrow(tr.querySelector('textarea'));
    if (focus) tr.querySelector('textarea').focus();
  }

  function setDefaultTax(taxId) {
    if (!taxId) return;
    tbody.querySelectorAll('select[name$=".tax_rate_id"]').forEach((sel) => {
      if (!sel.value) sel.value = String(taxId);
    });
    recalc();
  }

  (lines.length ? lines : [blankLine()]).forEach((l) => add(l, false));

  form.querySelector('[data-add-line]').addEventListener('click', () => {
    add(blankLine());
    onDirty();
  });

  form.querySelector('[data-add-item]')?.addEventListener('change', (e) => {
    const it = itemById.get(Number(e.target.value));
    e.target.value = '';
    if (!it) return;
    const cur = currency();
    if (it.currency !== cur) toast(`${it.name} is priced in ${it.currency}. Enter the ${cur} rate.`, true);
    // Replace a single untouched blank row instead of appending below it.
    const rows = read();
    if (rows.length === 1 && !rows[0].description && !rows[0].unit_price) tbody.innerHTML = '';
    add({
      item_id: it.id,
      description: it.description ? `${it.name}\n${it.description}` : it.name,
      quantity: '1',
      unit: it.unit,
      unit_price: it.currency === cur ? fromMinor(it.unit_price, it.currency) : '',
      discount_percent: '',
      tax_rate_id: it.tax_rate_id || '',
    });
    onDirty();
  });

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (e.target.closest('[data-remove]')) {
      tr.remove();
      if (!tbody.rows.length) add(blankLine(), false);
    } else if (e.target.closest('[data-move]')) {
      const btn = e.target.closest('[data-move]');
      const sib = btn.dataset.move === '-1' ? tr.previousElementSibling : tr.nextElementSibling;
      if (sib) btn.dataset.move === '-1' ? sib.before(tr) : sib.after(tr);
      btn.focus();
    } else return;
    onDirty();
    renumber();
    recalc();
  });

  form.addEventListener('input', (e) => {
    onDirty();
    if (e.target.matches('textarea[name$=".description"]')) autoGrow(e.target);
    recalc();
  });
  form.addEventListener('change', recalc);

  return { read, payload, recalc, setDefaultTax };
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight + 2, 240)}px`;
}

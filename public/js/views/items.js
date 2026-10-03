import { api, esc, money, pageHead, empty, state, toast, dialog, confirmDialog, field, input, select, textarea, qs, go, fromMinor } from '../ui.js';
import { ppmToPercent, isCurrency } from '../lib/money.js';
import { COMMON_CURRENCIES } from './documents.js';

export async function itemsView({ el, query, refresh }) {
  const items = await api(`/items${qs({ q: query.q, archived: query.archived })}`);
  el.innerHTML = `
    ${pageHead('Catalog', 'Services and products', '<button class="cta" type="button" data-new>Add item</button>')}
    <form class="filters" data-filters>
      <label class="field grow"><span>Search</span><input name="q" value="${esc(query.q || '')}"></label>
      <label class="check"><input type="checkbox" name="archived" ${query.archived ? 'checked' : ''}> Show archived</label>
      <button class="btn" type="submit">Filter</button>
    </form>
    ${items.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Unit</th><th>Tax</th><th class="num">Rate</th><th></th></tr></thead>
      <tbody>${items.map((it) => `<tr>
        <td>${esc(it.name)}${it.archived ? ' <span class="status">archived</span>' : ''}${it.description ? `<br><span class="muted pre">${esc(it.description)}</span>` : ''}</td>
        <td class="muted">${esc(it.unit || '—')}</td>
        <td class="muted">${it.tax_name ? `${esc(it.tax_name)} ${esc(ppmToPercent(it.tax_rate_ppm))}%` : '—'}</td>
        <td class="num">${esc(money(it.unit_price, it.currency))}</td>
        <td class="num"><button class="btn btn-sm" type="button" data-edit="${it.id}">Edit</button> <button class="btn btn-sm btn-quiet" type="button" data-del="${it.id}">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table></div>` : empty('No saved items. Save the services you bill often and add them to invoices in one click.')}`;

  el.querySelector('[data-filters]').addEventListener('submit', (e) => {
    e.preventDefault();
    go(`/items${qs({ q: e.target.q.value, archived: e.target.archived.checked ? '1' : '' })}`);
  });
  el.querySelector('[data-new]').addEventListener('click', async () => {
    if (await itemDialog(null)) refresh();
  });
  el.addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) {
      if (await itemDialog(items.find((i) => i.id === Number(edit.dataset.edit)))) refresh();
    } else if (del) {
      const it = items.find((i) => i.id === Number(del.dataset.del));
      if (!(await confirmDialog(`Remove ${it.name}?`, 'Items already used on documents are archived instead, so past invoices keep their lines.', 'Remove'))) return;
      try {
        const out = await api(`/items/${it.id}`, { method: 'DELETE' });
        toast(out.archived ? 'Archived' : 'Removed');
        refresh();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });
}

function itemDialog(it) {
  const cur = it?.currency || state.settings.defaults.currency;
  const currencies = [...new Set([cur, ...COMMON_CURRENCIES])].filter(isCurrency);
  return dialog({
    title: it ? `Edit ${it.name}` : 'New item',
    submit: it ? 'Save item' : 'Add item',
    body: `<div class="form-grid">
      ${field('Name', input('name', it?.name, 'required maxlength="120"'), { span: 12 })}
      ${field('Description', textarea('description', it?.description, 'maxlength="2000" rows="3"'), { span: 12, hint: 'Printed under the name on invoices.' })}
      ${field('Rate', input('unit_price', it ? fromMinor(it.unit_price, it.currency) : '', 'inputmode="decimal" required'), { span: 4 })}
      ${field('Currency', select('currency', currencies.map((c) => [c, c]), cur), { span: 4 })}
      ${field('Unit', input('unit', it?.unit, 'maxlength="20" placeholder="hr, day, seat"'), { span: 4 })}
      ${field('Tax', select('tax_rate_id', [['', 'None'], ...state.taxRates.map((t) => [t.id, `${t.name} ${ppmToPercent(t.rate_ppm)}%`])], it?.tax_rate_id || ''), { span: 12 })}
      ${it?.archived ? `<label class="check span-12"><input type="checkbox" name="archived" checked> Archived</label>` : ''}
    </div>`,
    onSubmit: (v) => api(it ? `/items/${it.id}` : '/items', {
      method: it ? 'PUT' : 'POST',
      body: { ...v, tax_rate_id: v.tax_rate_id ? Number(v.tax_rate_id) : null },
    }),
  });
}

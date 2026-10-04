import { api, esc, money, date, pageHead, empty, state, toast, confirmDialog, showErrors, clearErrors, field, input, select, textarea, go, setLeaveGuard } from '../ui.js';
import { isCurrency } from '../lib/money.js';
import { rowLinks } from '../ui.js';
import { COMMON_CURRENCIES, bindSaveKeys } from './documents.js';
import { linesMarkup, discountMarkup, mountLineEditor, linesToModel, discountToModel, blankLine } from './line-editor.js';

const UNITS = { week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] };

export function cadence(r) {
  const [one, many] = UNITS[r.interval_unit];
  return r.interval_count === 1 ? `Every ${one}` : `Every ${r.interval_count} ${many}`;
}

export async function recurringListView({ el, refresh }) {
  const list = await api('/recurring');
  el.innerHTML = `
    ${pageHead('Schedules', 'Recurring invoices', `
      <button class="btn btn-quiet" type="button" data-run>Run due now</button>
      <a class="cta" href="#/recurring/new">New schedule</a>`)}
    <p class="hint">The server checks schedules on start and every hour. Each run creates the invoice dated on its period, numbered in order.</p>
    ${list.length ? `<div class="table-wrap mt-2"><table>
      <thead><tr><th>Schedule</th><th>Client</th><th>Cadence</th><th>Next</th><th class="num">Runs</th><th class="num">Amount</th><th>State</th></tr></thead>
      <tbody>${list.map((r) => `<tr class="row-link" data-href="#/recurring/${r.id}">
        <td><a href="#/recurring/${r.id}">${esc(r.name)}</a></td>
        <td>${esc(r.client_name)}</td>
        <td class="muted">${esc(cadence(r))}${r.auto_issue ? ' · auto-issue' : ' · as draft'}</td>
        <td class="muted">${r.active ? esc(date(r.next_run)) : '—'}</td>
        <td class="num">${r.runs_done}${r.max_runs ? ` / ${r.max_runs}` : ''}</td>
        <td class="num">${esc(money(r.total, r.currency))}</td>
        <td><span class="status ${r.active ? 'status-active' : ''}">${r.active ? 'active' : 'stopped'}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>` : empty('No schedules. Retainers, hosting and licences bill themselves from here.')}`;
  el.addEventListener('click', rowLinks);
  el.querySelector('[data-run]').addEventListener('click', async () => {
    try {
      const { created } = await api('/recurring/run', { method: 'POST' });
      toast(created.length ? `Created ${created.length} invoice${created.length === 1 ? '' : 's'}` : 'Nothing due today');
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

export async function recurringEditView({ el, refresh }, id) {
  const [r, clients, items, generated] = await Promise.all([
    id ? api(`/recurring/${id}`) : null,
    api('/clients'),
    api('/items'),
    id ? api(`/documents?kind=invoice&recurring_id=${id}&limit=24`) : null,
  ]);
  if (!clients.length) {
    el.innerHTML = `${pageHead('Schedules', 'New schedule')}${empty('Add a client first.', '<a class="cta" href="#/clients/new">Add a client</a>')}`;
    return;
  }
  const s = state.settings;
  const first = clients.length === 1 ? clients[0] : null;
  const model = r
    ? { ...r, discount_value: discountToModel(r.discount_type, r.discount_value, r.currency), lines: linesToModel(r.lines, r.currency) }
    : {
        name: '', client_id: first?.id || '', currency: first?.currency || s.defaults.currency,
        interval_unit: 'month', interval_count: 1, start_date: state.meta.today, end_date: '', max_runs: '',
        auto_issue: 0, active: 1, payment_terms_days: first?.payment_terms_days ?? s.defaults.payment_terms_days,
        title: '', notes: s.defaults.notes, terms: s.defaults.terms, discount_type: 'none', discount_value: '',
        lines: [blankLine(first)],
      };
  const currencies = [...new Set([model.currency, ...clients.map((c) => c.currency), ...COMMON_CURRENCIES])].filter(isCurrency);

  el.innerHTML = `
    ${pageHead(r ? `${cadence(r)} · ${r.active ? 'active' : 'stopped'}` : 'Schedules', r ? r.name : 'New schedule', `
      <a class="btn btn-quiet" href="#/recurring">Back</a>
      ${r?.active ? '<button class="btn" type="button" data-run-now>Generate next now</button>' : ''}
      ${r ? `<button class="btn btn-quiet" type="button" data-remove>${generated?.count ? 'Stop' : 'Delete'}</button>` : ''}
      <button class="cta" type="submit" form="rec-form" data-mode="save">${r ? 'Save schedule' : 'Start schedule'}</button>`)}

    <form id="rec-form" class="editor" novalidate autocomplete="off">
      <div>
        <section class="section form-grid">
          ${field('Schedule name', input('name', model.name, 'required maxlength="120" placeholder="Monthly retainer"'), { span: 6 })}
          ${field('Client', select('client_id', [['', 'Choose a client'], ...clients.map((c) => [c.id, c.name])], model.client_id), { span: 4 })}
          ${field('Currency', select('currency', currencies.map((c) => [c, c]), model.currency), { span: 2 })}
          ${field('Every', input('interval_count', model.interval_count, 'type="number" min="1" max="36"'), { span: 2 })}
          ${field('Period', select('interval_unit', [['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']], model.interval_unit), { span: 2 })}
          ${field(r?.runs_done ? 'Started' : 'First invoice', input('start_date', model.start_date, `type="date" ${r?.runs_done ? 'readonly' : ''}`), { span: 4, hint: r?.runs_done ? '' : 'Month-end dates stay month-end.' })}
          ${field('Terms (days)', input('payment_terms_days', model.payment_terms_days, 'type="number" min="0" max="365"'), { span: 4 })}
          ${field('End after date', input('end_date', model.end_date || '', 'type="date"'), { span: 4, hint: 'Optional' })}
          ${field('Or after N invoices', input('max_runs', model.max_runs ?? '', 'type="number" min="1" max="1000"'), { span: 4, hint: 'Optional' })}
          <label class="check span-4"><input type="checkbox" name="auto_issue" ${model.auto_issue ? 'checked' : ''}> Issue automatically</label>
          ${r ? `<label class="check span-12"><input type="checkbox" name="active" ${model.active ? 'checked' : ''}> Active${!r.active ? ' — reactivating skips missed periods' : ''}</label>` : ''}
          ${field('Project on each invoice', input('title', model.title, 'maxlength="200"'), { span: 12 })}
        </section>
        <section class="section">
          <div class="section-head"><h2>Template lines</h2><span class="hint">Tax rates are read at each run</span></div>
          ${linesMarkup(items)}
        </section>
      </div>
      <aside class="editor-totals">
        <div class="panel"><h3>Each invoice</h3>${discountMarkup(model)}</div>
        ${r ? `<div class="panel">
          <h3>Next runs</h3>
          ${r.upcoming.length ? `<ol class="timeline">${r.upcoming.map((d) => `<li>${esc(date(d))}</li>`).join('')}</ol>` : '<p class="muted">Nothing scheduled.</p>'}
        </div>
        <div class="panel">
          <h3>Generated · ${generated.count}</h3>
          ${generated.rows.length ? `<table><tbody>${generated.rows.map((d) => `<tr class="row-link" data-href="#/invoices/${d.id}">
            <td><a href="#/invoices/${d.id}">${esc(d.number || 'Draft')}</a><br><span class="muted">${esc(date(d.issue_date))}</span></td>
            <td class="num">${esc(money(d.total, d.currency))}<br><span class="status status-${esc(d.status)}">${esc(d.status)}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">None yet.</p>'}
        </div>` : ''}
      </aside>
      <div>
        <section class="section form-grid">
          ${field('Notes to client', textarea('notes', model.notes, 'maxlength="4000" rows="3"'), { span: 6 })}
          ${field('Terms', textarea('terms', model.terms, 'maxlength="8000" rows="3"'), { span: 6 })}
        </section>
      </div>
    </form>`;

  const form = el.querySelector('#rec-form');
  const f = (n) => form.elements.namedItem(n);
  let dirty = false;
  const editor = mountLineEditor(form, { lines: model.lines, items, onDirty: () => (dirty = true) });
  setLeaveGuard(() => dirty);
  bindSaveKeys(form, 'save');

  f('client_id').addEventListener('change', () => {
    const c = clients.find((x) => x.id === Number(f('client_id').value));
    if (!c) return;
    f('currency').value = c.currency;
    f('payment_terms_days').value = c.payment_terms_days;
    editor.setDefaultTax(c.default_tax_rate_id);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const body = {
      name: f('name').value,
      client_id: Number(f('client_id').value) || null,
      currency: f('currency').value,
      interval_unit: f('interval_unit').value,
      interval_count: Number(f('interval_count').value) || 1,
      end_date: f('end_date').value || null,
      max_runs: f('max_runs').value ? Number(f('max_runs').value) : null,
      auto_issue: f('auto_issue').checked,
      payment_terms_days: f('payment_terms_days').value === '' ? undefined : Number(f('payment_terms_days').value),
      title: f('title').value,
      notes: f('notes').value,
      terms: f('terms').value,
      discount_type: f('discount_type').value,
      discount_value: f('discount_type').value === 'none' ? '0' : f('discount_value').value,
      lines: editor.payload(),
    };
    if (!r?.runs_done) body.start_date = f('start_date').value;
    if (r) body.active = f('active').checked;
    try {
      const saved = await api(r ? `/recurring/${r.id}` : '/recurring', { method: r ? 'PUT' : 'POST', body });
      dirty = false;
      toast(r ? 'Schedule saved' : 'Schedule started');
      if (r) refresh();
      else go(`/recurring/${saved.id}`);
    } catch (err) {
      showErrors(form, err);
    }
  });

  el.addEventListener('click', rowLinks);
  el.querySelector('[data-run-now]')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Generate the next invoice now?', `It is dated ${date(r.next_run)}, and the schedule moves one period on.`, 'Generate', false))) return;
    try {
      const doc = await api(`/recurring/${r.id}/run`, { method: 'POST' });
      toast(doc.number ? `Issued ${doc.number}` : 'Draft invoice created');
      go(`/invoices/${doc.id}`);
    } catch (err) {
      toast(err.message, true);
    }
  });
  el.querySelector('[data-remove]')?.addEventListener('click', async () => {
    const stop = generated?.count;
    if (!(await confirmDialog(stop ? 'Stop this schedule?' : 'Delete this schedule?', stop ? 'Invoices already generated stay as they are.' : 'Nothing has been generated from it.', stop ? 'Stop' : 'Delete'))) return;
    try {
      await api(`/recurring/${r.id}`, { method: 'DELETE' });
      toast(stop ? 'Schedule stopped' : 'Schedule deleted');
      go('/recurring');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

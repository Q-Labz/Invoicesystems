import { api, esc, pageHead, state, toast, dialog, confirmDialog, showErrors, clearErrors, field, input, select, textarea } from '../ui.js';
import { ppmToPercent, isCurrency } from '../lib/money.js';
import { COMMON_CURRENCIES, bindSaveKeys } from './documents.js';
import { setLeaveGuard } from '../ui.js';

export async function settingsView({ el, refresh }) {
  const [s, taxRates, meta] = await Promise.all([api('/settings'), api('/tax-rates?archived=1'), api('/meta')]);
  const b = s.business;
  const p = s.payments;
  const n = s.numbering;
  const d = s.defaults;
  const currencies = [...new Set([d.currency, ...COMMON_CURRENCIES])].filter(isCurrency);

  el.innerHTML = `
    ${pageHead('Settings', 'Business and defaults', '<button class="cta" type="submit" form="settings-form" data-mode="save">Save settings</button>')}

    <form id="settings-form" novalidate>
      <section class="section">
        <h2>Business</h2>
        <p class="hint">Printed on every document. Issued documents keep the details they were issued with.</p>
        <div class="form-grid mt-2">
          ${field('Business name', input('business.name', b.name, 'required maxlength="120"'), { span: 6 })}
          ${field('Email', input('business.email', b.email, 'type="email"'), { span: 6 })}
          ${field('Phone', input('business.phone', b.phone, 'maxlength="60"'), { span: 4 })}
          ${field('Website', input('business.website', b.website, 'maxlength="200"'), { span: 4 })}
          ${field('Tax / VAT ID', input('business.tax_id', b.tax_id, 'maxlength="60"'), { span: 4 })}
          ${field('Address', textarea('business.address', b.address, 'rows="4" maxlength="600"'), { span: 6 })}
          ${field('Payment instructions', textarea('business.payment_instructions', b.payment_instructions, 'rows="4" maxlength="2000" placeholder="Bank, account, routing / IBAN, SWIFT"'), { span: 6, hint: 'Shown on invoices as “How to pay”.' })}
        </div>
      </section>

      <section class="section">
        <h2>Numbering</h2>
        <p class="hint">Numbers are assigned when a document is issued, in order, with no gaps. Next invoice: <span class="mono">${esc(meta.next_numbers.invoice.next)}</span> · next estimate: <span class="mono">${esc(meta.next_numbers.estimate.next)}</span></p>
        <div class="form-grid mt-2">
          ${field('Invoice prefix', input('numbering.invoice_prefix', n.invoice_prefix, 'maxlength="16"'), { span: 3 })}
          ${field('Estimate prefix', input('numbering.estimate_prefix', n.estimate_prefix, 'maxlength="16"'), { span: 3 })}
          ${field('Digits', input('numbering.padding', n.padding, 'type="number" min="1" max="8"'), { span: 2 })}
          <label class="check span-4"><input type="checkbox" name="numbering.yearly" ${n.yearly ? 'checked' : ''}> Include year, restart each January</label>
        </div>
        <div class="actions mt-2">
          <button class="btn btn-sm" type="button" data-seq="invoice">Set next invoice number</button>
          <button class="btn btn-sm" type="button" data-seq="estimate">Set next estimate number</button>
        </div>
      </section>

      <section class="section" id="get-paid">
        <h2>Get paid</h2>
        <p class="hint">Each method you fill in appears on the client's invoice link with the exact amount and invoice number, as a one-tap link or a QR code. Money goes straight to your account; the app never holds it. Leave a field empty to hide that method.</p>
        <div class="form-grid mt-2">
          ${field('Zelle email or phone', input('payments.zelle', p.zelle, 'maxlength="120" placeholder="pay@yourbusiness.com"'), { span: 6, hint: 'USD invoices. Usually arrives within minutes.' })}
          ${field('Name on Zelle', input('payments.zelle_name', p.zelle_name, 'maxlength="80"'), { span: 6, hint: 'So the client sees who they are paying.' })}
          ${field('Cash App $Cashtag', input('payments.cash_app', p.cash_app ? `$${p.cash_app}` : '', 'maxlength="21" placeholder="$yourtag"'), { span: 4, hint: 'USD. Instant.' })}
          ${field('Venmo username', input('payments.venmo', p.venmo ? `@${p.venmo}` : '', 'maxlength="31" placeholder="@yourbusiness"'), { span: 4, hint: 'USD. Instant.' })}
          ${field('PayPal.me name', input('payments.paypal', p.paypal, 'maxlength="20" placeholder="yourbusiness"'), { span: 4, hint: 'Many currencies. Instant to your PayPal balance.' })}
          ${field('SEPA account holder', input('payments.sepa_name', p.sepa_name, 'maxlength="70"'), { span: 4, hint: 'EUR invoices get a GiroCode QR.' })}
          ${field('IBAN', input('payments.sepa_iban', p.sepa_iban, 'maxlength="42" autocomplete="off"'), { span: 6 })}
          ${field('BIC', input('payments.sepa_bic', p.sepa_bic, 'maxlength="11"'), { span: 2 })}
          ${field('UPI ID', input('payments.upi_vpa', p.upi_vpa, 'maxlength="256" placeholder="name@bank"'), { span: 6, hint: 'INR invoices. Instant.' })}
          ${field('Name on UPI', input('payments.upi_name', p.upi_name, 'maxlength="80"'), { span: 6 })}
        </div>
        <h3 class="mt-3">Crypto wallets</h3>
        <p class="hint">Name the coin and network exactly (e.g. "USDC on Base"). A payment sent on the wrong network is lost.</p>
        <div class="form-grid mt-1">
          ${[0, 1, 2, 3].map((i) => `
          ${field(i ? '' : 'Coin and network', input(`payments.crypto.${i}.label`, p.crypto[i]?.label, 'maxlength="40" data-crypto="label"'), { span: 4 })}
          ${field(i ? '' : 'Wallet address', input(`payments.crypto.${i}.address`, p.crypto[i]?.address, 'maxlength="128" autocomplete="off" spellcheck="false" data-crypto="address"'), { span: 8 })}`).join('')}
        </div>
        <label class="check mt-2"><input type="checkbox" name="payments.client_reports" ${p.client_reports ? 'checked' : ''}> Let clients tell you they've paid ("I've paid" button on the invoice link)</label>
        <p class="hint mt-1">Bank transfer details come from "Payment instructions" above.</p>
      </section>

      <section class="section">
        <h2>Defaults for new documents</h2>
        <div class="form-grid mt-2">
          ${field('Currency', select('defaults.currency', currencies.map((c) => [c, c]), d.currency), { span: 3 })}
          ${field('Payment terms (days)', input('defaults.payment_terms_days', d.payment_terms_days, 'type="number" min="0" max="365"'), { span: 3 })}
          ${field('Estimates valid (days)', input('defaults.estimate_valid_days', d.estimate_valid_days, 'type="number" min="1" max="365"'), { span: 3 })}
          ${field('Locale', input('locale', s.locale, 'maxlength="20" placeholder="en-US"'), { span: 3, hint: 'Number and date format.' })}
          ${field('Default notes', textarea('defaults.notes', d.notes, 'rows="3" maxlength="2000"'), { span: 6 })}
          ${field('Default terms', textarea('defaults.terms', d.terms, 'rows="3" maxlength="4000"'), { span: 6 })}
        </div>
      </section>
    </form>

    <section class="section">
      <div class="section-head"><h2>Tax rates</h2><button class="btn" type="button" data-new-tax>Add rate</button></div>
      <p class="hint">Documents store the rate they were issued with, so changing a rate never rewrites history.</p>
      ${taxRates.length ? `<div class="table-wrap mt-2"><table>
        <thead><tr><th>Name</th><th class="num">Rate</th><th></th></tr></thead>
        <tbody>${taxRates.map((t) => `<tr>
          <td>${esc(t.name)}${t.archived ? ' <span class="status">archived</span>' : ''}</td>
          <td class="num">${esc(ppmToPercent(t.rate_ppm))}%</td>
          <td class="num"><button class="btn btn-sm" type="button" data-edit-tax="${t.id}">Edit</button>
            ${t.archived ? `<button class="btn btn-sm btn-quiet" type="button" data-restore-tax="${t.id}">Restore</button>` : `<button class="btn btn-sm btn-quiet" type="button" data-archive-tax="${t.id}">Archive</button>`}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted mt-2">No tax rates. Add one to charge sales tax or VAT.</p>'}
    </section>`;

  const form = el.querySelector('#settings-form');
  let dirty = false;
  form.addEventListener('input', () => (dirty = true));
  setLeaveGuard(() => dirty);
  bindSaveKeys(form, 'save');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const body = { business: {}, numbering: {}, defaults: {}, payments: { crypto: [] } };
    for (const elx of form.elements) {
      if (!elx.name) continue;
      const cm = /^payments\.crypto\.(\d)\.(label|address)$/.exec(elx.name);
      if (cm) {
        (body.payments.crypto[cm[1]] ||= { label: '', address: '' })[cm[2]] = elx.value;
        continue;
      }
      const value = elx.type === 'checkbox' ? elx.checked : elx.type === 'number' ? (elx.value === '' ? undefined : Number(elx.value)) : elx.value;
      const [group, key] = elx.name.split('.');
      if (key) body[group][key] = value;
      else body[group] = value;
    }
    try {
      state.settings = await api('/settings', { method: 'PUT', body });
      dirty = false;
      state.meta = await api('/meta');
      toast('Settings saved');
      refresh();
    } catch (err) {
      showErrors(form, err);
    }
  });

  el.querySelectorAll('[data-seq]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.seq;
      const cur = meta.next_numbers[kind];
      const ok = await dialog({
        title: `Next ${kind} number`,
        body: `<p>For moving over from another system. Numbers only go forward.</p>
          <div class="form-grid">${field('Next sequence', input('next_sequence', cur.next_sequence, 'type="number" min="1" required'), { span: 6, hint: `Currently ${cur.next}` })}</div>`,
        submit: 'Set number',
        onSubmit: (v) => api(`/sequences/${kind}`, { method: 'PUT', body: { next_sequence: Number(v.next_sequence) } }),
      });
      if (ok) {
        toast(`Next ${kind}: ${ok.next}`);
        refresh();
      }
    }),
  );

  const reloadTaxes = async () => {
    state.taxRates = await api('/tax-rates');
    refresh();
  };
  const taxDialog = (t) =>
    dialog({
      title: t ? `Edit ${t.name}` : 'New tax rate',
      submit: t ? 'Save rate' : 'Add rate',
      body: `<div class="form-grid">
        ${field('Name', input('name', t?.name, 'required maxlength="60" placeholder="VAT"'), { span: 8 })}
        ${field('Rate %', input('rate', t ? ppmToPercent(t.rate_ppm) : '', 'inputmode="decimal" required placeholder="20"'), { span: 4 })}
      </div>`,
      onSubmit: (v) => api(t ? `/tax-rates/${t.id}` : '/tax-rates', { method: t ? 'PUT' : 'POST', body: v }),
    });

  el.querySelector('[data-new-tax]').addEventListener('click', async () => {
    if (await taxDialog(null)) reloadTaxes();
  });
  el.addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit-tax]');
    const arch = e.target.closest('[data-archive-tax]');
    const rest = e.target.closest('[data-restore-tax]');
    try {
      if (edit) {
        if (await taxDialog(taxRates.find((t) => t.id === Number(edit.dataset.editTax)))) reloadTaxes();
      } else if (arch) {
        if (!(await confirmDialog('Archive this rate?', 'It stops appearing on new lines. Existing documents keep it.', 'Archive'))) return;
        await api(`/tax-rates/${arch.dataset.archiveTax}`, { method: 'DELETE' });
        reloadTaxes();
      } else if (rest) {
        await api(`/tax-rates/${rest.dataset.restoreTax}`, { method: 'PUT', body: { archived: false } });
        reloadTaxes();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

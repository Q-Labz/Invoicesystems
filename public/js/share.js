import { renderDocument, esc } from './lib/doc-render.js';
import { formatMoney } from './lib/money.js';
import { qrSvg } from './lib/qr.js';

const root = document.getElementById('root');
const token = location.pathname.split('/').pop();

async function load() {
  const res = await fetch(`/api/public/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'This link is no longer valid.' : 'Could not load the document.');
  return res.json();
}

function render({ document: doc, pay, locale }) {
  const from = doc.from?.name || '7LABZ';
  document.title = `${doc.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${doc.number} — ${from}`;
  const balance = formatMoney(doc.balance, doc.currency, locale);
  root.innerHTML = `
    <div class="share-bar"><button class="btn" id="print" type="button">Print or save as PDF</button></div>
    ${pay?.reported ? `<section class="pay pay-done" role="status"><h2>Payment reported</h2><p>Thank you. ${esc(from)} will confirm it as soon as it arrives.</p></section>` : ''}
    ${pay && pay.options.length && !pay.reported ? payPanel(pay, balance, doc) : ''}
    ${renderDocument(doc, { locale })}`;
  document.getElementById('print').addEventListener('click', () => window.print());
  if (pay && pay.options.length && !pay.reported) bindPay(pay, doc);
}

function payPanel(pay, balance, doc) {
  const opts = pay.options;
  return `
  <section class="pay" aria-labelledby="pay-h">
    <div class="pay-head">
      <div>
        <div class="eyebrow">Pay ${esc(doc.number)}</div>
        <h2 id="pay-h" class="pay-amount">${esc(balance)}</h2>
      </div>
      <p class="hint">${opts[0].method === 'quickbooks'
        ? `Card and bank details go only to QuickBooks' secure checkout, never this page.`
        : `Paid directly to ${esc(doc.from?.name || 'us')}. No card details are taken here.`}</p>
    </div>
    <div class="tabs pay-tabs" role="tablist">
      ${opts.map((o, i) => `<button type="button" role="tab" id="pt-${i}" aria-controls="pp-${i}" aria-selected="${i === 0}" ${i === 0 ? 'aria-current="true"' : 'tabindex="-1"'}>${esc(o.label)}</button>`).join('')}
    </div>
    ${opts.map((o, i) => `
    <div class="pay-pane" role="tabpanel" id="pp-${i}" aria-labelledby="pt-${i}" ${i === 0 ? '' : 'hidden'}>
      <div class="pay-body">
        <dl class="pay-fields">${o.fields.map((f) => `
          <dt>${esc(f.label)}</dt>
          <dd><span class="pay-value">${esc(f.value)}</span><button class="btn btn-sm btn-quiet" type="button" data-copy="${esc(f.copy)}" aria-label="Copy ${esc(f.label)}">Copy</button></dd>`).join('')}
        </dl>
        ${o.qr ? `<figure class="pay-qr">${qrSvg(o.qr, { label: `${o.label} QR code` })}<figcaption class="hint">Scan with your phone</figcaption></figure>` : ''}
      </div>
      <p class="hint">${esc(o.speed)}${o.note ? `. ${esc(o.note)}` : ''}</p>
      ${o.href ? `<a class="btn btn-solid" href="${esc(o.href)}" target="_blank" rel="noopener">${esc(o.cta || `Open ${o.label} with ${balance} filled in`)} ↗</a>` : ''}
    </div>`).join('')}
    ${pay.can_report && opts.some((o) => o.method !== 'quickbooks') ? `
    <details class="pay-report">
      <summary class="cta">${opts[0].method === 'quickbooks' ? 'Paid another way?' : "I've paid"}</summary>
      <form id="report" novalidate>
        <div class="form-grid">
          <label class="field span-6"><span>Paid with</span><select name="method">${opts.filter((o) => o.method !== 'quickbooks').map((o) => `<option value="${esc(o.method)}">${esc(o.label)}</option>`).join('')}</select></label>
          <label class="field span-6"><span>Your name</span><input name="payer" maxlength="120" autocomplete="name"></label>
          <label class="field span-12"><span>Confirmation or transaction ID</span><input name="reference" maxlength="120" placeholder="Optional, helps match the payment"></label>
        </div>
        <button class="btn btn-solid mt-2" type="submit">Send confirmation</button>
      </form>
    </details>` : ''}
  </section>`;
}

function bindPay(pay, doc) {
  const tabs = [...root.querySelectorAll('.pay-tabs [role=tab]')];
  const select = (i) => {
    tabs.forEach((t, j) => {
      const on = i === j;
      t.setAttribute('aria-selected', on);
      t.toggleAttribute('aria-current', on);
      t.tabIndex = on ? 0 : -1;
      document.getElementById(`pp-${j}`).hidden = !on;
    });
    const sel = root.querySelector('#report select[name=method]');
    const m = pay.options[i]?.method;
    if (sel && [...sel.options].some((o) => o.value === m)) sel.value = m;
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(i));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      select(n);
      tabs[n].focus();
    });
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select it';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1600);
  });

  const form = document.getElementById('report');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const body = Object.fromEntries(new FormData(form));
    try {
      const res = await fetch(`/api/public/${encodeURIComponent(token)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send. Try again.');
      render(await load());
      root.querySelector('.pay-done')?.focus?.();
    } catch (err) {
      btn.disabled = false;
      let msg = form.querySelector('.field-error');
      if (!msg) {
        msg = document.createElement('p');
        msg.className = 'field-error';
        form.append(msg);
      }
      msg.textContent = err.message;
    }
  });
}

try {
  render(await load());
} catch (err) {
  root.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
}

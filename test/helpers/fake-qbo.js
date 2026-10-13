import assert from 'node:assert/strict';

// A small in-memory QuickBooks Online: enough of OAuth and the Accounting API to exercise the integration.
export function fakeQbo() {
  const s = {
    customers: [], items: [], invoices: [], payments: [], calls: [], refreshes: 0, revoked: false, extraTax: 0,
    accounts: [{ Id: '79', Name: 'Sales', AccountType: 'Income', Active: true }],
    nextId: 100,
  };
  const id = () => String(s.nextId++);
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const total = (lines) => Math.round(lines.reduce((t, l) => t + (l.DetailType === 'DiscountLineDetail' ? -l.Amount : l.Amount), 0) * 100) / 100;
  const balance = (inv) => Math.round((inv.TotalAmt - s.payments.filter((p) => p.Line.some((l) => l.LinkedTxn.some((x) => x.TxnId === inv.Id))).reduce((t, p) => t + p.Line.filter((l) => l.LinkedTxn.some((x) => x.TxnId === inv.Id)).reduce((a, l) => a + l.Amount, 0), 0)) * 100) / 100;
  const view = (inv) => ({ ...inv, Balance: balance(inv), LinkedTxn: s.payments.filter((p) => p.Line.some((l) => l.LinkedTxn.some((x) => x.TxnId === inv.Id))).map((p) => ({ TxnId: p.Id, TxnType: 'Payment' })) });

  s.pay = (invoiceId, amount) => {
    const p = { Id: id(), TxnDate: '2026-10-13', TotalAmt: amount, PaymentRefNum: 'CC-1', Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }] };
    s.payments.push(p);
    return p;
  };

  s.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    s.calls.push(`${method} ${u.pathname}`);
    if (u.href.startsWith('https://oauth.platform.intuit.com')) {
      const f = new URLSearchParams(opts.body);
      if (f.get('grant_type') === 'refresh_token') s.refreshes++;
      return json({ access_token: `at-${s.refreshes}-${Math.random()}`, refresh_token: `rt-${s.refreshes}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 });
    }
    if (u.href.startsWith('https://developer.api.intuit.com')) {
      s.revoked = true;
      return json({});
    }
    assert.match(opts.headers.Authorization, /^Bearer at-/);
    const path = u.pathname.replace(/^\/v3\/company\/9130\//, '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (path.startsWith('companyinfo/')) return json({ CompanyInfo: { CompanyName: '7LABZ LLC', Country: 'US' } });
    if (path === 'query') {
      const q = u.searchParams.get('query');
      const val = (re) => re.exec(q)?.[1]?.replace(/\\'/g, "'");
      let rows = [];
      if (/from Preferences/.test(q)) rows = [{ CurrencyPrefs: { HomeCurrency: { value: 'USD' }, MultiCurrencyEnabled: false } }];
      else if (/from Customer/.test(q)) rows = s.customers.filter((c) => c.DisplayName === val(/DisplayName = '((?:[^'\\]|\\.)*)'/));
      else if (/from Item/.test(q)) rows = s.items.filter((i) => i.Name === val(/Name = '((?:[^'\\]|\\.)*)'/));
      else if (/from Account/.test(q)) rows = s.accounts;
      else if (/from Invoice where DocNumber/.test(q)) rows = s.invoices.filter((i) => i.DocNumber === val(/DocNumber = '((?:[^'\\]|\\.)*)'/));
      else if (/from Invoice where Id in/.test(q)) {
        const ids = [...q.matchAll(/'(\d+)'/g)].map((m) => m[1]);
        rows = s.invoices.filter((i) => ids.includes(i.Id)).map(view);
      }
      const k = /from (\w+)/.exec(q)[1];
      return json({ QueryResponse: rows.length ? { [k]: rows } : {} });
    }
    if (path === 'customer' && method === 'POST') {
      const c = { ...body, Id: id(), SyncToken: '0' };
      s.customers.push(c);
      return json({ Customer: c });
    }
    if (path === 'item' && method === 'POST') {
      const i = { ...body, Id: id() };
      s.items.push(i);
      return json({ Item: i });
    }
    if (path === 'invoice' && method === 'POST') {
      if (u.searchParams.get('operation') === 'void') {
        const inv = s.invoices.find((i) => i.Id === body.Id);
        inv.voided = true;
        return json({ Invoice: inv });
      }
      if (body.Id) {
        const inv = s.invoices.find((i) => i.Id === body.Id);
        Object.assign(inv, body, { SyncToken: String(+inv.SyncToken + 1), TotalAmt: total(body.Line) + s.extraTax });
        return json({ Invoice: inv });
      }
      const inv = { ...body, Id: id(), SyncToken: '0', TotalAmt: total(body.Line) + s.extraTax };
      s.invoices.push(inv);
      return json({ Invoice: inv });
    }
    let m;
    if ((m = /^invoice\/(\d+)$/.exec(path))) {
      const inv = s.invoices.find((i) => i.Id === m[1]);
      return json({ Invoice: { ...view(inv), ...(u.searchParams.get('include') === 'invoiceLink' && inv.BillEmail ? { InvoiceLink: `https://connect.intuit.com/pay/${inv.Id}` } : {}) } });
    }
    if (path === 'payment' && method === 'POST') {
      const p = { ...body, Id: id() };
      s.payments.push(p);
      return json({ Payment: p });
    }
    if ((m = /^payment\/(\d+)$/.exec(path))) return json({ Payment: s.payments.find((p) => p.Id === m[1]) });
    return json({ Fault: { Error: [{ Message: 'not found', Detail: `no route ${method} ${path}` }] } }, 400);
  };
  return s;
}


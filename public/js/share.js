import { renderDocument, esc } from './lib/doc-render.js';

const root = document.getElementById('root');
const token = location.pathname.split('/').pop();

try {
  const res = await fetch(`/api/public/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'This link is no longer valid.' : 'Could not load the document.');
  const { document: doc, locale } = await res.json();
  document.title = `${doc.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${doc.number} — ${doc.from?.name || '7LABZ'}`;
  root.innerHTML = `
    <div class="share-bar"><button class="btn" id="print" type="button">Print or save as PDF</button></div>
    ${renderDocument(doc, { locale })}`;
  document.getElementById('print').addEventListener('click', () => window.print());
} catch (err) {
  root.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`;
}

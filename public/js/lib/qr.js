// QR code as inline SVG. One <path> of dark modules, colors from CSS (.qr-bg, .qr-fg).
import qrcode from '../vendor/qrcode.js';

qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

export function qrSvg(text, { label = 'QR code' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const safe = String(label).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect class="qr-bg" width="${size}" height="${size}"/><path class="qr-fg" d="${d}"/></svg>`;
}

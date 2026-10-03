import { createServer } from 'node:http';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 7777;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || 'data/invoicing.db';
const password = process.env.INVOICE_PASSWORD || '';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !password) {
  console.error(`Refusing to listen on ${HOST} without INVOICE_PASSWORD set.`);
  process.exit(1);
}

const app = createApp({ dbPath: DB_PATH, password, sessionSecret: process.env.SESSION_SECRET });

// Recurring invoices: catch up on start, then check hourly.
function runRecurring() {
  try {
    const { created } = app.ctx.recurring.runDue();
    if (created.length) console.log(`recurring: generated ${created.length} invoice(s)`);
  } catch (err) {
    console.error('recurring run failed', err);
  }
}
runRecurring();
const timer = setInterval(runRecurring, 60 * 60 * 1000);

const server = createServer((req, res) => app.handle(req, res));
server.listen(PORT, HOST, () => {
  console.log(`7LABZ invoicing — http://${HOST}:${PORT}  (db: ${DB_PATH}${password ? ', password on' : ''})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => {
      app.close();
      process.exit(0);
    });
  });
}

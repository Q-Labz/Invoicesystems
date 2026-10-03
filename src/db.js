import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Each entry runs once, in order; PRAGMA user_version records progress.
const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE tax_rates (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    rate_ppm   INTEGER NOT NULL CHECK (rate_ppm BETWEEN 0 AND 1000000),
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE clients (
    id                 INTEGER PRIMARY KEY,
    name               TEXT NOT NULL,
    company            TEXT NOT NULL DEFAULT '',
    email              TEXT NOT NULL DEFAULT '',
    cc_emails          TEXT NOT NULL DEFAULT '',
    phone              TEXT NOT NULL DEFAULT '',
    tax_id             TEXT NOT NULL DEFAULT '',
    address_line1      TEXT NOT NULL DEFAULT '',
    address_line2      TEXT NOT NULL DEFAULT '',
    city               TEXT NOT NULL DEFAULT '',
    region             TEXT NOT NULL DEFAULT '',
    postal_code        TEXT NOT NULL DEFAULT '',
    country            TEXT NOT NULL DEFAULT '',
    currency           TEXT NOT NULL,
    payment_terms_days INTEGER NOT NULL DEFAULT 30,
    default_tax_rate_id INTEGER REFERENCES tax_rates(id),
    notes              TEXT NOT NULL DEFAULT '',
    archived           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE items (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    unit        TEXT NOT NULL DEFAULT '',
    unit_price  INTEGER NOT NULL,
    currency    TEXT NOT NULL,
    tax_rate_id INTEGER REFERENCES tax_rates(id),
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE recurring (
    id                 INTEGER PRIMARY KEY,
    name               TEXT NOT NULL,
    client_id          INTEGER NOT NULL REFERENCES clients(id),
    currency           TEXT NOT NULL,
    interval_unit      TEXT NOT NULL CHECK (interval_unit IN ('week','month','year')),
    interval_count     INTEGER NOT NULL CHECK (interval_count BETWEEN 1 AND 36),
    start_date         TEXT NOT NULL,
    next_run           TEXT NOT NULL,
    anchor_day         INTEGER NOT NULL,
    end_date           TEXT,
    max_runs           INTEGER,
    runs_done          INTEGER NOT NULL DEFAULT 0,
    auto_issue         INTEGER NOT NULL DEFAULT 0,
    payment_terms_days INTEGER NOT NULL DEFAULT 30,
    title              TEXT NOT NULL DEFAULT '',
    notes              TEXT NOT NULL DEFAULT '',
    terms              TEXT NOT NULL DEFAULT '',
    discount_type      TEXT NOT NULL DEFAULT 'none',
    discount_value     INTEGER NOT NULL DEFAULT 0,
    lines              TEXT NOT NULL DEFAULT '[]',
    active             INTEGER NOT NULL DEFAULT 1,
    last_run_at        TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE documents (
    id                 INTEGER PRIMARY KEY,
    kind               TEXT NOT NULL CHECK (kind IN ('invoice','estimate')),
    number             TEXT UNIQUE,
    client_id          INTEGER NOT NULL REFERENCES clients(id),
    state              TEXT NOT NULL DEFAULT 'draft'
                       CHECK (state IN ('draft','issued','void','accepted','declined','converted')),
    currency           TEXT NOT NULL,
    issue_date         TEXT NOT NULL,
    due_date           TEXT,
    po_number          TEXT NOT NULL DEFAULT '',
    title              TEXT NOT NULL DEFAULT '',
    notes              TEXT NOT NULL DEFAULT '',
    terms              TEXT NOT NULL DEFAULT '',
    discount_type      TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','fixed')),
    discount_value     INTEGER NOT NULL DEFAULT 0,
    subtotal           INTEGER NOT NULL DEFAULT 0,
    discount_total     INTEGER NOT NULL DEFAULT 0,
    tax_total          INTEGER NOT NULL DEFAULT 0,
    total              INTEGER NOT NULL DEFAULT 0,
    taxes              TEXT NOT NULL DEFAULT '[]',
    client_snapshot    TEXT,
    business_snapshot  TEXT,
    share_token        TEXT NOT NULL UNIQUE,
    source_estimate_id INTEGER REFERENCES documents(id),
    recurring_id       INTEGER REFERENCES recurring(id),
    issued_at          TEXT,
    voided_at          TEXT,
    void_reason        TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX documents_client ON documents(client_id);
  CREATE INDEX documents_kind_state ON documents(kind, state);

  CREATE TABLE document_lines (
    id                 INTEGER PRIMARY KEY,
    document_id        INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position           INTEGER NOT NULL,
    item_id            INTEGER REFERENCES items(id),
    description        TEXT NOT NULL,
    quantity           TEXT NOT NULL,
    unit               TEXT NOT NULL DEFAULT '',
    unit_price         INTEGER NOT NULL,
    discount_bps       INTEGER NOT NULL DEFAULT 0,
    tax_rate_id        INTEGER REFERENCES tax_rates(id),
    tax_name           TEXT NOT NULL DEFAULT '',
    tax_rate_ppm       INTEGER NOT NULL DEFAULT 0,
    amount             INTEGER NOT NULL
  );
  CREATE INDEX lines_document ON document_lines(document_id);

  CREATE TABLE payments (
    id          INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    amount      INTEGER NOT NULL CHECK (amount <> 0),
    date        TEXT NOT NULL,
    method      TEXT NOT NULL,
    reference   TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX payments_document ON payments(document_id);
  CREATE INDEX payments_date ON payments(date);

  CREATE TABLE sequences (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  CREATE TABLE activity (
    id        INTEGER PRIMARY KEY,
    entity    TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action    TEXT NOT NULL,
    detail    TEXT NOT NULL DEFAULT '{}',
    at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX activity_entity ON activity(entity, entity_id);
  `,
];

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

let depth = 0;

// Nested-safe transaction: the outermost call is BEGIN/COMMIT, inner calls are savepoints.
export function transaction(db, fn) {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

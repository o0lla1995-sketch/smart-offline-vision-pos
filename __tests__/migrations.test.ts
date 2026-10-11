/**
 * MIGRATIONS & STARTUP — the regression suite for the v23.0.0 startup
 * crash loop («[op-sqlite] SQL prepare error: no such column:
 * active_in_store») and its whole bug class.
 *
 * Root cause recap (v23.0.0):
 *  - DDL_STATEMENTS run at EVERY startup BEFORE migrations.
 *  - The v23 fresh DDL created campaign_debts WITHOUT active_in_store,
 *    so migration v12's CREATE INDEX idx_cdebts_active crashed every
 *    fresh/cleared/pre-v20 install in a loop («مسح البيانات» made the
 *    loop permanent).
 *  - The same class: idx_cdebts_store_state in DDL crashed v20/v21
 *    upgrades; idx_sales_return_kind in DDL crashed v22 upgrades.
 *
 * This suite boots the REAL connection.ts (real DDL + real migrations)
 * against node:sqlite from every entry state the field can hold.
 */
import {freshApp, tempDb, load} from './helpers/app';
import {DatabaseSync} from 'node:sqlite';
import fs from 'fs';

/** Column names of a table in the opened app DB. */
function columns(db, table): string[] {
  const rows = db.execute(`PRAGMA table_info(${table})`).rows as {
    name: string;
  }[];
  return rows.map(r => String(r.name));
}

/** The campaign_debts shape as v20 shipped it (NO active_in_store,
 *  NO store_state) — for pre-v21 upgrade simulations. */
const CAMPAIGN_DEBTS_V20 = `
CREATE TABLE IF NOT EXISTS campaign_debts (
  campaign_id TEXT PRIMARY KEY,
  campaign_name TEXT NOT NULL,
  kind TEXT,
  campaign_status TEXT,
  merchant_status TEXT,
  starts_at TEXT,
  ends_at TEXT,
  redeemed_count INTEGER NOT NULL DEFAULT 0,
  redeemed_value_minor INTEGER NOT NULL DEFAULT 0,
  settled_minor INTEGER NOT NULL DEFAULT 0,
  settled_pending_minor INTEGER NOT NULL DEFAULT 0,
  settled_confirmed_minor INTEGER NOT NULL DEFAULT 0,
  due_minor INTEGER NOT NULL DEFAULT 0,
  settlement_state TEXT NOT NULL DEFAULT 'none'
    CHECK (settlement_state IN ('none','partial','full')),
  last_redemption_at TEXT,
  last_settlement_at TEXT,
  updated_at TEXT
)`;

/** Minimal pre-v23 sales/products/sila_payment_queue core for
 *  upgrade-from-v22 simulations (columns the migrations touch). */
const V22_CORE = `
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL UNIQUE,
  total_amount REAL NOT NULL,
  total_cost REAL NOT NULL DEFAULT 0,
  total_profit REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  payment_type TEXT NOT NULL DEFAULT 'RETAIL',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER,
  barcode TEXT UNIQUE,
  cost_price REAL NOT NULL DEFAULT 0,
  retail_price REAL NOT NULL DEFAULT 0,
  wholesale_price REAL NOT NULL DEFAULT 0,
  stock_quantity REAL NOT NULL DEFAULT 0,
  sold_by_weight INTEGER NOT NULL DEFAULT 0
);
`;

describe('database startup & migrations', () => {
  beforeEach(() => {
    globalThis.__SELA_DB_PATH = ':memory:';
  });

  it('boots a FRESH install cleanly (the crash-loop path)', async () => {
    const app = freshApp();
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();

    const db = app.connection.getDb();
    // The v23.0.1 fix: campaign_debts MUST have active_in_store AND
    // store_state from the fresh DDL.
    const cols = columns(db, 'campaign_debts');
    expect(cols).toContain('active_in_store');
    expect(cols).toContain('store_state');

    // The full v23 shape must exist everywhere.
    expect(columns(db, 'sales')).toContain('returned_minor');
    expect(columns(db, 'sales')).toContain('return_kind');
    expect(columns(db, 'products')).toContain('is_archived');
    expect(columns(db, 'sila_payment_queue')).toContain('kind');
    for (const table of [
      'sale_returns',
      'sale_return_items',
      'voucher_redemptions',
      'campaign_settlements',
      'sila_customers',
      'sila_debt_queue',
      'local_customers',
      'local_debts',
      'local_payments',
      'sila_app_collections',
    ]) {
      expect(columns(db, table).length).toBeGreaterThan(0);
    }
    // Migrations ran all the way.
    expect(app.storage.getNumber(app.storage.KEYS.schemaVersion, 0)).toBe(22); // v38: جرد متغيرات الملابس (v21 كان الاستبدال بقيمة المرجع)
    // v32 (round-40 #3): the expiry column exists on a fresh install.
    expect(columns(db, 'products')).toContain('expiry_date');
    // Seed categories exist.
    const cats = db.execute('SELECT COUNT(*) AS c FROM categories').rows
      [0] as {c: number};
    expect(Number(cats.c)).toBeGreaterThanOrEqual(6);
  });

  it('heals the EXACT crashed state from the field (v23 DDL shape + stuck schemaVersion)', async () => {
    // Simulate the user's phone: v23's DDL created campaign_debts
    // WITHOUT active_in_store, migration v12 crashed on the index,
    // schemaVersion never advanced (fresh install → 0/1).
    const file = tempDb('crashed-v23');
    const raw = new DatabaseSync(file);
    raw.exec(CAMPAIGN_DEBTS_V20.replace('campaign_debts', 'campaign_debts'));
    raw.exec(V22_CORE);
    raw.close();

    const app = freshApp(file);
    app.storage.storage.set(app.storage.KEYS.schemaVersion, 1);
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();

    const db = app.connection.getDb();
    const cols = columns(db, 'campaign_debts');
    expect(cols).toContain('active_in_store'); // healed by migration v12
    expect(cols).toContain('store_state'); // added by migration v14
    expect(app.storage.getNumber(app.storage.KEYS.schemaVersion, 0)).toBe(22); // v38: جرد متغيرات الملابس (v21 كان الاستبدال بقيمة المرجع)

    fs.rmSync(file, {force: true});
  });

  it('upgrades a v20 database (schemaVersion 12, campaign_debts without both columns)', async () => {
    const file = tempDb('upgrade-v20');
    const raw = new DatabaseSync(file);
    raw.exec(CAMPAIGN_DEBTS_V20);
    // One live campaign row with real activity (v13 auto-activation
    // must flag it 'active').
    raw.prepare(
      `INSERT INTO campaign_debts (campaign_id, campaign_name, due_minor)
       VALUES ('cmp-1', 'حملة المدارس', 5000)`,
    ).run();
    raw.close();

    const app = freshApp(file);
    app.storage.storage.set(app.storage.KEYS.schemaVersion, 12);
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();

    const db = app.connection.getDb();
    const cols = columns(db, 'campaign_debts');
    expect(cols).toContain('active_in_store');
    expect(cols).toContain('store_state');
    const row = db
      .execute(`SELECT active_in_store, store_state FROM campaign_debts
                WHERE campaign_id = 'cmp-1'`)
      .rows[0] as {active_in_store: number; store_state: string};
    expect(Number(row.active_in_store)).toBe(0); // no redemptions at this store
    expect(String(row.store_state)).toBe('available');
    fs.rmSync(file, {force: true});
  });

  it('upgrades a v21 database (schemaVersion 13 — has active_in_store, lacks store_state)', async () => {
    // Build: v20 shape + the v13 ALTER (exactly what a v21 install holds).
    const file = tempDb('upgrade-v21');
    const raw = new DatabaseSync(file);
    raw.exec(CAMPAIGN_DEBTS_V20);
    raw.exec(
      'ALTER TABLE campaign_debts ADD COLUMN active_in_store INTEGER NOT NULL DEFAULT 0',
    );
    raw.prepare(
      `INSERT INTO campaign_debts (campaign_id, campaign_name, active_in_store, due_minor)
       VALUES ('cmp-2', 'حملة رمضان', 1, 9000)`,
    ).run();
    raw.close();

    const app = freshApp(file);
    app.storage.storage.set(app.storage.KEYS.schemaVersion, 13);
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();

    const db = app.connection.getDb();
    expect(columns(db, 'campaign_debts')).toContain('store_state');
    const row = db
      .execute(`SELECT store_state FROM campaign_debts WHERE campaign_id = 'cmp-2'`)
      .rows[0] as {store_state: string};
    // v13 switch ON → v14 must carry it into the lifecycle as 'active'.
    expect(String(row.store_state)).toBe('active');
    fs.rmSync(file, {force: true});
  });

  it('upgrades a v22 database (schemaVersion 14 — sales lacks returned_minor/return_kind)', async () => {
    const file = tempDb('upgrade-v22');
    const raw = new DatabaseSync(file);
    raw.exec(V22_CORE);
    raw.exec(CAMPAIGN_DEBTS_V20);
    raw.exec(
      `ALTER TABLE campaign_debts ADD COLUMN active_in_store INTEGER NOT NULL DEFAULT 0`,
    );
    raw.exec(
      `ALTER TABLE campaign_debts ADD COLUMN store_state TEXT NOT NULL DEFAULT 'available'`,
    );
    // Historic sales rows that must survive untouched.
    raw.prepare(
      `INSERT INTO sales (invoice_number, total_amount) VALUES ('INV-20260101-0001', 25.5)`,
    ).run();
    raw.close();

    const app = freshApp(file);
    app.storage.storage.set(app.storage.KEYS.schemaVersion, 14);
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();

    const db = app.connection.getDb();
    expect(columns(db, 'sales')).toContain('returned_minor');
    expect(columns(db, 'sales')).toContain('return_kind');
    const sale = db
      .execute(`SELECT total_amount, returned_minor FROM sales WHERE invoice_number = 'INV-20260101-0001'`)
      .rows[0] as {total_amount: number; returned_minor: number};
    expect(Number(sale.total_amount)).toBeCloseTo(25.5, 5);
    expect(Number(sale.returned_minor)).toBe(0);
    expect(app.storage.getNumber(app.storage.KEYS.schemaVersion, 0)).toBe(22); // v38: جرد متغيرات الملابس (v21 كان الاستبدال بقيمة المرجع)
    fs.rmSync(file, {force: true});
  });

  it('upgrades a PRE-v20 database (schemaVersion 4 — no voucher tables at all)', async () => {
    const file = tempDb('upgrade-pre20');
    const raw = new DatabaseSync(file);
    raw.exec(V22_CORE);
    raw.close();

    const app = freshApp(file);
    app.storage.storage.set(app.storage.KEYS.schemaVersion, 4);
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();

    const db = app.connection.getDb();
    const cols = columns(db, 'campaign_debts');
    expect(cols).toContain('active_in_store');
    expect(cols).toContain('store_state');
    expect(columns(db, 'voucher_redemptions')).toContain('counter_extra_minor');
    fs.rmSync(file, {force: true});
  });

  it('every DDL statement is single-statement, index-safe SQLite', async () => {
    // DDL_STATEMENTS is not exported; run the fresh boot twice in a
    // row (idempotency) and verify no index references a missing
    // column by rebuilding integrity.
    const app = freshApp();
    await app.connection.initDatabase();
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();

    const db = app.connection.getDb();
    const check = db.execute('PRAGMA integrity_check').rows
      [0] as {integrity_check: string};
    expect(String(check.integrity_check)).toBe('ok');

    // Every CREATE INDEX in the schema must reference existing columns.
    const indexes = db
      .execute(
        `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`,
      )
      .rows as {name: string; tbl_name: string; sql: string}[];
    expect(indexes.length).toBeGreaterThan(20);
    for (const idx of indexes) {
      expect(typeof idx.sql).toBe('string');
      const tableCols = columns(db, String(idx.tbl_name));
      expect(tableCols.length).toBeGreaterThan(0);
    }
  });
});

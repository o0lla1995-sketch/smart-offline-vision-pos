/**
 * SQLite connection (op-sqlite JSI) + schema bootstrap.
 * ─────────────────────────────────────────────────────────────────
 * WAL journal + foreign keys ON, exact schema from the spec, plus a
 * first-run seed of default Arabic categories.
 */
import {open, type DB} from '@op-engineering/op-sqlite';
import {DB_NAME, DEFAULT_UNITS, STANDARD_UNITS_V5} from '../core/config';
import {logDiag} from '../core/diagnostics';
import {storage, getNumber, KEYS} from '../storage/storage';

let db: DB | null = null;

export function getDb(): DB {
  if (db == null) {
    throw new Error('قاعدة البيانات لم تُهيّأ بعد — أعد تشغيل التطبيق');
  }
  return db;
}

const DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- v34 (الجولة 42 #3): نمط المتجر الذي ينتمي إليه التصنيف —
    -- NULL يُوسم مرة واحدة بنمط المتجر الحالي عند أول إقلاع.
    store_mode TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'piece',
    -- v34 (الجولة 42 #3): نطاق الوحدة — نمط المتجر الذي تخدمه.
    store_mode TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS product_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    unit_id INTEGER NOT NULL,
    conversion REAL NOT NULL DEFAULT 1,
    barcode TEXT,
    retail_price REAL,
    wholesale_price REAL,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE CASCADE,
    UNIQUE(product_id, unit_id)
  )`,
  // ── v35 (الجولة 43): متغيرات المنتج الواحد — نمط Shopify Variants.
  //  ملابس: كل (لون × مقاس) صف بمخزونه (الربطة تملأ كل صف بعدد
  //  الربط)؛ مطعم/كافيتريا: كل حجم بسعره الخاص. اللون الفارغ ''
  //  للأحجام (ليست ملابس) كي يعمل UNIQUE دون قيود NULL.
  `CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'variant'
      CHECK (kind IN ('variant','size')),
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    stock_quantity REAL NOT NULL DEFAULT 0,
    retail_price REAL,
    cost_price REAL,
    created_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE(product_id, kind, color, size)
  )`,
  `CREATE TABLE IF NOT EXISTS stocktakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS stocktake_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stocktake_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    -- v38 (الجولة 46 #9): صف لكل متغير (لون × مقاس) لمنتجات المتغيرات —
    -- NULL لصف المنتج العادي. الفردية عبر فهرس تعبيري أدناه.
    variant_id INTEGER,
    variant_label TEXT,
    system_qty REAL NOT NULL DEFAULT 0,
    counted_qty REAL,
    FOREIGN KEY(stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktake_items_line
     ON stocktake_items(stocktake_id, product_id, IFNULL(variant_id, 0))`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cost_price REAL NOT NULL,
    retail_price REAL NOT NULL,
    wholesale_price REAL NOT NULL,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER,
    image_uri TEXT,
    low_stock_threshold INTEGER,
    barcode TEXT,
    -- v8.3 (round-12 #4): 1 = sold BY WEIGHT — prices are per kilo,
    -- stock is fractional kilograms and the POS opens a weight pad
    -- instead of counting pieces (the professional grocery pattern:
    -- Loyverse / Square scale-weighed products).
    sold_by_weight INTEGER NOT NULL DEFAULT 0,
    -- v23 (round-29 #1): 1 = ARCHIVED — a product with sales/stocktake
    -- history can never be hard-deleted (sale_items FK), so «حذف
    -- المنتج» archives it instead: hidden from POS + inventory +
    -- alerts, kept forever for invoice history, reports and RETURNS
    -- (a return must still find the product row to restore stock).
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(category_id) REFERENCES categories(id)
  )`,
  `CREATE TABLE IF NOT EXISTS product_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    embedding_data TEXT NOT NULL,
    angle_label TEXT,
    thumbnail_path TEXT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE,
    total_amount REAL NOT NULL,
    total_cost REAL NOT NULL,
    total_profit REAL NOT NULL,
    discount REAL DEFAULT 0,
    payment_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- v23 (round-29 #2): cumulative value returned against THIS
    -- invoice (agora) — drives the «مرتجع» badge and the remaining-
    -- value math; the return itself lives in sale_returns.
    returned_minor REAL NOT NULL DEFAULT 0,
    -- v23 (round-29 #2): set ONLY on RET-… rows — which book the
    -- return reverses ('cash' | 'sila' | 'local'). Lets the report
    -- queries net the debt buckets by the return's OWN period.
    return_kind TEXT
      CHECK (return_kind IS NULL OR return_kind IN ('cash','sila','local'))
  )`,
  `CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    cost_price REAL NOT NULL,
    total_line_price REAL NOT NULL,
    FOREIGN KEY(sale_id) REFERENCES sales(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  )`,
  // ── v23 (round-29 #2): نظام إرجاع المنتجات — المرتجع سجل مستقل
  // (إيصال RET-…) بصورته الذاتية، لا طمس للفاتورة الأصلية. السالب
  // يعيش في صف sales/sale_items الخاص بالمرتجع (RET-) فتتصفّى كل
  // تجميعات التقارير تلقائياً، بينما يبقى الأصل مُميّزاً بمقدار
  // المرتجع منه (returned_minor) وبقائمة مرتجعاته.
  `CREATE TABLE IF NOT EXISTS sale_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_number TEXT NOT NULL UNIQUE,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    invoice_ref TEXT NOT NULL,
    book TEXT NOT NULL
      CHECK (book IN ('cash','sila','local')),
    refund_method TEXT NOT NULL DEFAULT 'none'
      CHECK (refund_method IN ('none','cash')),
    refund_minor INTEGER NOT NULL CHECK (refund_minor > 0),
    debt_adjusted_minor INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sale_return_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
    sale_item_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit_name TEXT,
    base_quantity REAL NOT NULL CHECK (base_quantity > 0),
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL,
    cost_price REAL NOT NULL DEFAULT 0
  )`,
  // v36: الاستبدال بقيمة المرجع — بضاعة تخرج من المخزون مقابل
  // المرتجع، بلا أي أثر مالي (لا نقد ولا دين) — فقط حركة مخزون.
  `CREATE TABLE IF NOT EXISTS sale_return_exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit_name TEXT,
    base_quantity REAL NOT NULL CHECK (base_quantity > 0),
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL,
    cost_price REAL NOT NULL DEFAULT 0,
    variant_id INTEGER,
    variant_color TEXT,
    variant_label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id)',
  'CREATE INDEX IF NOT EXISTS idx_sale_returns_created ON sale_returns(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sri_return ON sale_return_items(return_id)',
  'CREATE INDEX IF NOT EXISTS idx_sri_sale_item ON sale_return_items(sale_item_id)',
  'CREATE INDEX IF NOT EXISTS idx_srex_return ON sale_return_exchanges(return_id)',
  // v23.0.1 FIX: idx_sales_return_kind was created HERE — before
  // migrations — so upgrading any pre-v23 database (whose sales
  // table lacks return_kind until migration v15 ALTERs it in)
  // crashed at startup with «no such column: return_kind». It is
  // now created ONLY inside migration v15, after the column is
  // guaranteed. (Same bug class as the campaign_debts fixes.)
  'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)',
  'CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)',
  'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)',
  'CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id)',
  'CREATE INDEX IF NOT EXISTS idx_product_units_barcode ON product_units(barcode)',
  'CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id)',
  'CREATE INDEX IF NOT EXISTS idx_stocktakes_status ON stocktakes(status)',
  'CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_product ON product_embeddings(product_id)',
  'CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)',
  'CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)',
  // ── v11 (SILA debt integration — SILA_POS_API §7) ────────────
  `CREATE TABLE IF NOT EXISTS sila_debt_queue (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone_last4 TEXT,
    customer_card TEXT,
    offline_qr TEXT,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'ILS',
    pos_invoice_ref TEXT NOT NULL UNIQUE,
    description TEXT,
    scanned_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','syncing','synced','failed')),
    reference_code TEXT,
    transaction_id TEXT,
    outstanding_after INTEGER,
    synced_at TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sila_customers (
    customer_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone_last4 TEXT,
    id_number TEXT,
    outstanding_minor INTEGER NOT NULL DEFAULT 0,
    credit_minor INTEGER NOT NULL DEFAULT 0,
    /** v18: baseline anchor for the collections reconciliation —
     *  the historical stock gap frozen at this store's FIRST full
     *  sight of the customer (0 on upgrades where the books already
     *  cover the server history). Write-once; never updated after. */
    reconcile_offset_minor INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT
  )`,
  // ── v15 (round-21 #3 — SILA_POS_DEBT_SEPARATION §3.1) ────────
  // The repayments queue: cashier-received payments uploaded to
  // /api/pos/payments with ONE idempotency key per receipt — the
  // missing upload path that made balances diverge (سداد عند
  // الكاشير لم يكن يُرفع أبداً لصِلة).
  `CREATE TABLE IF NOT EXISTS sila_payment_queue (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone_last4 TEXT,
    amount_minor INTEGER NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    pos_receipt_ref TEXT NOT NULL UNIQUE,
    description TEXT,
    paid_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','syncing','synced','failed')),
    -- v23 (round-29 #2): 'repayment' = سداد نقدي فعلي (enters the
    -- collections statistics); 'return_reversal' = العملية العكسية
    -- لمرتجع بضاعة على فاتورة دين مرفوعة للخادم — يُرفع كدفعة
    -- (method other) ليخفض دين الزبون في صِلة، لكنه لا يُحتسب
    -- أبداً ضمن المحصلات النقدية.
    kind TEXT NOT NULL DEFAULT 'repayment'
      CHECK (kind IN ('repayment','return_reversal')),
    reference_code TEXT,
    transaction_id TEXT,
    outstanding_after INTEGER,
    synced_at TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sila_dq_state ON sila_debt_queue(state, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sila_pq_state ON sila_payment_queue(state, created_at)',
  // ── v16 (round-22 #4): the STORE-LOCAL debt book — customers of
  // this store with ID number / name / phone, their debts (INV-L
  // series) and repayments (RCP-L series). NEVER uploaded to صِلة;
  // the migration path re-registers them as fresh INV-D debts.
  `CREATE TABLE IF NOT EXISTS local_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_number TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    sila_customer_id TEXT,
    sila_linked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS local_debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
    invoice_ref TEXT NOT NULL UNIQUE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    description TEXT,
    migrated INTEGER NOT NULL DEFAULT 0,
    migrated_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS local_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
    receipt_ref TEXT NOT NULL UNIQUE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    method TEXT NOT NULL DEFAULT 'cash'
      CHECK (method IN ('cash','card','other')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_local_debts_cust ON local_debts(local_customer_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_local_pays_cust ON local_payments(local_customer_id, created_at DESC)',
  // ── v18 (round-24 #1): money صِلة collected on the store's behalf —
  // every time a customer repays their STORE debt through the Sila
  // app (not at the cashier), the reconciliation engine records it
  // here so the debt shrinking is always paired with a visible
  // «تحصيل وارد من صِلة» entry. Nothing disappears from the books
  // anymore — the treasury and reports both read this ledger.
  `CREATE TABLE IF NOT EXISTS sila_app_collections (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    customer_name TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    pos_purchases_minor INTEGER,
    pos_outstanding_minor INTEGER,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sila_acct_cust ON sila_app_collections(customer_id, detected_at DESC)',
  // ── v20 (SILA_POS_VOUCHERS_API §5): القسائم الشرائية للحملات ──
  // Mirror of every voucher redemption attempt (§5 rule 1: NOT an
  // offline queue — the row is created at redeem time with ONE
  // idempotency_key and retries replay the same key on a live call).
  `CREATE TABLE IF NOT EXISTS voucher_redemptions (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    campaign_id TEXT,
    campaign_name TEXT,
    campaign_kind TEXT,
    voucher_id TEXT,
    value_minor INTEGER NOT NULL DEFAULT 0,
    pos_receipt_ref TEXT UNIQUE,
    reference_code TEXT,
    beneficiary_last4 TEXT,
    redeemed_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','ok','failed')),
    cart_json TEXT,
    sale_id INTEGER,
    counter_extra_minor INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_vr_state ON voucher_redemptions(state, created_at)',
  // The campaigns claim book — the institution owes the store for
  // every redeemed voucher until settlement completes (§2 rule 4).
  // EVERY figure is written from server snapshots only (§5 rule 3).
  `CREATE TABLE IF NOT EXISTS campaign_debts (
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
    updated_at TEXT,
    -- v21: the legacy activation switch — kept for migration v12/v13
    -- healing and for reads upgraded from old shapes; new writes go
    -- through store_state below.
    active_in_store INTEGER NOT NULL DEFAULT 0,
    -- v22 (round-28 #4): the campaign lifecycle in this store —
    -- 'available' (feed-discovered, not activated yet) → 'active'
    -- (the merchant activated it; one-way) → 'completed' (the
    -- merchant closed it; one-way, data preserved as is). There is
    -- NO way back: no double activation, no deactivation.
    store_state TEXT NOT NULL DEFAULT 'available'
      CHECK (store_state IN ('available','active','completed'))
  )`,
  // v23.0.1 FIX: idx_cdebts_store_state was created HERE — before
  // migrations run — so upgrading a v20/v21 database (whose
  // campaign_debts lacks store_state until migration v14) crashed
  // at startup with «no such column: store_state». Index creation
  // now lives ONLY in migration v14, after the column is guaranteed.
  // The same class of bug produced the v23 «no such column:
  // active_in_store» crash loop (see migration v12 fix below).
  // v20 POS-side mirror of the server's settlements[] feed (§4.2) —
  // feeds the period reports («تحصيلات الحملات بالفترة») and the
  // treasury (confirmed = money actually received).
  `CREATE TABLE IF NOT EXISTS campaign_settlements (
    settlement_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    amount_minor INTEGER NOT NULL,
    kind TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','confirmed','disputed','cancelled')),
    method TEXT,
    reference TEXT,
    created_at TEXT NOT NULL,
    mirrored_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_csettle_campaign ON campaign_settlements(campaign_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_csettle_status ON campaign_settlements(status, created_at)',
];

const DEFAULT_CATEGORIES: string[] = [
  'مشروبات',
  'شوكولاتة وحلويات',
  'معلبات وبقالة',
  'ألبان وأجبان',
  'خبز ومخبوزات',
  'منتجات متنوعة',
];

/**
 * Forward-only schema migrations, versioned in MMKV.
 * v2 (Sela 2.0): products.low_stock_threshold for per-product alerts.
 * v3 (sela 3.0): units system + product barcodes + stocktake tables.
 * v4 (sela 8.3): products.sold_by_weight (weight-sold products —
 *                prices per kilo, fractional kg stock) + the وقية
 *                (250 g) regional unit joins the seed catalog.
 */
async function applyMigrations(database: DB): Promise<void> {
  const storedVersion = getNumber(KEYS.schemaVersion, 0);
  let version: number = storedVersion > 0 ? storedVersion : 1;

  if (version < 2) {
    const existing = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'low_stock_threshold'",
    );
    const hasColumn = (existing.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasColumn) {
      await database.execute(
        'ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER',
      );
      logDiag('db', 'ترحيل v2: أُضيف عمود حد المخزون المنخفض');
    }
    version = 2;
  }

  if (version < 3) {
    const productsCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'barcode'",
    );
    const hasBarcode =
      (productsCols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasBarcode) {
      await database.execute('ALTER TABLE products ADD COLUMN barcode TEXT');
    }

    const saleItemsCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sale_items') WHERE name = 'unit_name'",
    );
    const hasUnitName =
      (saleItemsCols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasUnitName) {
      await database.execute(
        'ALTER TABLE sale_items ADD COLUMN unit_name TEXT',
      );
      await database.execute(
        'ALTER TABLE sale_items ADD COLUMN base_quantity REAL',
      );
    }

    // New v3 tables (also in DDL for fresh installs — IF NOT EXISTS both ways).
    await database.execute(
      `CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS product_units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        unit_id INTEGER NOT NULL,
        conversion REAL NOT NULL DEFAULT 1,
        barcode TEXT,
        retail_price REAL,
        wholesale_price REAL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE CASCADE,
        UNIQUE(product_id, unit_id)
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS stocktakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        status TEXT NOT NULL DEFAULT 'open',
        note TEXT
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS stocktake_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stocktake_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        system_qty REAL NOT NULL DEFAULT 0,
        counted_qty REAL,
        FOREIGN KEY(stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE,
        FOREIGN KEY(product_id) REFERENCES products(id),
        UNIQUE(stocktake_id, product_id)
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_stocktakes_status ON stocktakes(status)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id)',
    );
    logDiag('db', 'ترحيل v3: الوحدات والباركود والجرد');
    version = 3;
  }

  if (version < 4) {
    // v8.3 (round-12 #4): the weight-sold flag.
    const cols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'sold_by_weight'",
    );
    const hasWeight = (cols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasWeight) {
      await database.execute(
        'ALTER TABLE products ADD COLUMN sold_by_weight INTEGER NOT NULL DEFAULT 0',
      );
    }
    // The regional 250 g unit (وقية) joins every existing install so
    // weight products can price a quarter-kilo out of the box.
    const wakfCount = await database.execute(
      "SELECT COUNT(*) AS cnt FROM units WHERE name = 'وقية'",
    );
    const wakfRow = (wakfCount.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (wakfRow === 0) {
      const maxOrder = await database.execute(
        'SELECT MAX(sort_order) AS mx FROM units',
      );
      const mx = (maxOrder.rows?.[0] as {mx?: number | null})?.mx ?? 0;
      await database.execute(
        'INSERT INTO units (name, short_name, sort_order) VALUES (?, ?, ?)',
        ['وقية', 'وقية', Number(mx) + 1],
      );
    }
    logDiag('db', 'ترحيل v4: منتجات الوزن + وحدة الوقية');
    version = 4;
  }

  if (version < 5) {
    // v9.2 (round-15 #3): units.kind — the unit TYPE (piece /
    // weight / volume / length) so weight products offer weight
    // units (وقية، رطل…) and piece products offer packaging units
    // (كرتونة، علبة…).
    const kindCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('units') WHERE name = 'kind'",
    );
    const hasKind = (kindCols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasKind) {
      await database.execute(
        "ALTER TABLE units ADD COLUMN kind TEXT NOT NULL DEFAULT 'piece'",
      );
    }
    // Classify every EXISTING unit by its name (old installs).
    const kindByName: Record<string, string> = {
      كيلوغرام: 'weight',
      كيلو: 'weight',
      غرام: 'weight',
      وقية: 'weight',
      'نصف كيلو': 'weight',
      رطل: 'weight',
      أونصة: 'weight',
      لتر: 'volume',
      مليلتر: 'volume',
      جالون: 'volume',
      متر: 'length',
      سنتيمتر: 'length',
    };
    for (const [name, kind] of Object.entries(kindByName)) {
      await database.execute('UPDATE units SET kind = ? WHERE name = ?', [
        kind,
        name,
      ]);
    }
    // Top up the FULL standard catalog (names that don't exist yet
    // are inserted with their kind; existing ones keep their id).
    for (const unit of STANDARD_UNITS_V5) {
      const existing = await database.execute(
        'SELECT id FROM units WHERE name = ? COLLATE NOCASE',
        [unit.name],
      );
      const hit = existing.rows?.[0] as {id?: number} | undefined;
      if (hit?.id == null) {
        await database.execute(
          // v34: وحدات كتالوج v5 توسم بالنمط الافتراضي (بقالة) —
          // ترقية جهاز قديم تبقى وحداته ضمن نطاق بقالته.
          'INSERT INTO units (name, short_name, sort_order, kind, store_mode) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM units), ?, ?)',
          [unit.name, unit.short, unit.kind, 'grocery'],
        );
      }
    }
    logDiag('db', 'ترحيل v5: أنواع الوحدات + كتالوج الوحدات الكامل');
    version = 5;
  }

  if (version < 6) {
    // v11 (SILA §7): debt queue + customers cache. Fresh DDL above
    // already covers new installs; this heals older ones.
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sila_debt_queue (
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        customer_id TEXT,
        customer_name TEXT,
        customer_phone_last4 TEXT,
        customer_card TEXT,
        offline_qr TEXT,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'ILS',
        pos_invoice_ref TEXT NOT NULL UNIQUE,
        description TEXT,
        scanned_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','syncing','synced','failed')),
        reference_code TEXT,
        transaction_id TEXT,
        outstanding_after INTEGER,
        synced_at TEXT,
        error_code TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sila_customers (
        customer_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone_last4 TEXT,
        id_number TEXT,
        outstanding_minor INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sila_dq_state ON sila_debt_queue(state, created_at)',
    );
    logDiag('db', 'ترحيل v6: جداول ديون صِلة (الطابور + ذاكرة الزبائن)');
    version = 6;
  }

  if (version < 7) {
    // v14 (round-20 #4): product_embeddings.thumbnail_path — the
    // enrollment PHOTO of each angle was never persisted, so
    // reopening a registered product showed the three angle tiles
    // as empty camera placeholders («لا تظهر صور الأمامية والخلفية
    // والجانبية رغم أن المنتج مسجل»). The thumbnail now lives
    // beside its fingerprint and reloads with the form.
    const embCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('product_embeddings') WHERE name = 'thumbnail_path'",
    );
    const hasThumb = (embCols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasThumb) {
      await database.execute(
        'ALTER TABLE product_embeddings ADD COLUMN thumbnail_path TEXT',
      );
      logDiag('db', 'ترحيل v7: عمود صور بصمات المنتج (thumbnail_path)');
    }
    version = 7;
  }

  if (version < 8) {
    // v15 (round-21 #3 — SILA_POS_DEBT_SEPARATION §3.1/§2.4):
    // origin-split balances per customer so store debts and Sila-app
    // debts never mix again, plus the payments queue table.
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sila_payment_queue (
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        customer_id TEXT,
        customer_name TEXT,
        customer_phone_last4 TEXT,
        amount_minor INTEGER NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'cash',
        pos_receipt_ref TEXT NOT NULL UNIQUE,
        description TEXT,
        paid_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','syncing','synced','failed')),
        reference_code TEXT,
        transaction_id TEXT,
        outstanding_after INTEGER,
        synced_at TEXT,
        error_code TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sila_pq_state ON sila_payment_queue(state, created_at)',
    );
    // sila_customers split columns (§2.4 FIFO-origin fields).
    const splitCols: [string, string][] = [
      ['pos_outstanding_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['app_outstanding_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['other_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['pos_purchases_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['app_purchases_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_payment_at', 'TEXT'],
      ['last_payment_amount_minor', 'INTEGER'],
    ];
    for (const [column, ddl] of splitCols) {
      const check = await database.execute(
        "SELECT COUNT(*) AS cnt FROM pragma_table_info('sila_customers') WHERE name = ?",
        [column],
      );
      const has = (check.rows?.[0] as {cnt?: number})?.cnt ?? 0;
      if (!has) {
        await database.execute(
          `ALTER TABLE sila_customers ADD COLUMN ${column} ${ddl}`,
        );
      }
    }
    logDiag(
      'db',
      'ترحيل v8: فصل أصول الديون (متجر/تطبيق) + طابور سدادّات صِلة',
    );
    version = 8;
  }

  if (version < 9) {
    // v16 (round-22 #4): the STORE-LOCAL debt book — accounts for
    // customers recorded by ID number / name / phone with debts and
    // repayments that never leave this device (fresh DDL above
    // covers new installs; this heals older ones).
    await database.execute(
      `CREATE TABLE IF NOT EXISTS local_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_number TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        phone TEXT,
        notes TEXT,
        sila_customer_id TEXT,
        sila_linked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS local_debts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
        invoice_ref TEXT NOT NULL UNIQUE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        description TEXT,
        migrated INTEGER NOT NULL DEFAULT 0,
        migrated_ref TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS local_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
        receipt_ref TEXT NOT NULL UNIQUE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        method TEXT NOT NULL DEFAULT 'cash'
          CHECK (method IN ('cash','card','other')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_local_debts_cust ON local_debts(local_customer_id, created_at DESC)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_local_pays_cust ON local_payments(local_customer_id, created_at DESC)',
    );
    logDiag('db', 'ترحيل v9: دفتر ديون المتجر المحلي (زبائن + ديون + سدادّات)');
    version = 9;
  }

  if (version < 10) {
    // v17 (round-23 #3/#8): the prepaid-credit awareness —
    // sila_customers.credit_minor caches the customer's PREPAID
    // balance from the server feed (the pos_get_customers row), so
    // the store can recognize at SALE time that a debt invoice is
    // actually COVERED by existing credit (the server consumes it
    // automatically on upload — 0067 — but the store's own books
    // never knew). sila_debt_queue.credit_covered_minor records how
    // much of each debt the credit absorbed (locally estimated at
    // sale/migration time, reconciled to the server's exact
    // credit_consumed_minor once the row syncs).
    const creditCols: [string, string, string][] = [
      ['sila_customers', 'credit_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['sila_debt_queue', 'credit_covered_minor', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [table, column, ddl] of creditCols) {
      const check = await database.execute(
        `SELECT COUNT(*) AS cnt FROM pragma_table_info('${table}') WHERE name = ?`,
        [column],
      );
      const has = (check.rows?.[0] as {cnt?: number})?.cnt ?? 0;
      if (!has) {
        await database.execute(
          `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`,
        );
      }
    }
    logDiag(
      'db',
      'ترحيل v10: وعي الرصيد المسبق (credit_minor + credit_covered_minor)',
    );
    version = 10;
  }

  if (version < 11) {
    // v18 (round-24 #1): the Sila-app collections ledger — the
    // reconciliation engine writes one row per detected «تحصيل عبر
    // تطبيق صِلة» (customer repaid their STORE debt through the
    // Sila app). Before v18 those repayments simply vanished: the
    // server balance dropped, the store's books never saw the money
    // (the exact complaint «فإن الدين يختفي ولا يسجل سدادات مستلمة
    // من صلة»). Fresh DDL above covers new installs; this heals old
    // ones. The stock reconciliation repopulates history on the
    // first sync after this update — no data was ever lost
    // server-side, it just was never mirrored locally.
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sila_app_collections (
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL,
        customer_name TEXT,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        pos_purchases_minor INTEGER,
        pos_outstanding_minor INTEGER,
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sila_acct_cust ON sila_app_collections(customer_id, detected_at DESC)',
    );
    // v18: the reconciliation baseline anchor on the customers cache
    // (old installs get 0 = «the books already cover the history» —
    // exactly the upgrade path that must RECOVER the gap, never
    // baseline it away).
    const offsetCheck = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sila_customers') WHERE name = 'reconcile_offset_minor'",
    );
    const hasOffset =
      (offsetCheck.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasOffset) {
      await database.execute(
        'ALTER TABLE sila_customers ADD COLUMN reconcile_offset_minor INTEGER NOT NULL DEFAULT 0',
      );
    }
    logDiag(
      'db',
      'ترحيل v11: سجل تحصيلات تطبيق صِلة (مطابقة الديون المسددة خارج الكاشير)',
    );
    version = 11;
  }

  if (version < 12) {
    // v20 (SILA_POS_VOUCHERS_API §5): the voucher campaigns book —
    // redemption attempts mirror + the campaigns claim ledger + the
    // settlements mirror. Fresh DDL above covers new installs; this
    // heals older ones.
    await database.execute(
      `CREATE TABLE IF NOT EXISTS voucher_redemptions (
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        campaign_id TEXT,
        campaign_name TEXT,
        campaign_kind TEXT,
        voucher_id TEXT,
        value_minor INTEGER NOT NULL DEFAULT 0,
        pos_receipt_ref TEXT UNIQUE,
        reference_code TEXT,
        beneficiary_last4 TEXT,
        redeemed_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','ok','failed')),
        cart_json TEXT,
        sale_id INTEGER,
        counter_extra_minor INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_vr_state ON voucher_redemptions(state, created_at)',
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS campaign_debts (
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
        updated_at TEXT,
        active_in_store INTEGER NOT NULL DEFAULT 0
      )`,
    );
    // v23.0.1 FIX (THE startup crash «no such column: active_in_store»):
    // the fresh DDL at the top of this file runs BEFORE migrations at
    // EVERY startup and — in v23 — created campaign_debts WITHOUT
    // active_in_store, so the CREATE TABLE above was a no-op and the
    // index below crashed every fresh/cleared/pre-v20 install in a
    // loop (the in-app «مسح البيانات» advice made the loop permanent).
    // Self-heal now: pragma-check the column, ALTER it in when missing
    // (this also repairs databases already stuck in the crash loop),
    // THEN create the index.
    const v12Cols = await database.execute(
      'PRAGMA table_info(campaign_debts)',
    );
    const v12HasActive = (v12Cols.rows ?? []).some(
      row => String((row as {name?: unknown}).name ?? '') === 'active_in_store',
    );
    if (!v12HasActive) {
      await database.execute(
        'ALTER TABLE campaign_debts ADD COLUMN active_in_store INTEGER NOT NULL DEFAULT 0',
      );
    }
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_cdebts_active ON campaign_debts(active_in_store, due_minor DESC)',
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS campaign_settlements (
        settlement_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        amount_minor INTEGER NOT NULL,
        kind TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','confirmed','disputed','cancelled')),
        method TEXT,
        reference TEXT,
        created_at TEXT NOT NULL,
        mirrored_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_csettle_campaign ON campaign_settlements(campaign_id, created_at DESC)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_csettle_status ON campaign_settlements(status, created_at)',
    );
    logDiag(
      'db',
      'ترحيل v12: القسائم الشرائية للحملات (صرف + مطالبات + تسويات)',
    );
    version = 12;
  }

  if (version < 13) {
    // v21 (round-27 #1): the merchant's campaign switch — only
    // campaigns marked active in THIS store count in the books.
    // Fresh DDL above covers new installs; this heals older ones.
    // Campaigns that already carry activity (a redemption landed at
    // this store) start ACTIVE so nothing the store is already
    // claiming disappears; feed-only rows start inactive.
    const columns = await database.execute('PRAGMA table_info(campaign_debts)');
    const hasActiveColumn = (columns.rows ?? []).some(
      row => String((row as {name?: unknown}).name ?? '') === 'active_in_store',
    );
    if (!hasActiveColumn) {
      await database.execute(
        'ALTER TABLE campaign_debts ADD COLUMN active_in_store INTEGER NOT NULL DEFAULT 0',
      );
      await database.execute(
        `UPDATE campaign_debts SET active_in_store = 1
         WHERE campaign_id IN (
           SELECT DISTINCT campaign_id FROM voucher_redemptions
           WHERE state = 'ok' AND campaign_id IS NOT NULL
         )`,
      );
    }
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_cdebts_active ON campaign_debts(active_in_store, due_minor DESC)',
    );
    logDiag(
      'db',
      'ترحيل v13: مفتاح «فعّالة بالمتجر» لحملات القسائم — تُحتسب المستحقات للحملات المفعّلة فقط',
    );
    version = 13;
  }

  if (version < 14) {
    // v22 (round-28 #4): the campaign lifecycle replaces the old
    // on/off switch — a campaign moves available → active →
    // completed and NEVER backwards. Activation is one-way (no
    // double activation, no deactivation — only «مكتملة»), and a
    // completed campaign keeps its data AND its standing dues in
    // the books exactly as they were. Fresh DDL above covers new
    // installs; this heals v13 installs (active_in_store 1 →
    // 'active') and any pre-v13 stragglers (redemptions → 'active').
    const columns = await database.execute('PRAGMA table_info(campaign_debts)');
    const names = (columns.rows ?? []).map(row =>
      String((row as {name?: unknown}).name ?? ''),
    );
    if (!names.includes('store_state')) {
      await database.execute(
        `ALTER TABLE campaign_debts ADD COLUMN store_state TEXT NOT NULL DEFAULT 'available'`,
      );
      // v13 switch ON → 'active'. A v13 row with the switch OFF but
      // real OK redemptions at this store is already 'active' by the
      // v13 auto-activation — belt and braces for restored backups.
      await database.execute(
        `UPDATE campaign_debts SET store_state = 'active'
         WHERE active_in_store = 1
            OR campaign_id IN (
              SELECT DISTINCT campaign_id FROM voucher_redemptions
              WHERE state = 'ok' AND campaign_id IS NOT NULL
            )`,
      );
    }
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_cdebts_store_state ON campaign_debts(store_state, due_minor DESC)',
    );
    logDiag(
      'db',
      'ترحيل v14: دورة حياة الحملات (متاحة → مفعّلة → مكتملة) — لا تفعيل مرتين ولا تعطيل، والمكتملة تبقى محفوظة كما هي',
    );
    version = 14;
  }

  if (version < 15) {
    // v23 (round-29 #1 + #2): product archiving + the returns system.
    // ── #1: products.is_archived — «حذف المنتج» لم يكن يعمل أبداً
    // لمنتج له سجل مبيعات/جرد (FOREIGN KEY constraint failed على
    // sale_items)؛ الآن يُؤرشف بدل الحذف: يختفي من البيع والمخزن
    // والتنبيهات ويبقى للتقارير والمرتجعات.
    const productCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'is_archived'",
    );
    const hasArchived =
      (productCols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasArchived) {
      await database.execute(
        'ALTER TABLE products ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0',
      );
    }
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_products_archived ON products(is_archived, name)',
    );

    // ── #2: sales.returned_minor + sales.return_kind — الفاتورة
    // تحمل قيمة ما أُرجع منها، وصف المرتجع (RET-) يحدد أي دفتر
    // يعكسه حتى تتصفّى تجميعات الديون بفترة المرتجع نفسها.
    const salesCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sales') WHERE name = 'returned_minor'",
    );
    const hasReturned =
      (salesCols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasReturned) {
      await database.execute(
        'ALTER TABLE sales ADD COLUMN returned_minor REAL NOT NULL DEFAULT 0',
      );
    }
    // v23.0.1: return_kind is checked INDEPENDENTLY — a crash between
    // the two ALTERs must not leave a half-migrated sales table whose
    // return_kind is missing forever (the index below would crash).
    const salesCols2 = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sales') WHERE name = 'return_kind'",
    );
    const hasReturnKind =
      (salesCols2.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasReturnKind) {
      await database.execute(`ALTER TABLE sales ADD COLUMN return_kind TEXT`);
    }
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sales_return_kind ON sales(return_kind)',
    );

    // ── #2: sila_payment_queue.kind — فصل السداد الفعلي عن العملية
    // العكسية للمرتجعات في كل إحصائيات المحصلات.
    const pqCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sila_payment_queue') WHERE name = 'kind'",
    );
    const hasKind = (pqCols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasKind) {
      await database.execute(
        `ALTER TABLE sila_payment_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'repayment'`,
      );
    }

    // ── #2: جداول المرتجعات (التعريف الكامل أعلاه في DDL — هذا
    // للمثبتات القديمة).
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sale_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_number TEXT NOT NULL UNIQUE,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        invoice_ref TEXT NOT NULL,
        book TEXT NOT NULL
          CHECK (book IN ('cash','sila','local')),
        refund_method TEXT NOT NULL DEFAULT 'none'
          CHECK (refund_method IN ('none','cash')),
        refund_minor INTEGER NOT NULL CHECK (refund_minor > 0),
        debt_adjusted_minor INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sale_return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
        sale_item_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        quantity REAL NOT NULL CHECK (quantity > 0),
        unit_name TEXT,
        base_quantity REAL NOT NULL CHECK (base_quantity > 0),
        unit_price REAL NOT NULL,
        line_total REAL NOT NULL,
        cost_price REAL NOT NULL DEFAULT 0
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sale_returns_created ON sale_returns(created_at)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sri_return ON sale_return_items(return_id)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sri_sale_item ON sale_return_items(sale_item_id)',
    );
    logDiag(
      'db',
      'ترحيل v15: أرشفة المنتجات بدل حذفها + نظام إرجاع المنتجات (RET) + العملية العكسية لمرتجعات صِلة',
    );
    version = 15;
  }

  if (version < 16) {
    // ── v25 (round-32 #3): نظام المصروفات والسحب من الخزينة ──────
    // The cash-movements ledger — the Loyverse/Square cash-drawer
    // discipline: every shekel that leaves or enters the drawer
    // outside a sale is DOCUMENTED with its own numbered reference,
    // its kind, its category and (for secured withdrawals) the
    // authorization method used:
    //   • expense     (EXP-000001) — مصروف تشغيلي (كهرباء، إيجار…)
    //   • withdrawal  (WD-000001)  — سحب رصيد من الخزينة (تأمين: بصمة/PIN)
    //   • deposit     (DEP-000001) — إيداع نقدي إلى الخزينة
    // Rows are IMMUTABLE by design (audit trail — no UPDATE/DELETE
    // APIs exist on the repo); corrections are counter-entries.
    // The treasury snapshot subtracts expenses + withdrawals and adds
    // deposits back, so «النقد المتوقع بالخزينة» always matches the
    // drawer's physical reality.
    await database.execute(
      `CREATE TABLE IF NOT EXISTS cash_movements (
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('expense','withdrawal','deposit')),
        category TEXT NOT NULL DEFAULT 'أخرى',
        note TEXT,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        auth_method TEXT NOT NULL DEFAULT 'none'
          CHECK (auth_method IN ('fingerprint','pin','none')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_cash_mov_kind_date ON cash_movements(kind, created_at)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_cash_mov_date ON cash_movements(created_at)',
    );
    logDiag(
      'db',
      'ترحيل v16: نظام المصروفات والسحب من الخزينة (سجل الحركات المالية EXP/WD/DEP)',
    );
    version = 16;
  }

  if (version < 17) {
    // ── v32 (round-40 #3): صلاحية المنتجات — تاريخ انتهاء اختياري
    //  لكل منتج ('YYYY-MM-DD'). يُغذّي تحذيرات «قرب الانتهاء»
    //  و«منتهي» في تنبيهات المخزون + إشعارات النظام، وشريحة
    //  فلترة «الصلاحية» في شاشة المخزون.
    const cols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'expiry_date'",
    );
    const hasExpiry = (cols.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasExpiry) {
      await database.execute('ALTER TABLE products ADD COLUMN expiry_date TEXT');
    }
    logDiag('db', 'ترحيل v17: تاريخ انتهاء صلاحية المنتجات');
    version = 17;
  }

  if (version < 18) {
    // v33 (round-41 #11 — SILA_STORE_APP_SPEC_v990 §3/§4.5, هجرة
    // 0075 على خادم صِلة): فصل حسابي لكل نقطة بيع — الأعمدة الثلاثة
    //  الجديدة تحمل أرصدة «هذا الجهاز تحديداً» من إسناد الخادم ثنائي
    //  المرحلة (device_outstanding = المستحق المسند لنقطتك)، فلا
    //  تختلط بفواتير متاجر التاجر الأخرى المرتبطة بنفس الحساب.
    const deviceCols: [string, string][] = [
      ['device_outstanding_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['device_purchases_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['device_payments_minor', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [column, ddl] of deviceCols) {
      const check = await database.execute(
        "SELECT COUNT(*) AS cnt FROM pragma_table_info('sila_customers') WHERE name = ?",
        [column],
      );
      const has = (check.rows?.[0] as {cnt?: number})?.cnt ?? 0;
      if (!has) {
        await database.execute(
          `ALTER TABLE sila_customers ADD COLUMN ${column} ${ddl}`,
        );
      }
    }
    logDiag(
      'db',
      'ترحيل v18: حسابات منفصلة لكل نقطة بيع (device_* من 0075)',
    );
    version = 18;
  }

  if (version < 19) {
    // ── v34 (الجولة 42 #3): نظام أنماط احترافي ────────────────────
    //  (أ) نطاق التصنيفات والوحدات لكل نمط: العمود store_mode يحمل
    //      نمط المتجر الذي ينتمي إليه التصنيف/الوحدة — تبديل النمط
    //      لا يزرع فوق القديم بعد اليوم؛ كل نمط يرى أصنافه ووحداته
    //      فقط (دون حذف أي شيء — إعادة النمط تعيد الظهور فوراً).
    //      NULL = صف قديم قبل الترقية → يُوسم بنمط المتجر الحالي
    //      مرة واحدة عند أول إقلاع (وسم البيانات القديمة يتم في
    //      طبقة الكتالوج كي يُقرأ إعداد النمط الحي، لا هنا).
    //  (ب) ربطة الملابس: style_group يجمع منتجات الموديل الواحد
    //      (بنطال جينز — أسود بمقاسات 30..36)، وvariant_size و
    //      variant_color يعرضان في شبكة البيع نافذة اختيار المقاس
    //      واللون — النمط العالمي (Shopify/Lightspeed) دون كسر أي
    //      مسار قائم: كل مقاس يبقى منتجاً كاملاً بمخزونه وباركوده.
    const modeCols: [string, string, string][] = [
      ['categories', 'store_mode', 'TEXT'],
      ['units', 'store_mode', 'TEXT'],
      ['products', 'style_group', 'TEXT'],
      ['products', 'variant_size', 'TEXT'],
      ['products', 'variant_color', 'TEXT'],
    ];
    for (const [table, column, ddl] of modeCols) {
      const check = await database.execute(
        `SELECT COUNT(*) AS cnt FROM pragma_table_info('${table}') WHERE name = ?`,
        [column],
      );
      const has = (check.rows?.[0] as {cnt?: number})?.cnt ?? 0;
      if (!has) {
        await database.execute(
          `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`,
        );
      }
    }
    logDiag(
      'db',
      'ترحيل v19: نطاق التصنيفات/الوحدات لكل نمط + ربطة الملابس (style_group)',
    );
    version = 19;
  }

  if (version < 20) {
    // ── v35 (الجولة 43): الموديل الواحد منتج واحد بمتغيرات ──────
    //  (أ) أعمدة المنتج الجديدة: has_variants (منتج بمتغيرات:
    //      ملابس لون×مقاس / مطعم أحجام)، base_unit_name (وحدة الأساس
    //      بلغة المجال: شريط/علبة/حصة/صحن/كوب)، stock_untracked
    //      (مخزون بلا تتبع — مطعم/كافيتريا)، sizes_count (عدد
    //      المقاسات بربطة الملابس — أساس بيع الجملة بالربطة).
    //  (ب) أعمدة سطر البيع: variant_label (وصف المتغير للفاتورة)
    //      و variant_id (استرجاع مخزون المتغير عند الإرجاع).
    //  (ج) دمج ربطات v34 القديمة: النسخة السابقة كانت تولّد منتجاً
    //      مستقلاً لكل مقاس بذات اسم الموديل («قام بتوزيعه على عدة
    //      منتجات وهذا خطأ») — الدمج يجمع كل منتجات الاسم نفسه في
    //      منتج واحد (أول صف) بمتغيرات (لون × مقاس) مخزون كل منها
    //      من صفه الأصلي؛ الصفوف الأخرى تُحذف إن لم يكن لها تاريخ
    //      بيع/جرد (وإلا تُؤرشف لتبقى للفواتير القديمة والإرجاع).
    const v20Cols: [string, string, string][] = [
      ['products', 'has_variants', 'INTEGER NOT NULL DEFAULT 0'],
      ['products', 'base_unit_name', 'TEXT'],
      ['products', 'stock_untracked', 'INTEGER NOT NULL DEFAULT 0'],
      ['products', 'sizes_count', 'INTEGER'],
      ['sale_items', 'variant_label', 'TEXT'],
      ['sale_items', 'variant_id', 'INTEGER'],
      ['sale_items', 'variant_color', 'TEXT'],
    ];
    for (const [table, column, ddl] of v20Cols) {
      const check = await database.execute(
        `SELECT COUNT(*) AS cnt FROM pragma_table_info('${table}') WHERE name = ?`,
        [column],
      );
      const has = (check.rows?.[0] as {cnt?: number})?.cnt ?? 0;
      if (!has) {
        await database.execute(
          `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`,
        );
      }
    }

    // (ج) دمج ربطات v34: كل منتجات الموديل الواحد (style_group
    //     مضبوط) تُجمَّع باسمها الأساسي (قبل « — لون · مقاس»).
    const legacyRows = await database.execute(
      `SELECT id, name, stock_quantity, variant_size, variant_color, style_group
         FROM products
        WHERE style_group IS NOT NULL AND style_group != '' AND is_archived = 0
        ORDER BY id ASC`,
    );
    type LegacyRow = {
      id: number;
      name: string;
      stock_quantity: number;
      variant_size: string | null;
      variant_color: string | null;
      style_group: string;
    };
    const legacy = (legacyRows.rows ?? []) as unknown as LegacyRow[];
    if (legacy.length > 0) {
      // تجميع بالاسم الأساسي للموديل (قبل « — »).
      const groups = new Map<string, LegacyRow[]>();
      for (const row of legacy) {
        const baseName = row.name.split(' — ')[0].trim() || row.name;
        const arr = groups.get(baseName) ?? [];
        arr.push(row);
        groups.set(baseName, arr);
      }
      for (const [baseName, rows] of groups) {
        // متغيرات الموديل: كل (لون × مقاس) مخزونه من صفوفه.
        const variantMap = new Map<string, number>();
        const sizes = new Set<string>();
        for (const row of rows) {
          const size = (row.variant_size ?? '').trim();
          const color = (row.variant_color ?? '').trim();
          sizes.add(size);
          const key = `${color}\u0000${size}`;
          variantMap.set(
            key,
            (variantMap.get(key) ?? 0) + Math.max(0, row.stock_quantity),
          );
        }
        const total = [...variantMap.values()].reduce(
          (sum, qty) => sum + qty,
          0,
        );
        // المنتج الباقي = أول صف (الأقدم) — يحمل الاسم الأساسي
        // والمتغيرات، وتُمسح منه سمات v34 كي لا يُعاد تجميعه.
        const primary = rows[0];
        await database.execute(
          `UPDATE products SET
             name = ?, has_variants = 1, sizes_count = ?,
             stock_quantity = ?, style_group = NULL,
             variant_size = NULL, variant_color = NULL
           WHERE id = ?`,
          [baseName, sizes.size, total, primary.id],
        );
        for (const [key, qty] of variantMap) {
          const [color, size] = key.split('\u0000');
          await database.execute(
            `INSERT OR REPLACE INTO product_variants
               (product_id, kind, color, size, stock_quantity, retail_price, cost_price, created_at)
             VALUES (?, 'variant', ?, ?, ?, NULL, NULL, datetime('now'))`,
            [primary.id, color, size, qty],
          );
        }
        // بقية صفوف المجموعة: حذف إن بلا تاريخ، وإلا أرشفة
        // (تبقى للفواتير القديمة والإرجاع — مخفية عن البيع).
        for (const row of rows.slice(1)) {
          const history = await database.execute(
            `SELECT 1 WHERE EXISTS (SELECT 1 FROM sale_items WHERE product_id = ?)
                    OR EXISTS (SELECT 1 FROM stocktake_items WHERE product_id = ?)
               LIMIT 1`,
            [row.id, row.id],
          );
          const hasHistory =
            (history.rows ?? []).length > 0;
          if (hasHistory) {
            await database.execute(
              `UPDATE products SET is_archived = 1, stock_quantity = 0
                WHERE id = ?`,
              [row.id],
            );
          } else {
            await database.execute('DELETE FROM products WHERE id = ?', [
              row.id,
            ]);
          }
        }
      }
      logDiag(
        'db',
        `ترحيل v20: دُمجت ربطات الملابس القديمة في موديلات بمتغيرات (${legacy.length} صف)`,
      );
    }
    logDiag(
      'db',
      'ترحيل v20: متغيرات المنتج + وحدة الأساس + المخزون بلا تتبع',
    );
    version = 20;
  }

  if (version < 21) {
    // ── v36: الاستبدال بقيمة المرجع في الإرجاع ─────────────────
    // أعمدة إشعار المرتجع (is_exchange/exchange_minor) + جدول
    // صور أصناف الاستبدال. بلا أي تغيير على السلوك القائم —
    // القيم القديمة تعني «إرجاع مالي عادي».
    const srCols: [string, string][] = [
      ['is_exchange', 'INTEGER NOT NULL DEFAULT 0'],
      ['exchange_minor', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [column, ddl] of srCols) {
      const check = await database.execute(
        `SELECT COUNT(*) AS cnt FROM pragma_table_info('sale_returns') WHERE name = ?`,
        [column],
      );
      const has = (check.rows?.[0] as {cnt?: number})?.cnt ?? 0;
      if (!has) {
        await database.execute(
          `ALTER TABLE sale_returns ADD COLUMN ${column} ${ddl}`,
        );
      }
    }
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sale_return_exchanges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        quantity REAL NOT NULL CHECK (quantity > 0),
        unit_name TEXT,
        base_quantity REAL NOT NULL CHECK (base_quantity > 0),
        unit_price REAL NOT NULL,
        line_total REAL NOT NULL,
        cost_price REAL NOT NULL DEFAULT 0,
        variant_id INTEGER,
        variant_color TEXT,
        variant_label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_srex_return ON sale_return_exchanges(return_id)',
    );
    logDiag('db', 'ترحيل v21: أعمدة الاستبدال وجدول صوره (الاستبدال بقيمة المرجع)');
    version = 21;
  }

  if (version < 22) {
    // ── v38 (الجولة 46 #9): جرد متغيرات الملابس ────────────────────
    // stocktake_items صار يحمل صفوفاً لكل متغير (لون × مقاس) للمنتجات
    // ذات المتغيرات — الملابس تُجرد ربطة ربطة لا كموديل واحداً.
    // القيد الفريد القديم (stocktake_id, product_id) يُستبدل بفهرس
    // تعبيري يفصل صفوف المنتج (variant_id NULL) عن صفوف متغيراته.
    // الجلسات المفتوحة القديمة تُرحّل كما هي (variant_id NULL) فلا
    // يُفقد أي عدّ قائم.
    const hasVariantCol = await database.execute(
      `SELECT COUNT(*) AS cnt FROM pragma_table_info('stocktake_items') WHERE name = 'variant_id'`,
    );
    const variantColExists =
      (hasVariantCol.rows?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!variantColExists) {
      await database.execute(`CREATE TABLE stocktake_items_v22 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stocktake_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        variant_id INTEGER,
        variant_label TEXT,
        system_qty REAL NOT NULL DEFAULT 0,
        counted_qty REAL,
        FOREIGN KEY(stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE,
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
      )`);
      await database.execute(
        `INSERT INTO stocktake_items_v22
           (stocktake_id, product_id, system_qty, counted_qty)
         SELECT stocktake_id, product_id, system_qty, counted_qty
           FROM stocktake_items`,
      );
      await database.execute('DROP TABLE stocktake_items');
      await database.execute(
        'ALTER TABLE stocktake_items_v22 RENAME TO stocktake_items',
      );
    }
    await database.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktake_items_line
         ON stocktake_items(stocktake_id, product_id, IFNULL(variant_id, 0))`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id)',
    );
    logDiag('db', 'ترحيل v22: جرد متغيرات الملابس (صف لكل لون × مقاس)');
    version = 22;
  }

  if (version !== storedVersion) {
    storage.set(KEYS.schemaVersion, version as number);
  }
}

/**
 * Opens the database, applies the schema and seeds default categories.
 * Safe to call multiple times (idempotent).
 */
export async function initDatabase(): Promise<void> {
  if (db != null) {
    return;
  }
  try {
    db = open({name: DB_NAME});

    // Performance pragmas — WAL keeps reads fast while a sale writes.
    db.execute('PRAGMA journal_mode = WAL;');
    db.execute('PRAGMA foreign_keys = ON;');

    for (const statement of DDL_STATEMENTS) {
      await db.execute(statement);
    }

    await applyMigrations(db);

    const seeded = storage.getBoolean(KEYS.seededFlag);
    if (!seeded) {
      const countResult = await db.execute(
        'SELECT COUNT(*) AS cnt FROM categories',
      );
      const countRow = countResult.rows?.[0] as
        | {cnt?: number}
        | undefined;
      if ((countRow?.cnt ?? 0) === 0) {
        for (const name of DEFAULT_CATEGORIES) {
          // v34: البذور الافتراضية موسومة بالنمط الافتراضي (بقالة).
          await db.execute(
            'INSERT INTO categories (name, store_mode) VALUES (?, ?)',
            [name, 'grocery'],
          );
        }
        logDiag('db', `تمت إضافة ${DEFAULT_CATEGORIES.length} فئات افتراضية`);
      }
      // Seed the default unit catalog (قطعة، كرتونة، كيلو…).
      const unitsCount = await db.execute('SELECT COUNT(*) AS cnt FROM units');
      const unitsRow = unitsCount.rows?.[0] as
        | {cnt?: number}
        | undefined;
      if ((unitsRow?.cnt ?? 0) === 0) {
        let order = 0;
        for (const unit of DEFAULT_UNITS) {
          // v34: البذور الافتراضية موسومة بالنمط الافتراضي (بقالة).
          await db.execute(
            'INSERT INTO units (name, short_name, sort_order, kind, store_mode) VALUES (?, ?, ?, ?, ?)',
            [unit.name, unit.short, order++, unit.kind, 'grocery'],
          );
        }
        logDiag('db', `تمت إضافة ${DEFAULT_UNITS.length} وحدات افتراضية`);
      }
      storage.set(KEYS.seededFlag, true);
    }

    logDiag('db', 'قاعدة البيانات جاهزة');
  } catch (error) {
    logDiag('db', `فشل تهيئة قاعدة البيانات: ${toMessage(error)}`, 'error');
    throw error;
  }
}

/** DANGEROUS: wipes all business data (used by Settings → reset). */
export async function wipeAllData(): Promise<void> {
  const database = getDb();
  await database.execute('DELETE FROM stocktake_items');
  await database.execute('DELETE FROM stocktakes');
  await database.execute('DELETE FROM sale_return_items');
  await database.execute('DELETE FROM sale_return_exchanges');
  await database.execute('DELETE FROM sale_returns');
  await database.execute('DELETE FROM sale_items');
  await database.execute('DELETE FROM sales');
  await database.execute('DELETE FROM product_embeddings');
  await database.execute('DELETE FROM product_units');
  await database.execute('DELETE FROM products');
  await database.execute('DELETE FROM categories');
  await database.execute('DELETE FROM units');
  await database.execute('DELETE FROM sila_customers');
  await database.execute('DELETE FROM sila_debt_queue');
  await database.execute('DELETE FROM sila_payment_queue');
  await database.execute('DELETE FROM sila_app_collections');
  await database.execute('DELETE FROM local_payments');
  await database.execute('DELETE FROM local_debts');
  await database.execute('DELETE FROM local_customers');
  await database.execute('DELETE FROM campaign_settlements');
  await database.execute('DELETE FROM campaign_debts');
  await database.execute('DELETE FROM voucher_redemptions');
  await database.execute('DELETE FROM cash_movements');
  await database.execute(
    "DELETE FROM sqlite_sequence WHERE name IN ('categories','units','products','product_embeddings','product_units','sales','sale_items','stocktakes','stocktake_items','sale_returns','sale_return_items','sale_return_exchanges','sila_debt_queue','sila_payment_queue','sila_app_collections','local_customers','local_debts','local_payments','voucher_redemptions','campaign_settlements','cash_movements')",
  );
  logDiag('db', 'تم حذف جميع البيانات بناءً على طلب المستخدم', 'warn');
}

export function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Extracts a readable message from native promise rejections. */
export function nativeErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const candidate = error as {message?: string; code?: string};
    if (candidate.message) {
      return candidate.message;
    }
    if (candidate.code) {
      return `${fallback} (${candidate.code})`;
    }
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return fallback;
}

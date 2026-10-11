/**
 * BackupService — full JSON backup & restore (v6).
 * ─────────────────────────────────────────────────────────────────
 * One file carries EVERYTHING needed to move the shop to a new device
 * or recover after a reinstall:
 *
 *   - categories + units          (with their original ids)
 *   - products                    (prices, stock, thresholds, barcode)
 *   - product_units               (sellable units + conversion + prices)
 *   - product_embeddings          (the vision fingerprints)
 *   - sales + sale_items          (full history with item lines)
 *   - stocktakes + items          (inventory count sessions)
 *   - settings                    (store info, scanner, receipts…)
 *
 * Export writes a pretty JSON into Downloads/SmartVisionPOS via the
 * native MediaStore exporter. Import opens the system file picker
 * (SAF), reads the same format and restores in ONE SQLite
 * transaction — either the whole backup lands or nothing changes.
 *
 * Format: { "app": "sela", "backupVersion": 2, ... }
 *
 * v8.3 (round-12 #3): the backup now EMBEDS the product images as
 * base64 ("images") — v1 carried only file PATHS, so a restore on a
 * new device or after a reinstall brought products back with dead
 * image references and no picture. Restore writes fresh image files
 * and repoints every product's image_uri at them. Also carries
 * sold_by_weight (weight-sold products).
 */
import {getDb, toMessage} from '../database/connection';
import {requirePlatformUtils} from '../native/nativeBridge';
import {getSettings, useSettingsStore} from '../stores/settingsStore';
import {
  APP_VERSION,
  APP_BUILD_CODE,
  EMBEDDING_MODEL_VERSION,
} from '../core/config';
import {InvoiceService} from './InvoiceService';
import {SilaSync} from './sila/SilaSync';
import {logDiag} from '../core/diagnostics';
import type {AppSettings} from '../stores/settingsStore';

const BACKUP_VERSION = 5;
const JSON_MIME = 'application/json';

/** v23 (round-29 #2): one RET receipt in a backup — keyed by the
 *  ORIGINAL invoice number (internal ids get remapped on restore). */
interface SaleReturnBackupEntry {
  return_number: string;
  sale_invoice_ref: string;
  book: string;
  refund_method: string;
  refund_minor: number;
  debt_adjusted_minor: number;
  note: string | null;
  created_at: string;
  items: {
    /** The ORIGINAL sale_items row id (mapped on restore). */
    sale_item_ref: string;
    product_id: number;
    product_name: string;
    quantity: number;
    unit_name: string | null;
    base_quantity: number;
    unit_price: number;
    line_total: number;
    cost_price: number;
  }[];
}

export interface BackupSummary {
  categories: number;
  units: number;
  products: number;
  productUnits: number;
  embeddings: number;
  sales: number;
  createdAt: string;
  /** v15 (round-21 #2): rows a legacy backup carried with duplicate
   *  keys — skipped instead of failing the whole restore. */
  skippedSales?: number;
}

/** v28 (round-36 #4): exported for the Google Drive restore path. */
export interface BackupFile {
  app: string;
  backupVersion: number;
  createdAt: string;
  appVersion: string;
  /** v10 (round-16 #4): the embedding-model generation the
   *  fingerprints were built with — a mismatched generation is
   *  SKIPPED on restore (vectors from another model live in a
   *  different space and would poison matching). */
  embeddingModelVersion?: number;
  /** v34: مع عمود نطاق النمط (store_mode) — الاستعادة تحافظ على
   *  فصل تصنيفات كل مجال. */
  categories: {id: number; name: string; store_mode?: string | null}[];
  units: {
    id: number;
    name: string;
    short_name: string;
    sort_order: number;
    /** v9.2 (round-15 #3): the unit type (old backups: undefined). */
    kind?: string;
    /** v34: نطاق النمط الذي تخدمه الوحدة. */
    store_mode?: string | null;
  }[];
  products: {
    id: number;
    name: string;
    cost_price: number;
    retail_price: number;
    wholesale_price: number;
    stock_quantity: number;
    category_id: number | null;
    image_uri: string | null;
    low_stock_threshold: number | null;
    barcode: string | null;
    sold_by_weight?: number;
    /** v23 (round-29 #1): 1 = archived (old backups: live). */
    is_archived?: number;
    /** v32 (round-40 #3): expiry 'YYYY-MM-DD' (old backups: none). */
    expiry_date?: string | null;
    /** v34: ربطة الملابس. */
    style_group?: string | null;
    variant_size?: string | null;
    variant_color?: string | null;
    /** v35 (الجولة 43): متغيرات المنتج + وحدة الأساس + المخزون
     *  بلا تتبع + مقاسات الربطة (نسخ قديمة: القيم الافتراضية). */
    has_variants?: number;
    base_unit_name?: string | null;
    stock_untracked?: number;
    sizes_count?: number | null;
    created_at: string;
  }[];
  product_units: {
    product_id: number;
    unit_id: number;
    conversion: number;
    barcode: string | null;
    retail_price: number | null;
    wholesale_price: number | null;
  }[];
  /** v35 (الجولة 43): متغيرات المنتجات (ملابس لون×مقاس، مطعم
   *  أحجام بأسعارها) — اختيارية كي تُستعاد النسخ الأقدم. */
  product_variants?: {
    id: number;
    product_id: number;
    kind: 'variant' | 'size';
    color: string;
    size: string;
    stock_quantity: number;
    retail_price: number | null;
    cost_price: number | null;
  }[];
  embeddings: {
    product_id: number;
    angle_label: string;
    embedding_data: string;
    /** v14 (round-20 #4): the enrollment photo path — optional so
     * older backup files (without it) still restore. */
    thumbnail_path?: string | null;
  }[];
  sales: {
    id: number;
    invoice_number: string;
    total_amount: number;
    total_cost: number;
    total_profit: number;
    discount: number;
    payment_type: string | null;
    created_at: string;
    /** v23 (round-29 #2): the return columns (old backups: 0/NULL —
     * a backup from before returns simply had none). */
    returned_minor?: number;
    return_kind?: string | null;
  }[];
  sale_items: {
    /** v23 (round-29 #2): the ORIGINAL line id — lets the restore
     *  remap sale_return_items.sale_item_id (old backups: the
     *  return lines simply restore unmapped). */
    id?: number;
    sale_id: number;
    product_id: number;
    quantity: number;
    unit_price: number;
    cost_price: number;
    total_line_price: number;
    /** v23 (round-29 #2): fixing a PRE-EXISTING gap — unit_name and
     * base_quantity never traveled with backups, so restored
     * history lost its unit labels and stock math. Optional so old
     * files still restore. */
    unit_name?: string | null;
    base_quantity?: number | null;
    /** v35 (الجولة 43): وصف المتغير ومعرّفه (استرجاع المخزون
     *  الدقيق عند إرجاع نسخة مستعادة). */
    variant_label?: string | null;
    variant_id?: number | null;
  }[];
  /** v23 (round-29 #2): the RETURNS — RET receipts (and their own
  // negative sales rows above) with the line snapshots. Optional
  // so older backups restore cleanly without them. */
  sale_returns?: {
    return_number: string;
    sale_invoice_ref: string;
    book: string;
    refund_method: string;
    refund_minor: number;
    debt_adjusted_minor: number;
    note: string | null;
    created_at: string;
    items: {
      sale_item_ref: string;
      product_id: number;
      product_name: string;
      quantity: number;
      unit_name: string | null;
      base_quantity: number;
      unit_price: number;
      line_total: number;
      cost_price: number;
    }[];
  }[];
  stocktakes: {
    id: number;
    started_at: string;
    completed_at: string | null;
    status: string;
    note: string | null;
  }[];
  stocktake_items: {
    stocktake_id: number;
    product_id: number;
    /** v38 (الجولة 46 #9): صف متغير ملابس — معرّف المتغير وتسميته
     *  (لون · مقاس)؛ NULL لصف المنتج العادي. */
    variant_id?: number | null;
    variant_label?: string | null;
    system_qty: number;
    counted_qty: number | null;
  }[];
  /** v11 (SILA): the debt queue — restoring must bring debts back
   *  (they sync by idempotency_key, safe by design §6.2). */
  sila_debts?: {
    idempotency_key: string;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone_last4: string | null;
    customer_card: string | null;
    offline_qr: string | null;
    amount_minor: number;
    currency: string;
    pos_invoice_ref: string;
    description: string | null;
    scanned_at: string;
    /** v17 (round-23 #3): prepaid-credit coverage — older backups
     *  restore as 0 (auto-derived again after the next sync). */
    credit_covered_minor?: number;
    state: 'pending' | 'syncing' | 'synced' | 'failed';
    reference_code: string | null;
    transaction_id: string | null;
    outstanding_after: number | null;
    synced_at: string | null;
    error_code: string | null;
    error_message: string | null;
    retry_count: number;
    created_at: string;
  }[];
  /** v11 (SILA): cached customers balances.
   *  v15 (round-21 #3): + the origin-split fields (§2.4) — older
   *  backups without them restore as 0 (legacy mixing tolerant). */
  sila_customers?: {
    customer_id: string;
    name: string;
    phone_last4: string | null;
    id_number: string | null;
    outstanding_minor: number;
    /** v17 (round-23 #3): the prepaid credit cache. */
    credit_minor?: number;
    pos_outstanding_minor?: number;
    app_outstanding_minor?: number;
    other_minor?: number;
    pos_purchases_minor?: number;
    app_purchases_minor?: number;
    last_payment_at?: string | null;
    last_payment_amount_minor?: number | null;
    /** v18 (round-24 #1): the reconciliation baseline anchor —
     *  restored with the row so the collections engine never
     *  re-detects pre-anchor history after a restore. */
    reconcile_offset_minor?: number;
    last_synced_at: string | null;
  }[];
  /** v15 (round-21 #3): the repayments queue — one row per RCP
   *  receipt, same restore rules as the debts (§3.1). */
  sila_payments?: {
    idempotency_key: string;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone_last4: string | null;
    amount_minor: number;
    payment_method: string;
    pos_receipt_ref: string;
    description: string | null;
    paid_at: string;
    state: 'pending' | 'syncing' | 'synced' | 'failed';
    /** v23 (round-29 #2): 'return_reversal' rows restore as such;
     * older backups default to 'repayment'. */
    kind?: 'repayment' | 'return_reversal';
    reference_code: string | null;
    transaction_id: string | null;
    outstanding_after: number | null;
    synced_at: string | null;
    error_code: string | null;
    error_message: string | null;
    retry_count: number;
    created_at: string;
  }[];
  /** v16 (round-22 #4): the STORE-LOCAL debt book — accounts by ID
   *  number + their INV-L debts and RCP-L repayments. All local,
   *  never uploaded; restoring brings the whole book back. */
  local_customers?: {
    id: number;
    id_number: string;
    name: string;
    phone: string | null;
    notes: string | null;
    sila_customer_id: string | null;
    sila_linked_at: string | null;
    created_at: string;
  }[];
  local_debts?: {
    local_customer_id: number;
    invoice_ref: string;
    amount_minor: number;
    description: string | null;
    migrated: number;
    migrated_ref: string | null;
    created_at: string;
  }[];
  local_payments?: {
    local_customer_id: number;
    receipt_ref: string;
    amount_minor: number;
    method: string;
    note: string | null;
    created_at: string;
  }[];
  /** v18 (round-24 #1): money صِلة collected on the store's behalf
   *  (customer repaid through the Sila app) — restoring this ledger
   *  keeps the treasury and reports whole; without it every restored
   *  install would re-detect the same collections as NEW money on
   *  the next sync (double count). */
  sila_app_collections?: {
    customer_id: string;
    customer_name: string | null;
    amount_minor: number;
    detected_at: string;
  }[];
  /** v20 (SILA_POS_VOUCHERS_API): the voucher campaigns book —
   *  redemption attempts (with their cart snapshots + sale links),
   *  the campaigns claim ledger and the settlements mirror.
   *  Restoring them keeps the treasury/reports whole and stops the
   *  settlements sync from re-notifying old arrivals; campaign
   *  balances re-verify against the server on the next sync anyway
   *  (server truth wins). */
  voucher_redemptions?: {
    idempotency_key: string;
    payload: string;
    campaign_id: string | null;
    campaign_name: string | null;
    campaign_kind: string | null;
    voucher_id: string | null;
    value_minor: number;
    pos_receipt_ref: string | null;
    reference_code: string | null;
    beneficiary_last4: string | null;
    redeemed_at: string;
    state: string;
    cart_json: string | null;
    sale_id: number | null;
    counter_extra_minor: number;
    error_code: string | null;
    error_message: string | null;
    retry_count: number;
    synced_at: string | null;
    created_at: string;
  }[];
  campaign_debts?: {
    campaign_id: string;
    campaign_name: string;
    kind: string | null;
    campaign_status: string | null;
    merchant_status: string | null;
    starts_at: string | null;
    ends_at: string | null;
    /** v22 (round-28 #4): the in-store lifecycle — restored EXACTLY
     *  as it was (available/active/completed): «في النسخة
     *  الاحتياطية تسترجع حالة الحملة كما هي». */
    store_state?: 'available' | 'active' | 'completed';
    redeemed_count: number;
    redeemed_value_minor: number;
    settled_minor: number;
    settled_pending_minor: number;
    settled_confirmed_minor: number;
    due_minor: number;
    settlement_state: string;
    last_redemption_at: string | null;
    last_settlement_at: string | null;
    updated_at: string | null;
  }[];
  campaign_settlements?: {
    settlement_id: string;
    campaign_id: string;
    campaign_name: string | null;
    amount_minor: number;
    kind: string | null;
    status: string;
    method: string | null;
    reference: string | null;
    created_at: string;
  }[];
  /** v8.3: embedded product image files (base64 JPEG) — keyed by
   *  `name`, referenced by the products' original image paths. */
  images?: {name: string; data: string}[];
  settings: Partial<AppSettings>;
}

function rowsOf(result: {
  rows?: unknown[];
}): Record<string, unknown>[] {
  return (result.rows ?? []) as Record<string, unknown>[];
}

function nowLocal(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export const BackupService = {
  /** Builds the backup JSON document from the live database.
   *  v28 (round-36 #4): `compact` skips the pretty indentation —
   *  the Google Drive upload path uses it to shave ~15% off the
   *  uploaded bytes (the local Downloads export stays pretty). */
  async buildBackupJson(
    options?: {compact?: boolean},
  ): Promise<{json: string; summary: BackupSummary}> {
    const db = getDb();

    const [
      categories,
      units,
      products,
      productUnits,
      productVariants,
      embeddings,
      sales,
      saleItems,
      saleReturnsRaw,
      stocktakes,
      stocktakeItems,
      silaDebts,
      silaCustomers,
      silaPayments,
      localCustomers,
      localDebts,
      localPayments,
      appCollections,
      voucherRedemptions,
      campaignDebts,
      campaignSettlements,
    ] = await Promise.all([
      db.execute('SELECT id, name, store_mode FROM categories'),
      db.execute('SELECT id, name, short_name, sort_order, kind, store_mode FROM units'),
      db.execute(
        'SELECT id, name, cost_price, retail_price, wholesale_price, stock_quantity, category_id, image_uri, low_stock_threshold, barcode, sold_by_weight, is_archived, expiry_date, style_group, variant_size, variant_color, has_variants, base_unit_name, stock_untracked, sizes_count, created_at FROM products',
      ),
      db.execute(
        'SELECT product_id, unit_id, conversion, barcode, retail_price, wholesale_price FROM product_units',
      ),
      // v35 (الجولة 43): متغيرات المنتجات — تنتقل وتُعاد بترقيم
      //  جديد مع منتجاتها (ملابس لون×مقاس، مطعم أحجام بأسعارها).
      db
        .execute(
          'SELECT id, product_id, kind, color, size, stock_quantity, retail_price, cost_price FROM product_variants',
        )
        .catch(() => ({rows: []})),
      db.execute(
        'SELECT product_id, angle_label, embedding_data, thumbnail_path FROM product_embeddings',
      ),
      db.execute(
        'SELECT id, invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, returned_minor, return_kind FROM sales',
      ),
      db.execute(
        'SELECT id, sale_id, product_id, quantity, unit_price, cost_price, total_line_price, unit_name, base_quantity, variant_label, variant_id FROM sale_items',
      ),
      // v23 (round-29 #2): the RETURNS — with the ORIGINAL invoice
      //  number (invoice_ref), NOT the internal sale id (ids get
      //  remapped on restore; invoice numbers are stable).
      db
        .execute(
          `SELECT sr.return_number, sr.invoice_ref AS sale_invoice_ref, sr.book,
                  sr.refund_method, sr.refund_minor, sr.debt_adjusted_minor,
                  sr.note, sr.created_at,
                  si.id AS sale_item_id, si.product_id, si.product_name,
                  si.quantity, si.unit_name, si.base_quantity, si.unit_price,
                  si.line_total, si.cost_price
           FROM sale_returns sr
           LEFT JOIN sale_return_items si ON si.return_id = sr.id
           ORDER BY sr.id ASC, si.id ASC`,
        )
        .catch(() => ({rows: []})),
      db.execute(
        'SELECT id, started_at, completed_at, status, note FROM stocktakes',
      ),
      db.execute(
        'SELECT stocktake_id, product_id, variant_id, variant_label, system_qty, counted_qty FROM stocktake_items',
      ),
      db.execute(
        `SELECT idempotency_key, customer_id, customer_name, customer_phone_last4,
                customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
                description, scanned_at, credit_covered_minor, state, reference_code, transaction_id,
                outstanding_after, synced_at, error_code, error_message, retry_count, created_at
         FROM sila_debt_queue`,
      ),
      db.execute(
        `SELECT customer_id, name, phone_last4, id_number, outstanding_minor,
                credit_minor,
                pos_outstanding_minor, app_outstanding_minor, other_minor,
                pos_purchases_minor, app_purchases_minor,
                last_payment_at, last_payment_amount_minor,
                reconcile_offset_minor, last_synced_at
         FROM sila_customers`,
      ),
      db
        .execute(
          `SELECT idempotency_key, customer_id, customer_name, customer_phone_last4,
                amount_minor, payment_method, pos_receipt_ref, description,
                paid_at, state, kind, reference_code, transaction_id,
                outstanding_after, synced_at, error_code, error_message,
                retry_count, created_at
         FROM sila_payment_queue`,
        )
        .catch(() => ({rows: []})),
      db
        .execute(
          `SELECT id, id_number, name, phone, notes, sila_customer_id,
                sila_linked_at, created_at
         FROM local_customers`,
        )
        .catch(() => ({rows: []})),
      db
        .execute(
          `SELECT local_customer_id, invoice_ref, amount_minor, description,
                migrated, migrated_ref, created_at
         FROM local_debts`,
        )
        .catch(() => ({rows: []})),
      db
        .execute(
          `SELECT local_customer_id, receipt_ref, amount_minor, method, note,
                created_at
         FROM local_payments`,
        )
        .catch(() => ({rows: []})),
      db
        .execute(
          `SELECT customer_id, customer_name, amount_minor, detected_at
         FROM sila_app_collections`,
        )
        .catch(() => ({rows: []})),
      db
        .execute(
          `SELECT idempotency_key, payload, campaign_id, campaign_name,
                campaign_kind, voucher_id, value_minor, pos_receipt_ref,
                reference_code, beneficiary_last4, redeemed_at, state,
                cart_json, sale_id, counter_extra_minor, error_code,
                error_message, retry_count, synced_at, created_at
         FROM voucher_redemptions`,
        )
        .catch(() => ({rows: []})),
      db
        .execute(
          `SELECT campaign_id, campaign_name, kind, campaign_status,
                merchant_status, starts_at, ends_at, store_state,
                redeemed_count, redeemed_value_minor, settled_minor,
                settled_pending_minor, settled_confirmed_minor, due_minor,
                settlement_state, last_redemption_at, last_settlement_at,
                updated_at
         FROM campaign_debts`,
        )
        .catch(() => ({rows: []})),
      db
        .execute(
          `SELECT settlement_id, campaign_id, campaign_name, amount_minor,
                kind, status, method, reference, created_at
         FROM campaign_settlements`,
        )
        .catch(() => ({rows: []})),
    ]);

    // v8.3 (round-12 #3): embed every product image as base64 so a
    // restore on ANY device brings the pictures back. Files are read
    // through the guarded native helper; a missing/dead file is
    // silently skipped (its path is simply not in the map, and the
    // restore then clears that product's image).
    const images: {name: string; data: string}[] = [];
    try {
      const platform = requirePlatformUtils();
      const seen = new Set<string>();
      for (const row of rowsOf(products)) {
        const uri = row.image_uri == null ? null : String(row.image_uri);
        if (uri == null || uri.length === 0 || seen.has(uri)) {
          continue;
        }
        seen.add(uri);
        try {
          const base64 = await platform.readFileBase64(uri);
          if (base64.length > 0) {
            const name = `img_${images.length}_${uri
              .split('/')
              .pop()
              ?.replace(/[^A-Za-z0-9._-]/g, '_')}`;
            images.push({name, data: base64});
          }
        } catch {
          // Dead path — nothing to embed.
        }
      }
    } catch {
      // Native helper unavailable (old bridge?) — export paths only.
    }

    const doc: BackupFile = {
      app: 'sela',
      backupVersion: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: `${APP_VERSION} (${APP_BUILD_CODE})`,
      categories: rowsOf(categories).map(row => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
        // v34: نطاق النمط — يُنقل مع النسخة كي تبقى المجالات مفصولة.
        store_mode: row.store_mode == null ? null : String(row.store_mode),
      })),
      units: rowsOf(units).map(row => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
        short_name: String(row.short_name ?? ''),
        sort_order: Number(row.sort_order ?? 0),
        kind: String(row.kind ?? 'piece'),
        store_mode: row.store_mode == null ? null : String(row.store_mode),
      })),
      products: rowsOf(products).map(row => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
        cost_price: Number(row.cost_price ?? 0),
        retail_price: Number(row.retail_price ?? 0),
        wholesale_price: Number(row.wholesale_price ?? 0),
        stock_quantity: Number(row.stock_quantity ?? 0),
        category_id: row.category_id == null ? null : Number(row.category_id),
        image_uri: row.image_uri == null ? null : String(row.image_uri),
        low_stock_threshold:
          row.low_stock_threshold == null
            ? null
            : Number(row.low_stock_threshold),
        barcode: row.barcode == null ? null : String(row.barcode),
        sold_by_weight: Number(row.sold_by_weight ?? 0) === 1 ? 1 : 0,
        is_archived: Number(row.is_archived ?? 0) === 1 ? 1 : 0,
        expiry_date:
          row.expiry_date == null || String(row.expiry_date).length < 10
            ? null
            : String(row.expiry_date).slice(0, 10),
        // v34: ربطة الملابس — المجموعة والمقاس واللون.
        style_group: row.style_group == null ? null : String(row.style_group),
        variant_size: row.variant_size == null ? null : String(row.variant_size),
        variant_color:
          row.variant_color == null ? null : String(row.variant_color),
        // v35 (الجولة 43): متغيرات المنتج + وحدة الأساس + المخزون
        //  بلا تتبع + مقاسات الربطة.
        has_variants: Number(row.has_variants ?? 0) === 1 ? 1 : 0,
        base_unit_name:
          row.base_unit_name == null || String(row.base_unit_name).length === 0
            ? null
            : String(row.base_unit_name),
        stock_untracked: Number(row.stock_untracked ?? 0) === 1 ? 1 : 0,
        sizes_count: row.sizes_count == null ? null : Number(row.sizes_count),
        created_at: String(row.created_at ?? ''),
      })),
      product_units: rowsOf(productUnits).map(row => ({
        product_id: Number(row.product_id),
        unit_id: Number(row.unit_id),
        conversion: Number(row.conversion ?? 1),
        barcode: row.barcode == null ? null : String(row.barcode),
        retail_price:
          row.retail_price == null ? null : Number(row.retail_price),
        wholesale_price:
          row.wholesale_price == null ? null : Number(row.wholesale_price),
      })),
      // v35 (الجولة 43): متغيرات المنتجات — تنتقل كما هي وتُعاد
      //  بترقيم جديد مع منتجها في الاسترجاع.
      product_variants: rowsOf(productVariants).map(row => ({
        id: Number(row.id),
        product_id: Number(row.product_id),
        kind: String(row.kind ?? 'variant') === 'size' ? 'size' : 'variant',
        color: String(row.color ?? ''),
        size: String(row.size ?? ''),
        stock_quantity: Number(row.stock_quantity ?? 0),
        retail_price: row.retail_price == null ? null : Number(row.retail_price),
        cost_price: row.cost_price == null ? null : Number(row.cost_price),
      })),
      embeddings: rowsOf(embeddings).map(row => ({
        product_id: Number(row.product_id),
        angle_label: String(row.angle_label ?? 'front'),
        embedding_data: String(row.embedding_data ?? '[]'),
        thumbnail_path:
          row.thumbnail_path == null || row.thumbnail_path === ''
            ? null
            : String(row.thumbnail_path),
      })),
      sales: rowsOf(sales).map(row => ({
        id: Number(row.id),
        invoice_number: String(row.invoice_number ?? ''),
        total_amount: Number(row.total_amount ?? 0),
        total_cost: Number(row.total_cost ?? 0),
        total_profit: Number(row.total_profit ?? 0),
        discount: Number(row.discount ?? 0),
        payment_type:
          row.payment_type == null ? null : String(row.payment_type),
        created_at: String(row.created_at ?? ''),
        returned_minor: Number(row.returned_minor ?? 0),
        return_kind: row.return_kind == null ? null : String(row.return_kind),
      })),
      sale_items: rowsOf(saleItems).map(row => ({
        id: Number(row.id),
        sale_id: Number(row.sale_id),
        product_id: Number(row.product_id),
        quantity: Number(row.quantity ?? 0),
        unit_price: Number(row.unit_price ?? 0),
        cost_price: Number(row.cost_price ?? 0),
        total_line_price: Number(row.total_line_price ?? 0),
        unit_name: row.unit_name == null ? null : String(row.unit_name),
        base_quantity:
          row.base_quantity == null ? null : Number(row.base_quantity),
        variant_label:
          row.variant_label == null || String(row.variant_label).length === 0
            ? null
            : String(row.variant_label),
        variant_id: row.variant_id == null ? null : Number(row.variant_id),
      })),
      // v23 (round-29 #2): the returns, grouped one entry per RET
      //  receipt with its line snapshots (the export's LEFT JOIN
      //  yields one row per line + a bare row for empty receipts).
      sale_returns: (() => {
        const byNumber = new Map<string, SaleReturnBackupEntry>();
        for (const row of rowsOf(saleReturnsRaw)) {
          const number = String(row.return_number ?? '');
          if (number.length === 0) {
            continue;
          }
          let ret = byNumber.get(number);
          if (ret == null) {
            ret = {
              return_number: number,
              sale_invoice_ref: String(row.sale_invoice_ref ?? ''),
              book: String(row.book ?? 'cash'),
              refund_method: String(row.refund_method ?? 'none'),
              refund_minor: Number(row.refund_minor ?? 0),
              debt_adjusted_minor: Number(row.debt_adjusted_minor ?? 0),
              note: row.note == null ? null : String(row.note),
              created_at: String(row.created_at ?? ''),
              items: [],
            };
            byNumber.set(number, ret);
          }
          if (row.sale_item_id != null) {
            ret.items.push({
              sale_item_ref: String(row.sale_item_id),
              product_id: Number(row.product_id),
              product_name: String(row.product_name ?? ''),
              quantity: Number(row.quantity ?? 0),
              unit_name: row.unit_name == null ? null : String(row.unit_name),
              base_quantity: Number(row.base_quantity ?? 0),
              unit_price: Number(row.unit_price ?? 0),
              line_total: Number(row.line_total ?? 0),
              cost_price: Number(row.cost_price ?? 0),
            });
          }
        }
        return [...byNumber.values()];
      })(),
      stocktakes: rowsOf(stocktakes).map(row => ({
        id: Number(row.id),
        started_at: String(row.started_at ?? ''),
        completed_at:
          row.completed_at == null ? null : String(row.completed_at),
        status: String(row.status ?? 'open'),
        note: row.note == null ? null : String(row.note),
      })),
      stocktake_items: rowsOf(stocktakeItems).map(row => ({
        stocktake_id: Number(row.stocktake_id),
        product_id: Number(row.product_id),
        variant_id: row.variant_id == null ? null : Number(row.variant_id),
        variant_label:
          row.variant_label == null ? null : String(row.variant_label),
        system_qty: Number(row.system_qty ?? 0),
        counted_qty: row.counted_qty == null ? null : Number(row.counted_qty),
      })),
      sila_debts: rowsOf(silaDebts).map(row => ({
        idempotency_key: String(row.idempotency_key ?? ''),
        customer_id: row.customer_id == null ? null : String(row.customer_id),
        customer_name:
          row.customer_name == null ? null : String(row.customer_name),
        customer_phone_last4:
          row.customer_phone_last4 == null
            ? null
            : String(row.customer_phone_last4),
        customer_card:
          row.customer_card == null ? null : String(row.customer_card),
        offline_qr: row.offline_qr == null ? null : String(row.offline_qr),
        amount_minor: Number(row.amount_minor ?? 0),
        currency: String(row.currency ?? 'ILS'),
        pos_invoice_ref: String(row.pos_invoice_ref ?? ''),
        description: row.description == null ? null : String(row.description),
        scanned_at: String(row.scanned_at ?? ''),
        credit_covered_minor: Number(row.credit_covered_minor ?? 0),
        state: (row.state ?? 'pending') as 'pending',
        reference_code:
          row.reference_code == null ? null : String(row.reference_code),
        transaction_id:
          row.transaction_id == null ? null : String(row.transaction_id),
        outstanding_after:
          row.outstanding_after == null ? null : Number(row.outstanding_after),
        synced_at: row.synced_at == null ? null : String(row.synced_at),
        error_code: row.error_code == null ? null : String(row.error_code),
        error_message:
          row.error_message == null ? null : String(row.error_message),
        retry_count: Number(row.retry_count ?? 0),
        created_at: String(row.created_at ?? ''),
      })),
      sila_customers: rowsOf(silaCustomers).map(row => ({
        customer_id: String(row.customer_id ?? ''),
        name: String(row.name ?? ''),
        phone_last4: row.phone_last4 == null ? null : String(row.phone_last4),
        id_number: row.id_number == null ? null : String(row.id_number),
        outstanding_minor: Number(row.outstanding_minor ?? 0),
        credit_minor: Number(row.credit_minor ?? 0),
        pos_outstanding_minor: Number(row.pos_outstanding_minor ?? 0),
        app_outstanding_minor: Number(row.app_outstanding_minor ?? 0),
        other_minor: Number(row.other_minor ?? 0),
        pos_purchases_minor: Number(row.pos_purchases_minor ?? 0),
        app_purchases_minor: Number(row.app_purchases_minor ?? 0),
        last_payment_at:
          row.last_payment_at == null ? null : String(row.last_payment_at),
        last_payment_amount_minor:
          row.last_payment_amount_minor == null
            ? null
            : Number(row.last_payment_amount_minor),
        reconcile_offset_minor: Number(row.reconcile_offset_minor ?? 0),
        last_synced_at:
          row.last_synced_at == null ? null : String(row.last_synced_at),
      })),
      sila_payments: rowsOf(silaPayments).map(row => ({
        idempotency_key: String(row.idempotency_key ?? ''),
        customer_id: row.customer_id == null ? null : String(row.customer_id),
        customer_name:
          row.customer_name == null ? null : String(row.customer_name),
        customer_phone_last4:
          row.customer_phone_last4 == null
            ? null
            : String(row.customer_phone_last4),
        amount_minor: Number(row.amount_minor ?? 0),
        payment_method: String(row.payment_method ?? 'cash'),
        pos_receipt_ref: String(row.pos_receipt_ref ?? ''),
        description: row.description == null ? null : String(row.description),
        paid_at: String(row.paid_at ?? ''),
        state: (row.state ?? 'pending') as 'pending',
        kind: row.kind === 'return_reversal' ? 'return_reversal' : 'repayment',
        reference_code:
          row.reference_code == null ? null : String(row.reference_code),
        transaction_id:
          row.transaction_id == null ? null : String(row.transaction_id),
        outstanding_after:
          row.outstanding_after == null ? null : Number(row.outstanding_after),
        synced_at: row.synced_at == null ? null : String(row.synced_at),
        error_code: row.error_code == null ? null : String(row.error_code),
        error_message:
          row.error_message == null ? null : String(row.error_message),
        retry_count: Number(row.retry_count ?? 0),
        created_at: String(row.created_at ?? ''),
      })),
      // v16 (round-22 #4): the store-local debt book travels with
      // the backup — accounts (with their صِلة links), INV-L debts
      // and RCP-L repayments, verbatim (all IDs remapped on restore).
      local_customers: rowsOf(localCustomers).map(row => ({
        id: Number(row.id ?? 0),
        id_number: String(row.id_number ?? ''),
        name: String(row.name ?? ''),
        phone: row.phone == null ? null : String(row.phone),
        notes: row.notes == null ? null : String(row.notes),
        sila_customer_id:
          row.sila_customer_id == null ? null : String(row.sila_customer_id),
        sila_linked_at:
          row.sila_linked_at == null ? null : String(row.sila_linked_at),
        created_at: String(row.created_at ?? ''),
      })),
      local_debts: rowsOf(localDebts).map(row => ({
        local_customer_id: Number(row.local_customer_id ?? 0),
        invoice_ref: String(row.invoice_ref ?? ''),
        amount_minor: Number(row.amount_minor ?? 0),
        description: row.description == null ? null : String(row.description),
        migrated: Number(row.migrated ?? 0),
        migrated_ref:
          row.migrated_ref == null ? null : String(row.migrated_ref),
        created_at: String(row.created_at ?? ''),
      })),
      local_payments: rowsOf(localPayments).map(row => ({
        local_customer_id: Number(row.local_customer_id ?? 0),
        receipt_ref: String(row.receipt_ref ?? ''),
        amount_minor: Number(row.amount_minor ?? 0),
        method: String(row.method ?? 'cash'),
        note: row.note == null ? null : String(row.note),
        created_at: String(row.created_at ?? ''),
      })),
      // v18 (round-24 #1): the Sila-app collections ledger.
      sila_app_collections: rowsOf(appCollections).map(row => ({
        customer_id: String(row.customer_id ?? ''),
        customer_name:
          row.customer_name == null ? null : String(row.customer_name),
        amount_minor: Number(row.amount_minor ?? 0),
        detected_at: String(row.detected_at ?? ''),
      })),
      // v20: the voucher campaigns book (redemptions + claims +
      // settlements mirror) — sale_id restores by receipt ref.
      voucher_redemptions: rowsOf(voucherRedemptions).map(row => ({
        idempotency_key: String(row.idempotency_key ?? ''),
        payload: String(row.payload ?? ''),
        campaign_id: row.campaign_id == null ? null : String(row.campaign_id),
        campaign_name:
          row.campaign_name == null ? null : String(row.campaign_name),
        campaign_kind:
          row.campaign_kind == null ? null : String(row.campaign_kind),
        voucher_id: row.voucher_id == null ? null : String(row.voucher_id),
        value_minor: Number(row.value_minor ?? 0),
        pos_receipt_ref:
          row.pos_receipt_ref == null ? null : String(row.pos_receipt_ref),
        reference_code:
          row.reference_code == null ? null : String(row.reference_code),
        beneficiary_last4:
          row.beneficiary_last4 == null ? null : String(row.beneficiary_last4),
        redeemed_at: String(row.redeemed_at ?? ''),
        state: String(row.state ?? 'pending'),
        cart_json: row.cart_json == null ? null : String(row.cart_json),
        sale_id: row.sale_id == null ? null : Number(row.sale_id),
        counter_extra_minor: Number(row.counter_extra_minor ?? 0),
        error_code: row.error_code == null ? null : String(row.error_code),
        error_message:
          row.error_message == null ? null : String(row.error_message),
        retry_count: Number(row.retry_count ?? 0),
        synced_at: row.synced_at == null ? null : String(row.synced_at),
        created_at: String(row.created_at ?? ''),
      })),
      campaign_debts: rowsOf(campaignDebts).map(row => ({
        campaign_id: String(row.campaign_id ?? ''),
        campaign_name: String(row.campaign_name ?? ''),
        kind: row.kind == null ? null : String(row.kind),
        campaign_status:
          row.campaign_status == null ? null : String(row.campaign_status),
        merchant_status:
          row.merchant_status == null ? null : String(row.merchant_status),
        starts_at: row.starts_at == null ? null : String(row.starts_at),
        ends_at: row.ends_at == null ? null : String(row.ends_at),
        // v22 (round-28 #4): the lifecycle state rides along so a
        // restore never resets an activated/completed campaign.
        store_state:
          row.store_state === 'active' || row.store_state === 'completed'
            ? row.store_state
            : 'available',
        redeemed_count: Number(row.redeemed_count ?? 0),
        redeemed_value_minor: Number(row.redeemed_value_minor ?? 0),
        settled_minor: Number(row.settled_minor ?? 0),
        settled_pending_minor: Number(row.settled_pending_minor ?? 0),
        settled_confirmed_minor: Number(row.settled_confirmed_minor ?? 0),
        due_minor: Number(row.due_minor ?? 0),
        settlement_state: String(row.settlement_state ?? 'none'),
        last_redemption_at:
          row.last_redemption_at == null
            ? null
            : String(row.last_redemption_at),
        last_settlement_at:
          row.last_settlement_at == null
            ? null
            : String(row.last_settlement_at),
        updated_at: row.updated_at == null ? null : String(row.updated_at),
      })),
      campaign_settlements: rowsOf(campaignSettlements).map(row => ({
        settlement_id: String(row.settlement_id ?? ''),
        campaign_id: String(row.campaign_id ?? ''),
        campaign_name:
          row.campaign_name == null ? null : String(row.campaign_name),
        amount_minor: Number(row.amount_minor ?? 0),
        kind: row.kind == null ? null : String(row.kind),
        status: String(row.status ?? 'pending'),
        method: row.method == null ? null : String(row.method),
        reference: row.reference == null ? null : String(row.reference),
        created_at: String(row.created_at ?? ''),
      })),
      images,
      settings: getSettings(),
      embeddingModelVersion: EMBEDDING_MODEL_VERSION,
    };

    return {
      json: JSON.stringify(doc, null, options?.compact ? 0 : 2),
      summary: {
        categories: doc.categories.length,
        units: doc.units.length,
        products: doc.products.length,
        productUnits: doc.product_units.length,
        embeddings: doc.embeddings.length,
        sales: doc.sales.length,
        createdAt: doc.createdAt,
      },
    };
  },

  /** Writes the backup file into Downloads/SmartVisionPOS. */
  async exportBackup(): Promise<{path: string; summary: BackupSummary}> {
    const {json, summary} = await this.buildBackupJson();
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `sela_backup_${stamp}.json`;
    const path = await requirePlatformUtils().exportFile(
      fileName,
      JSON_MIME,
      json,
    );
    logDiag(
      'backup',
      `تم إنشاء نسخة احتياطية: ${summary.products} منتج، ${summary.embeddings} بصمة، ${summary.sales} فاتورة`,
    );
    return {path, summary};
  },

  /** Opens the system picker, reads and validates the file (no writes). */
  async pickAndParseBackup(): Promise<BackupFile> {
    const content = await requirePlatformUtils().pickAndReadFile([
      JSON_MIME,
      'application/octet-stream',
      'text/plain',
    ]);
    return BackupService.parseAndValidateBackup(content);
  },

  /** v28 (round-36 #4): parses + validates backup CONTENT — shared
   *  by the local file picker and the Google Drive download path. */
  parseAndValidateBackup(content: string): BackupFile {
    let doc: BackupFile;
    try {
      doc = JSON.parse(content) as BackupFile;
    } catch {
      throw new Error('الملف المختار ليس ملف نسخة احتياطية صالح من sela');
    }
    if (doc == null || doc.app !== 'sela' || !Array.isArray(doc.products)) {
      throw new Error(
        'صيغة الملف غير صحيحة — اختر ملف نسخة احتياطية أنشأه تطبيق sela',
      );
    }
    if (doc.backupVersion > BACKUP_VERSION) {
      throw new Error(
        'النسخة الاحتياطية أحدث من التطبيق — حدّث التطبيق أولاً ثم استعد',
      );
    }
    return doc;
  },

  /**
   * Restores a parsed backup in ONE transaction — full replace of
   * catalog + history, then applies settings. Either everything lands
   * or nothing changes.
   */
  async restoreBackup(doc: BackupFile): Promise<BackupSummary> {
    const db = getDb();

    // v8.3 (round-12 #3): write every EMBEDDED image into fresh files
    // BEFORE the transaction, then map old path → new path so the
    // restored products point at files that actually exist on THIS
    // device. v1 backups (no images block) keep the original paths —
    // same-device restores still work, and the dead-path cleanup pass
    // (catalogStore) clears the rest.
    const imageNewPath = new Map<string, string>();
    if (Array.isArray(doc.images) && doc.images.length > 0) {
      const nameToNewPath = new Map<string, string>();
      try {
        const platform = requirePlatformUtils();
        for (const image of doc.images) {
          if (!image?.name || !image?.data) {
            continue;
          }
          const newPath = await platform.writeFileBase64(
            'thumbs',
            image.name.endsWith('.jpg') ? image.name : `${image.name}.jpg`,
            image.data,
          );
          nameToNewPath.set(image.name, newPath);
        }
      } catch {
        // Native writer unavailable — fall back to original paths.
      }
      for (const product of doc.products ?? []) {
        const uri = product.image_uri;
        if (uri == null || uri.length === 0) {
          continue;
        }
        // The export stored images keyed by name; find the embedded
        // copy that belonged to this product by matching the original
        // file name inside the embedded name.
        const originalName = uri.split('/').pop() ?? '';
        const match = doc.images.find(
          entry =>
            entry?.name != null &&
            entry.name.includes(originalName.replace(/[^A-Za-z0-9._-]/g, '_')),
        );
        if (match != null) {
          const newPath = nameToNewPath.get(match.name);
          if (newPath != null) {
            imageNewPath.set(uri, newPath);
          }
        }
      }
    }

    // v15 (round-21 #2): SANITIZE before the transaction. A backup
    // carrying duplicate invoice numbers / debt refs (the historical
    // numbering bugs of rounds 16–20) used to hit a UNIQUE constraint
    // and roll the WHOLE restore back — «رفعت النسخة الاحتياطية
    // والفواتير لم تُحسب». Duplicates are re-suffixed instead, and
    // the debt/payment queues drop second copies of the same
    // idempotency key or invoice/receipt ref (§4.3: the صِلة server
    // rejects duplicates by design — the first copy wins).
    const seenInvoiceNumbers = new Set<string>();
    for (const sale of doc.sales ?? []) {
      const raw = String(sale.invoice_number ?? '').trim();
      if (raw.length === 0) {
        continue; // the insert generates an R- fallback number
      }
      if (seenInvoiceNumbers.has(raw)) {
        let suffix = 2;
        while (seenInvoiceNumbers.has(`${raw}-R${suffix}`)) {
          suffix += 1;
        }
        sale.invoice_number = `${raw}-R${suffix}`;
        seenInvoiceNumbers.add(sale.invoice_number);
      } else {
        seenInvoiceNumbers.add(raw);
        sale.invoice_number = raw;
      }
    }
    const seenDebtKeys = new Set<string>();
    const seenDebtRefs = new Set<string>();
    const cleanDebts = (doc.sila_debts ?? []).filter(debt => {
      const key = String(debt.idempotency_key ?? '');
      const ref = String(debt.pos_invoice_ref ?? '');
      if (!key || !ref) {
        return false;
      }
      if (seenDebtKeys.has(key) || seenDebtRefs.has(ref)) {
        return false;
      }
      seenDebtKeys.add(key);
      seenDebtRefs.add(ref);
      return true;
    });
    const seenPayKeys = new Set<string>();
    const seenPayRefs = new Set<string>();
    const cleanPayments = (doc.sila_payments ?? []).filter(payment => {
      const key = String(payment.idempotency_key ?? '');
      const ref = String(payment.pos_receipt_ref ?? '');
      if (!key || !ref) {
        return false;
      }
      if (seenPayKeys.has(key) || seenPayRefs.has(ref)) {
        return false;
      }
      seenPayKeys.add(key);
      seenPayRefs.add(ref);
      return true;
    });

    // op-sqlite transactions resolve with void — counts are captured
    // through this mutable summary object instead.
    const summary: BackupSummary = {
      categories: 0,
      units: 0,
      products: 0,
      productUnits: 0,
      embeddings: 0,
      sales: 0,
      createdAt: doc.createdAt ?? '',
    };

    await db.transaction(async tx => {
      await tx.execute('DELETE FROM sale_return_items');
      await tx.execute('DELETE FROM sale_returns');
      await tx.execute('DELETE FROM sale_items');
      await tx.execute('DELETE FROM sales');
      await tx.execute('DELETE FROM stocktake_items');
      await tx.execute('DELETE FROM stocktakes');
      await tx.execute('DELETE FROM product_embeddings');
      await tx.execute('DELETE FROM product_units');
      await tx.execute('DELETE FROM products');
      await tx.execute('DELETE FROM units');
      await tx.execute('DELETE FROM categories');
      await tx.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('categories','units','products','product_units','product_embeddings','sales','sale_items','sale_returns','sale_return_items','stocktakes','stocktake_items')",
      );

      // Categories & units — keep maps from backup ids to fresh ids.
      const categoryMap = new Map<number, number>();
      for (const category of doc.categories ?? []) {
        if (!category.name) {
          continue;
        }
        const inserted = await tx.execute(
          // v34: النطاق يُستعاد كما كان — فصل المجالات محفوظ.
          'INSERT INTO categories (name, store_mode) VALUES (?, ?)',
          [category.name, category.store_mode ?? null],
        );
        categoryMap.set(Number(category.id), Number(inserted.insertId));
      }

      const unitMap = new Map<number, number>();
      for (const unit of doc.units ?? []) {
        if (!unit.name) {
          continue;
        }
        const inserted = await tx.execute(
          'INSERT INTO units (name, short_name, sort_order, kind, store_mode) VALUES (?, ?, ?, ?, ?)',
          [
            unit.name,
            unit.short_name || unit.name,
            Number(unit.sort_order ?? 0),
            // v9.2: carry the unit type through the restore (old
            // backups default to 'piece').
            unit.kind === 'weight' ||
            unit.kind === 'volume' ||
            unit.kind === 'length'
              ? unit.kind
              : 'piece',
            // v34: نطاق النمط.
            unit.store_mode ?? null,
          ],
        );
        unitMap.set(Number(unit.id), Number(inserted.insertId));
      }

      // Products — map backup ids to fresh ids so everything else lines up.
      const productMap = new Map<number, number>();
      for (const product of doc.products ?? []) {
        if (!product.name) {
          continue;
        }
        const restoredImage =
          product.image_uri != null
            ? imageNewPath.get(product.image_uri) ?? product.image_uri
            : null;
        const inserted = await tx.execute(
          `INSERT INTO products
            (name, cost_price, retail_price, wholesale_price, stock_quantity, category_id, image_uri, low_stock_threshold, barcode, sold_by_weight, is_archived, expiry_date, style_group, variant_size, variant_color, has_variants, base_unit_name, stock_untracked, sizes_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            product.name,
            Number(product.cost_price ?? 0),
            Number(product.retail_price ?? 0),
            Number(product.wholesale_price ?? 0),
            Number(product.stock_quantity ?? 0),
            product.category_id != null
              ? categoryMap.get(Number(product.category_id)) ?? null
              : null,
            restoredImage,
            product.low_stock_threshold ?? null,
            product.barcode ?? null,
            product.sold_by_weight === 1 ? 1 : 0,
            product.is_archived === 1 ? 1 : 0,
            product.expiry_date ?? null,
            // v34: ربطة الملابس — تُستعاد كما كانت.
            product.style_group ?? null,
            product.variant_size ?? null,
            product.variant_color ?? null,
            // v35 (الجولة 43): متغيرات المنتج + وحدة الأساس +
            // المخزون بلا تتبع + مقاسات الربطة.
            product.has_variants === 1 ? 1 : 0,
            product.base_unit_name ?? null,
            product.stock_untracked === 1 ? 1 : 0,
            product.sizes_count ?? null,
            product.created_at || nowLocal(),
          ],
        );
        productMap.set(Number(product.id), Number(inserted.insertId));
      }

      // v35 (الجولة 43): متغيرات المنتجات — تُستعاد بترقيم جديد
      //  مع منتجها؛ خريطة المعرّفات تُعيد ربط أسطر البيع
      //  بمتغيراتها (استرجاع المخزون الدقيق عند الإرجاع).
      const variantIdMap = new Map<number, number>();
      for (const row of doc.product_variants ?? []) {
        const newProductId = productMap.get(Number(row.product_id));
        if (newProductId == null) {
          continue;
        }
        const inserted = await tx.execute(
          `INSERT INTO product_variants
            (product_id, kind, color, size, stock_quantity, retail_price, cost_price, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newProductId,
            row.kind === 'size' ? 'size' : 'variant',
            String(row.color ?? ''),
            String(row.size ?? ''),
            Number(row.stock_quantity ?? 0),
            row.retail_price ?? null,
            row.cost_price ?? null,
            nowLocal(),
          ],
        );
        variantIdMap.set(Number(row.id), Number(inserted.insertId));
      }

      // Sellable units per product.
      let productUnits = 0;
      for (const row of doc.product_units ?? []) {
        const newProductId = productMap.get(Number(row.product_id));
        const newUnitId = unitMap.get(Number(row.unit_id));
        if (newProductId == null || newUnitId == null) {
          continue;
        }
        await tx.execute(
          `INSERT INTO product_units
            (product_id, unit_id, conversion, barcode, retail_price, wholesale_price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            newProductId,
            newUnitId,
            Number(row.conversion ?? 1),
            row.barcode ?? null,
            row.retail_price ?? null,
            row.wholesale_price ?? null,
          ],
        );
        productUnits += 1;
      }

      // Vision fingerprints. v10 (round-16 #4): fingerprints from a
      // DIFFERENT embedding-model generation are skipped — their
      // vectors live in another feature space and matching them
      // against the current model would be garbage. Backups with NO
      // generation marker (pre-v10) were built with the v1 model and
      // are skipped for the same reason.
      let embeddings = 0;
      const fingerprintsCompatible =
        doc.embeddingModelVersion === EMBEDDING_MODEL_VERSION;
      if (fingerprintsCompatible) {
        for (const embedding of doc.embeddings ?? []) {
          const newProductId = productMap.get(Number(embedding.product_id));
          if (newProductId == null || !embedding.embedding_data) {
            continue;
          }
          await tx.execute(
            'INSERT INTO product_embeddings (product_id, embedding_data, angle_label, thumbnail_path) VALUES (?, ?, ?, ?)',
            [
              newProductId,
              embedding.embedding_data,
              embedding.angle_label || 'front',
              embedding.thumbnail_path ?? null,
            ],
          );
          embeddings += 1;
        }
      } else {
        logDiag(
          'backup',
          `تم تخطي ${
            doc.embeddings?.length ?? 0
          } بصمة — نموذج تعرّف مختلف (أعد تسجيل صور المنتجات)`,
          'warn',
        );
      }

      // Sales history — v15: a single bad row is SKIPPED (counted as
      // skipped) instead of killing the whole restore transaction.
      // v23 (round-29 #2): returned_minor + return_kind travel with
      // every sale; the invoice-number map feeds the returns below.
      const saleMap = new Map<number, number>();
      const saleIdByInvoiceRef = new Map<string, number>();
      let sales = 0;
      let skippedSales = 0;
      for (const sale of doc.sales ?? []) {
        try {
          const inserted = await tx.execute(
            `INSERT INTO sales
              (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, returned_minor, return_kind)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              sale.invoice_number || `R-${Date.now()}-${sales}`,
              Number(sale.total_amount ?? 0),
              Number(sale.total_cost ?? 0),
              Number(sale.total_profit ?? 0),
              Number(sale.discount ?? 0),
              sale.payment_type ?? null,
              sale.created_at || nowLocal(),
              Number(sale.returned_minor ?? 0),
              sale.return_kind ?? null,
            ],
          );
          saleMap.set(Number(sale.id), Number(inserted.insertId));
          if (sale.invoice_number) {
            saleIdByInvoiceRef.set(
              String(sale.invoice_number),
              Number(inserted.insertId),
            );
          }
          sales += 1;
        } catch {
          skippedSales += 1;
        }
      }
      summary.skippedSales = skippedSales;

      // v23 (round-29 #2): sale_items keep unit_name + base_quantity
      //  (a PRE-EXISTING backup gap — restored history used to lose
      //  its unit labels and stock math), and the old→new line-id
      //  map feeds the return lines below.
      const saleItemMap = new Map<number, number>();
      for (const item of doc.sale_items ?? []) {
        const newSaleId = saleMap.get(Number(item.sale_id));
        const newProductId = productMap.get(Number(item.product_id));
        if (newSaleId == null || newProductId == null) {
          continue;
        }
        const inserted = await tx.execute(
          `INSERT INTO sale_items
            (sale_id, product_id, quantity, unit_price, cost_price, total_line_price, unit_name, base_quantity, variant_label, variant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newSaleId,
            newProductId,
            Number(item.quantity ?? 0),
            Number(item.unit_price ?? 0),
            Number(item.cost_price ?? 0),
            Number(item.total_line_price ?? 0),
            item.unit_name ?? null,
            item.base_quantity == null ? null : Number(item.base_quantity),
            // v35 (الجولة 43): وصف المتغير ينتقل نصاً، والمعرّف
            //  يُعاد ربطه بمتغيره الجديد (أو يُترك بلا متغير إن
            //  غاب عن النسخة الاحتياطية).
            (item as {variant_label?: string | null}).variant_label ?? null,
            (item as {variant_id?: number | null}).variant_id != null
              ? variantIdMap.get(
                  Number(
                    (item as {variant_id?: number | null}).variant_id,
                  ),
                ) ?? null
              : null,
          ],
        );
        if (item.id != null) {
          saleItemMap.set(Number(item.id), Number(inserted.insertId));
        }
      }

      // v23 (round-29 #2): the RETURNS — RET receipts against the
      //  ORIGINAL invoice (mapped by invoice number; the internal
      //  sale ids were remapped above), each line mapped to its new
      //  sale_items id so per-line remaining math stays correct.
      let saleReturns = 0;
      for (const ret of doc.sale_returns ?? []) {
        const newSaleId = saleIdByInvoiceRef.get(String(ret.sale_invoice_ref));
        if (newSaleId == null) {
          continue;
        }
        const insertedReturn = await tx.execute(
          `INSERT INTO sale_returns
            (return_number, sale_id, invoice_ref, book, refund_method, refund_minor, debt_adjusted_minor, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ret.return_number,
            newSaleId,
            String(ret.sale_invoice_ref),
            ret.book || 'cash',
            ret.refund_method || 'none',
            Number(ret.refund_minor ?? 0),
            Number(ret.debt_adjusted_minor ?? 0),
            ret.note ?? null,
            ret.created_at || nowLocal(),
          ],
        );
        for (const line of ret.items ?? []) {
          const newProductId = productMap.get(Number(line.product_id));
          if (newProductId == null) {
            continue;
          }
          const newSaleItemId =
            saleItemMap.get(Number(line.sale_item_ref)) ?? -1;
          await tx.execute(
            `INSERT INTO sale_return_items
              (return_id, sale_item_id, product_id, product_name, quantity, unit_name, base_quantity, unit_price, line_total, cost_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              Number(insertedReturn.insertId),
              newSaleItemId,
              newProductId,
              line.product_name || `#${line.product_id}`,
              Number(line.quantity ?? 0),
              line.unit_name ?? null,
              Number(line.base_quantity ?? 0),
              Number(line.unit_price ?? 0),
              Number(line.line_total ?? 0),
              Number(line.cost_price ?? 0),
            ],
          );
        }
        saleReturns += 1;
      }

      // Stocktake sessions.
      const stocktakeMap = new Map<number, number>();
      for (const stocktake of doc.stocktakes ?? []) {
        const inserted = await tx.execute(
          `INSERT INTO stocktakes
            (started_at, completed_at, status, note)
           VALUES (?, ?, ?, ?)`,
          [
            stocktake.started_at || nowLocal(),
            stocktake.completed_at ?? null,
            stocktake.status || 'open',
            stocktake.note ?? null,
          ],
        );
        stocktakeMap.set(Number(stocktake.id), Number(inserted.insertId));
      }

      for (const item of doc.stocktake_items ?? []) {
        const newStocktakeId = stocktakeMap.get(Number(item.stocktake_id));
        const newProductId = productMap.get(Number(item.product_id));
        if (newStocktakeId == null || newProductId == null) {
          continue;
        }
        // v38 (الجولة 46 #9): صفوف متغيرات الملابس — المعرّف المحلي
        //  القديم يُعاد ربطه بخريطة المتغيرات المُنشأة حديثاً عبر
        //  (المنتج، التسمية) — أرقام المتغيرات تتغير مع الاستعادة.
        let newVariantId: number | null = null;
        if (item.variant_id != null) {
          const variantRow = await tx.execute(
            `SELECT id FROM product_variants
              WHERE product_id = ? AND kind = 'variant'
                AND TRIM(COALESCE(NULLIF(color, '') || ' · ', '') || size) = ?
              LIMIT 1`,
            [newProductId, item.variant_label ?? ''],
          );
          const hit = variantRow.rows?.[0] as {id?: number} | undefined;
          newVariantId = hit?.id ?? null;
        }
        await tx.execute(
          `INSERT INTO stocktake_items
            (stocktake_id, product_id, variant_id, variant_label, system_qty, counted_qty)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            newStocktakeId,
            newProductId,
            newVariantId,
            item.variant_label ?? null,
            Number(item.system_qty ?? 0),
            item.counted_qty ?? null,
          ],
        );
      }

      // v11 (SILA): debts + customers cache. Debt rows key on
      // idempotency_key / pos_invoice_ref (NOT local ids) so they
      // restore verbatim — the server dedupes replays (§6.2) and
      // 'syncing' rows from a crash recover to pending (§8).
      await tx.execute('DELETE FROM sila_debt_queue');
      await tx.execute('DELETE FROM sila_customers');
      await tx.execute('DELETE FROM sila_payment_queue');
      await tx.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('sila_debt_queue','sila_payment_queue')",
      );
      for (const debt of cleanDebts) {
        await tx.execute(
          `INSERT INTO sila_debt_queue
            (idempotency_key, customer_id, customer_name, customer_phone_last4,
             customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
             description, scanned_at, credit_covered_minor, state, reference_code, transaction_id,
             outstanding_after, synced_at, error_code, error_message, retry_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            debt.idempotency_key,
            debt.customer_id ?? null,
            debt.customer_name ?? null,
            debt.customer_phone_last4 ?? null,
            debt.customer_card ?? null,
            debt.offline_qr ?? null,
            Number(debt.amount_minor ?? 0),
            debt.currency || 'ILS',
            debt.pos_invoice_ref,
            debt.description ?? null,
            debt.scanned_at || nowLocal(),
            Number(debt.credit_covered_minor ?? 0),
            debt.state === 'synced' || debt.state === 'failed'
              ? debt.state
              : 'pending',
            debt.reference_code ?? null,
            debt.transaction_id ?? null,
            debt.outstanding_after ?? null,
            debt.synced_at ?? null,
            debt.error_code ?? null,
            debt.error_message ?? null,
            Number(debt.retry_count ?? 0),
            debt.created_at || nowLocal(),
          ],
        );
      }
      for (const customer of doc.sila_customers ?? []) {
        if (!customer.customer_id || !customer.name) {
          continue;
        }
        await tx.execute(
          `INSERT INTO sila_customers
            (customer_id, name, phone_last4, id_number, outstanding_minor,
             credit_minor,
             pos_outstanding_minor, app_outstanding_minor, other_minor,
             pos_purchases_minor, app_purchases_minor,
             last_payment_at, last_payment_amount_minor,
             reconcile_offset_minor, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            customer.customer_id,
            customer.name,
            customer.phone_last4 ?? null,
            customer.id_number ?? null,
            Number(customer.outstanding_minor ?? 0),
            Number(customer.credit_minor ?? 0),
            Number(customer.pos_outstanding_minor ?? 0),
            Number(customer.app_outstanding_minor ?? 0),
            Number(customer.other_minor ?? 0),
            Number(customer.pos_purchases_minor ?? 0),
            Number(customer.app_purchases_minor ?? 0),
            customer.last_payment_at ?? null,
            customer.last_payment_amount_minor == null
              ? null
              : Number(customer.last_payment_amount_minor),
            // v18: the baseline anchor rides with the row (older
            // backups restore as 0 = the books cover the history).
            Number(customer.reconcile_offset_minor ?? 0),
            customer.last_synced_at ?? null,
          ],
        );
      }

      // v15 (round-21 #3): the repayments queue — restored verbatim by
      // idempotency key / receipt ref (server dedupes replays §2.5).
      // v23 (round-29 #2): kind travels too — a 'return_reversal'
      // row stays excluded from the collections statistics.
      for (const payment of cleanPayments) {
        try {
          await tx.execute(
            `INSERT INTO sila_payment_queue
              (idempotency_key, customer_id, customer_name, customer_phone_last4,
               amount_minor, payment_method, pos_receipt_ref, description,
               paid_at, state, kind, reference_code, transaction_id,
               outstanding_after, synced_at, error_code, error_message,
               retry_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              payment.idempotency_key,
              payment.customer_id ?? null,
              payment.customer_name ?? null,
              payment.customer_phone_last4 ?? null,
              Number(payment.amount_minor ?? 0),
              payment.payment_method || 'cash',
              payment.pos_receipt_ref,
              payment.description ?? null,
              payment.paid_at || nowLocal(),
              payment.state === 'synced' || payment.state === 'failed'
                ? payment.state
                : 'pending',
              payment.kind === 'return_reversal'
                ? 'return_reversal'
                : 'repayment',
              payment.reference_code ?? null,
              payment.transaction_id ?? null,
              payment.outstanding_after ?? null,
              payment.synced_at ?? null,
              payment.error_code ?? null,
              payment.error_message ?? null,
              Number(payment.retry_count ?? 0),
              payment.created_at || nowLocal(),
            ],
          );
        } catch {
          // A duplicate that slipped the sanitizer — first copy wins.
        }
      }

      // v16 (round-22 #4): the STORE-LOCAL debt book. Customer rows
      // remap their ids (the same discipline as categories/products)
      // so debts and repayments keep pointing at the right account;
      // refs (INV-L / RCP-L) restore verbatim — they're this store's
      // own namespace, never uploaded anywhere.
      await tx.execute('DELETE FROM local_payments');
      await tx.execute('DELETE FROM local_debts');
      await tx.execute('DELETE FROM local_customers');
      await tx.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('local_customers','local_debts','local_payments')",
      );
      const localCustomerMap = new Map<number, number>();
      for (const customer of doc.local_customers ?? []) {
        if (!customer.id_number || !customer.name) {
          continue;
        }
        const insert = await tx.execute(
          `INSERT INTO local_customers
            (id_number, name, phone, notes, sila_customer_id, sila_linked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            customer.id_number,
            customer.name,
            customer.phone ?? null,
            customer.notes ?? null,
            customer.sila_customer_id ?? null,
            customer.sila_linked_at ?? null,
            customer.created_at || nowLocal(),
          ],
        );
        if (customer.id != null && insert.insertId != null) {
          localCustomerMap.set(customer.id, insert.insertId);
        }
      }
      let localDebtsRestored = 0;
      for (const debt of doc.local_debts ?? []) {
        const mappedId = localCustomerMap.get(debt.local_customer_id);
        if (mappedId == null || !debt.invoice_ref) {
          continue;
        }
        try {
          await tx.execute(
            `INSERT INTO local_debts
              (local_customer_id, invoice_ref, amount_minor, description, migrated, migrated_ref, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              mappedId,
              debt.invoice_ref,
              Number(debt.amount_minor ?? 0),
              debt.description ?? null,
              Number(debt.migrated ?? 0),
              debt.migrated_ref ?? null,
              debt.created_at || nowLocal(),
            ],
          );
          localDebtsRestored += 1;
        } catch {
          // Duplicate ref — first copy wins.
        }
      }
      for (const payment of doc.local_payments ?? []) {
        const mappedId = localCustomerMap.get(payment.local_customer_id);
        if (mappedId == null || !payment.receipt_ref) {
          continue;
        }
        try {
          await tx.execute(
            `INSERT INTO local_payments
              (local_customer_id, receipt_ref, amount_minor, method, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              mappedId,
              payment.receipt_ref,
              Number(payment.amount_minor ?? 0),
              payment.method || 'cash',
              payment.note ?? null,
              payment.created_at || nowLocal(),
            ],
          );
        } catch {
          // Duplicate ref — first copy wins.
        }
      }

      // v18 (round-24 #1): the Sila-app collections ledger — restored
      // verbatim. CRITICAL for the reconciliation engine: without
      // these rows the next sync would re-detect the same historical
      // collections as NEW money (the stock method subtracts what's
      // already recorded; an empty ledger = full re-detection =
      // double-counted treasury).
      let appCollectionsRestored = 0;
      await tx.execute('DELETE FROM sila_app_collections');
      await tx.execute(
        "DELETE FROM sqlite_sequence WHERE name = 'sila_app_collections'",
      );
      for (const collection of doc.sila_app_collections ?? []) {
        if (!collection.customer_id || !(collection.amount_minor > 0)) {
          continue;
        }
        try {
          await tx.execute(
            `INSERT INTO sila_app_collections
              (customer_id, customer_name, amount_minor, detected_at)
             VALUES (?, ?, ?, ?)`,
            [
              collection.customer_id,
              collection.customer_name ?? null,
              Number(collection.amount_minor ?? 0),
              collection.detected_at || nowLocal(),
            ],
          );
          appCollectionsRestored += 1;
        } catch {
          // Malformed row — skip quietly.
        }
      }
      if (appCollectionsRestored > 0) {
        logDiag(
          'backup',
          `استُعيد ${appCollectionsRestored} تحصيل عبر تطبيق صِلة`,
        );
      }

      // v20: the voucher campaigns book — redemptions, claims and the
      // settlements mirror. sale_id is re-linked by pos_receipt_ref
      // (the STABLE key — sales get fresh ids during the restore).
      let voucherRowsRestored = 0;
      await tx.execute('DELETE FROM voucher_redemptions');
      await tx.execute('DELETE FROM campaign_debts');
      await tx.execute('DELETE FROM campaign_settlements');
      await tx.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('voucher_redemptions')",
      );
      for (const redemption of doc.voucher_redemptions ?? []) {
        if (!redemption.idempotency_key || !redemption.payload) {
          continue;
        }
        try {
          await tx.execute(
            `INSERT INTO voucher_redemptions (
              idempotency_key, payload, campaign_id, campaign_name,
              campaign_kind, voucher_id, value_minor, pos_receipt_ref,
              reference_code, beneficiary_last4, redeemed_at, state,
              cart_json, sale_id, counter_extra_minor, error_code,
              error_message, retry_count, synced_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
            [
              redemption.idempotency_key,
              redemption.payload,
              redemption.campaign_id ?? null,
              redemption.campaign_name ?? null,
              redemption.campaign_kind ?? null,
              redemption.voucher_id ?? null,
              Number(redemption.value_minor ?? 0),
              redemption.pos_receipt_ref ?? null,
              redemption.reference_code ?? null,
              redemption.beneficiary_last4 ?? null,
              redemption.redeemed_at || nowLocal(),
              redemption.state || 'pending',
              redemption.cart_json ?? null,
              Number(redemption.counter_extra_minor ?? 0),
              redemption.error_code ?? null,
              redemption.error_message ?? null,
              Number(redemption.retry_count ?? 0),
              redemption.synced_at ?? null,
              redemption.created_at || nowLocal(),
            ],
          );
          voucherRowsRestored += 1;
        } catch {
          // Duplicate idempotency key — first copy wins.
        }
      }
      // Re-link the sale rows by the STABLE receipt ref (INV-V-…).
      await tx.execute(
        `UPDATE voucher_redemptions
         SET sale_id = (
           SELECT s.id FROM sales s
           WHERE s.invoice_number = voucher_redemptions.pos_receipt_ref
           LIMIT 1
         )
         WHERE pos_receipt_ref IS NOT NULL AND state = 'ok'`,
      );
      let campaignsRestored = 0;
      for (const campaign of doc.campaign_debts ?? []) {
        if (!campaign.campaign_id || !campaign.campaign_name) {
          continue;
        }
        try {
          await tx.execute(
            `INSERT INTO campaign_debts (
              campaign_id, campaign_name, kind, campaign_status,
              merchant_status, starts_at, ends_at, store_state,
              redeemed_count, redeemed_value_minor, settled_minor,
              settled_pending_minor, settled_confirmed_minor, due_minor,
              settlement_state, last_redemption_at, last_settlement_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              campaign.campaign_id,
              campaign.campaign_name,
              campaign.kind ?? null,
              campaign.campaign_status ?? null,
              campaign.merchant_status ?? null,
              campaign.starts_at ?? null,
              campaign.ends_at ?? null,
              // v22 (round-28 #4): the lifecycle state restores
              // EXACTLY as it was backed up (default: available
              // for pre-v22 backups).
              campaign.store_state === 'active' ||
              campaign.store_state === 'completed'
                ? campaign.store_state
                : 'available',
              Number(campaign.redeemed_count ?? 0),
              Number(campaign.redeemed_value_minor ?? 0),
              Number(campaign.settled_minor ?? 0),
              Number(campaign.settled_pending_minor ?? 0),
              Number(campaign.settled_confirmed_minor ?? 0),
              Number(campaign.due_minor ?? 0),
              campaign.settlement_state || 'none',
              campaign.last_redemption_at ?? null,
              campaign.last_settlement_at ?? null,
              campaign.updated_at ?? null,
            ],
          );
          campaignsRestored += 1;
        } catch {
          // Duplicate campaign — first copy wins.
        }
      }
      let settlementsRestored = 0;
      for (const settlement of doc.campaign_settlements ?? []) {
        if (!settlement.settlement_id || !settlement.campaign_id) {
          continue;
        }
        try {
          await tx.execute(
            `INSERT INTO campaign_settlements (
              settlement_id, campaign_id, campaign_name, amount_minor,
              kind, status, method, reference, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              settlement.settlement_id,
              settlement.campaign_id,
              settlement.campaign_name ?? null,
              Number(settlement.amount_minor ?? 0),
              settlement.kind ?? null,
              settlement.status || 'pending',
              settlement.method ?? null,
              settlement.reference ?? null,
              settlement.created_at || nowLocal(),
            ],
          );
          settlementsRestored += 1;
        } catch {
          // Duplicate settlement — first copy wins.
        }
      }
      if (voucherRowsRestored + campaignsRestored + settlementsRestored > 0) {
        logDiag(
          'backup',
          `استُعيد دفتر القسائم: ${voucherRowsRestored} صرف و${campaignsRestored} حملة و${settlementsRestored} تسوية`,
        );
      }
      logDiag(
        'backup',
        `استُعيد دفتر المتجر: ${localCustomerMap.size} زبون و${localDebtsRestored} دين محلي`,
      );

      // Counters land on the outer summary object (TS-friendly).
      summary.categories = categoryMap.size;
      summary.units = unitMap.size;
      summary.products = productMap.size;
      summary.productUnits = productUnits;
      summary.embeddings = embeddings;
      summary.sales = sales;
    });

    // Settings land outside the DB transaction (MMKV).
    if (doc.settings != null) {
      useSettingsStore.getState().update(doc.settings);
    }

    // v10 (round-16 #1): the restored sales may carry HIGHER invoice
    // numbers than this device's counter — reconcile immediately so
    // the next sale continues after the last restored invoice.
    try {
      await InvoiceService.syncInvoiceCounterFromDb();
    } catch {
      // The DB-aware reservation recovers on the next sale anyway.
    }

    // v16 (round-22 #1): the restored DB may be OLDER than what the
    // صِلة server remembers (numbers uploaded from an earlier install
    // that the backup never saw) — advance today's counters past the
    // server's refs so restored-state uploads don't bounce
    // DUPLICATE_*_REF. Quiet + offline-safe.
    try {
      void SilaSync.advanceCountersFromServer();
    } catch {
      // Pairing may be absent — nothing to advance against.
    }

    logDiag(
      'backup',
      `تمت الاستعادة: ${summary.products} منتج و${summary.embeddings} بصمة و${summary.sales} فاتورة`,
    );
    return summary;
  },

  /** Summary of a parsed backup (used before the confirm dialog). */
  summarize(doc: BackupFile): BackupSummary {
    return {
      categories: doc.categories?.length ?? 0,
      units: doc.units?.length ?? 0,
      products: doc.products?.length ?? 0,
      productUnits: doc.product_units?.length ?? 0,
      embeddings: doc.embeddings?.length ?? 0,
      sales: doc.sales?.length ?? 0,
      createdAt: doc.createdAt ?? '',
    };
  },

  /** v15 (round-21 #2): sila counters for the confirm dialog — debts
   *  and repayments inside the backup are part of the store's
   *  accounting and must be VISIBLE before restoring. */
  silaCounts(doc: BackupFile): {debts: number; payments: number} {
    return {
      debts: doc.sila_debts?.length ?? 0,
      payments: doc.sila_payments?.length ?? 0,
    };
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};

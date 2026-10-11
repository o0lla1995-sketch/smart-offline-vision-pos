/**
 * Stocktake repository — جلسات الجرد.
 * ─────────────────────────────────────────────────────────────────
 * A stocktake session snapshots every product's system quantity at
 * start; the merchant then enters counted quantities physically.
 * Completing a session (optionally) reconciles stock to the counted
 * values inside one transaction and stamps the full audit report.
 *
 * v38 (الجولة 46 #9): جرد حسب نوع المنتج — منتجات المتغيرات
 * (الملابس: لون × مقاس) تُجرد متغيراً متغيراً: صف مستقل لكل ربطة
 * بمخزونها النظامي، وتسوية الإتمام تكتب عدّ كل متغير في صفه ثم
 * تعيد توليد إجمالي الموديل (products.stock_quantity) من مجموع
 * متغيراته فلا يتفكك الاتساق أبداً. باقي الأنماط (بقالة/صيدلية/
 * فواكه/مطعم/كافيتريا) تبقى صفوفها على مستوى المنتج كما كانت،
 * مع تلميح وحدة القياس المناسب لكل مجال (علبة/كرتونة/كغ…).
 */
import {getDb} from '../connection';
import {localNow} from '../../core/format';
import type {
  Stocktake,
  StocktakeItem,
  StocktakeSummary,
} from '../../core/types';

function rowToStocktake(row: Record<string, unknown>): Stocktake {
  return {
    id: Number(row.id),
    started_at: String(row.started_at ?? ''),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    status: row.status === 'completed' ? 'completed' : 'open',
    note: row.note == null ? null : String(row.note),
  };
}

function rowToItem(row: Record<string, unknown>): StocktakeItem {
  return {
    id: Number(row.id),
    stocktake_id: Number(row.stocktake_id),
    product_id: Number(row.product_id),
    variantId: row.variant_id == null ? null : Number(row.variant_id),
    variantLabel: row.variant_label == null ? null : String(row.variant_label),
    baseUnitName:
      row.base_unit_name == null || String(row.base_unit_name).length === 0
        ? null
        : String(row.base_unit_name),
    productName: String(row.product_name ?? ''),
    barcode: row.barcode == null ? null : String(row.barcode),
    categoryId: row.category_id == null ? null : Number(row.category_id),
    system_qty: Number(row.system_qty ?? 0),
    counted_qty: row.counted_qty == null ? null : Number(row.counted_qty),
    unitHint: row.unit_hint == null ? null : String(row.unit_hint),
    soldByWeight: Number(row.sold_by_weight ?? 0) === 1 ? 1 : 0,
  };
}

/**
 * Carton-style hint for PIECE products: "كرتونة × 24".
 * v8.3: WEIGHT products show their biggest sub-kilo unit instead —
 * "1 وقية = 0.25 كغ" (conversion < 1, printf keeps the fraction that
 * CAST AS INTEGER used to truncate to 0).
 */
const UNIT_HINT_SQL = `(
  SELECT '1 ' || u.name || ' = ' || printf('%.3g', pu.conversion) ||
    (CASE WHEN p.sold_by_weight = 1 THEN ' كغ' ELSE ' قطعة' END)
  FROM product_units pu JOIN units u ON u.id = pu.unit_id
  WHERE pu.product_id = p.id
    AND (
      (p.sold_by_weight = 1 AND pu.conversion > 0 AND pu.conversion < 1)
      OR (COALESCE(p.sold_by_weight, 0) = 0 AND pu.conversion > 1)
    )
  ORDER BY pu.conversion DESC LIMIT 1
) AS unit_hint`;

export const StocktakeRepo = {
  async getOpen(): Promise<Stocktake | null> {
    const result = await getDb().execute(
      "SELECT * FROM stocktakes WHERE status = 'open' ORDER BY id DESC LIMIT 1",
    );
    const row = result.rows?.[0];
    return row ? rowToStocktake(row) : null;
  },

  async list(limit = 20): Promise<Stocktake[]> {
    const result = await getDb().execute(
      'SELECT * FROM stocktakes ORDER BY id DESC LIMIT ?',
      [limit],
    );
    return (result.rows ?? []).map(rowToStocktake);
  },

  /** Creates a session and snapshots current stock for every product.
   * v37 (الجولة 45 #1ج): شمولية الجرد — تُزال فلاتر «بلا تتبع»
   *  نهائياً: كان المود الذي افتراضه stock_untracked=1 (الكافيتريا/
   *  المطعم) يُقصّ كلياً من جلسة الجرد فلا تظهر منتجاته في قائمة
   *  الجرد إطلاقاً (شكوى التاجر نصاً). الآن كل منتج غير مؤرشف يدخل
   *  الجلسة — المخزون القائم يُلتقط كمرجع، والتاجر يعدّ ما يشاء
   *  منه، والتسوية عند الإتمام تكتب العدّ فور اختيار «تطبيق
   *  التعديلات». بلا تتبع تبقى الكمية مرجعاً (لا تُخصم بالبيع)
   *  لكنها صادقة بعد كل جرد.
   * v38 (الجولة 46 #9): الملابس ومنتجات المتغيرات — صف مستقل لكل
   *  (لون × مقاس) بمخزونه النظامي بدل صف واحد للموديل كله (كان
   *  يجرد الموديل رقماً واحداً فيعمي الفروقات بين الربط). أحجام
   *  المطعم (kind='size') بلا مخزون لكل حجم — تبقى على صف المنتج. */
  async start(): Promise<Stocktake> {
    const db = getDb();
    const open = await this.getOpen();
    if (open != null) {
      return open;
    }
    const created = await db.execute(
      "INSERT INTO stocktakes (started_at, status) VALUES (?, 'open')",
      [localNow()],
    );
    const id = created.insertId ?? -1;
    // صفوف المنتجات بلا متغيرات ملابس (البقية كلها).
    await db.execute(
      `INSERT INTO stocktake_items (stocktake_id, product_id, system_qty)
       SELECT ?, p.id, p.stock_quantity FROM products p
        WHERE p.is_archived = 0
          AND NOT EXISTS (
            SELECT 1 FROM product_variants v
             WHERE v.product_id = p.id AND v.kind = 'variant'
          )`,
      [id],
    );
    // صفوف متغيرات الملابس — ربطة ربطة بلونها ومقاسها.
    await db.execute(
      `INSERT INTO stocktake_items (stocktake_id, product_id, variant_id, variant_label, system_qty)
       SELECT ?, v.product_id, v.id,
              TRIM(COALESCE(NULLIF(v.color, '') || ' · ', '') || v.size),
              v.stock_quantity
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.kind = 'variant' AND p.is_archived = 0`,
      [id],
    );
    const result = await db.execute('SELECT * FROM stocktakes WHERE id = ?', [
      id,
    ]);
    const row = result.rows?.[0];
    if (!row) {
      throw new Error('تعذر إنشاء جلسة الجرد');
    }
    return rowToStocktake(row);
  },

  async cancel(id: number): Promise<void> {
    const db = getDb();
    await db.execute('DELETE FROM stocktake_items WHERE stocktake_id = ?', [
      id,
    ]);
    await db.execute('DELETE FROM stocktakes WHERE id = ?', [id]);
  },

  async listItems(
    stocktakeId: number,
    options?: {
      search?: string;
      categoryId?: number | 'all';
      onlyPending?: boolean;
    },
  ): Promise<StocktakeItem[]> {
    const conditions = ['si.stocktake_id = ?'];
    const params: (string | number)[] = [stocktakeId];
    const search = options?.search?.trim();
    if (search) {
      conditions.push(
        `(p.name LIKE ? OR si.variant_label LIKE ?)`,
      );
      params.push(`%${search}%`, `%${search}%`);
    }
    if (options?.categoryId != null && options?.categoryId !== 'all') {
      conditions.push('p.category_id = ?');
      params.push(options.categoryId);
    }
    if (options?.onlyPending) {
      conditions.push('si.counted_qty IS NULL');
    }
    const result = await getDb().execute(
      `SELECT si.*, p.name AS product_name, p.barcode, p.category_id,
              p.sold_by_weight, p.base_unit_name, ${UNIT_HINT_SQL}
       FROM stocktake_items si
       JOIN products p ON p.id = si.product_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.name ASC, si.variant_label ASC`,
      params,
    );
    return (result.rows ?? []).map(rowToItem);
  },

  /** v38: العدّ يكتب على صف (المنتج، المتغير) — المتغير NULL للصف
   *  العادي، ومعرّف متغير الملابس لصفه. */
  async setCounted(
    stocktakeId: number,
    productId: number,
    counted: number | null,
    variantId: number | null = null,
  ): Promise<void> {
    await getDb().execute(
      `UPDATE stocktake_items SET counted_qty = ?
        WHERE stocktake_id = ? AND product_id = ?
          AND IFNULL(variant_id, 0) = IFNULL(?, 0)`,
      [counted, stocktakeId, productId, variantId],
    );
  },

  async summary(stocktakeId: number): Promise<StocktakeSummary> {
    const result = await getDb().execute(
      `SELECT
         COUNT(*) AS total_items,
         SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END) AS counted_items,
         SUM(CASE WHEN counted_qty IS NOT NULL AND counted_qty = system_qty THEN 1 ELSE 0 END) AS matched_items,
         SUM(CASE WHEN counted_qty IS NOT NULL AND counted_qty < system_qty THEN 1 ELSE 0 END) AS shortage_items,
         SUM(CASE WHEN counted_qty IS NOT NULL AND counted_qty > system_qty THEN 1 ELSE 0 END) AS surplus_items,
         COALESCE(SUM(system_qty), 0) AS total_system,
         COALESCE(SUM(counted_qty), 0) AS total_counted
       FROM stocktake_items WHERE stocktake_id = ?`,
      [stocktakeId],
    );
    const row = result.rows?.[0] ?? {};
    return {
      totalItems: Number(row.total_items ?? 0),
      countedItems: Number(row.counted_items ?? 0),
      matchedItems: Number(row.matched_items ?? 0),
      shortageItems: Number(row.shortage_items ?? 0),
      surplusItems: Number(row.surplus_items ?? 0),
      totalSystem: Number(row.total_system ?? 0),
      totalCounted: Number(row.total_counted ?? 0),
    };
  },

  /**
   * Completes the session. When `applyAdjustments` is true, every counted
   * value is written back atomically: product-level rows update
   * products.stock_quantity; VARIANT rows (v38: clothing لون × مقاس)
   * update product_variants.stock_quantity and then REGENERATE the
   * parent product's total from the sum of its variants — the same
   * invariant the sale/return flows maintain. Items left uncounted
   * keep their system quantity untouched.
   */
  async complete(
    stocktakeId: number,
    applyAdjustments: boolean,
  ): Promise<{adjusted: number}> {
    const db = getDb();
    let adjusted = 0;
    await db.transaction(async tx => {
      if (applyAdjustments) {
        // 1) صفوف المنتجات العادية.
        const result = await tx.execute(
          `UPDATE products
           SET stock_quantity = (
             SELECT si.counted_qty FROM stocktake_items si
             WHERE si.stocktake_id = ? AND si.product_id = products.id
               AND si.variant_id IS NULL AND si.counted_qty IS NOT NULL
           )
           WHERE id IN (
             SELECT si.product_id FROM stocktake_items si
             WHERE si.stocktake_id = ? AND si.variant_id IS NULL
               AND si.counted_qty IS NOT NULL
           )`,
          [stocktakeId, stocktakeId],
        );
        adjusted = result.rowsAffected ?? 0;
        // 2) صفوف متغيرات الملابس — العدّ على صف المتغير نفسه.
        const variantResult = await tx.execute(
          `UPDATE product_variants
           SET stock_quantity = (
             SELECT si.counted_qty FROM stocktake_items si
             WHERE si.stocktake_id = ? AND si.variant_id = product_variants.id
               AND si.counted_qty IS NOT NULL
           )
           WHERE id IN (
             SELECT si.variant_id FROM stocktake_items si
             WHERE si.stocktake_id = ? AND si.variant_id IS NOT NULL
               AND si.counted_qty IS NOT NULL
           )`,
          [stocktakeId, stocktakeId],
        );
        adjusted += variantResult.rowsAffected ?? 0;
        // 3) إعادة توليد إجمالي كل موديل جُردت متغيراته — من مجموع
        //    متغيراته (نفس عقد البيع/الإرجاع) فلا ينفك الاتساق.
        const resync = await tx.execute(
          `UPDATE products
           SET stock_quantity = (
             SELECT COALESCE(SUM(v.stock_quantity), 0)
               FROM product_variants v
              WHERE v.product_id = products.id AND v.kind = 'variant'
           )
           WHERE id IN (
             SELECT DISTINCT si.product_id FROM stocktake_items si
             WHERE si.stocktake_id = ? AND si.variant_id IS NOT NULL
               AND si.counted_qty IS NOT NULL
           )`,
          [stocktakeId],
        );
        // الصفوف المعاد توليدها ليست «منتجات معدّلة» إضافية — هي
        // نفس متغيرات الخطوة 2 مجتمعة؛ لا نضيفها إلى العدّ.
        void resync;
      }
      await tx.execute(
        "UPDATE stocktakes SET status = 'completed', completed_at = ? WHERE id = ?",
        [localNow(), stocktakeId],
      );
    });
    return {adjusted};
  },

  async getById(id: number): Promise<Stocktake | null> {
    const result = await getDb().execute(
      'SELECT * FROM stocktakes WHERE id = ?',
      [id],
    );
    const row = result.rows?.[0];
    return row ? rowToStocktake(row) : null;
  },
};

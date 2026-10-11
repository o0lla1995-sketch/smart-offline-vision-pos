/**
 * Products repository — search, filtering, CRUD and stock movement.
 */
import {getDb, toMessage} from '../connection';
import {localNow} from '../../core/format';
import type {Product} from '../../core/types';

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    cost_price: Number(row.cost_price ?? 0),
    retail_price: Number(row.retail_price ?? 0),
    wholesale_price: Number(row.wholesale_price ?? 0),
    stock_quantity: Number(row.stock_quantity ?? 0),
    category_id: row.category_id == null ? null : Number(row.category_id),
    image_uri: row.image_uri == null ? null : String(row.image_uri),
    low_stock_threshold:
      row.low_stock_threshold == null ? null : Number(row.low_stock_threshold),
    barcode:
      row.barcode == null || row.barcode === '' ? null : String(row.barcode),
    sold_by_weight: Number(row.sold_by_weight ?? 0) === 1 ? 1 : 0,
    is_archived: Number(row.is_archived ?? 0) === 1 ? 1 : 0,
    expiry_date:
      row.expiry_date == null || String(row.expiry_date).length < 10
        ? null
        : String(row.expiry_date).slice(0, 10),
    // v34 (الجولة 42 #3): ربطة الملابس — مجموعة الموديل المشتركة
    // (لون واحد × مقاسات) وسمة كل منتج فرعي.
    style_group:
      row.style_group == null || String(row.style_group).length === 0
        ? null
        : String(row.style_group),
    variant_size:
      row.variant_size == null || String(row.variant_size).length === 0
        ? null
        : String(row.variant_size),
    variant_color:
      row.variant_color == null || String(row.variant_color).length === 0
        ? null
        : String(row.variant_color),
    // v35 (الجولة 43): متغيرات المنتج الواحد + وحدة الأساس +
    // المخزون بلا تتبع + مقاسات الربطة.
    has_variants: Number(row.has_variants ?? 0) === 1 ? 1 : 0,
    base_unit_name:
      row.base_unit_name == null || String(row.base_unit_name).length === 0
        ? null
        : String(row.base_unit_name),
    stock_untracked: Number(row.stock_untracked ?? 0) === 1 ? 1 : 0,
    sizes_count: row.sizes_count == null ? null : Number(row.sizes_count),
    created_at: String(row.created_at ?? ''),
  };
}

export interface ProductInput {
  name: string;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  stock_quantity: number;
  category_id: number | null;
  image_uri: string | null;
  low_stock_threshold?: number | null;
  barcode?: string | null;
  /** v8.3: 1 = sold by weight (kilo base). */
  sold_by_weight?: number;
  /** v32 (round-40 #3): تاريخ انتهاء الصلاحية 'YYYY-MM-DD' أو null. */
  expiry_date?: string | null;
  /** v34 (الجولة 42 #3): ربطة الملابس — مجموعة الموديل والمقاس واللون. */
  style_group?: string | null;
  variant_size?: string | null;
  variant_color?: string | null;
  /** v35 (الجولة 43): منتج بمتغيرات داخلية (ملابس لون×مقاس /
   *  مطعم أحجام) — البيع عبر نافذة المتغيرات. */
  has_variants?: number;
  /** v35: وحدة الأساس بلغة المجال (شريط/علبة/حصة/صحن/كوب). */
  base_unit_name?: string | null;
  /** v35: 1 = مخزون بلا تتبع — البيع لا يُحجب ولا يُخصم. */
  stock_untracked?: number;
  /** v35: عدد المقاسات بربطة الملابس (أساس بيع الجملة بالربطة). */
  sizes_count?: number | null;
}

export const ProductRepo = {
  async list(options?: {
    search?: string;
    categoryId?: number | 'all';
    /** v23 (round-29 #1): 'active' (default) hides archived products
     *  from POS/inventory/alerts; 'archived' shows ONLY the archived
     *  ones (the «المؤرشفة» view); 'all' returns everything. */
    archival?: 'active' | 'archived' | 'all';
  }): Promise<Product[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    const search = options?.search?.trim();
    if (search) {
      conditions.push('p.name LIKE ?');
      params.push(`%${search}%`);
    }
    if (options?.categoryId != null && options.categoryId !== 'all') {
      conditions.push('p.category_id = ?');
      params.push(options.categoryId);
    }
    if (options?.archival !== 'all') {
      if (options?.archival === 'archived') {
        conditions.push('p.is_archived = 1');
      } else {
        conditions.push('p.is_archived = 0');
      }
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT p.* FROM products p ${where} ORDER BY p.name ASC LIMIT 500`;
    const result = await getDb().execute(sql, params);
    const rows = result.rows ?? [];
    return rows.map(rowToProduct);
  },

  async getById(id: number): Promise<Product | null> {
    const result = await getDb().execute(
      'SELECT * FROM products WHERE id = ?',
      [id],
    );
    const row = result.rows?.[0];
    return row ? rowToProduct(row) : null;
  },

  async countAll(): Promise<number> {
    const result = await getDb().execute(
      'SELECT COUNT(*) AS cnt FROM products',
    );
    const row = result.rows?.[0] as {cnt?: number} | undefined;
    return Number(row?.cnt ?? 0);
  },

  async create(input: ProductInput): Promise<number> {
    const name = input.name.trim();
    if (!name) throw new Error('اسم المنتج مطلوب');
    if (
      input.retail_price < 0 ||
      input.wholesale_price < 0 ||
      input.cost_price < 0
    ) {
      throw new Error('الأسعار لا يمكن أن تكون سالبة');
    }
    if (input.stock_quantity < 0) {
      throw new Error('الكمية لا يمكن أن تكون سالبة');
    }
    const result = await getDb().execute(
      `INSERT INTO products
        (name, cost_price, retail_price, wholesale_price, stock_quantity, category_id, image_uri, low_stock_threshold, barcode, sold_by_weight, expiry_date, style_group, variant_size, variant_color, has_variants, base_unit_name, stock_untracked, sizes_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        input.cost_price,
        input.retail_price,
        input.wholesale_price,
        input.stock_quantity,
        input.category_id,
        input.image_uri,
        input.low_stock_threshold ?? null,
        input.barcode?.trim() ? input.barcode.trim() : null,
        input.sold_by_weight === 1 ? 1 : 0,
        input.expiry_date ?? null,
        input.style_group?.trim() ? input.style_group.trim() : null,
        input.variant_size?.trim() ? input.variant_size.trim() : null,
        input.variant_color?.trim() ? input.variant_color.trim() : null,
        input.has_variants === 1 ? 1 : 0,
        input.base_unit_name?.trim() ? input.base_unit_name.trim() : null,
        input.stock_untracked === 1 ? 1 : 0,
        input.sizes_count ?? null,
        localNow(),
      ],
    );
    return result.insertId ?? -1;
  },

  async update(id: number, input: ProductInput): Promise<void> {
    const name = input.name.trim();
    if (!name) throw new Error('اسم المنتج مطلوب');
    if (
      input.retail_price < 0 ||
      input.wholesale_price < 0 ||
      input.cost_price < 0
    ) {
      throw new Error('الأسعار لا يمكن أن تكون سالبة');
    }
    if (input.stock_quantity < 0) {
      throw new Error('الكمية لا يمكن أن تكون سالبة');
    }
    await getDb().execute(
      `UPDATE products SET
        name = ?, cost_price = ?, retail_price = ?, wholesale_price = ?,
        stock_quantity = ?, category_id = ?, image_uri = ?, low_stock_threshold = ?,
        barcode = ?, sold_by_weight = ?, expiry_date = ?,
        style_group = ?, variant_size = ?, variant_color = ?,
        has_variants = ?, base_unit_name = ?, stock_untracked = ?, sizes_count = ?
       WHERE id = ?`,
      [
        name,
        input.cost_price,
        input.retail_price,
        input.wholesale_price,
        input.stock_quantity,
        input.category_id,
        input.image_uri,
        input.low_stock_threshold ?? null,
        input.barcode?.trim() ? input.barcode.trim() : null,
        input.sold_by_weight === 1 ? 1 : 0,
        input.expiry_date ?? null,
        input.style_group?.trim() ? input.style_group.trim() : null,
        input.variant_size?.trim() ? input.variant_size.trim() : null,
        input.variant_color?.trim() ? input.variant_color.trim() : null,
        input.has_variants === 1 ? 1 : 0,
        input.base_unit_name?.trim() ? input.base_unit_name.trim() : null,
        input.stock_untracked === 1 ? 1 : 0,
        input.sizes_count ?? null,
        id,
      ],
    );
  },

  /** Exact barcode lookup for POS scanning (base-unit barcode).
   *  v23 (round-29 #1): a LIVE product always wins over an archived
   *  one sharing the same barcode (a re-added product must sell). */
  async findByBarcode(code: string): Promise<Product | null> {
    const clean = code.trim();
    if (!clean) return null;
    const result = await getDb().execute(
      'SELECT * FROM products WHERE barcode = ? ORDER BY is_archived ASC LIMIT 1',
      [clean],
    );
    const row = result.rows?.[0];
    return row ? rowToProduct(row) : null;
  },

  /** v23 (round-29 #1): has this product left history behind
   *  (sales lines or stocktake counts)? Such rows can NEVER be
   *  hard-deleted — sale_items/stocktake_items FKs — so «حذف»
   *  archives them instead. */
  async hasHistory(id: number): Promise<boolean> {
    const result = await getDb().execute(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM sale_items WHERE product_id = ?)
              OR EXISTS (SELECT 1 FROM stocktake_items WHERE product_id = ?)
         LIMIT 1`,
      [id, id],
    );
    return (result.rows ?? []).length > 0;
  },

  /** v23 (round-29 #1): the fix for the FOREIGN KEY crash on
   *  «حذف المنتج» — a product with sales/stocktake history is
   *  ARCHIVED (hidden, kept for reports + returns) instead of
   *  crashing; a historyless product is deleted for real. */
  async remove(id: number): Promise<'deleted' | 'archived'> {
    if (await this.hasHistory(id)) {
      await getDb().execute(
        'UPDATE products SET is_archived = 1 WHERE id = ?',
        [id],
      );
      return 'archived';
    }
    await getDb().execute('DELETE FROM products WHERE id = ?', [id]);
    return 'deleted';
  },

  /** v23 (round-29 #1): brings an archived product back to the
   *  shelf (POS + inventory + alerts) — history was never lost. */
  async unarchive(id: number): Promise<void> {
    await getDb().execute('UPDATE products SET is_archived = 0 WHERE id = ?', [
      id,
    ]);
  },

  /** Atomically decrements stock; throws a friendly error on oversell.
   *  v35: مخزون بلا تتبع (stock_untracked=1) لا يُخصم أبداً —
   *  البيع لا يُحجب بنفاد (مطعم/كافيتريا). */
  async decrementStock(id: number, quantity: number): Promise<void> {
    const result = await getDb().execute(
      `UPDATE products SET stock_quantity = stock_quantity - ?
        WHERE id = ? AND stock_quantity >= ? AND stock_untracked = 0`,
      [quantity, id, quantity],
    );
    if (result.rowsAffected !== 1) {
      // منتج بلا تتبع: الصف نفسه (وليس حرس الكمية) هو ما لم
      // يطابق — لا خطأ هنا؛ غير ذلك فالمخزون فعلاً لا يكفي.
      const row = await getDb().execute(
        'SELECT stock_untracked FROM products WHERE id = ?',
        [id],
      );
      const untracked =
        (row.rows?.[0] as {stock_untracked?: number})
          ?.stock_untracked === 1;
      if (untracked) {
        return;
      }
      throw new Error(
        `الكمية المتوفرة من المنتج غير كافية (المطلوب: ${quantity})`,
      );
    }
  },

  /** Sets an absolute stock value (used after stocktake reconciliation). */
  async setStock(id: number, quantity: number): Promise<void> {
    await getDb().execute(
      'UPDATE products SET stock_quantity = ? WHERE id = ?',
      [quantity, id],
    );
  },

  /** v8.3: nulls a product's image (its file is gone — restore /
   *  reinstall left a dead path; the fallback icon must come back). */
  async clearImage(id: number): Promise<void> {
    await getDb().execute('UPDATE products SET image_uri = NULL WHERE id = ?', [
      id,
    ]);
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};

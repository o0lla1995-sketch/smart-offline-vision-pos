/**
 * Categories repository — CRUD + safety guard against deleting a
 * category that still has products attached.
 * v34 (الجولة 42 #3): نطاق لكل نمط — كل تصنيف يحمل نمط المتجر الذي
 * أُنشئ فيه (store_mode)، والقوائم تُرشَّح بالنمط الحالي: كل مجال
 * يرى تصنيفاته فقط، وتبديل النمط لا يزرع فوق القديم أبداً. لا
 * يُحذف شيء — إعادة النمط تعيد ظهور تصنيفاته فوراً.
 */
import {getDb, toMessage} from '../connection';
import type {Category} from '../../core/types';

function rowToCategory(row: Record<string, unknown>): Category {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    /** v34: نمط المتجر الذي ينتمي إليه التصنيف (null = قديم
     *  قبل الترقية — يُوسم مرة واحدة عند أول إقلاع). */
    store_mode:
      row.store_mode == null || String(row.store_mode).length === 0
        ? null
        : String(row.store_mode),
  };
}

export const CategoryRepo = {
  /**
   * قائمة التصنيفات.
   * @param mode عند تمريره: تصنيفات هذا النمط فقط (واجهات المتجر).
   *   بلا وسيط: كل التصنيفات (النسخ الاحتياطي والترحيلات).
   */
  async list(mode?: string | null): Promise<Category[]> {
    const sql =
      mode != null && mode.length > 0
        ? 'SELECT id, name, store_mode FROM categories WHERE store_mode = ? ORDER BY name ASC'
        : 'SELECT id, name, store_mode FROM categories ORDER BY name ASC';
    const result = await getDb().execute(sql, mode != null && mode.length > 0 ? [mode] : []);
    const rows = result.rows ?? [];
    return rows.map(rowToCategory);
  },

  /** v34: إنشاء تصنيف داخل نطاق نمط معين (يسم بالوسم نفسه). */
  async create(name: string, mode?: string | null): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الفئة فارغ');
    }
    // التفرد داخل النطاق نفسه فقط — «علبة» للصيدلية و«علبة» لبقالة
    // أخرى مستقبلاً لا يتعارضان (كل نمط عالم مستقل).
    const scopeMode = mode != null && mode.length > 0 ? mode : null;
    const exists = await getDb().execute(
      'SELECT COUNT(*) AS cnt FROM categories WHERE lower(name) = lower(?) AND (store_mode IS ? OR (store_mode IS NULL AND ? IS NULL))',
      [trimmed, scopeMode, scopeMode],
    );
    const existsRow = exists.rows?.[0] as {cnt?: number} | undefined;
    if ((existsRow?.cnt ?? 0) > 0) {
      throw new Error('توجد فئة بنفس الاسم مسبقاً');
    }
    const result = await getDb().execute(
      'INSERT INTO categories (name, store_mode) VALUES (?, ?)',
      [trimmed, scopeMode],
    );
    return result.insertId ?? -1;
  },

  async rename(id: number, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الفئة فارغ');
    }
    await getDb().execute('UPDATE categories SET name = ? WHERE id = ?', [
      trimmed,
      id,
    ]);
  },

  /**
   * Lists categories with the number of products in each.
   * v34: يرشَّح بالنمط عند تمريره (شاشة إدارة التصنيفات).
   */
  async listWithCounts(mode?: string | null): Promise<Category[]> {
    const where =
      mode != null && mode.length > 0 ? 'WHERE c.store_mode = ?' : '';
    const result = await getDb().execute(
      `SELECT c.id, c.name, c.store_mode, COUNT(p.id) AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.name ASC`,
      mode != null && mode.length > 0 ? [mode] : [],
    );
    const rows = result.rows ?? [];
    return rows.map(row => ({
      ...rowToCategory(row),
      productCount: Number(row.product_count ?? 0),
    }));
  },

  /**
   * Deletes a category. Products keep existing but become uncategorized
   * (same behaviour as global POS systems like Loyverse).
   */
  async remove(id: number): Promise<void> {
    await getDb().execute(
      'UPDATE products SET category_id = NULL WHERE category_id = ?',
      [id],
    );
    await getDb().execute('DELETE FROM categories WHERE id = ?', [id]);
  },

  /** v34: وسم كل الصفوف غير الموسومة بنمط معين (وسم البيانات
   *  القديمة مرة واحدة عند أول إقلاع بعد الترقية). */
  async tagUntagged(mode: string): Promise<number> {
    const result = await getDb().execute(
      'UPDATE categories SET store_mode = ? WHERE store_mode IS NULL',
      [mode],
    );
    return Number(result.rowsAffected ?? 0);
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};

/**
 * VariantRepo — v35 (الجولة 43): متغيرات المنتج الواحد.
 * ─────────────────────────────────────────────────────────────────
 * نمط Shopify Variants: الموديل الواحد منتج واحد بمتغيرات داخلية
 * في جدول product_variants —
 *  • ملابس (kind='variant'): كل (لون × مقاس) صف بمخزونه؛ الربطة
 *    (مقاسات × ألوان × عدد الربط) تملأ كل صف بعدد الربط، وإجمالي
 *    القطع = ألوان × مقاسات × ربط.
 *  • مطعم/كافيتريا (kind='size'): كل حجم بسعره الخاص.
 * المخزون الكلي للمنتج (products.stock_quantity) يُبقى دائماً مساويًا
 * لمجموع متغيراته كي تستمر كل منطومات المخزون القائمة (حراس
 * البيع، التقارير، الجرد) بالعمل دون تغيير — والخصم الدقيق يتم
 * من صف المتغير نفسه داخل معاملة البيع نفسها.
 */
import {getDb} from '../connection';
import {localNow} from '../../core/format';
import type {ProductVariant} from '../../core/types';

function rowToVariant(row: Record<string, unknown>): ProductVariant {
  return {
    id: Number(row.id),
    product_id: Number(row.product_id),
    kind: String(row.kind ?? 'variant') === 'size' ? 'size' : 'variant',
    color: String(row.color ?? ''),
    size: String(row.size ?? ''),
    stock_quantity: Number(row.stock_quantity ?? 0),
    retail_price:
      row.retail_price == null ? null : Number(row.retail_price),
    cost_price: row.cost_price == null ? null : Number(row.cost_price),
    created_at: String(row.created_at ?? ''),
  };
}

export interface VariantInput {
  kind: 'variant' | 'size';
  color: string;
  size: string;
  stock_quantity: number;
  retail_price?: number | null;
  cost_price?: number | null;
}

export const VariantRepo = {
  async listByProduct(productId: number): Promise<ProductVariant[]> {
    const result = await getDb().execute(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id ASC',
      [productId],
    );
    return (result.rows ?? []).map(rowToVariant);
  },

  /** All variants grouped by product id (catalog refresh). */
  async listAll(): Promise<Map<number, ProductVariant[]>> {
    const result = await getDb().execute(
      'SELECT * FROM product_variants ORDER BY id ASC',
    );
    const rows = (result.rows ?? []).map(rowToVariant);
    const map = new Map<number, ProductVariant[]>();
    for (const row of rows) {
      const arr = map.get(row.product_id) ?? [];
      arr.push(row);
      map.set(row.product_id, arr);
    }
    return map;
  },

  /** v35: يستبدل متغيرات منتج كاملة (حفظ صفحة المنتج) داخل
   *  معاملة واحدة.
   *  v39 (الجولة 47 — السبب الجذري لتصفير المخزون): المعامل
   *  syncProductStock يقرر هل يُحدَّث مخزون المنتج بمجموع
   *  متغيراته. كان هذا التحديث ينفذ دائماً، فأي تعديل لمنتج
   *  قائم يستدعي replaceForProduct(targetId, []) (مسار «نظّف
   *  صفوف المتغيرات») كان يكتب stock_quantity = 0 فوق الكمية
   *  المحفوظة للتو — «حفظ بنجاح» فوق مخزون مصفَّر، في كل مود.
   *  الآن:
   *   • ملابس (kind='variant'): sync=true — مخزون الموديل = مجموع
   *     متغيراته فعلاً (هذا تصميمه الصحيح).
   *   • أحجام مطعم/كافيتريا (kind='size'): sync=false — الأحجام
   *     تحمل أسعارها فقط (مخزونها دائماً 0)، والكمية مصدرها حقل
   *     الكمية في صفحة المنتج.
   *   • التنظيف (مصفوفة فارغة): sync=false — حذف صفوف المتغيرات
   *     فقط، والمخزون القائم لا يُمس.
   */
  async replaceForProduct(
    productId: number,
    variants: VariantInput[],
    syncProductStock = false,
  ): Promise<void> {
    const db = getDb();
    await db.transaction(async tx => {
      await tx.execute('DELETE FROM product_variants WHERE product_id = ?', [
        productId,
      ]);
      let total = 0;
      for (const variant of variants) {
        const color = variant.color.trim();
        const size = variant.size.trim();
        if (!color && !size) {
          continue;
        }
        await tx.execute(
          `INSERT INTO product_variants
             (product_id, kind, color, size, stock_quantity, retail_price, cost_price, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            productId,
            variant.kind,
            color,
            size,
            Math.max(0, variant.stock_quantity),
            variant.retail_price ?? null,
            variant.cost_price ?? null,
            localNow(),
          ],
        );
        total += Math.max(0, variant.stock_quantity);
      }
      if (syncProductStock) {
        await tx.execute(
          'UPDATE products SET stock_quantity = ? WHERE id = ?',
          [total, productId],
        );
      }
    });
  },

  /** Atomic variant decrement (sale transaction) — throws Arabic
   *  error when the variant is short. */
  async decrement(
    tx: {execute: (sql: string, params?: unknown[]) => Promise<any>},
    variantId: number,
    quantity: number,
  ): Promise<void> {
    const result = await tx.execute(
      'UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
      [quantity, variantId, quantity],
    );
    if (result.rowsAffected !== 1) {
      throw new Error(`نفدت كمية هذا المتغير (${quantity} مطلوبة)`);
    }
  },

  /** Restore variant stock (return receipt). */
  async restore(
    tx: {execute: (sql: string, params?: unknown[]) => Promise<any>},
    variantId: number,
    quantity: number,
  ): Promise<void> {
    await tx.execute(
      'UPDATE product_variants SET stock_quantity = stock_quantity + ? WHERE id = ?',
      [quantity, variantId],
    );
  },
};

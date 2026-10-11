/**
 * Units repository — user-defined sellable units (قطعة، كرتونة، كيلو…)
 * plus per-product unit rows with conversion factors and price overrides.
 * v9.2 (round-15 #3): every unit carries a TYPE (kind — piece /
 * weight / volume / length) so weight products offer weight units
 * and piece products offer packaging units.
 * v34 (الجولة 42 #3): نطاق لكل نمط — كل وحدة موسومة بنمط المتجر
 * الذي أُنشئت فيه (store_mode)؛ القوائم والمنتقيات ترشَّح بالنمط
 * الحالي فلا تتداخل وحدات المجالات فوق بعضها، وتبديل النمط لا
 * يزرع فوق القديم (لا تراكم) ولا يحذف شيئاً.
 */
import {getDb, toMessage} from '../connection';
import type {ProductUnit, Unit, UnitKind} from '../../core/types';

/** Safe kind for a raw DB row (old rows default to 'piece'). */
function kindOf(row: Record<string, unknown>): UnitKind {
  const value = String(row.kind ?? 'piece');
  return value === 'weight' || value === 'volume' || value === 'length'
    ? value
    : 'piece';
}

function rowToUnit(row: Record<string, unknown>): Unit {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    short_name: String(row.short_name ?? ''),
    sort_order: Number(row.sort_order ?? 0),
    kind: kindOf(row),
    store_mode:
      row.store_mode == null || String(row.store_mode).length === 0
        ? null
        : String(row.store_mode),
  };
}

function rowToProductUnit(row: Record<string, unknown>): ProductUnit {
  return {
    id: Number(row.id),
    product_id: Number(row.product_id),
    unit_id: Number(row.unit_id),
    unitName: String(row.unit_name ?? ''),
    unitShort: String(row.unit_short ?? ''),
    conversion: Number(row.conversion ?? 1),
    barcode: row.barcode == null ? null : String(row.barcode),
    retail_price: row.retail_price == null ? null : Number(row.retail_price),
    wholesale_price:
      row.wholesale_price == null ? null : Number(row.wholesale_price),
  };
}

export const UnitRepo = {
  /** v9.2: grouped by TYPE first (piece → weight → volume → length)
   *  so the management screen and pickers read naturally.
   *  v34: @param mode عند تمريره → وحدات هذا النمط فقط (واجهات
   *  المتجر والمنتقيات)؛ بلا وسيط → الكل (نسخ احتياطي/ترحيل). */
  async list(mode?: string | null): Promise<Unit[]> {
    const scoped = mode != null && mode.length > 0;
    const result = await getDb().execute(
      `SELECT * FROM units
       ${scoped ? 'WHERE store_mode = ?' : ''}
       ORDER BY CASE kind
         WHEN 'piece' THEN 0
         WHEN 'weight' THEN 1
         WHEN 'volume' THEN 2
         ELSE 3
       END, sort_order ASC, id ASC`,
      scoped ? [mode as string] : [],
    );
    return (result.rows ?? []).map(rowToUnit);
  },

  /** v34: إنشاء وحدة داخل نطاق نمط (وسم store_mode). */
  async create(
    name: string,
    short: string,
    kind: UnitKind = 'piece',
    mode?: string | null,
  ): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الوحدة مطلوب');
    }
    const scopeMode = mode != null && mode.length > 0 ? mode : null;
    const existing = await getDb().execute(
      'SELECT id FROM units WHERE name = ? COLLATE NOCASE AND (store_mode IS ? OR (store_mode IS NULL AND ? IS NULL))',
      [trimmed, scopeMode, scopeMode],
    );
    const hit = existing.rows?.[0] as {id?: number} | undefined;
    if (hit?.id != null) {
      throw new Error('توجد وحدة بنفس الاسم مسبقاً');
    }
    const orderResult = await getDb().execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM units',
    );
    const next = Number(
      (orderResult.rows?.[0] as {next?: number})?.next ?? 1,
    );
    const result = await getDb().execute(
      'INSERT INTO units (name, short_name, sort_order, kind, store_mode) VALUES (?, ?, ?, ?, ?)',
      [trimmed, short.trim() || trimmed, next, kind, scopeMode],
    );
    return result.insertId ?? -1;
  },

  /**
   * v9.1 (round-14 #4): find a unit by exact name or create it —
   * used by the one-tap weight-package chips (وقية / نصف كغ…) so a
   * merchant never has to leave the product form to add a package
   * unit that doesn't exist yet.
   * v9.2 (round-15 #3): carries the unit TYPE through.
   * v34: carries the MODE scope through (استلام البضاعة ينشئ وحدة
   *  الكرتونة/الكيس/العلبة داخل نطاق النمط الحالي).
   */
  async getOrCreate(
    name: string,
    short?: string,
    kind: UnitKind = 'piece',
    mode?: string | null,
  ): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الوحدة مطلوب');
    }
    const scopeMode = mode != null && mode.length > 0 ? mode : null;
    const existing = await getDb().execute(
      'SELECT id FROM units WHERE name = ? COLLATE NOCASE AND (store_mode IS ? OR (store_mode IS NULL AND ? IS NULL))',
      [trimmed, scopeMode, scopeMode],
    );
    const hit = existing.rows?.[0] as {id?: number} | undefined;
    if (hit?.id != null) {
      return hit.id;
    }
    const orderResult = await getDb().execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM units',
    );
    const next = Number(
      (orderResult.rows?.[0] as {next?: number})?.next ?? 1,
    );
    const result = await getDb().execute(
      'INSERT INTO units (name, short_name, sort_order, kind, store_mode) VALUES (?, ?, ?, ?, ?)',
      [trimmed, (short ?? trimmed).trim() || trimmed, next, kind, scopeMode],
    );
    return result.insertId ?? -1;
  },

  async rename(
    id: number,
    name: string,
    short: string,
    kind?: UnitKind,
  ): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الوحدة مطلوب');
    }
    if (kind == null) {
      await getDb().execute(
        'UPDATE units SET name = ?, short_name = ? WHERE id = ?',
        [trimmed, short.trim() || trimmed, id],
      );
      return;
    }
    await getDb().execute(
      'UPDATE units SET name = ?, short_name = ?, kind = ? WHERE id = ?',
      [trimmed, short.trim() || trimmed, kind, id],
    );
  },

  async remove(id: number): Promise<void> {
    const usage = await getDb().execute(
      'SELECT COUNT(*) AS cnt FROM product_units WHERE unit_id = ?',
      [id],
    );
    const count = Number((usage.rows?.[0] as {cnt?: number})?.cnt ?? 0);
    if (count > 0) {
      throw new Error(
        `الوحدة مستخدمة في ${count} منتج — احذفها من المنتجات أولاً`,
      );
    }
    await getDb().execute('DELETE FROM units WHERE id = ?', [id]);
  },

  /** v34: وسم كل الوحدات غير الموسومة بنمط معين (وسم البيانات
   *  القديمة مرة واحدة عند أول إقلاع بعد الترقية). */
  async tagUntagged(mode: string): Promise<number> {
    const result = await getDb().execute(
      'UPDATE units SET store_mode = ? WHERE store_mode IS NULL',
      [mode],
    );
    return Number(result.rowsAffected ?? 0);
  },

  // ── Per-product unit rows ─────────────────────────────────────

  async listForProduct(productId: number): Promise<ProductUnit[]> {
    const result = await getDb().execute(
      `SELECT pu.*, u.name AS unit_name, u.short_name AS unit_short
       FROM product_units pu
       JOIN units u ON u.id = pu.unit_id
       WHERE pu.product_id = ?
       ORDER BY u.sort_order ASC`,
      [productId],
    );
    return (result.rows ?? []).map(rowToProductUnit);
  },

  async findByBarcode(
    code: string,
  ): Promise<{productId: number; productUnit: ProductUnit} | null> {
    const clean = code.trim();
    if (!clean) {
      return null;
    }
    const result = await getDb().execute(
      `SELECT pu.*, u.name AS unit_name, u.short_name AS unit_short
       FROM product_units pu
       JOIN units u ON u.id = pu.unit_id
       WHERE pu.barcode = ?
       LIMIT 1`,
      [clean],
    );
    const row = result.rows?.[0];
    return row
      ? {
          productId: Number(row.product_id),
          productUnit: rowToProductUnit(row),
        }
      : null;
  },

  /** Replaces the unit rows of a product inside an open transaction body.
   *  v9.1 (round-14 #4): conversions are FRACTIONAL-ALLOWING — a
   *  weight sub-unit like وقية = 0.25 (كغ) is the whole point. The
   *  old Math.max(1, …) clamp silently rewrote 0.25 → 1, which made
   *  every weight package deduct a FULL kilo — this was the
   *  "weight units are unsuitable" bug. */
  async replaceForProduct(
    productId: number,
    rows: {
      unit_id: number;
      conversion: number;
      barcode?: string | null;
      retail_price?: number | null;
      wholesale_price?: number | null;
    }[],
  ): Promise<void> {
    const db = getDb();
    await db.execute('DELETE FROM product_units WHERE product_id = ?', [
      productId,
    ]);
    for (const row of rows) {
      const conversion = Number(row.conversion);
      if (!Number.isFinite(conversion) || conversion <= 0) {
        throw new Error('معامل التحويل غير صالح');
      }
      const rounded = Math.round(conversion * 1000) / 1000;
      await db.execute(
        `INSERT OR REPLACE INTO product_units
          (product_id, unit_id, conversion, barcode, retail_price, wholesale_price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          productId,
          row.unit_id,
          rounded,
          row.barcode?.trim() ? row.barcode.trim() : null,
          row.retail_price != null && row.retail_price > 0
            ? row.retail_price
            : null,
          row.wholesale_price != null && row.wholesale_price > 0
            ? row.wholesale_price
            : null,
        ],
      );
    }
  },
};

export {toMessage};

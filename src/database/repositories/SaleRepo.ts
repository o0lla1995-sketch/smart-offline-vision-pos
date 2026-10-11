/**
 * Sales repository — the checkout transaction itself.
 * The sale, its items and all stock decrements run inside ONE SQLite
 * transaction so a crash can never leave half-written accounting data.
 * v23 (round-29 #2): the RETURNS engine lives here too — a return is
 * a NEGATIVE invoice (RET-… row + negative sale_items) plus stock
 * restore plus the debt-book adjustment, ALL inside one transaction.
 */
import {getDb, toMessage} from '../connection';
import {localNow} from '../../core/format';
import type {
  CartLine,
  ExchangeLineInput,
  PricingMode,
  ReturnBook,
  ReturnLineInput,
  SaleItemRecord,
  SaleRecord,
  SaleReturnExchange,
  SaleReturnItem,
  SaleReturnRecord,
  SaleWithItems,
} from '../../core/types';

export interface CreateSaleInput {
  invoiceNumber: string;
  lines: CartLine[];
  /** Absolute discount in ₪ applied to the whole invoice. */
  discount: number;
  paymentType: PricingMode;
  /** v14 (round-20 #1/#2): when present the sale is a صِلة credit
   *  sale — the debt-queue row is inserted INSIDE the very same
   *  SQLite transaction as the invoice, its items and the stock
   *  decrements. Any failure (a UNIQUE invoice-ref conflict, an
   *  oversell, a crash) rolls the WHOLE operation back: no half
   *  sale is ever left behind — the exact "failed but recorded"
   *  complaint. */
  debtRow?: {
    idempotencyKey: string;
    customerId: string | null;
    customerName: string | null;
    customerPhoneLast4: string | null;
    customerCard: string | null;
    offlineQr: string | null;
    amountMinor: number;
    description: string;
    scannedAt: string;
    /** v17 (round-23 #3): the prepaid-credit part of amountMinor
     *  (min(amount, cached credit)) — the store books the invoice as
     *  PAID by this much; the FULL amount still uploads and the
     *  server consumes the credit itself (0067). */
    creditCoveredMinor?: number;
  };
  /** v16 (round-22 #4): when present the sale is a STORE-LOCAL
   *  credit sale (دفتر المتجر) — the debt lands in local_debts
   *  inside the SAME transaction, never in the صِلة queue. The
   *  invoice number is the INV-L series ref. */
  localDebtRow?: {
    localCustomerId: number;
    customerName: string;
    amountMinor: number;
    description: string;
  };
}

function rowToSale(row: Record<string, unknown>): SaleRecord {
  return {
    id: Number(row.id),
    invoice_number: String(row.invoice_number ?? ''),
    total_amount: Number(row.total_amount ?? 0),
    total_cost: Number(row.total_cost ?? 0),
    total_profit: Number(row.total_profit ?? 0),
    discount: Number(row.discount ?? 0),
    payment_type: String(row.payment_type ?? 'RETAIL') as PricingMode,
    created_at: String(row.created_at ?? ''),
    returned_minor: Number(row.returned_minor ?? 0),
    return_kind: (row.return_kind as SaleRecord['return_kind']) ?? null,
  };
}

function rowToItem(row: Record<string, unknown>): SaleItemRecord {
  return {
    id: Number(row.id),
    sale_id: Number(row.sale_id),
    product_id: Number(row.product_id),
    quantity: Number(row.quantity ?? 0),
    unit_price: Number(row.unit_price ?? 0),
    cost_price: Number(row.cost_price ?? 0),
    total_line_price: Number(row.total_line_price ?? 0),
    unit_name: row.unit_name == null ? null : String(row.unit_name),
    base_quantity: row.base_quantity == null ? null : Number(row.base_quantity),
    variant_label:
      row.variant_label == null || String(row.variant_label).length === 0
        ? null
        : String(row.variant_label),
    variant_id:
      row.variant_id == null ? null : Number(row.variant_id),
    variant_color:
      row.variant_color == null || String(row.variant_color).length === 0
        ? null
        : String(row.variant_color),
  };
}

/** v23 (round-29 #2): sale_returns row mapper. */
function rowToReturn(row: Record<string, unknown>): SaleReturnRecord {
  return {
    id: Number(row.id),
    return_number: String(row.return_number ?? ''),
    sale_id: Number(row.sale_id),
    invoice_ref: String(row.invoice_ref ?? ''),
    book: String(row.book ?? 'cash') as SaleReturnRecord['book'],
    refund_method: String(row.refund_method ?? 'none') as 'none' | 'cash',
    refund_minor: Number(row.refund_minor ?? 0),
    debt_adjusted_minor: Number(row.debt_adjusted_minor ?? 0),
    is_exchange: Number(row.is_exchange ?? 0) === 1 ? 1 : 0,
    exchange_minor: Number(row.exchange_minor ?? 0),
    note: row.note == null ? null : String(row.note),
    created_at: String(row.created_at ?? ''),
  };
}

/** v23 (round-29 #2): sale_return_items row mapper. */
function rowToReturnItem(row: Record<string, unknown>): SaleReturnItem {
  return {
    id: Number(row.id),
    return_id: Number(row.return_id),
    sale_item_id: Number(row.sale_item_id),
    product_id: Number(row.product_id),
    product_name: String(row.product_name ?? ''),
    quantity: Number(row.quantity ?? 0),
    unit_name: row.unit_name == null ? null : String(row.unit_name),
    base_quantity: Number(row.base_quantity ?? 0),
    unit_price: Number(row.unit_price ?? 0),
    line_total: Number(row.line_total ?? 0),
    cost_price: Number(row.cost_price ?? 0),
  };
}

/** v36: صورة صنف استبدال محفوظ — بضاعة خرجت من المخزون مقابل
 *  مرتجع، بلا أثر مالي. */
function rowToExchange(row: Record<string, unknown>): SaleReturnExchange {
  return {
    id: Number(row.id),
    return_id: Number(row.return_id),
    product_id: Number(row.product_id),
    product_name: String(row.product_name ?? ''),
    quantity: Number(row.quantity ?? 0),
    unit_name: row.unit_name == null ? null : String(row.unit_name),
    base_quantity: Number(row.base_quantity ?? 0),
    unit_price: Number(row.unit_price ?? 0),
    line_total: Number(row.line_total ?? 0),
    cost_price: Number(row.cost_price ?? 0),
    variant_id: row.variant_id == null ? null : Number(row.variant_id),
    variant_color:
      row.variant_color == null ? null : String(row.variant_color),
    variant_label:
      row.variant_label == null ? null : String(row.variant_label),
  };
}

export const SaleRepo = {
  /**
   * Creates the invoice. Throws with an Arabic message when stock is
   * insufficient — the caller shows a toast and keeps the cart intact.
   */
  async createSale(input: CreateSaleInput): Promise<SaleWithItems> {
    if (input.lines.length === 0) {
      throw new Error('السلة فارغة');
    }
    const db = getDb();

    const subtotal = input.lines.reduce(
      (sum, line) => sum + line.unitPrice * line.quantity,
      0,
    );
    const discount = Math.min(Math.max(input.discount, 0), subtotal);
    const totalAmount = subtotal - discount;
    const totalCost = input.lines.reduce(
      (sum, line) => sum + line.costPrice * line.quantity,
      0,
    );
    const totalProfit = totalAmount - totalCost;
    const createdAt = localNow();

    let saleId = -1;

    await db.transaction(async tx => {
      const insertSale = await tx.execute(
        `INSERT INTO sales
          (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.invoiceNumber,
          totalAmount,
          totalCost,
          totalProfit,
          discount,
          input.paymentType,
          createdAt,
        ],
      );
      saleId = insertSale.insertId ?? -1;
      if (saleId < 0) {
        throw new Error('فشل إنشاء الفاتورة');
      }

      for (const line of input.lines) {
        const baseQty = line.quantity * (line.conversion ?? 1);
        await tx.execute(
          `INSERT INTO sale_items
            (sale_id, product_id, quantity, unit_price, cost_price, total_line_price, unit_name, base_quantity, variant_label, variant_id, variant_color)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId,
            line.productId,
            line.quantity,
            line.unitPrice,
            line.costPrice,
            line.unitPrice * line.quantity,
            line.unitName ?? null,
            baseQty,
            line.variantLabel ?? null,
            line.variantId ?? null,
            line.bundleColor ?? null,
          ],
        );
        // v35 (الجولة 43): مخزون بلا تتبع (مطعم/كافيتريا) لا يُخصم
        //  ولا يُحجب أبداً — الخدمة لا تُعدّ مخزوناً.
        const untracked = await tx.execute(
          'SELECT stock_untracked FROM products WHERE id = ?',
          [line.productId],
        );
        const isUntracked =
          (
            untracked.rows?.[0] as
              | {stock_untracked?: number}
              | undefined
          )?.stock_untracked === 1;
        if (!isUntracked) {
          // Oversell guard inside the same transaction (base units).
          const stockUpdate = await tx.execute(
            'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
            [baseQty, line.productId, baseQty],
          );
          if (stockUpdate.rowsAffected !== 1) {
            throw new Error(
              `الكمية المتوفرة من "${line.name}" غير كافية (${baseQty} قطعة مطلوبة)`,
            );
          }
        }
        // v35: خصم المتغير نفسه (لون × مقاس) — تحديد دقيق داخل
        //  معاملة الفاتورة ذاتها؛ مجموع المنتج خُصم أعلاه. أحجام
        //  المطعم (kind='size') بلا مخزون لكل حجم — تخطّى.
        if (line.variantId != null) {
          const kindRow = await tx.execute(
            'SELECT kind FROM product_variants WHERE id = ?',
            [line.variantId],
          );
          const variantKind = (
            kindRow.rows?.[0] as {kind?: string} | undefined
          )?.kind;
          if (variantKind === 'variant') {
            const variantUpdate = await tx.execute(
              'UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
              [baseQty, line.variantId, baseQty],
            );
            if (variantUpdate.rowsAffected !== 1) {
              throw new Error(
                `نفدت كمية "${line.name}" من هذا المتغير (${baseQty} مطلوبة)`,
              );
            }
          }
        }
        // v35: ربطة الجملة — قطعة من كل مقاس باللون المختار؛
        //  كل مقاس يُخصم منه عدد الربط (line.quantity).
        if (line.bundleColor != null) {
          const colorRows = await tx.execute(
            `SELECT id, stock_quantity FROM product_variants
              WHERE product_id = ? AND kind = 'variant' AND color = ?`,
            [line.productId, line.bundleColor],
          );
          const rows = (colorRows.rows ?? []) as {
            id: number;
            stock_quantity: number;
          }[];
          for (const row of rows) {
            const update = await tx.execute(
              'UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
              [line.quantity, row.id, line.quantity],
            );
            if (update.rowsAffected !== 1) {
              throw new Error(
                `مقاس من لون ${line.bundleColor} في "${line.name}" لا يكفي لـ ${line.quantity} ربطة`,
              );
            }
          }
        }
      }

      // v14 (round-20 #1/#2): the صِلة debt row joins the SAME
      // transaction — a pos_invoice_ref conflict (or any other
      // failure) aborts the invoice, the items AND the stock
      // decrements together. The sale can no longer be "recorded
      // while the debt operation failed".
      if (input.debtRow != null) {
        await tx.execute(
          `INSERT INTO sila_debt_queue (
            idempotency_key, customer_id, customer_name, customer_phone_last4,
            customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
            description, scanned_at, credit_covered_minor, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ILS', ?, ?, ?, ?, 'pending')`,
          [
            input.debtRow.idempotencyKey,
            input.debtRow.customerId,
            input.debtRow.customerName,
            input.debtRow.customerPhoneLast4,
            input.debtRow.customerCard,
            input.debtRow.offlineQr,
            input.debtRow.amountMinor,
            input.invoiceNumber,
            input.debtRow.description,
            input.debtRow.scannedAt,
            Math.max(
              0,
              Math.min(
                input.debtRow.creditCoveredMinor ?? 0,
                input.debtRow.amountMinor,
              ),
            ),
          ],
        );
      }

      // v16 (round-22 #4): the store-LOCAL debt twin — same atomic
      // discipline, different table (local_debts, INV-L series,
      // never uploaded).
      if (input.localDebtRow != null) {
        await tx.execute(
          `INSERT INTO local_debts (
            local_customer_id, invoice_ref, amount_minor, description
          ) VALUES (?, ?, ?, ?)`,
          [
            input.localDebtRow.localCustomerId,
            input.invoiceNumber,
            input.localDebtRow.amountMinor,
            input.localDebtRow.description,
          ],
        );
      }
    });

    const saleResult = await db.execute('SELECT * FROM sales WHERE id = ?', [
      saleId,
    ]);
    const saleRow = saleResult.rows?.[0];
    const itemsResult = await db.execute(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC',
      [saleId],
    );
    const itemRows = itemsResult.rows ?? [];

    return {
      sale: rowToSale(saleRow ?? {}),
      items: itemRows.map(rowToItem),
    };
  },

  // ── v23 (round-29 #2): THE RETURNS ENGINE ────────────────────

  /** Per-line already-returned quantities for an invoice — the
   *  ReturnSheet's ceiling (each original sale_items row can only be
   *  returned once, in total, across every RET receipt). */
  async returnedQtyByLine(saleId: number): Promise<Map<number, number>> {
    try {
      const result = await getDb().execute(
        `SELECT sri.sale_item_id AS sale_item_id, COALESCE(SUM(sri.quantity), 0) AS qty
         FROM sale_return_items sri
         JOIN sale_returns sr ON sr.id = sri.return_id
         WHERE sr.sale_id = ?
         GROUP BY sri.sale_item_id`,
        [saleId],
      );
      const map = new Map<number, number>();
      for (const row of result.rows ?? []) {
        map.set(
          Number((row as {sale_item_id?: unknown}).sale_item_id ?? 0),
          Number((row as {qty?: unknown}).qty ?? 0),
        );
      }
      return map;
    } catch {
      return new Map();
    }
  },

  /** Every return receipt issued against an invoice (newest first). */
  async returnsForSale(saleId: number): Promise<SaleReturnRecord[]> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM sale_returns WHERE sale_id = ? ORDER BY id DESC',
        [saleId],
      );
      return (result.rows ?? []).map(rowToReturn);
    } catch {
      return [];
    }
  },

  /** v23 (round-29 #2): one return receipt by its RET-… number. */
  async returnByNumber(returnNumber: string): Promise<SaleReturnRecord | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM sale_returns WHERE return_number = ? LIMIT 1',
        [returnNumber],
      );
      const row = result.rows?.[0];
      return row ? rowToReturn(row) : null;
    } catch {
      return null;
    }
  },

  /** The return's own line snapshot (detail view). */
  async returnItems(returnId: number): Promise<SaleReturnItem[]> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id ASC',
        [returnId],
      );
      return (result.rows ?? []).map(rowToReturnItem);
    } catch {
      return [];
    }
  },

  /** v36: صور أصناف الاستبدال لإشعار مرتجع معين (للطباعة والعروض). */
  async returnExchanges(returnId: number): Promise<SaleReturnExchange[]> {
    const result = await getDb().execute(
      'SELECT * FROM sale_return_exchanges WHERE return_id = ? ORDER BY id ASC',
      [returnId],
    );
    return (result.rows ?? []).map(row =>
      rowToExchange(row as Record<string, unknown>),
    );
  },

  /** v23 (round-29 #2): creates a RETURN — one atomic transaction:
   *   1. a NEGATIVE RET-… invoice row (nets revenue/cogs/profit in
   *      every report automatically) + negative sale_items lines,
   *   2. stock restore (base units) for every returned line,
   *   3. the sale_returns + sale_return_items snapshot rows,
   *   4. the original invoice's returned_minor accumulator,
   *   5. the DEBT adjustment inside the SAME transaction:
   *      • sila pending/failed → the queue row's amount shrinks
   *        (deleted at zero — the server never learns the returned
   *        part); sila synced → a return_reversal payment row is
   *        enqueued (uploads as method 'other' and reduces the
   *        customer's debt on the صلة server — the ONLY reverse
   *        operation the API offers); sila syncing → rejected
   *        before the transaction even starts;
   *      • local → the local_debts row's amount shrinks (never
   *        below zero);
   *      • cash → nothing to adjust (the refund itself is the
   *        merchant's cash-out, already netted by the RET row).
   *
   * discountRatio = total_amount / subtotal of the ORIGINAL invoice
   * (pro-rata discount) — returning every line refunds exactly the
   * invoice total, not the pre-discount subtotal.
   */
  async createReturn(input: {
    returnNumber: string;
    saleId: number;
    invoiceRef: string;
    book: ReturnBook;
    refundMethod: 'none' | 'cash';
    /** Pro-rata discount ratio of the original invoice (0..1]. */
    discountRatio: number;
    lines: ReturnLineInput[];
    /** v36→v40 (الجولة 48 #2): الاستبدال بقيمة المرجع — بضاعة تخرج
     *  من المخزون بدل المرتجع. موجودة وغير فارغة = وضع الاستبدال:
     *  الفرق بين قيمة المرتجع وقيمة البدائل يُسوّى مالياً —
     *  صف RET يحمل الصافي (إيراد/تكلفة/ربح الفرق) فيبقى حساب
     *  الخزينة متوازناً في كل سيناريو، والدين (محلي أو صلة)
     *  يزيد أو ينقص بالفرق بدل إبقائه جامداً. */
    exchange?: ExchangeLineInput[];
    /** v40 (الجولة 48 #2): زيادة دين صِلة المتزامن — حين تكون قيمة
     *  البدائل أعلى من المرتجع على فاتورة INV-D مرفوعة للخادم،
     *  يُنشأ صف دين جديد (state pending) يرفع الفرق للخادم كسدادٍ
     *  معكوس تماماً: pos_invoice_ref = رقم الإشعار + "-EX" (فريد
     *  دائماً لأن أرقام الإشعارات فريدة). */
    silaDebtIncrease?: {
      customerId: string | null;
      customerName: string | null;
      customerPhoneLast4: string | null;
      amountMinor: number;
      posInvoiceRef: string;
      idempotencyKey: string;
      description: string;
    } | null;
    /** sila reversal payload when the queue row is already synced. */
    silaReversal?: {
      customerId: string | null;
      customerName: string | null;
      customerPhoneLast4: string | null;
      amountMinor: number;
      /** The RCP-… receipt ref for the payment upload (the API's
       *  own series — safer than the RET- number against any
       *  server-side receipt pattern validation). */
      posReceiptRef: string;
      idempotencyKey: string;
    } | null;
    note?: string | null;
  }): Promise<SaleReturnRecord> {
    if (input.lines.length === 0) {
      throw new Error('لم يتم اختيار أي صنف للإرجاع');
    }
    const db = getDb();

    // ── Compute the money first (pure, no DB) ──────────────────
    // Line value at sale price, pro-rated for the invoice discount.
    const lineValues = input.lines.map(line => ({
      ...line,
      lineTotal: line.unitPrice * line.quantity * input.discountRatio,
      lineCost: line.costPrice * line.quantity,
      baseQty: line.quantity * line.basePerUnit,
    }));
    const refundValue = lineValues.reduce((sum, l) => sum + l.lineTotal, 0);
    const refundMinor = Math.round(refundValue * 100);
    if (refundMinor <= 0) {
      throw new Error('قيمة المرتجع غير صالحة');
    }
    const totalCost = lineValues.reduce((sum, l) => sum + l.lineCost, 0);
    const createdAt = localNow();

    // ── v36→v40: حساب الاستبدال (إن وجد) ─────────────────────
    // قيمة البضاعة البديلة بأسعارها الحالية. v36 كانت تُصفّر كل
    // الأثر المالي؛ v40 (الجولة 48 #2) تسوّي الفرق بالسعر كما طلب
    // التاجر: صف RET يحمل الصافي —
    //   total  = قيمة البدائل − قيمة المرتجع  (فرق موجب = دخل نقد)
    //   cost   = تكلفة البدائل − تكلفة المرتجع (بضاعة غادرت بدل أخرى)
    //   profit = total − cost
    // وبذلك يبقى معادلة الخزينة (الإيراد − مبيعات الدين + المقبوضات)
    // متوازنة في كل السيناريوهات: زبون نقدي يدفع/يستلم الفرق نقداً
    // (الإيراد يتحرك بالفرق)، ودين محلي/صلة يزيد أو ينقص بالفرق
    // (الإيراد وكرديت المبيعات يتحركان معاً فينعادلان — لا نقد تحرك).
    const exchangeMode = (input.exchange?.length ?? 0) > 0;
    const exchangeValues = (input.exchange ?? []).map(line => ({
      ...line,
      lineTotal: line.unitPrice * line.quantity,
      lineCost: line.costPrice * line.quantity,
      baseQty: line.quantity * line.basePerUnit,
    }));
    const exchangeValue = exchangeValues.reduce(
      (sum, l) => sum + l.lineTotal,
      0,
    );
    const exchangeMinor = Math.round(exchangeValue * 100);
    if (exchangeMode && exchangeMinor <= 0) {
      throw new Error('قيمة الاستبدال غير صالحة');
    }
    const exchangeCost = exchangeValues.reduce((sum, l) => sum + l.lineCost, 0);
    // v40: الفرق بالسعر — موجب: المرتجع أغلى (يُرد للزبون أو يُخصم
    // من دينه)؛ سالب: البدائل أغلى (يدفعها الزبون نقداً أو تُضاف
    // لدينه).
    const diffMinor = exchangeMode ? refundMinor - exchangeMinor : 0;

    let returnId = -1;

    await db.transaction(async tx => {
      // 1) The NEGATIVE invoice — every existing aggregation (revenue,
      //    cogs, profit, daily, hourly, top products) nets out with
      //    ZERO query changes; return_kind tells the debt buckets
      //    which side to net.
      const insertRet = await tx.execute(
        `INSERT INTO sales
          (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, return_kind)
         VALUES (?, ?, ?, ?, 0, 'RETAIL', ?, ?)`,
        [
          input.returnNumber,
          // v40 (الجولة 48 #2): وضع الاستبدال يحمل الصافي —
          //   total = البدائل − المرتجع (موجب = الزبون دفع فرقاً
          //   نقدياً دخل الخزينة، سالب = الكاشير سلّم الفرق منها)
          //   cost = تكلفة البدائل − تكلفة المرتجع، وprofit = الفرق.
          //   زبون الدين: الصافي نفسه ينعكس في دفتره بالفرق (خصم أو
          //   زيادة) فتنعادل معادلة الخزينة — لا نقد تحرك.
          exchangeMode ? exchangeValue - refundValue : -refundValue,
          exchangeMode ? exchangeCost - totalCost : -totalCost,
          exchangeMode
            ? exchangeValue - refundValue - (exchangeCost - totalCost)
            : -(refundValue - totalCost),
          createdAt,
          input.book,
        ],
      );
      const retSaleId = insertRet.insertId ?? -1;
      if (retSaleId < 0) {
        throw new Error('فشل إنشاء سجل المرتجع');
      }

      // 2) Negative lines + stock restore + the snapshot rows.
      for (const line of lineValues) {
        await tx.execute(
          `INSERT INTO sale_items
            (sale_id, product_id, quantity, unit_price, cost_price, total_line_price, unit_name, base_quantity, variant_label, variant_id, variant_color)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            retSaleId,
            line.productId,
            -line.quantity,
            line.unitPrice,
            line.costPrice,
            -line.lineTotal,
            line.unitName,
            -line.baseQty,
            line.variantLabel ?? null,
            line.variantId ?? null,
            line.variantColor ?? null,
          ],
        );
        // v35 (الجولة 43): مخزون بلا تتبع لا يُسترجع (لم يُخصم
        //  أصلاً)؛ والمتغير يُسترجع تحديداً بمعرّفه.
        const untracked = await tx.execute(
          'SELECT stock_untracked FROM products WHERE id = ?',
          [line.productId],
        );
        const isUntracked =
          (
            untracked.rows?.[0] as
              | {stock_untracked?: number}
              | undefined
          )?.stock_untracked === 1;
        // Stock comes back (base units) — the product row ALWAYS
        // exists: history-bearing products are archived, never
        // deleted (v23 #1), and only history-bearing products can
        // be returned.
        if (!isUntracked) {
          await tx.execute(
            'UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?',
            [line.baseQty, line.productId],
          );
        }
        // v35 (الجولة 43): استرجاع المتغير تحديداً — أو كل مقاسات
        //  لون الربطة المرتجعة (قطعة لكل مقاس بعدد الربط).
        if (line.variantId != null) {
          const kindRow = await tx.execute(
            'SELECT kind FROM product_variants WHERE id = ?',
            [line.variantId],
          );
          const variantKind = (
            kindRow.rows?.[0] as {kind?: string} | undefined
          )?.kind;
          if (variantKind === 'variant') {
            await tx.execute(
              'UPDATE product_variants SET stock_quantity = stock_quantity + ? WHERE id = ?',
              [line.baseQty, line.variantId],
            );
          }
        } else if (line.variantColor != null) {
          await tx.execute(
            `UPDATE product_variants SET stock_quantity = stock_quantity + ?
              WHERE product_id = ? AND kind = 'variant' AND color = ?`,
            [line.quantity, line.productId, line.variantColor],
          );
        }
      }

      // 3) The return receipt + its line snapshots.
      //    v36: وضع الاستبدال → refund_method 'none' قسراً (لا نقد)
      //    + is_exchange=1 + exchange_minor؛ الدين لا يُمس إطلاقاً.
      const insertReturn = await tx.execute(
        `INSERT INTO sale_returns
          (return_number, sale_id, invoice_ref, book, refund_method, refund_minor, debt_adjusted_minor, is_exchange, exchange_minor, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          input.returnNumber,
          input.saleId,
          input.invoiceRef,
          input.book,
          exchangeMode ? 'none' : input.refundMethod,
          refundMinor,
          exchangeMode ? 1 : 0,
          exchangeMode ? exchangeMinor : 0,
          input.note?.trim() || null,
          createdAt,
        ],
      );
      returnId = insertReturn.insertId ?? -1;
      if (returnId < 0) {
        throw new Error('فشل إنشاء إيصال المرتجع');
      }
      for (const line of lineValues) {
        await tx.execute(
          `INSERT INTO sale_return_items
            (return_id, sale_item_id, product_id, product_name, quantity, unit_name, base_quantity, unit_price, line_total, cost_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            returnId,
            line.saleItemId,
            line.productId,
            line.productName,
            line.quantity,
            line.unitName,
            line.baseQty,
            line.unitPrice,
            line.lineTotal,
            line.costPrice,
          ],
        );
      }

      // v36: صور أصناف الاستبدال + خصم مخزونها + سطرها الموجب في
      // فاتورة المرتجع (الكميات فقط تعمل في الإحصاءات؛ القيم المالية
      // للصف كله أصفار في وضع الاستبدال فلا يتحرك أي رقم مالي).
      for (const line of exchangeValues) {
        await tx.execute(
          `INSERT INTO sale_return_exchanges
            (return_id, product_id, product_name, quantity, unit_name, base_quantity, unit_price, line_total, cost_price, variant_id, variant_color, variant_label, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            returnId,
            line.productId,
            line.productName,
            line.quantity,
            line.unitName,
            line.baseQty,
            line.unitPrice,
            line.lineTotal,
            line.costPrice,
            line.variantId ?? null,
            line.variantColor ?? null,
            (line.variantLabel ?? null),
            createdAt,
          ],
        );
        // سطر موجب في فاتورة المرتجع — «ما خرج بدلاً من المرتجع».
        await tx.execute(
          `INSERT INTO sale_items
            (sale_id, product_id, quantity, unit_price, cost_price, total_line_price, unit_name, base_quantity, variant_label, variant_id, variant_color)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            retSaleId,
            line.productId,
            line.quantity,
            line.unitPrice,
            line.costPrice,
            line.lineTotal,
            line.unitName,
            line.baseQty,
            (line.variantLabel ?? null),
            line.variantId ?? null,
            line.variantColor ?? null,
          ],
        );
        // خصم المخزون (وحدات الأساس) مع تحقق توفر واضح.
        const prodRow = await tx.execute(
          'SELECT stock_quantity, stock_untracked, has_variants FROM products WHERE id = ?',
          [line.productId],
        );
        const prod = prodRow.rows?.[0] as
          | {stock_quantity?: number; stock_untracked?: number; has_variants?: number}
          | undefined;
        if (prod == null) {
          throw new Error(`منتج الاستبدال «${line.productName}» غير موجود`);
        }
        const untrackedExchange = Number(prod.stock_untracked ?? 0) === 1;
        if (!untrackedExchange) {
          const available = Number(prod.stock_quantity ?? 0);
          if (line.baseQty > available + 0.0001) {
            throw new Error(
              `مخزون «${line.productName}» لا يكفي للاستبدال — المتوفر ${available} والمطلوب ${line.baseQty}`,
            );
          }
          await tx.execute(
            'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?',
            [line.baseQty, line.productId],
          );
        }
        if (line.variantId != null) {
          const vRow = await tx.execute(
            'SELECT stock_quantity FROM product_variants WHERE id = ?',
            [line.variantId],
          );
          const vStock = vRow.rows?.[0] as
            | {stock_quantity?: number}
            | undefined;
          const vAvail = Number(vStock?.stock_quantity ?? 0);
          if (!untrackedExchange && line.baseQty > vAvail + 0.0001) {
            throw new Error(
              `مخزون متغير «${line.productName}» لا يكفي للاستبدال — المتوفر ${vAvail}`,
            );
          }
          await tx.execute(
            'UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?',
            [line.baseQty, line.variantId],
          );
        }
      }

      // 4) The original invoice's accumulator — «تعديل الفاتورة
      //    التي تم الإرجاع منها مع تمييزها».
      await tx.execute(
        'UPDATE sales SET returned_minor = returned_minor + ? WHERE id = ?',
        [refundMinor, input.saleId],
      );

      // 5) The DEBT adjustment — same transaction, no half states.
      //    v40 (الجولة 48 #2): في وضع الاستبدال يُعدَّل الدين بالفرق
      //    بين قيمة المرتجع وقيمة البدائل — المرتجع أغلى → يُخصم
      //    الفرق من دين الزبون (محلي أو صلة)؛ البدائل أغلى → يزيد
      //    الدين بالفرق. الإرجاع المالي العادي كما كان: يُخصم كامل
      //    قيمة المرتجع. الزبون النقدي: لا دين يُمس هنا إطلاقاً —
      //    الفرق يمر عبر صف RET نفسه (نقد خرج من الخزينة أو دخلها).
      let debtAdjustedMinor = 0;
      if (input.book === 'local') {
        // v40: الاستبدال يعدّل بالفرق؛ الإرجاع العادي بكامل القيمة.
        const adjustMinor = exchangeMode ? diffMinor : refundMinor;
        // v26 (round-34 #2): local_debts.amount_minor carries
        // CHECK (amount_minor > 0) — the old blind
        // `SET amount_minor = MAX(0, amount_minor - ?)` CRASHED with
        // an SQL CHECK error the moment a return zeroed the debt
        // (returning ALL the items of an INV-L invoice), rolling the
        // whole transaction back — «لا يسمح بإرجاع كل الأصناف جميعا».
        // The fix mirrors the sila pending-queue discipline: read the
        // current amount, shrink it while it stays positive, DELETE
        // the row when the return consumes it entirely (the invoice
        // + the sale_returns snapshot keep the full history, and the
        // customer disappears from the debtors list owing nothing).
        const localRow = await tx.execute(
          'SELECT amount_minor FROM local_debts WHERE invoice_ref = ? AND migrated = 0',
          [input.invoiceRef],
        );
        const localDebt = localRow.rows?.[0] as
          | {amount_minor?: number | null}
          | undefined;
        if (localDebt != null && adjustMinor !== 0) {
          const currentLocal = Number(localDebt.amount_minor ?? 0);
          if (adjustMinor > 0) {
            // خصم — ينكمش الدين ويحذف الصف عند الاستهلاك الكامل.
            if (adjustMinor >= currentLocal) {
              await tx.execute(
                'DELETE FROM local_debts WHERE invoice_ref = ? AND migrated = 0',
                [input.invoiceRef],
              );
              debtAdjustedMinor = currentLocal;
            } else {
              await tx.execute(
                `UPDATE local_debts
                   SET amount_minor = amount_minor - ?
                 WHERE invoice_ref = ? AND migrated = 0`,
                [adjustMinor, input.invoiceRef],
              );
              debtAdjustedMinor = adjustMinor;
            }
          } else {
            // v40: زيادة — البدائل أغلى من المرتجع فدين الزبون يزيد
            // بالفرق. الصف موجود (الطبقة العليا ترفض الحالة المفقودة
            // قبل المعاملة برسالة واضحة) وCHECK البقاء موجباً مضمون
            // لأننا نضيف فقط.
            await tx.execute(
              `UPDATE local_debts
                 SET amount_minor = amount_minor + ?
               WHERE invoice_ref = ? AND migrated = 0`,
              [-adjustMinor, input.invoiceRef],
            );
          }
        }
      } else if (input.book === 'sila') {
        if (input.silaReversal != null) {
          // Synced debt — the reverse operation: a payment upload
          // (kind 'return_reversal') reduces the customer's debt on
          // the صلة server exactly like a repayment, but never
          // counts as collected cash in the store's statistics.
          // v40: في الاستبدال مبلغ العكس = الفرق فقط (المرتجع أغلى)،
          // وفي الإرجاع العادي = كامل قيمة المرتجع كما كان.
          await tx.execute(
            `INSERT INTO sila_payment_queue (
              idempotency_key, customer_id, customer_name, customer_phone_last4,
              amount_minor, payment_method, pos_receipt_ref, description,
              paid_at, state, kind
            ) VALUES (?, ?, ?, ?, ?, 'other', ?, ?, ?, 'pending', 'return_reversal')`,
            [
              input.silaReversal.idempotencyKey,
              input.silaReversal.customerId,
              input.silaReversal.customerName,
              input.silaReversal.customerPhoneLast4,
              input.silaReversal.amountMinor,
              input.silaReversal.posReceiptRef,
              `عكس قيمة مرتجع بضاعة — فاتورة ${input.invoiceRef} (إشعار ${input.returnNumber})`,
              createdAt,
            ],
          );
          debtAdjustedMinor = input.silaReversal.amountMinor;
        } else if (input.silaDebtIncrease != null) {
          // v40 (الجولة 48 #2): دين متزامن والبدائل أغلى — صف دين
          // جديد (pending) يرفع الفرق للخادم مع أول مزامنة؛ المرجع
          // فريد بحكم تفرّد رقم الإشعار (RET-…-EX) فلا يتضارب مع
          // فاتورة الديون الأصلية أبداً، والوصف يشرح مصدره للتاجر
          // في سجل الزبون على الخادم.
          await tx.execute(
            `INSERT INTO sila_debt_queue (
              idempotency_key, customer_id, customer_name, customer_phone_last4,
              amount_minor, currency, pos_invoice_ref, description,
              scanned_at, state
            ) VALUES (?, ?, ?, ?, ?, 'ILS', ?, ?, ?, 'pending')`,
            [
              input.silaDebtIncrease.idempotencyKey,
              input.silaDebtIncrease.customerId,
              input.silaDebtIncrease.customerName,
              input.silaDebtIncrease.customerPhoneLast4,
              input.silaDebtIncrease.amountMinor,
              input.silaDebtIncrease.posInvoiceRef,
              input.silaDebtIncrease.description,
              createdAt,
            ],
          );
        } else {
          // Pending/failed queue row — the server never learned the
          // original amounts, so BOTH directions adjust the row
          // directly: shrink (or delete at zero) when the returned
          // goods outweigh the replacements, GROW by the difference
          // when the customer took more (v40) — the upload then
          // carries the net debt to the server in one number.
          const row = await tx.execute(
            'SELECT amount_minor, credit_covered_minor FROM sila_debt_queue WHERE pos_invoice_ref = ?',
            [input.invoiceRef],
          );
          const debtRow = row.rows?.[0] as
            | {amount_minor?: number; credit_covered_minor?: number}
            | undefined;
          if (debtRow != null) {
            const current = Number(debtRow.amount_minor ?? 0);
            const adjustMinor = exchangeMode ? diffMinor : refundMinor;
            if (adjustMinor >= 0) {
              const nextAmount = Math.max(0, current - adjustMinor);
              if (nextAmount === 0) {
                await tx.execute(
                  'DELETE FROM sila_debt_queue WHERE pos_invoice_ref = ?',
                  [input.invoiceRef],
                );
              } else {
                await tx.execute(
                  `UPDATE sila_debt_queue
                     SET amount_minor = ?,
                         credit_covered_minor = MIN(COALESCE(credit_covered_minor, 0), ?)
                   WHERE pos_invoice_ref = ?`,
                  [nextAmount, nextAmount, input.invoiceRef],
                );
              }
              debtAdjustedMinor = Math.min(adjustMinor, current);
            } else {
              // v40: البدائل أغلى — الدين المعلق يزيد بالفرق.
              await tx.execute(
                `UPDATE sila_debt_queue
                   SET amount_minor = amount_minor + ?,
                       credit_covered_minor = MIN(COALESCE(credit_covered_minor, 0), amount_minor + ?)
                 WHERE pos_invoice_ref = ?`,
                [-adjustMinor, -adjustMinor, input.invoiceRef],
              );
            }
          }
        }
      }
      if (debtAdjustedMinor > 0) {
        await tx.execute(
          'UPDATE sale_returns SET debt_adjusted_minor = ? WHERE id = ?',
          [debtAdjustedMinor, returnId],
        );
      }
    });

    const result = await db.execute('SELECT * FROM sale_returns WHERE id = ?', [
      returnId,
    ]);
    return rowToReturn(result.rows?.[0] ?? {});
  },

  async listRecent(limit = 20): Promise<SaleRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM sales ORDER BY id DESC LIMIT ?',
      [Math.min(Math.max(limit, 1), 200)],
    );
    const rows = result.rows ?? [];
    return rows.map(rowToSale);
  },

  /** v12 (round-18 #4): all-time collected revenue — the Home
   *  «الخزينة» number (total sales minus SILA debts = real cash). */
  async allTimeRevenue(): Promise<number> {
    try {
      const result = await getDb().execute(
        'SELECT COALESCE(SUM(total_amount), 0) AS revenue FROM sales',
      );
      const row = (result.rows?.[0] ?? {}) as {
        revenue?: number | null;
      };
      return Number(row.revenue ?? 0);
    } catch {
      return 0;
    }
  },

  async getItemsForSale(saleId: number): Promise<SaleItemRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC',
      [saleId],
    );
    const rows = result.rows ?? [];
    return rows.map(rowToItem);
  },

  /** v9.1 (round-14 #5) → v23 (round-29 #3): a REAL search engine.
   *  ─────────────────────────────────────────────────────────
   *  Was: invoice-number LIKE only. Now ONE paged query matches:
   *   • invoice number (any series — INV-/INV-D/INV-L/INV-V/RET-)
   *     including its DIGITS-ONLY form (202610061),
   *   • the CREDITOR name (صِلة queue + local book, via invoice ref),
   *   • any PRODUCT NAME on the invoice's lines,
   *   • the total amount (12 / 12.5 / 12.50),
   *   • the date (2026-10-06 / 20261006 / 10-06).
   *  Plus FILTERS (kind + date range) — all index-friendly and
   *  paged exactly as before. */
  async listPagePaged(options: {
    limit: number;
    offset: number;
    search?: string;
    /** v23: 'all' | cash (INV-) | sila debt (INV-D) | local debt
     *  (INV-L) | voucher (INV-V) | returns (RET-). */
    kind?: 'all' | 'cash' | 'sila' | 'local' | 'voucher' | 'returns';
    /** v23: inclusive local-date bounds ('' = open). */
    fromDate?: string;
    toDate?: string;
  }): Promise<(SaleRecord & {itemsCount: number})[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    const search = options.search?.trim() ?? '';
    if (search.length > 0) {
      const like = `%${search}%`;
      const digits = search.replace(/[^0-9.]/g, '');
      const amount = Number.parseFloat(search);
      const searchClauses = [
        's.invoice_number LIKE ?',
        `EXISTS (
           SELECT 1 FROM sila_debt_queue dq
           WHERE dq.pos_invoice_ref = s.invoice_number
             AND dq.customer_name LIKE ?)`,
        `EXISTS (
           SELECT 1 FROM local_debts ld
           JOIN local_customers lc ON lc.id = ld.local_customer_id
           WHERE ld.invoice_ref = s.invoice_number
             AND lc.name LIKE ?)`,
        `EXISTS (
           SELECT 1 FROM sale_items si
           JOIN products p ON p.id = si.product_id
           WHERE si.sale_id = s.id AND p.name LIKE ?)`,
      ];
      conditions.push(`(${searchClauses.join(' OR ')})`);
      params.push(like, like, like, like);
      // Digits-only typing (20261006 / 0001) — match the invoice
      // number with every letter/dash of the series stripped out.
      if (digits.length >= 2 && !search.includes('.')) {
        const stripped = ['-', 'I', 'N', 'V', 'D', 'L', 'R', 'E', 'T'].reduce(
          (expr, ch) => `REPLACE(${expr}, '${ch}', '')`,
          's.invoice_number',
        );
        conditions.push(`(${stripped} LIKE ?)`);
        params.push(`%${digits}%`);
      }
      // An exact amount (12 / 12.5 / 12.50).
      if (!Number.isNaN(amount) && search.match(/^[0-9]+(\.[0-9]+)?$/)) {
        conditions.push('ABS(s.total_amount - ?) < 0.005');
        params.push(amount);
      }
    }

    if (options.kind != null && options.kind !== 'all') {
      switch (options.kind) {
        case 'cash':
          conditions.push(
            "s.invoice_number LIKE 'INV-%' AND s.invoice_number NOT LIKE 'INV-D-%' AND s.invoice_number NOT LIKE 'INV-L-%' AND s.invoice_number NOT LIKE 'INV-V-%'",
          );
          break;
        case 'sila':
          conditions.push("s.invoice_number LIKE 'INV-D-%'");
          break;
        case 'local':
          conditions.push("s.invoice_number LIKE 'INV-L-%'");
          break;
        case 'voucher':
          conditions.push("s.invoice_number LIKE 'INV-V-%'");
          break;
        case 'returns':
          conditions.push('s.return_kind IS NOT NULL');
          break;
      }
    }
    if (options.fromDate) {
      conditions.push('date(s.created_at) >= date(?)');
      params.push(options.fromDate);
    }
    if (options.toDate) {
      conditions.push('date(s.created_at) <= date(?)');
      params.push(options.toDate);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await getDb().execute(
      `SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count
       FROM sales s ${where}
       ORDER BY s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    );
    const rows = result.rows ?? [];
    return rows.map(row => ({
      ...rowToSale(row),
      itemsCount: Number(row.items_count ?? 0),
    }));
  },

  /** v9.1: one invoice by id (the detail screen). */
  async getById(saleId: number): Promise<SaleRecord | null> {
    const result = await getDb().execute('SELECT * FROM sales WHERE id = ?', [
      saleId,
    ]);
    const row = result.rows?.[0];
    return row ? rowToSale(row) : null;
  },

  /** v25 (round-32 #4): the EXACT match by invoice number — the
   *  scan-to-open path. The printed receipt's CODE128 barcode
   *  carries the number verbatim (INV-/INV-D/INV-L/INV-V/RET-), so
   *  one indexed equality is all the lookup needs (a LIKE would
   *  risk opening the WRONG invoice on partial matches). */
  async byInvoiceNumber(invoiceNumber: string): Promise<SaleRecord | null> {
    const trimmed = invoiceNumber.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      const result = await getDb().execute(
        'SELECT * FROM sales WHERE invoice_number = ? LIMIT 1',
        [trimmed],
      );
      const row = result.rows?.[0];
      return row ? rowToSale(row) : null;
    } catch {
      return null;
    }
  },

  async countAll(): Promise<number> {
    const result = await getDb().execute('SELECT COUNT(*) AS cnt FROM sales');
    const row = result.rows?.[0] as {cnt?: number} | undefined;
    return Number(row?.cnt ?? 0);
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};

/**
 * Reports repository — SQL aggregations for the accounting engine.
 * All ranges are [from 00:00:00, to 23:59:59] in LOCAL time because
 * `sales.created_at` is always written as local device time.
 */
import {getDb, toMessage} from '../connection';
import {monthLabel, weekdayLabel} from '../../core/format';
import type {
  DailyPoint,
  DateRange,
  HourlyPoint,
  ReportSummary,
  TopProduct,
} from '../../core/types';

/** v15 (round-21 #4): credit invoices of the DEBT series in a range —
 *  count + totals from the sales table itself (INV-D-… rows), so
 *  restored backups count too (round-21 #2). */
export interface DebtSalesSummary {
  /** All credit invoices (INV-D + INV-L). */
  count: number;
  amount: number;
  /** v17 (round-23 #2): the صِلة series (INV-D-…). */
  silaCount: number;
  silaAmount: number;
  /** v17 (round-23 #2): the store-local book series (INV-L-…). */
  localCount: number;
  localAmount: number;
}

function rangeBounds(range: DateRange): [string, string] {
  return [`${range.from} 00:00:00`, `${range.to} 23:59:59`];
}

/* ── v30 (round-38 #3): إسناد المرتجعات لفترة الفاتورة الأصلية ──
 *
 * قاعدة التاجر: «إرجاع مبيعات قديمة لا يجعل مبيعات اليوم بالسالب،
 * والمفترض ألا تُحتسب المنتجات المرجعة في اليوم الذي أُرجعت فيه».
 * النموذج المحاسبي (نفس انضباط Loyverse): إيصال المرتجع (RET-) يُسند
 * إلى فترة الفاتورة الأصلية التي خرجت منها البضاعة — لا إلى يوم
 * معالجة الاسترداد. هكذا:
 *   • مبيعات اليوم/صافي الربح لا ينقصان أبداً بسبب مرتجع فاتورة
 *     قديمة (المردود يُخصم من يوم البيع نفسه — التاريخ المُعاد
 *     صياغته)، ولا يمكن أن يصبح رصيد اليوم سالباً لأن كل مرتجع
 *     مُسند لفترته لا يتجاوز فاتورته الأصلية داخل نفس الفترة.
 *   • مؤشر «المرتجعات» (عدد/قيمة) يبقى بيوم المعالجة — التاجر يرى
 *     ما استردّه اليوم فعلاً بشفافية تامة.
 * ربط وصيغة الإسناد (دفاعي: صف RET بلا سلسلة sale_returns — لا
 * يحدث، تُنشآن في معاملة واحدة — يبقى على تاريخه الذاتي). */
const RETURN_ORIGINAL_LINK = `
  SELECT sr.return_number AS ret_number, o.created_at AS orig_created_at
  FROM sale_returns sr
  JOIN sales o ON o.id = sr.sale_id`;

/** التاريخ الذي ينتمي إليه الصف: للمرتجع = تاريخ فاتورته الأصلية. */
const EFFECTIVE_AT = `CASE WHEN s.return_kind IS NOT NULL
  THEN COALESCE(link.orig_created_at, s.created_at)
  ELSE s.created_at END`;

/** شرط الانتماء للفترة بالتاريخ المُسند. */
const EFFECTIVE_IN_RANGE = `${EFFECTIVE_AT} >= ? AND ${EFFECTIVE_AT} <= ?`;

export const ReportRepo = {
  async summary(range: DateRange): Promise<ReportSummary> {
    const [start, end] = rangeBounds(range);
    // v23 (round-29 #2) → v30 (round-38 #3): RET rows are NEGATIVE
    // sales that net revenue/cogs/profit — but in the ORIGINAL
    // invoice's period (EFFECTIVE_AT), so refunding an old sale can
    // never dent today's figures («لا تُحتسب منتجات مرجعة قديمة في
    // اليوم»). The invoice COUNT is own-date (a return is not an
    // invoice) and the returns KPI stays own-date too — the merchant
    // still SEES what he refunded today, it just never distorts the
    // net numbers.
    const salesResult = await getDb().execute(
      `SELECT
         COALESCE(SUM(s.total_amount), 0) AS revenue,
         COALESCE(SUM(s.total_cost), 0) AS cogs,
         COALESCE(SUM(s.total_profit), 0) AS profit,
         COALESCE(SUM(s.discount), 0) AS discount_total
       FROM sales s
       LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
         ON link.ret_number = s.invoice_number
       WHERE ${EFFECTIVE_IN_RANGE}`,
      [start, end],
    );
    const salesRow =
      (salesResult.rows?.[0] as
        | {
            revenue?: number;
            cogs?: number;
            profit?: number;
            discount_total?: number;
          }
        | undefined) ?? {};

    // Activity counters — by the row's OWN date: real invoices
    // created in the period + refunds PROCESSED in the period.
    const activityResult = await getDb().execute(
      `SELECT
         COALESCE(SUM(CASE WHEN s.return_kind IS NULL THEN 1 ELSE 0 END), 0) AS invoices,
         COALESCE(SUM(CASE WHEN s.return_kind IS NOT NULL THEN 1 ELSE 0 END), 0) AS returns_cnt,
         COALESCE(SUM(CASE WHEN s.return_kind IS NOT NULL THEN -s.total_amount ELSE 0 END), 0) AS returns_total
       FROM sales s
       WHERE s.created_at >= ? AND s.created_at <= ?`,
      [start, end],
    );
    const activityRow =
      (activityResult.rows?.[0] as
        | {
            invoices?: number;
            returns_cnt?: number;
            returns_total?: number;
          }
        | undefined) ?? {};

    const itemsResult = await getDb().execute(
      `SELECT COALESCE(SUM(si.quantity), 0) AS items
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
         ON link.ret_number = s.invoice_number
       WHERE ${EFFECTIVE_IN_RANGE}`,
      [start, end],
    );
    const itemsRow = itemsResult.rows?.[0] as
      | {items?: number}
      | undefined;

    const invoices = Number(activityRow.invoices ?? 0);
    const returnsCount = Number(activityRow.returns_cnt ?? 0);
    const revenue = Number(salesRow.revenue ?? 0);
    return {
      revenue,
      cogs: Number(salesRow.cogs ?? 0),
      netProfit: Number(salesRow.profit ?? 0),
      invoicesCount: invoices,
      itemsCount: Number(itemsRow?.items ?? 0),
      discountTotal: Number(salesRow.discount_total ?? 0),
      avgInvoice: invoices > 0 ? revenue / invoices : 0,
      returnsCount,
      returnsTotal: Number(activityRow.returns_total ?? 0),
    };
  },

  async topProducts(range: DateRange, limit = 10): Promise<TopProduct[]> {
    const [start, end] = rangeBounds(range);
    // v30 (round-38 #3): return lines net their product's totals in
    // the ORIGINAL invoice's period — an old sale's refund never
    // plants a negative row in today's best-sellers.
    const result = await getDb().execute(
      `SELECT
         si.product_id AS product_id,
         COALESCE(p.name, 'منتج محذوف') AS name,
         SUM(si.quantity) AS quantity,
         SUM(si.total_line_price) AS revenue,
         SUM(si.total_line_price - si.cost_price * si.quantity) AS profit
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
         ON link.ret_number = s.invoice_number
       LEFT JOIN products p ON p.id = si.product_id
       WHERE ${EFFECTIVE_IN_RANGE}
       GROUP BY si.product_id, p.name
       ORDER BY revenue DESC
       LIMIT ?`,
      [start, end, Math.min(Math.max(limit, 1), 50)],
    );
    const rows = result.rows ?? [];
    return rows.map(row => ({
      productId: Number(row.product_id),
      name: String(row.name ?? ''),
      quantity: Number(row.quantity ?? 0),
      revenue: Number(row.revenue ?? 0),
      profit: Number(row.profit ?? 0),
    }));
  },

  async dailySeries(range: DateRange): Promise<DailyPoint[]> {
    const [start, end] = rangeBounds(range);
    // v30 (round-38 #3): a return nets its ORIGINAL day's bar (the
    // restated-history view) — today's bar never dips negative from
    // an old invoice's refund.
    const result = await getDb().execute(
      `SELECT
         substr(${EFFECTIVE_AT}, 1, 10) AS day,
         SUM(s.total_amount) AS revenue,
         SUM(s.total_profit) AS profit
       FROM sales s
       LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
         ON link.ret_number = s.invoice_number
       WHERE ${EFFECTIVE_IN_RANGE}
       GROUP BY day
       ORDER BY day ASC`,
      [start, end],
    );
    const byDay = new Map<string, DailyPoint>();
    for (const row of result.rows ?? []) {
      const day = String(row.day ?? '');
      byDay.set(day, {
        day,
        label: weekdayLabel(day),
        revenue: Number(row.revenue ?? 0),
        profit: Number(row.profit ?? 0),
      });
    }
    // Fill gaps so charts show continuous days.
    // v42 (الجولة 50 #3): الحارس ١٢٠ كان يقطع السلسلة عند الفترات
    //  الطويلة (مثل «الكل») فيسقط أحدث الأيام خارج الرسم — رُفع
    //  إلى ٤٠٠، والفترات الأطول من ذلك أصلاً تتحول للسلسلة
    //  الشهرية في ReportService فلا تمر من هنا إطلاقاً.
    const points: DailyPoint[] = [];
    const cursor = new Date(`${range.from}T00:00:00`);
    const last = new Date(`${range.to}T00:00:00`);
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard < 400) {
      const day = toLocalDayString(cursor);
      points.push(
        byDay.get(day) ?? {
          day,
          label: weekdayLabel(day),
          revenue: 0,
          profit: 0,
        },
      );
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
    return points;
  },

  /** v42 (الجولة 50 #3): السلسلة الشهرية — نفس محاسبة السلسلة
   *  اليومية (المرتجع يُسند لفترة فاتورته الأصلية) لكن مجمّعة
   *  شهرياً؛ تبدأ من أول شهر فيه نشاط فعلي (لا من بداية النطاق
   *  المطلق مثل 2000-01-01 في «الكل») فلا يبتلع الرسم سنوات
   *  فارغة، وتُسد فجوات الشهور بلا نشاط كي يبقى المحور متصلاً.
   *  day يحمل 'YYYY-MM' و label يحمل اسم الشهر الشامي. */
  async monthlySeries(range: DateRange): Promise<DailyPoint[]> {
    const [start, end] = rangeBounds(range);
    const result = await getDb().execute(
      `SELECT
         substr(${EFFECTIVE_AT}, 1, 7) AS month,
         SUM(s.total_amount) AS revenue,
         SUM(s.total_profit) AS profit
       FROM sales s
       LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
         ON link.ret_number = s.invoice_number
       WHERE ${EFFECTIVE_IN_RANGE}
       GROUP BY month
       ORDER BY month ASC`,
      [start, end],
    );
    const rows = result.rows ?? [];
    // لا مبيعات إطلاقاً — سلسلة فارغة (الرسم يعرض حالة الفراغ).
    if (rows.length === 0) {
      return [];
    }
    const byMonth = new Map<string, DailyPoint>();
    let firstMonth = String(rows[0].month ?? '');
    for (const row of rows) {
      const month = String(row.month ?? '');
      byMonth.set(month, {
        day: month,
        label: monthLabel(month),
        revenue: Number(row.revenue ?? 0),
        profit: Number(row.profit ?? 0),
      });
      if (month < firstMonth) {
        firstMonth = month;
      }
    }
    // البدء من أول شهر نشاط (وليس من بداية النطاق) — الشهور
    // الفارغة قبله لا معنى لها في الرسم.
    if (firstMonth < range.from.slice(0, 7)) {
      firstMonth = range.from.slice(0, 7);
    }
    const points: DailyPoint[] = [];
    const [fy, fm] = firstMonth.split('-').map(Number);
    const [ty, tm] = range.to.slice(0, 7).split('-').map(Number);
    let y = fy;
    let m = fm;
    let guard = 0;
    while ((y < ty || (y === ty && m <= tm)) && guard < 600) {
      const month = `${y}-${String(m).padStart(2, '0')}`;
      points.push(
        byMonth.get(month) ?? {
          day: month,
          label: monthLabel(month),
          revenue: 0,
          profit: 0,
        },
      );
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      guard += 1;
    }
    return points;
  },

  async hourlySeries(range: DateRange): Promise<HourlyPoint[]> {
    const [start, end] = rangeBounds(range);
    // v30 (round-38 #3): the return lands in the ORIGINAL sale's
    // hour — the hourly curve stays the original day's shape.
    const result = await getDb().execute(
      `SELECT
         CAST(substr(${EFFECTIVE_AT}, 12, 2) AS INTEGER) AS hour,
         SUM(s.total_amount) AS revenue,
         COUNT(*) AS orders
       FROM sales s
       LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
         ON link.ret_number = s.invoice_number
       WHERE ${EFFECTIVE_IN_RANGE}
       GROUP BY hour
       ORDER BY hour ASC`,
      [start, end],
    );
    const byHour = new Map<number, HourlyPoint>();
    for (const row of result.rows ?? []) {
      const hour = Number(row.hour ?? 0);
      byHour.set(hour, {
        hour,
        revenue: Number(row.revenue ?? 0),
        orders: Number(row.orders ?? 0),
      });
    }
    const points: HourlyPoint[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      points.push(byHour.get(hour) ?? {hour, revenue: 0, orders: 0});
    }
    return points;
  },

  /** v15 (round-21 #4) → v17 (round-23 #2) → v23 (round-29 #2):
   *  credit sales in the range, SPLIT BY SERIES — INV-D (صِلة) and
   *  INV-L (دفتر المتجر) — NET OF RETURNS: a RET row carrying
   *  return_kind 'sila'/'local' subtracts from its book's amount
   * IN ITS ORIGINAL INVOICE'S PERIOD (v30 round-38 #3), so a debt-invoice return never
   *  distorts the period's cash-sales math (its negative revenue
   * and its negative credit-sale cancel out). */
  async debtSalesSummary(range: DateRange): Promise<DebtSalesSummary> {
    const [start, end] = rangeBounds(range);
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(CASE WHEN s.invoice_number LIKE 'INV-D-%' THEN 1 ELSE 0 END), 0) AS sila_cnt,
           COALESCE(SUM(CASE WHEN s.invoice_number LIKE 'INV-D-%' THEN s.total_amount ELSE 0 END), 0)
             + COALESCE(SUM(CASE WHEN s.return_kind = 'sila' THEN s.total_amount ELSE 0 END), 0) AS sila_amount,
           COALESCE(SUM(CASE WHEN s.invoice_number LIKE 'INV-L-%' THEN 1 ELSE 0 END), 0) AS local_cnt,
           COALESCE(SUM(CASE WHEN s.invoice_number LIKE 'INV-L-%' THEN s.total_amount ELSE 0 END), 0)
             + COALESCE(SUM(CASE WHEN s.return_kind = 'local' THEN s.total_amount ELSE 0 END), 0) AS local_amount
         FROM sales s
         LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
           ON link.ret_number = s.invoice_number
         WHERE ${EFFECTIVE_IN_RANGE}
           AND (s.invoice_number LIKE 'INV-D-%'
             OR s.invoice_number LIKE 'INV-L-%'
             OR s.return_kind IS NOT NULL)`,
        [start, end],
      );
      const row = (result.rows?.[0] ?? {}) as {
        sila_cnt?: number | null;
        sila_amount?: number | null;
        local_cnt?: number | null;
        local_amount?: number | null;
      };
      const silaCount = Number(row.sila_cnt ?? 0);
      const localCount = Number(row.local_cnt ?? 0);
      const silaAmount = Number(row.sila_amount ?? 0);
      const localAmount = Number(row.local_amount ?? 0);
      return {
        count: silaCount + localCount,
        amount: silaAmount + localAmount,
        silaCount,
        silaAmount,
        localCount,
        localAmount,
      };
    } catch {
      return {
        count: 0,
        amount: 0,
        silaCount: 0,
        silaAmount: 0,
        localCount: 0,
        localAmount: 0,
      };
    }
  },

  /** v20 (SILA_POS_VOUCHERS_API §2): the VOUCHER sales series
   *  (INV-V-…) in a range — the goods part of voucher redemptions
   *  lives in the sales table like every sale (revenue, top
   *  products, daily series all count it), while the CLAIM on the
   *  institution is mirrored in campaign_debts from the server.
   *  The cash card subtracts these totals from «المبيعات النقدية»
   *  because no counter cash entered for them at sale time (only
   *  the counter-extra part did) — the money arrives with the
   *  campaign settlements instead. */
  async voucherSalesSummary(
    range: DateRange,
  ): Promise<{count: number; goodsAmount: number}> {
    const [start, end] = rangeBounds(range);
    try {
      const result = await getDb().execute(
        `SELECT
           COUNT(*) AS cnt,
           COALESCE(SUM(total_amount), 0) AS goods_amount
         FROM sales
         WHERE created_at >= ? AND created_at <= ?
           AND invoice_number LIKE 'INV-V-%'`,
        [start, end],
      );
      const row = (result.rows?.[0] ?? {}) as {
        cnt?: number | null;
        goods_amount?: number | null;
      };
      return {
        count: Number(row.cnt ?? 0),
        goodsAmount: Number(row.goods_amount ?? 0),
      };
    } catch {
      return {count: 0, goodsAmount: 0};
    }
  },

  /** Detailed sale rows used by the CSV / XLS exporters.
   *  v23 (round-29 #2): RET rows are included (negative) and
   *  labelled «مرتجع». */
  async salesDetail(range: DateRange): Promise<
    {
      invoice: string;
      createdAt: string;
      itemsCount: number;
      quantity: number;
      total: number;
      cost: number;
      profit: number;
      discount: number;
      paymentType: string;
    }[]
  > {
    const [start, end] = rangeBounds(range);
    const result = await getDb().execute(
      `SELECT
         s.invoice_number AS invoice,
         s.created_at AS created_at,
         (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count,
         (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) AS quantity,
         s.total_amount AS total,
         s.total_cost AS cost,
         s.total_profit AS profit,
         s.discount AS discount,
         s.payment_type AS payment_type,
         s.return_kind AS return_kind
       FROM sales s
       LEFT JOIN (${RETURN_ORIGINAL_LINK}) link
         ON link.ret_number = s.invoice_number
       WHERE ${EFFECTIVE_IN_RANGE}
       ORDER BY s.created_at ASC`,
      [start, end],
    );
    const rows = result.rows ?? [];
    return rows.map(row => ({
      invoice: String(row.invoice ?? ''),
      createdAt: String(row.created_at ?? ''),
      itemsCount: Number(row.items_count ?? 0),
      quantity: Number(row.quantity ?? 0),
      total: Number(row.total ?? 0),
      cost: Number(row.cost ?? 0),
      profit: Number(row.profit ?? 0),
      discount: Number(row.discount ?? 0),
      paymentType:
        row.return_kind != null
          ? 'مرتجع'
          : String(row.payment_type ?? 'RETAIL') === 'WHOLESALE'
          ? 'جملة'
          : 'مفرق',
    }));
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};

function toLocalDayString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

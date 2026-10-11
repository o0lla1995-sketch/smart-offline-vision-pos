/**
 * sila/SilaRepo — local persistence for the SILA debt queue, the
 *  v15 repayments queue and the customers balance cache
 *  (SILA_POS_API §7 + SILA_POS_DEBT_SEPARATION §3.1).
 * ─────────────────────────────────────────────────────────────────
 * Rules enforced here (§7 «قواعد صارمة"):
 *  - the debt row is created AT SALE TIME with ONE idempotency_key
 *    that never changes — retries replay the same key;
 *  - pos_invoice_ref is UNIQUE — one invoice = one debt;
 *  - v15: the SAME discipline for repayments — one row per receipt
 *    (pos_receipt_ref UNIQUE + one idempotency_key forever);
 *  - failed rows keep their error code for the merchant screen.
 */
import {getDb, toMessage} from '../../database/connection';
import {logDiag} from '../../core/diagnostics';
import {localToday} from '../../core/format';
import {
  getNumber,
  setNumber,
  getString,
  setString,
  KEYS,
} from '../../storage/storage';
import type {SilaDebtRow, SilaCustomer, SilaPaymentRow} from '../../core/types';

function rowToDebt(row: Record<string, unknown>): SilaDebtRow {
  return {
    local_id: Number(row.local_id ?? 0),
    idempotency_key: String(row.idempotency_key ?? ''),
    customer_id: (row.customer_id as string) ?? null,
    customer_name: (row.customer_name as string) ?? null,
    customer_phone_last4: (row.customer_phone_last4 as string) ?? null,
    customer_card: (row.customer_card as string) ?? null,
    offline_qr: (row.offline_qr as string) ?? null,
    amount_minor: Number(row.amount_minor ?? 0),
    currency: String(row.currency ?? 'ILS'),
    pos_invoice_ref: String(row.pos_invoice_ref ?? ''),
    description: (row.description as string) ?? null,
    scanned_at: String(row.scanned_at ?? ''),
    state: (row.state as SilaDebtRow['state']) ?? 'pending',
    reference_code: (row.reference_code as string) ?? null,
    transaction_id: (row.transaction_id as string) ?? null,
    outstanding_after:
      row.outstanding_after == null ? null : Number(row.outstanding_after),
    credit_covered_minor: Number(row.credit_covered_minor ?? 0),
    synced_at: (row.synced_at as string) ?? null,
    error_code: (row.error_code as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    created_at: String(row.created_at ?? ''),
  };
}

function rowToCustomer(row: Record<string, unknown>): SilaCustomer {
  return {
    customer_id: String(row.customer_id ?? ''),
    name: String(row.name ?? ''),
    phone_last4: (row.phone_last4 as string) ?? null,
    id_number: (row.id_number as string) ?? null,
    credit_minor: Number(row.credit_minor ?? 0),
    outstanding_minor: Number(row.outstanding_minor ?? 0),
    pos_outstanding_minor: Number(row.pos_outstanding_minor ?? 0),
    app_outstanding_minor: Number(row.app_outstanding_minor ?? 0),
    other_minor: Number(row.other_minor ?? 0),
    pos_purchases_minor: Number(row.pos_purchases_minor ?? 0),
    app_purchases_minor: Number(row.app_purchases_minor ?? 0),
    device_outstanding_minor: Number(row.device_outstanding_minor ?? 0),
    device_purchases_minor: Number(row.device_purchases_minor ?? 0),
    device_payments_minor: Number(row.device_payments_minor ?? 0),
    last_payment_at: (row.last_payment_at as string) ?? null,
    last_payment_amount_minor:
      row.last_payment_amount_minor == null
        ? null
        : Number(row.last_payment_amount_minor),
    last_synced_at: (row.last_synced_at as string) ?? null,
  };
}

function rowToPayment(row: Record<string, unknown>): SilaPaymentRow {
  return {
    local_id: Number(row.local_id ?? 0),
    idempotency_key: String(row.idempotency_key ?? ''),
    customer_id: (row.customer_id as string) ?? null,
    customer_name: (row.customer_name as string) ?? null,
    customer_phone_last4: (row.customer_phone_last4 as string) ?? null,
    amount_minor: Number(row.amount_minor ?? 0),
    payment_method: String(row.payment_method ?? 'cash'),
    pos_receipt_ref: String(row.pos_receipt_ref ?? ''),
    description: (row.description as string) ?? null,
    paid_at: String(row.paid_at ?? ''),
    state: (row.state as SilaPaymentRow['state']) ?? 'pending',
    kind: (row.kind as SilaPaymentRow['kind']) ?? 'repayment',
    reference_code: (row.reference_code as string) ?? null,
    transaction_id: (row.transaction_id as string) ?? null,
    outstanding_after:
      row.outstanding_after == null ? null : Number(row.outstanding_after),
    synced_at: (row.synced_at as string) ?? null,
    error_code: (row.error_code as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    created_at: String(row.created_at ?? ''),
  };
}

export interface EnqueueDebtInput {
  idempotencyKey: string;
  customerId: string | null;
  customerName: string | null;
  customerPhoneLast4: string | null;
  customerCard: string | null;
  offlineQr: string | null;
  amountMinor: number;
  posInvoiceRef: string;
  description: string;
  scannedAt: string;
  /** v17 (round-23 #3): the part of amountMinor the customer's
   *  prepaid credit is expected to absorb (min(amount, cached
   *  credit)). The FULL amount still uploads — the server consumes
   *  the credit itself — but the store's books already know the
   *  invoice is partially/fully PAID, not pure debt. */
  creditCoveredMinor?: number;
}

export interface EnqueuePaymentInput {
  idempotencyKey: string;
  customerId: string | null;
  customerName: string | null;
  customerPhoneLast4: string | null;
  amountMinor: number;
  paymentMethod: string;
  posReceiptRef: string;
  description: string;
  paidAt: string;
  /** v23 (round-29 #2): 'return_reversal' marks the reverse
   *  operation for a returned debt invoice (excluded from the
   *  collections statistics). */
  kind?: 'repayment' | 'return_reversal';
}

/** v35 (الجولة 43): تشذيب التحصيلات الوهمية (المطابقة الهابطة).
 *  ─────────────────────────────────────────────────────────────────
 *  دفاتر المتجر تدّعي من التحصيلات أكثر مما يعرفه خادم صِلة عن
 *  ديون هذه النقطة (device_purchases − device_outstanding) → الفارق
 *  تحصيل مسجَّل بلا برهان — غالباً من عصر مطابقة أرقام POS الشاملة
 *  التي كانت تجمع سدادّات وتحصيلات متاجر التاجر الأخرى فتأكل
 *  فواتير هذا المتجر (شكوى «فاتورة 20₪ سُجّل منها 5 دين فقط»).
 *
 *  التشذيب يحذف الفارق من أحدث صفوف sila_app_collections (الوهمي
 *  دائماً الأحدث — دفعات عصر POS الكبيرة)، ويقصّ الصف الحدودي جزئياً
 *  إن لزم، ثم يمتص المبلغ في أساس المطابقة (reconcile_offset_minor)
 *  حتى لا يعيد المحرك الصاعد تسجيله في التمريرة التالية — نفس
 *  انضباط حذف التاجر اليدوي (deleteAppCollection) تماماً.
 *
 *  لا يمس سدادّات الكاشير ولا تغطية الرصيد إطلاقاً — نقدٌ استلمه
 *  التاجر بيده لا يُحذف بقرار محرك. يُرجع المبلغ المشذَّب فعلياً. */
async function trimOverRecordedCollections(
  customerId: string,
  customerName: string,
  excessMinor: number,
): Promise<number> {
  const db = getDb();
  let remaining = Math.round(excessMinor);
  if (remaining <= 0) {
    return 0;
  }
  const rows = await db.execute(
    `SELECT local_id, amount_minor FROM sila_app_collections
      WHERE customer_id = ?
      ORDER BY local_id DESC`,
    [customerId],
  );
  let trimmedTotal = 0;
  for (const raw of rows.rows ?? []) {
    if (remaining <= 0) {
      break;
    }
    const hit = raw as {local_id?: number; amount_minor?: number};
    const localId = Number(hit.local_id ?? 0);
    const amount = Math.round(Number(hit.amount_minor ?? 0));
    if (amount <= 0) {
      continue;
    }
    if (amount <= remaining) {
      await db.execute(
        'DELETE FROM sila_app_collections WHERE local_id = ?',
        [localId],
      );
      trimmedTotal += amount;
      remaining -= amount;
    } else {
      await db.execute(
        'UPDATE sila_app_collections SET amount_minor = ? WHERE local_id = ?',
        [amount - remaining, localId],
      );
      trimmedTotal += remaining;
      remaining = 0;
    }
  }
  if (trimmedTotal > 0) {
    // امتصاص المشذَّب في الأساس (زيادةً كما الحذف اليدوي) — إيديموتية
    //  القرار: بدونها يقفز «غير المسجل» بمقدار المشذَّب في التمريرة
    //  التالية فيعيد المحرك تسجيله ولا تستقر الدفاتر أبداً.
    await db.execute(
      `UPDATE sila_customers
         SET reconcile_offset_minor = reconcile_offset_minor + ?
       WHERE customer_id = ?`,
      [trimmedTotal, customerId],
    );
    logDiag(
      'sila',
      `شُذِّبت تحصيلات وهمية لـ ${customerName}: ${(
        trimmedTotal / 100
      ).toFixed(2)}₪ — لا يعرفها خادم صِلة لديون هذه النقطة`,
      'warn',
    );
  }
  return trimmedTotal;
}

export const SilaRepo = {
  /** Creates the queue row at sale time (§7 rule 1). */
  async enqueue(input: EnqueueDebtInput): Promise<SilaDebtRow> {
    const db = getDb();
    await db.execute(
      `INSERT INTO sila_debt_queue (
        idempotency_key, customer_id, customer_name, customer_phone_last4,
        customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
        description, scanned_at, credit_covered_minor, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ILS', ?, ?, ?, ?, 'pending')`,
      [
        input.idempotencyKey,
        input.customerId,
        input.customerName,
        input.customerPhoneLast4,
        input.customerCard,
        input.offlineQr,
        input.amountMinor,
        input.posInvoiceRef,
        input.description,
        input.scannedAt,
        Math.max(0, Math.min(input.creditCoveredMinor ?? 0, input.amountMinor)),
      ],
    );
    const row = await db.execute(
      'SELECT * FROM sila_debt_queue WHERE idempotency_key = ?',
      [input.idempotencyKey],
    );
    logDiag(
      'sila',
      `أُضيف دين للطابور: ${input.posInvoiceRef} — ${
        input.customerName ?? 'زبون'
      }`,
    );
    return rowToDebt(row.rows?.[0] ?? {});
  },

  /** Oldest-first pending batch (≤ 100, §6.2). */
  async pendingBatch(limit = 100): Promise<SilaDebtRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM sila_debt_queue WHERE state = 'pending'
       ORDER BY created_at ASC, local_id ASC LIMIT ?`,
      [limit],
    );
    return (result.rows ?? []).map(row =>
      rowToDebt(row as Record<string, unknown>),
    );
  },

  async markSyncing(localIds: number[]): Promise<void> {
    if (localIds.length === 0) {
      return;
    }
    const db = getDb();
    for (const id of localIds) {
      await db.execute(
        "UPDATE sila_debt_queue SET state = 'syncing' WHERE local_id = ?",
        [id],
      );
    }
  },

  async markSynced(
    localId: number,
    patch: {
      referenceCode: string;
      transactionId: string;
      outstandingAfter: number;
      /** v17 (round-23 #3): the server's EXACT credit_consumed_minor
       *  for this debt (when it answers one) — reconciles the local
       *  estimate so the books match صِلة to the agora. */
      creditCovered?: number | null;
    },
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'synced', reference_code = ?, transaction_id = ?,
           outstanding_after = ?,
           credit_covered_minor = COALESCE(?, credit_covered_minor),
           synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           error_code = NULL, error_message = NULL
       WHERE local_id = ?`,
      [
        patch.referenceCode,
        patch.transactionId,
        patch.outstandingAfter,
        patch.creditCovered ?? null,
        localId,
      ],
    );
  },

  async markFailed(
    localId: number,
    code: string,
    message: string,
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'failed', error_code = ?, error_message = ?
       WHERE local_id = ?`,
      [code, message, localId],
    );
  },

  /** Transient failure — back to pending with the retry count. */
  async markRetry(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'pending', retry_count = retry_count + 1
       WHERE local_id = ?`,
      [localId],
    );
  },

  /** §8: rows stuck in 'syncing' (crash mid-batch) return to pending. */
  async recoverStuck(minutes = 10): Promise<number> {
    const db = getDb();
    const result = await db.execute(
      `SELECT local_id FROM sila_debt_queue WHERE state = 'syncing'
         AND datetime(created_at, '+' || ? || ' minutes') < datetime('now')`,
      [minutes],
    );
    const ids = (result.rows ?? []).map(row =>
      Number((row as {local_id?: number}).local_id ?? 0),
    );
    for (const id of ids) {
      await db.execute(
        "UPDATE sila_debt_queue SET state = 'pending' WHERE local_id = ?",
        [id],
      );
    }
    return ids.length;
  },

  /** Manually requeue a failed row (merchant fixed the cause). */
  async requeue(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'pending', error_code = NULL, error_message = NULL,
           retry_count = 0
       WHERE local_id = ?`,
      [localId],
    );
  },

  async counts(): Promise<{
    pending: number;
    failed: number;
    synced: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN state = 'synced' THEN 1 ELSE 0 END) AS synced
         FROM sila_debt_queue`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        pending?: number | null;
        failed?: number | null;
        synced?: number | null;
      };
      return {
        pending: row.pending ?? 0,
        failed: row.failed ?? 0,
        synced: row.synced ?? 0,
      };
    } catch (error) {
      logDiag('sila', `تعذر عدّ طابور الديون: ${toMessage(error)}`, 'warn');
      return {pending: 0, failed: 0, synced: 0};
    }
  },

  /** Recent rows for the merchant's debt panel (newest first).
   *  v19 (round-25 #5): paged (limit + offset) + optional state
   *  filter + optional search (invoice ref / customer name) — the
   *  redesigned صِلة debts tab searches and pages through hundreds
   *  of invoices instead of one flat wall. */
  async recent(
    limit = 60,
    offset = 0,
    stateFilter?: SilaDebtRow['state'],
    search?: string,
  ): Promise<SilaDebtRow[]> {
    const clauses: string[] = [];
    // v45 (round-53): op-sqlite 11 types execute() params as Scalar[]
    const args: (string | number | boolean | null)[] = [];
    if (stateFilter) {
      clauses.push('state = ?');
      args.push(stateFilter);
    }
    const q = search?.trim() ?? '';
    if (q.length > 0) {
      clauses.push('(pos_invoice_ref LIKE ? OR customer_name LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await getDb().execute(
      `SELECT * FROM sila_debt_queue ${where}
       ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                local_id DESC
       LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    return (result.rows ?? []).map(row =>
      rowToDebt(row as Record<string, unknown>),
    );
  },

  /** v19 (round-25 #5): row count for the paged debts tab — same
   *  filters as recent() so «عرض المزيد» knows when to stop. */
  async debtQueueCount(
    stateFilter?: SilaDebtRow['state'],
    search?: string,
  ): Promise<number> {
    try {
      const clauses: string[] = [];
      // v45 (round-53): op-sqlite 11 types execute() params as Scalar[]
      const args: (string | number | boolean | null)[] = [];
      if (stateFilter) {
        clauses.push('state = ?');
        args.push(stateFilter);
      }
      const q = search?.trim() ?? '';
      if (q.length > 0) {
        clauses.push('(pos_invoice_ref LIKE ? OR customer_name LIKE ?)');
        args.push(`%${q}%`, `%${q}%`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt FROM sila_debt_queue ${where}`,
        args,
      );
      const row = (result.rows?.[0] ?? {}) as {cnt?: number};
      return Number(row.cnt ?? 0);
    } catch {
      return 0;
    }
  },

  async byInvoiceRef(invoiceRef: string): Promise<SilaDebtRow | null> {
    const result = await getDb().execute(
      'SELECT * FROM sila_debt_queue WHERE pos_invoice_ref = ? LIMIT 1',
      [invoiceRef],
    );
    const row = result.rows?.[0];
    return row ? rowToDebt(row as Record<string, unknown>) : null;
  },

  /**
   * v16 (round-22 #1): renumber a debt whose upload collided
   * server-side (DUPLICATE_INVOICE_REF — the server never forgets a
   * pos_invoice_ref, and a fresh install restarts the numbering).
   * The queue row AND the sale row move to the fresh number together
   * so the receipt, the invoices center and the upload all agree.
   */
  async renumberDebtInvoice(oldRef: string, newRef: string): Promise<boolean> {
    if (oldRef === newRef || oldRef.length === 0 || newRef.length === 0) {
      return false;
    }
    const db = getDb();
    try {
      await db.transaction(async tx => {
        await tx.execute(
          `UPDATE sila_debt_queue
           SET pos_invoice_ref = ?, state = 'pending', retry_count = 0
           WHERE pos_invoice_ref = ?`,
          [newRef, oldRef],
        );
        await tx.execute(
          'UPDATE sales SET invoice_number = ? WHERE invoice_number = ?',
          [newRef, oldRef],
        );
      });
      logDiag(
        'sila',
        `أُعيد ترقيم الدين ${oldRef} ← ${newRef} (الرقم السابق محجوز في صِلة)`,
      );
      return true;
    } catch (error) {
      logDiag(
        'sila',
        `فشل إعادة ترقيم الدين ${oldRef}: ${toMessage(error)}`,
        'warn',
      );
      return false;
    }
  },

  /**
   * v16 (round-22 #1): the receipts twin of renumberDebtInvoice —
   * a cashier payment whose upload collided (DUPLICATE_RECEIPT_REF
   * after a reinstall restarted RCP numbering) moves to a fresh
   * receipt number and returns to the queue.
   */
  async renumberPaymentReceipt(
    oldRef: string,
    newRef: string,
  ): Promise<boolean> {
    if (oldRef === newRef || oldRef.length === 0 || newRef.length === 0) {
      return false;
    }
    const db = getDb();
    try {
      await db.execute(
        `UPDATE sila_payment_queue
         SET pos_receipt_ref = ?, state = 'pending', retry_count = 0
         WHERE pos_receipt_ref = ?`,
        [newRef, oldRef],
      );
      logDiag('sila', `أُعيد ترقيم إيصال السداد ${oldRef} ← ${newRef}`);
      return true;
    } catch (error) {
      logDiag(
        'sila',
        `فشل إعادة ترقيم الإيصال ${oldRef}: ${toMessage(error)}`,
        'warn',
      );
      return false;
    }
  },

  /** All invoice numbers that carry a SILA debt — used to badge the
   *  invoices center rows (one query, no per-row lookups). */
  async allDebtInvoiceRefs(): Promise<Set<string>> {
    try {
      const result = await getDb().execute(
        'SELECT pos_invoice_ref FROM sila_debt_queue',
      );
      const refs = new Set<string>();
      for (const row of result.rows ?? []) {
        const ref = String(
          (row as {pos_invoice_ref?: string}).pos_invoice_ref ?? '',
        );
        if (ref.length > 0) {
          refs.add(ref);
        }
      }
      return refs;
    } catch {
      return new Set();
    }
  },

  /** v20: the debt invoices whose prepaid credit (partly) covered
   *  them — the invoices center badges these «رصيد» so a
   *  DEBT+PREPAID invoice is never mistaken for a pure debt. */
  async prepaidCoveredInvoiceRefs(): Promise<Set<string>> {
    try {
      const result = await getDb().execute(
        'SELECT pos_invoice_ref FROM sila_debt_queue WHERE credit_covered_minor > 0',
      );
      const refs = new Set<string>();
      for (const row of result.rows ?? []) {
        const ref = String(
          (row as {pos_invoice_ref?: string}).pos_invoice_ref ?? '',
        );
        if (ref.length > 0) {
          refs.add(ref);
        }
      }
      return refs;
    } catch {
      return new Set();
    }
  },

  /** v12 (round-18 #4): aggregates for the Home debts report —
   *  total outstanding debt (every state: the goods left the store
   *  on credit regardless of sync state), the unsynced portion,
   *  and today's debt so the treasury number can exclude it. */
  async totals(): Promise<{
    allMinor: number;
    allCount: number;
    pendingMinor: number;
    pendingCount: number;
    todayMinor: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(amount_minor), 0) AS all_minor,
           COUNT(*) AS all_count,
           COALESCE(SUM(CASE WHEN state IN ('pending','syncing') THEN amount_minor ELSE 0 END), 0) AS pending_minor,
           SUM(CASE WHEN state IN ('pending','syncing') THEN 1 ELSE 0 END) AS pending_count,
           COALESCE(SUM(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN amount_minor ELSE 0 END), 0) AS today_minor
         FROM sila_debt_queue`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        all_minor?: number | null;
        all_count?: number | null;
        pending_minor?: number | null;
        pending_count?: number | null;
        today_minor?: number | null;
      };
      return {
        allMinor: Number(row.all_minor ?? 0),
        allCount: Number(row.all_count ?? 0),
        pendingMinor: Number(row.pending_minor ?? 0),
        pendingCount: Number(row.pending_count ?? 0),
        todayMinor: Number(row.today_minor ?? 0),
      };
    } catch (error) {
      logDiag('sila', `تعذر جمع ملخص الديون: ${toMessage(error)}`, 'warn');
      return {
        allMinor: 0,
        allCount: 0,
        pendingMinor: 0,
        pendingCount: 0,
        todayMinor: 0,
      };
    }
  },

  /** v12 (round-18 #1): one-time repair — v11 sent explicit nulls in
   *  debt records so the server answered VALIDATION_ERROR and rows
   *  bounced pending↔retry forever. With the null-free builder this
   *  error cannot recur, so any row still sitting in 'failed' with
   *  that code is requeued and will sync on the next cycle. */
  async requeueFailedValidation(): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT local_id FROM sila_debt_queue
         WHERE state = 'failed' AND error_code = 'VALIDATION_ERROR'`,
      );
      const ids = (result.rows ?? []).map(row =>
        Number((row as {local_id?: number}).local_id ?? 0),
      );
      for (const id of ids) {
        await getDb().execute(
          `UPDATE sila_debt_queue
           SET state = 'pending', error_code = NULL, error_message = NULL,
               retry_count = 0
           WHERE local_id = ?`,
          [id],
        );
      }
      if (ids.length > 0) {
        logDiag(
          'sila',
          `أُعيدت ${ids.length} دين فاشل (خطأ تحقق قديم) إلى طابور المزامنة`,
        );
      }
      return ids.length;
    } catch {
      return 0;
    }
  },

  /** v15 (round-21 #3): ORIGIN-SPLIT server totals (§2.4/§3.3) —
   *  the store's own outstanding debts (pos), the Sila-app portion
   *  (app, informational only — NOT the store's revenue) and manual
   *  adjustments. What the Home dashboard and reports consume; the
   *  mixed `outstanding_minor` alone is no longer used for store
   *  statistics (that mixing was the «تداخل» complaint). */
  async customersOutstandingTotal(): Promise<{
    totalMinor: number;
    posTotalMinor: number;
    appTotalMinor: number;
    otherTotalMinor: number;
    /** v33 (round-41 #11 — 0075): إجمالي ديون هذه النقطة تحديداً
     *  على الخادم (مجموع device_outstanding لكل الزبائن). */
    deviceTotalMinor: number;
    debtorsCount: number;
    lastSyncedAt: string | null;
  }> {
    try {
      // v27 (round-35 #1): the debtors KPI counts STORE debtors only
      // (pos_outstanding_minor > 0) — the same number the customers
      // page shows («في صفحة الزبائن لا ديون لأي زبون» while the KPI
      // said «زبون مدين لك»). The mixed outstanding_minor includes
      // debts the customer made INSIDE the Sila app itself — they are
      // not owed to this store and never enter its books.
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(outstanding_minor), 0) AS total_minor,
           COALESCE(SUM(pos_outstanding_minor), 0) AS pos_minor,
           COALESCE(SUM(app_outstanding_minor), 0) AS app_minor,
           COALESCE(SUM(other_minor), 0) AS other_minor,
           COALESCE(SUM(device_outstanding_minor), 0) AS device_minor,
           COALESCE(SUM(CASE WHEN pos_outstanding_minor > 0 THEN 1 ELSE 0 END), 0) AS debtors,
           MAX(last_synced_at) AS last_sync
         FROM sila_customers`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        total_minor?: number | null;
        pos_minor?: number | null;
        app_minor?: number | null;
        other_minor?: number | null;
        device_minor?: number | null;
        debtors?: number | null;
        last_sync?: string | null;
      };
      return {
        totalMinor: Number(row.total_minor ?? 0),
        posTotalMinor: Number(row.pos_minor ?? 0),
        appTotalMinor: Number(row.app_minor ?? 0),
        otherTotalMinor: Number(row.other_minor ?? 0),
        deviceTotalMinor: Number(row.device_minor ?? 0),
        debtorsCount: Number(row.debtors ?? 0),
        lastSyncedAt: row.last_sync ?? null,
      };
    } catch (error) {
      logDiag('sila', `تعذر جمع أرصدة الزبائن: ${toMessage(error)}`, 'warn');
      return {
        totalMinor: 0,
        posTotalMinor: 0,
        appTotalMinor: 0,
        otherTotalMinor: 0,
        deviceTotalMinor: 0,
        debtorsCount: 0,
        lastSyncedAt: null,
      };
    }
  },

  /** v32 (round-40 #6): دين هذا المتجر تحديداً لكل زبون — من
   *  الدفاتر المحلية، لا من أرصدة الخادم: فواتير الدين التي أصدرها
   *  هذا المتجر (طابور الديون كاملاً بكل حالاته) مطروح منها ما
   *  غطّاه الرصيد المسبق، وسدادّات الكاشير هنا، والعمليات العكسية
   *  لمرتجعات ديون صِلة، وتحصيلات تطبيق صِلة على ديون المتجر.
   *  هذا هو «دين المتجر نفسه» الذي طلبه التاجر مميّزاً عن أرصدة
   *  الخادم التي قد تجمع فواتير كل المتاجر المرتبطة بنفس التاجر.
   *
   *  v34 (الجولة 42 #2): حدّ أدنى صفر لكل زبون — أي فائض سدادّ/
   *  تحصيل فوق دين المتجر (كتحصيل تطبيق على ديون متجر آخر كان
   *  يُسجّل قبل فصل المطابقة الجهازية) لا ينقلب ديناً سالباً يخصم
   *  بصمت من إجمالي الدين القائم للغير؛ الفائض يبقى في محفظة
   *  الزبون لدى تطبيق صِلة نفسه (رصيد تطبيق صلة لا يمس دفاتر
   *  المتجر) ولا يدخل كتب المتجر مطلقاً. */
  async storeOwnOutstandingByCustomer(): Promise<Map<string, number>> {
    try {
      const result = await getDb().execute(
        `SELECT customer_id, MAX(0, SUM(delta)) AS own_minor FROM (
           SELECT customer_id,
                  SUM(amount_minor - COALESCE(credit_covered_minor, 0)) AS delta
             FROM sila_debt_queue
            WHERE customer_id IS NOT NULL
            GROUP BY customer_id
           UNION ALL
           SELECT customer_id, -SUM(amount_minor) AS delta
             FROM sila_payment_queue
            WHERE customer_id IS NOT NULL
            GROUP BY customer_id
           UNION ALL
           SELECT customer_id, -SUM(amount_minor) AS delta
             FROM sila_app_collections
            GROUP BY customer_id
         )
         GROUP BY customer_id`,
      );
      const map = new Map<string, number>();
      for (const row of result.rows ?? []) {
        const r = row as {customer_id?: string; own_minor?: number | null};
        if (r.customer_id != null && String(r.customer_id).length > 0) {
          map.set(String(r.customer_id), Math.round(Number(r.own_minor ?? 0)));
        }
      }
      return map;
    } catch (error) {
      logDiag(
        'sila',
        `تعذر حساب ديون المتجر لكل زبون: ${toMessage(error)}`,
        'warn',
      );
      return new Map();
    }
  },

  /** v32 (round-40 #6): إجمالي دين هذا المتجر + عدد المدينين له —
   *  من الدفاتر المحلية (نفس معادلة storeOwnOutstandingByCustomer).
   *  هذا هو الرقم الذي تقوده إحصائيات الرئيسية والتقارير ونظرة
   *  عامة، بدل أرصدة الخادم المختلطة بمتاجر التاجر الأخرى.
   *  v34 (الجولة 42 #2): حدّ أدنى صفر لكل زبون قبل الجمع — لا
   *  يُخصم سالب أحد الزبائن من ديون بقية الزبائن أبداً. */
  async storeOwnOutstandingTotal(): Promise<{
    ownMinor: number;
    debtorsCount: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(MAX(own, 0)), 0) AS total_minor,
                COALESCE(SUM(CASE WHEN own > 0 THEN 1 ELSE 0 END), 0) AS debtors
         FROM (
           SELECT customer_id, SUM(delta) AS own FROM (
             SELECT customer_id,
                    SUM(amount_minor - COALESCE(credit_covered_minor, 0)) AS delta
               FROM sila_debt_queue
              WHERE customer_id IS NOT NULL
              GROUP BY customer_id
             UNION ALL
             SELECT customer_id, -SUM(amount_minor) AS delta
               FROM sila_payment_queue
              WHERE customer_id IS NOT NULL
              GROUP BY customer_id
             UNION ALL
             SELECT customer_id, -SUM(amount_minor) AS delta
               FROM sila_app_collections
              GROUP BY customer_id
           )
           GROUP BY customer_id
         )`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        total_minor?: number | null;
        debtors?: number | null;
      };
      return {
        ownMinor: Math.round(Number(row.total_minor ?? 0)),
        debtorsCount: Number(row.debtors ?? 0),
      };
    } catch (error) {
      logDiag(
        'sila',
        `تعذر حساب إجمالي ديون المتجر: ${toMessage(error)}`,
        'warn',
      );
      return {ownMinor: 0, debtorsCount: 0};
    }
  },

  /** v36 (0078): ديون هذا المتجر التي لم تصل الخادم بعد — فواتير دين
   *  للزبون ما تزال في الطابور (pending/syncing). سقف سداد الكاشير
   *  في التطبيق يضيفها إلى حد الخادم (device_outstanding) لأن الخادم
   *  لا يعرفها بعد، ولولا هذا الخادم لرفض الإيصال (0078 §3.5) رغم
   *  أن الدفاتر المحلية تعرف الدين — فتنتظر المزامنة ويُقبل لاحقاً
   *  من تلقاء نفسه. */
  async pendingUnsyncedOwnDebtMinor(
    customerId: string,
  ): Promise<number> {
    if (!customerId || customerId.length === 0) {
      return 0;
    }
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(amount_minor - COALESCE(credit_covered_minor, 0)), 0) AS minor
           FROM sila_debt_queue
          WHERE customer_id = ?
            AND state IN ('pending','syncing')`,
        [customerId],
      );
      const row = (result.rows?.[0] ?? {}) as {minor?: number | null};
      return Math.max(0, Number(row.minor ?? 0));
    } catch {
      return 0;
    }
  },

  // ── v15 (round-21 #3): repayments queue (§3.1 sila_payment_uploads) ──

  /** Creates a payment row at collection time — ONE idempotency key
   *  per receipt, forever (§3 golden rule 3).
   *  v23 (round-29 #2): kind — 'repayment' (the default, counts in
   *  collections) vs 'return_reversal' (the reverse operation for a
   *  returned debt invoice — uploads identically, excluded from
   *  every collections statistic). */
  async enqueuePayment(input: EnqueuePaymentInput): Promise<SilaPaymentRow> {
    const db = getDb();
    await db.execute(
      `INSERT INTO sila_payment_queue (
        idempotency_key, customer_id, customer_name, customer_phone_last4,
        amount_minor, payment_method, pos_receipt_ref, description,
        paid_at, state, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        input.idempotencyKey,
        input.customerId,
        input.customerName,
        input.customerPhoneLast4,
        input.amountMinor,
        input.paymentMethod,
        input.posReceiptRef,
        input.description,
        input.paidAt,
        input.kind ?? 'repayment',
      ],
    );
    const row = await db.execute(
      'SELECT * FROM sila_payment_queue WHERE idempotency_key = ?',
      [input.idempotencyKey],
    );
    logDiag(
      'sila',
      `أُضيف سداد للطابور: ${input.posReceiptRef} — ${
        input.customerName ?? 'زبون'
      }`,
    );
    return rowToPayment(row.rows?.[0] ?? {});
  },

  async pendingPaymentBatch(limit = 100): Promise<SilaPaymentRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM sila_payment_queue WHERE state = 'pending'
       ORDER BY created_at ASC, local_id ASC LIMIT ?`,
      [limit],
    );
    return (result.rows ?? []).map(row =>
      rowToPayment(row as Record<string, unknown>),
    );
  },

  async markPaymentSyncing(localIds: number[]): Promise<void> {
    if (localIds.length === 0) {
      return;
    }
    const db = getDb();
    for (const id of localIds) {
      await db.execute(
        "UPDATE sila_payment_queue SET state = 'syncing' WHERE local_id = ?",
        [id],
      );
    }
  },

  async markPaymentSynced(
    localId: number,
    patch: {
      referenceCode: string;
      transactionId: string;
      outstandingAfter: number;
    },
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
       SET state = 'synced', reference_code = ?, transaction_id = ?,
           outstanding_after = ?, synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           error_code = NULL, error_message = NULL
       WHERE local_id = ?`,
      [
        patch.referenceCode,
        patch.transactionId,
        patch.outstandingAfter,
        localId,
      ],
    );
  },

  async markPaymentFailed(
    localId: number,
    code: string,
    message: string,
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
       SET state = 'failed', error_code = ?, error_message = ?
       WHERE local_id = ?`,
      [code, message, localId],
    );
  },

  async markPaymentRetry(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
       SET state = 'pending', retry_count = retry_count + 1
       WHERE local_id = ?`,
      [localId],
    );
  },

  async requeuePayment(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
       SET state = 'pending', error_code = NULL, error_message = NULL,
           retry_count = 0
       WHERE local_id = ?`,
      [localId],
    );
  },

  async recoverStuckPayments(minutes = 10): Promise<number> {
    const db = getDb();
    const result = await db.execute(
      `SELECT local_id FROM sila_payment_queue WHERE state = 'syncing'
         AND datetime(created_at, '+' || ? || ' minutes') < datetime('now')`,
      [minutes],
    );
    const ids = (result.rows ?? []).map(row =>
      Number((row as {local_id?: number}).local_id ?? 0),
    );
    for (const id of ids) {
      await db.execute(
        "UPDATE sila_payment_queue SET state = 'pending' WHERE local_id = ?",
        [id],
      );
    }
    return ids.length;
  },

  async paymentCounts(): Promise<{
    pending: number;
    failed: number;
    synced: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN state = 'synced' THEN 1 ELSE 0 END) AS synced
         FROM sila_payment_queue`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        pending?: number | null;
        failed?: number | null;
        synced?: number | null;
      };
      return {
        pending: row.pending ?? 0,
        failed: row.failed ?? 0,
        synced: row.synced ?? 0,
      };
    } catch (error) {
      logDiag('sila', `تعذر عدّ طابور السداد: ${toMessage(error)}`, 'warn');
      return {pending: 0, failed: 0, synced: 0};
    }
  },

  async recentPayments(limit = 40, offset = 0): Promise<SilaPaymentRow[]> {
    try {
      // v27 (round-35 #1): return_reversal rows are EXCLUDED — a
      // goods return is NOT a cashier settlement («اصلا هو مرتجع
      // وليس مسدد»). The reversal still reduces the customer's debt
      // on the صلة server (its whole purpose), but it must never
      // surface in the السدادّات book nor in the «سدادّات عند
      // الكاشير» KPI. The return itself lives in the invoice's
      // returns history and the returns report, where it belongs.
      const result = await getDb().execute(
        `SELECT * FROM sila_payment_queue
         WHERE COALESCE(kind, 'repayment') = 'repayment'
         ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                  local_id DESC
         LIMIT ? OFFSET ?`,
        [limit, offset],
      );
      return (result.rows ?? []).map(row =>
        rowToPayment(row as Record<string, unknown>),
      );
    } catch {
      return []; // table not there yet (pre-v15 install, first run)
    }
  },

  /** RCP-YYYYMMDD-NNNN — DB-aware, never-backwards (mirrors the
   *  invoice reservation discipline: max(MMKV next, highest stored
   *  sequence for today) + 1 — §3.1 pos_receipt_ref فريد). */
  async reserveReceiptRef(): Promise<string> {
    const today = localToday();
    const dayCompact = today.replace(/-/g, '');
    const prefix = `RCP-${dayCompact}-`;
    let dbMax = 0;
    try {
      const result = await getDb().execute(
        'SELECT pos_receipt_ref FROM sila_payment_queue WHERE pos_receipt_ref LIKE ?',
        [`${prefix}%`],
      );
      const re = new RegExp('^RCP-(d{8})-(d+)$');
      for (const row of result.rows ?? []) {
        const match = re.exec(String(row.pos_receipt_ref ?? ''));
        if (match) {
          dbMax = Math.max(dbMax, parseInt(match[2], 10));
        }
      }
    } catch {
      // Table missing on old installs — MMKV counter alone.
    }
    const lastDay = getString(KEYS.paymentReceiptDay, '');
    const counter = getNumber(KEYS.paymentReceiptCounter, 0);
    const mmkvNext = lastDay === today ? counter + 1 : 1;
    const next = Math.max(mmkvNext, dbMax + 1);
    setNumber(KEYS.paymentReceiptCounter, next);
    setString(KEYS.paymentReceiptDay, today);
    return `${prefix}${String(next).padStart(4, '0')}`;
  },

  /** Repayments RECEIVED at this cashier — all states (the cash
   *  entered the drawer the moment it was collected, regardless of
   *  upload state). Used by the treasury + reports (§3.4: a payment
   * is an asset swap — debt → cash — NEVER revenue). */
  async paymentsTotals(): Promise<{
    allMinor: number;
    allCount: number;
    todayMinor: number;
    syncedMinor: number;
    pendingMinor: number;
  }> {
    try {
      // v23 (round-29 #2): return_reversal rows NEVER count as
      // collected cash — they reverse DEBT, they are not income.
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(amount_minor), 0) AS all_minor,
           COUNT(*) AS all_count,
           COALESCE(SUM(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN amount_minor ELSE 0 END), 0) AS today_minor,
           COALESCE(SUM(CASE WHEN state = 'synced' THEN amount_minor ELSE 0 END), 0) AS synced_minor,
           COALESCE(SUM(CASE WHEN state IN ('pending','syncing') THEN amount_minor ELSE 0 END), 0) AS pending_minor
         FROM sila_payment_queue
         WHERE COALESCE(kind, 'repayment') = 'repayment'`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        all_minor?: number | null;
        all_count?: number | null;
        today_minor?: number | null;
        synced_minor?: number | null;
        pending_minor?: number | null;
      };
      return {
        allMinor: Number(row.all_minor ?? 0),
        allCount: Number(row.all_count ?? 0),
        todayMinor: Number(row.today_minor ?? 0),
        syncedMinor: Number(row.synced_minor ?? 0),
        pendingMinor: Number(row.pending_minor ?? 0),
      };
    } catch (error) {
      logDiag('sila', `تعذر جمع ملخص السدادّات: ${toMessage(error)}`, 'warn');
      return {
        allMinor: 0,
        allCount: 0,
        todayMinor: 0,
        syncedMinor: 0,
        pendingMinor: 0,
      };
    }
  },

  /** Repayments inside a date range (reports) — by LOCAL day of the
   *  created_at timestamp (v19 round-25 #6: these tables store UTC
   *  via datetime('now'); comparing the raw string against local
   *  date boundaries misattributed payments made between 00:00 and
   *  03:00 to the PREVIOUS day — Asia/Jerusalem is UTC+3).
   *  v23 (round-29 #2): return_reversal rows are EXCLUDED — a
   *  goods return is not a collection, in ANY period. */
  async paymentsInRange(
    from: string,
    to: string,
  ): Promise<{count: number; minor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_minor), 0) AS minor
         FROM sila_payment_queue
         WHERE COALESCE(kind, 'repayment') = 'repayment'
           AND date(created_at, 'localtime') >= ?
           AND date(created_at, 'localtime') <= ?`,
        [from, to],
      );
      const row = (result.rows?.[0] ?? {}) as {
        cnt?: number | null;
        minor?: number | null;
      };
      return {count: Number(row.cnt ?? 0), minor: Number(row.minor ?? 0)};
    } catch {
      return {count: 0, minor: 0};
    }
  },

  /** v23 (round-29 #2): the all-time total of return reversals —
   *  the amount by which the treasury's credit-sales figure must
   *  shrink for synced صِلة debts that were later (partly)
   *  returned. Pending queue rows were already shrunk at return
   *  time; SYNCED rows keep their original amount in the queue,
   *  and the reversal payment row is what cancels them — so the
   *  treasury subtracts the reversals from creditSales, keeping
   *  revenue(net) − creditSales(net) + collections(no reversals)
   *  balanced in every scenario. */
  async returnReversalsTotal(): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(amount_minor), 0) AS minor
         FROM sila_payment_queue
         WHERE COALESCE(kind, 'repayment') = 'return_reversal'`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        minor?: number | null;
      };
      return Number(row.minor ?? 0);
    } catch {
      return 0;
    }
  },

  /** v26 (round-34 #3): reversal payments ENQUEUED but not yet on the
   *  صِلة server (pending/syncing) — the part of a synced-debt return
   *  the server hasn't seen yet. The live «الدين القائم» displays
   *  (Home + reports) subtract this so a return is reflected
   *  IMMEDIATELY, not only after the next upload + balances refresh
   *  («لم تتغير قيم الدين القائم بعد الإرجاعات»). */
  async pendingReversalsMinor(): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(amount_minor), 0) AS minor
         FROM sila_payment_queue
         WHERE COALESCE(kind, 'repayment') = 'return_reversal'
           AND state IN ('pending','syncing')`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        minor?: number | null;
      };
      return Number(row.minor ?? 0);
    } catch {
      return 0;
    }
  },

  // ── customers cache (§7) ───────────────────────────────────────

  /** v15 (§3.2-ب): REPLACE the row per customer — no MERGE, no local
   *  aggregation. Split fields default to 0 when the server hasn't
   *  deployed the 0069 origin split yet (backwards compatible).
   *  v18: `reconcileOffsetMinor` lands ONLY with a row's creation
   *  (first full sight) — the write-once baseline anchor for the
   *  collections reconciliation; existing rows keep theirs. */
  async upsertCustomers(
    rows: {
      customerId: string;
      name: string;
      phoneLast4: string | null;
      outstandingMinor: number;
      /** v17 (round-23 #3): the server-known prepaid credit. Pass
       *  null to PRESERVE the cached value (partial updates after a
       *  debt sync don't carry it). */
      creditMinor?: number | null;
      posOutstandingMinor?: number;
      appOutstandingMinor?: number;
      otherMinor?: number;
      posPurchasesMinor?: number;
      appPurchasesMinor?: number;
      /** v33 (round-41 #11 — 0075): أرصدة هذه النقطة تحديداً. */
      deviceOutstandingMinor?: number;
      devicePurchasesMinor?: number;
      devicePaymentsMinor?: number;
      lastPaymentAt?: string | null;
      lastPaymentAmountMinor?: number | null;
      /** v18 (round-24 #1): baseline anchor for NEW rows only. */
      reconcileOffsetMinor?: number;
    }[],
    syncedAt: string,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const db = getDb();
    for (const row of rows) {
      // v17 (round-23 #3): creditMinor == null means "this update
      // doesn't know the credit" (a post-debt-sync upsert) — two SQL
      // variants so a NOT NULL column never needs a NULL sentinel:
      // the null variant simply doesn't touch credit_minor.
      const knowsCredit = row.creditMinor != null;
      const sql = knowsCredit
        ? `INSERT INTO sila_customers (
             customer_id, name, phone_last4, outstanding_minor,
             credit_minor,
             pos_outstanding_minor, app_outstanding_minor, other_minor,
             pos_purchases_minor, app_purchases_minor,
             device_outstanding_minor, device_purchases_minor, device_payments_minor,
             last_payment_at, last_payment_amount_minor,
             reconcile_offset_minor, last_synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?)
           ON CONFLICT(customer_id) DO UPDATE SET
             name = excluded.name,
             phone_last4 = excluded.phone_last4,
             outstanding_minor = excluded.outstanding_minor,
             credit_minor = excluded.credit_minor,
             pos_outstanding_minor = excluded.pos_outstanding_minor,
             app_outstanding_minor = excluded.app_outstanding_minor,
             other_minor = excluded.other_minor,
             pos_purchases_minor = excluded.pos_purchases_minor,
             app_purchases_minor = excluded.app_purchases_minor,
             device_outstanding_minor = excluded.device_outstanding_minor,
             device_purchases_minor = excluded.device_purchases_minor,
             device_payments_minor = excluded.device_payments_minor,
             last_payment_at = excluded.last_payment_at,
             last_payment_amount_minor = excluded.last_payment_amount_minor,
             reconcile_offset_minor = CASE WHEN excluded.reconcile_offset_minor > 0 THEN excluded.reconcile_offset_minor ELSE sila_customers.reconcile_offset_minor END,
             last_synced_at = excluded.last_synced_at`
        : `INSERT INTO sila_customers (
             customer_id, name, phone_last4, outstanding_minor,
             pos_outstanding_minor, app_outstanding_minor, other_minor,
             pos_purchases_minor, app_purchases_minor,
             device_outstanding_minor, device_purchases_minor, device_payments_minor,
             last_payment_at, last_payment_amount_minor,
             reconcile_offset_minor, last_synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?)
           ON CONFLICT(customer_id) DO UPDATE SET
             name = excluded.name,
             phone_last4 = excluded.phone_last4,
             outstanding_minor = excluded.outstanding_minor,
             pos_outstanding_minor = excluded.pos_outstanding_minor,
             app_outstanding_minor = excluded.app_outstanding_minor,
             other_minor = excluded.other_minor,
             pos_purchases_minor = excluded.pos_purchases_minor,
             app_purchases_minor = excluded.app_purchases_minor,
             device_outstanding_minor = excluded.device_outstanding_minor,
             device_purchases_minor = excluded.device_purchases_minor,
             device_payments_minor = excluded.device_payments_minor,
             last_payment_at = excluded.last_payment_at,
             last_payment_amount_minor = excluded.last_payment_amount_minor,
             reconcile_offset_minor = CASE WHEN excluded.reconcile_offset_minor > 0 THEN excluded.reconcile_offset_minor ELSE sila_customers.reconcile_offset_minor END,
             last_synced_at = excluded.last_synced_at`;
      const args = knowsCredit
        ? [
            row.customerId,
            row.name,
            row.phoneLast4,
            row.outstandingMinor,
            Math.max(0, Math.round(row.creditMinor ?? 0)),
            row.posOutstandingMinor ?? 0,
            row.appOutstandingMinor ?? 0,
            row.otherMinor ?? 0,
            row.posPurchasesMinor ?? 0,
            row.appPurchasesMinor ?? 0,
            row.deviceOutstandingMinor ?? 0,
            row.devicePurchasesMinor ?? 0,
            row.devicePaymentsMinor ?? 0,
            row.lastPaymentAt ?? null,
            row.lastPaymentAmountMinor ?? null,
            row.reconcileOffsetMinor ?? null,
            syncedAt,
          ]
        : [
            row.customerId,
            row.name,
            row.phoneLast4,
            row.outstandingMinor,
            row.posOutstandingMinor ?? 0,
            row.appOutstandingMinor ?? 0,
            row.otherMinor ?? 0,
            row.posPurchasesMinor ?? 0,
            row.appPurchasesMinor ?? 0,
            row.deviceOutstandingMinor ?? 0,
            row.devicePurchasesMinor ?? 0,
            row.devicePaymentsMinor ?? 0,
            row.lastPaymentAt ?? null,
            row.lastPaymentAmountMinor ?? null,
            row.reconcileOffsetMinor ?? null,
            syncedAt,
          ];
      await db.execute(sql, args);
    }
  },

  /** v18 (round-24 #1): the post-debt-sync cache touch — UPDATE ONLY.
   *  The v17 upsert-created rows here, which had two costs: it
   *  zeroed the origin-split columns (pos_outstanding → 0 until the
   *  next full refresh) and it made cache-row existence unusable as
   *  a «seen in a full refresh» marker for the reconciliation
   *  baseline. Updating only name/phone/total balance fixes both;
   *  customers the full feed hasn't delivered yet simply stay
   *  untouched until it does. */
  async touchCustomerAfterSync(
    row: {
      customerId: string;
      name: string;
      phoneLast4: string | null;
      outstandingMinor: number;
    },
    syncedAt: string,
  ): Promise<void> {
    try {
      await getDb().execute(
        `UPDATE sila_customers
           SET name = ?,
               phone_last4 = COALESCE(?, phone_last4),
               outstanding_minor = ?,
               last_synced_at = ?
         WHERE customer_id = ?`,
        [
          row.name,
          row.phoneLast4,
          row.outstandingMinor,
          syncedAt,
          row.customerId,
        ],
      );
    } catch (error) {
      logDiag(
        'sila',
        `تعذر تحديث ذاكرة الزبون بعد المزامنة: ${toMessage(error)}`,
        'warn',
      );
    }
  },

  async listCustomers(): Promise<SilaCustomer[]> {
    try {
      const result = await getDb().execute(
        // v24 (round-31 #2): the customers page is the STORE-debt
        // book now — order by the store's own part, not the total.
        `SELECT * FROM sila_customers
         ORDER BY pos_outstanding_minor DESC, name COLLATE NOCASE ASC`,
      );
      return (result.rows ?? []).map(row =>
        rowToCustomer(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },

  /** Cached customer by SILA cid — offline QR codes carry no name. */
  async findCustomer(customerId: string): Promise<SilaCustomer | null> {
    if (!customerId) {
      return null;
    }
    try {
      const result = await getDb().execute(
        'SELECT * FROM sila_customers WHERE customer_id = ? LIMIT 1',
        [customerId],
      );
      const row = result.rows?.[0];
      return row ? rowToCustomer(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  /** v17 (round-23 #3): local-only cache touch after a credit-covered
   *  debt sale — the prepaid balance the cache shows must drop by
   *  the covered part immediately, so the NEXT sale of the same
   *  customer sees the reduced credit (the server's own consumption
   *  arrives with the next balances refresh and corrects any drift). */
  async consumeCachedCredit(
    customerId: string,
    coveredMinor: number,
  ): Promise<void> {
    if (!customerId || coveredMinor <= 0) {
      return;
    }
    try {
      await getDb().execute(
        `UPDATE sila_customers
           SET credit_minor = MAX(0, credit_minor - ?)
         WHERE customer_id = ?`,
        [Math.round(coveredMinor), customerId],
      );
    } catch (error) {
      logDiag(
        'sila',
        `تعذر خصم الرصيد المسبق من الذاكرة: ${toMessage(error)}`,
        'warn',
      );
    }
  },

  /** v17 (round-23 #2): Σ credit_covered_minor of debt rows created in
   *  the range — the money prepaid credit absorbed (treated as
   *  received at sale/migration time in the store's cash math).
   *  v19 (round-25 #6): LOCAL-day comparison (created_at is UTC). */
  async creditCoveredInRange(from: string, to: string): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(credit_covered_minor), 0) AS minor
         FROM sila_debt_queue
         WHERE date(created_at, 'localtime') >= ?
           AND date(created_at, 'localtime') <= ?`,
        [from, to],
      );
      const row = (result.rows?.[0] ?? {}) as {
        minor?: number | null;
      };
      return Number(row.minor ?? 0);
    } catch {
      return 0;
    }
  },

  // ── v18 (round-24 #1): Sila-app collections reconciliation ────────

  /**
   * THE reconciliation engine (طريقة المخزون مع خطّ أساس).
   * ─────────────────────────────────────────────────────────────────
   * v34 (الجولة 42 #2): المطابقة صارت على مستوى هذه النقطة
   * تحديداً (0075 device fields) — لا على أرقام POS الشاملة التي
   * تجمع فواتير كل متاجر التاجر المرتبطة بنفس الحساب. حين كان
   * الزبون يسدّد عبر تطبيق صلة ديناً وُلد في متجر آخر للتاجر، كان
   * الفارق POS-الشامل ينمو فيُسجّل هنا تحصيلاً وهمياً: الخزينة
   * تتضخم و«دين المتجر نفسه» لذلك الزبون ينقلب سالباً فيخصم
   * بصمت من إجمالي الدين القائم — وصف التاجر بالضبط: «الديون على
   * زبائن صلة لا تحسب في الدين القائم». الآن:
   *   collectedOnDeviceDebts = device_purchases_minor − device_outstanding_minor
   * (كل ما طُفئ من ديون هذه النقطة — بإسناد الخادم ثنائي المرحلة)،
   * والفارق عن الحصة المحلية هو ما جمعه تطبيق صلة على ديون هذه
   * النقطة بالتحديد. الخوادم قبل 0075 لا ترسل الحقول → الرجوع
   * الآمن لأرقام POS الشاملة كما كان. **v35 (الجولة 43): أُلغي هذا
   * الرجوع نهائياً** — شكوى التاجر: «فاتورة دين 20₪ على زبون صلة
   * أول مرة ورصيده صفر سُجّل منها 5 دين فقط والباقي عُوّض بتحصيلات
   * وهمية عبر التطبيق، كأن هناك تداخلاً بفواتير متاجر أخرى أو
   * قديمة». في حساب التاجر متعدد المتاجر، فارق POS الشامل يجمع
   * سدادّات وتحصيلات متاجر التاجر الأخرى — لا يمكن إثبات أنه يخص
   * هذه النقطة، وتسجيله كان يأكل الفواتير الجديدة ويعكس الأرصدة.
   * الآن ثلاث طبقات: (①) لا مطابقة إلا بأرقام الجهاز 0075 — غابت
   * → تخطّي كامل بلا تسجيل وبلا تجميد أساس، وأول مشاهدة بلا أرقام
   * تُعلَّم بأساس حارس ‎-1‎ يُجمَّد عند أول مشاهدة حاملة للأرقام؛
   * (②) سقف الدين المحلي: التحصيل المسجّل لا يتجاوز دين الزبون في
   * دفاتر هذه النقطة أبداً؛ (③) المطابقة الهابطة: ادّعت الدفاتر
   * فوق ما جمعه الخادم على ديون هذه النقطة فعلاً → الفارق وهمي
   * يُشذَّب من أحدث التحصيلات ويُمتص في الأساس (شفاء ذاتي شامل
   * لكل تلوث عصر POS — وفاتورة الـ20 المستهدمة تعود كاملة).
   *
   * The server knows the full stock per customer:
   *   collectedOnStoreDebts = pos_purchases_minor − pos_outstanding_minor
   * (every purchase this store's invoices created, minus what still
   * stands — payments AND prepaid-credit consumption both reduce
   * pos_outstanding by FIFO, migration 0069).
   *
   * The store knows its own share of that stock:
   *   cashier collections      = Σ sila_payment_queue.amount
   *                              (synced OR syncing — a payment that
   *                              already reached the server but isn't
   *                              marked synced yet must not inflate
   *                              the gap: the v18 race recorded such
   *                              rows TWICE)
   *   prepaid-credit coverage  = Σ sila_debt_queue.credit_covered_minor
   *   already-detected app
   *   collections              = Σ sila_app_collections.amount
   *
   * The GAP — minus the customer's baseline anchor — is money صِلة
   * collected on the store's behalf that no local book has seen:
   *   unrecorded = (stock − localShare) − reconcile_offset_minor
   *
   * v19 (round-25 #1 — the «تحصيل دين 67.10» complaint): the baseline
   * is now frozen for EVERY customer at the FIRST v19 sight, not
   * only for cache-new ones. The v18 upgrade path left existing
   * rows anchored at 0, so the ENTIRE historical gap (old app
   * payments from before v18 — «معاملات قديمة» exactly as the
   * merchant suspected) dumped at once as ONE huge collection dated
   * TODAY. With `freezeBaseline` (the first v19 pass after the
   * update) every existing customer's CURRENT gap becomes the
   * anchor: history stays history, and only NEW app payments are
   * recorded — dated correctly, sized correctly.
   *
   * The anchor is preserved forever by upsertCustomers (write-once:
   * a non-positive incoming value never overwrites a stored one —
   * the v18 COALESCE(0, old) bug wiped every anchor to 0 on each
   * full refresh, which re-armed the historical dump).
   *
   * This method is SELF-HEALING and IDEMPOTENT: no cursors, no
   * time windows (survives offline gaps >10 ledger entries), heals
   * restores, and never re-records what the books already carry
   * (each recorded collection grows localShare by the same amount,
   * so the gap returns to zero by itself).
   *
   * `newCustomerOffsets` collects the baseline anchors for customers
   * the cache has never seen — the caller hands them to
   * upsertCustomers so the anchor lands with the row's creation.
   *
   * Returns the total minor amount newly recorded this pass.
   */
  async reconcileAppCollections(
    rows: {
      customerId: string;
      name: string;
      posPurchasesMinor: number;
      posOutstandingMinor: number;
      /** v34 (الجولة 42 #2): أرقام هذه النقطة تحديداً (خادم 0075 —
       *  إسناد ثنائي المرحلة). متوفرة → تُستخدم بدل أرقام POS
       *  الشاملة؛ غائبة (null) على الخوادم الأقدم → الرجوع الآمن. */
      devicePurchasesMinor?: number | null;
      deviceOutstandingMinor?: number | null;
    }[],
    newCustomerOffsets: Map<string, number>,
    /** v19 (round-25 #1): first-pass flag — freeze the CURRENT gap
     * of every EXISTING cache row as its baseline so historical
     * collections never dump as fresh money. */
    freezeBaseline = false,
    /** v34 (الجولة 42 #2): إعادة تجميد أحادية لأُسس المطابقة على
     *  الأرقام الجهازية عند أول تمريرة تتضمنها (مرة واحدة فقط) —
     *  أسس v19 جُمّدت على أرقام POS الشاملة (تاريخ متاجر أخرى
     *  داخلها)؛ إبقاؤها كما هي كان سيبتلع تحصيلات حقيقية على
     *  ديون هذه النقطة لأن الأسس أعلى من الفارق الجهازي الصحيح. */
    deviceBaselineReset = false,
  ): Promise<{recordedMinor: number; trimmedMinor: number}> {
    if (rows.length === 0) {
      return {recordedMinor: 0, trimmedMinor: 0};
    }
    const db = getDb();
    let recordedTotal = 0;
    let recordedCount = 0;
    let trimmedTotal = 0;
    let skippedNoDevice = 0;
    for (const row of rows) {
      try {
        // v35 ①: أرقام هذه النقطة (0075) فقط — غيابها يعني أن أي
        //  فارق لا يمكن إثبات نسبته لهذه النقطة (فارق POS الشامل
        //  يجمع تحصيلات متاجر التاجر الأخرى وسدادّاتها — تسجيله
        //  هنا كان يأكل فواتير هذا المتجر). تخطٍّ كامل: لا تسجيل
        //  ولا تجميد أساس من مشاهدة عمياء.
        const hasDeviceNumbers =
          row.devicePurchasesMinor != null &&
          row.deviceOutstandingMinor != null;
        if (!hasDeviceNumbers) {
          skippedNoDevice += 1;
          // أول مشاهدة بلا أرقام جهاز: علِّم بأساس حارس -1 حتى
          // يُجمَّد عند أول مشاهدة تحمل الأرقام — لا يُخلق الصف
          // بأساس صفر مسلّح لفراغ تاريخي لاحق.
          const seen = await db.execute(
            'SELECT 1 AS x FROM sila_customers WHERE customer_id = ?',
            [row.customerId],
          );
          if ((seen.rows?.length ?? 0) === 0) {
            newCustomerOffsets.set(row.customerId, -1);
          }
          continue;
        }
        const purchasesBase = Number(row.devicePurchasesMinor);
        const outstandingBase = Number(row.deviceOutstandingMinor);
        const collectedOnStoreDebts = purchasesBase - outstandingBase;
        // The store's own share of that stock (see header) — plus the
        // v35 extras: payments the server has CONFIRMED (synced only)
        // for the downward trim, and the full local books (all
        // payment states + effective debt) for the local-debt cap.
        const aggResult = await db.execute(
          `SELECT
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_payment_queue
               WHERE customer_id = ? AND state IN ('synced','syncing')) AS cashier_minor,
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_payment_queue
               WHERE customer_id = ? AND state = 'synced') AS cashier_synced_minor,
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_payment_queue
               WHERE customer_id = ?) AS payments_all_minor,
             (SELECT COALESCE(SUM(amount_minor - COALESCE(credit_covered_minor, 0)), 0) FROM sila_debt_queue
               WHERE customer_id = ?) AS effective_debt_minor,
             (SELECT COALESCE(SUM(credit_covered_minor), 0) FROM sila_debt_queue
               WHERE customer_id = ?) AS credit_minor,
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_app_collections
               WHERE customer_id = ?) AS app_minor`,
          [
            row.customerId,
            row.customerId,
            row.customerId,
            row.customerId,
            row.customerId,
            row.customerId,
          ],
        );
        const agg = (aggResult.rows?.[0] ?? {}) as {
          cashier_minor?: number | null;
          cashier_synced_minor?: number | null;
          payments_all_minor?: number | null;
          effective_debt_minor?: number | null;
          credit_minor?: number | null;
          app_minor?: number | null;
        };
        const cashierSyncedMinor = Number(agg.cashier_synced_minor ?? 0);
        const creditMinor = Number(agg.credit_minor ?? 0);
        const appMinor = Number(agg.app_minor ?? 0);
        let localShare =
          Number(agg.cashier_minor ?? 0) + creditMinor + appMinor;
        // v35 ②: دين الزبون الحالي في دفاتر هذه النقطة (كل حالات
        //  السداد — النقد استُلم فعلاً ولو تأجل الرفع) — سقف لا
        //  يتجاوزه أي تحصيل يُسجَّل، فلا ينقلب الرصيد سالباً أبداً.
        const localOutstanding = Math.max(
          0,
          Number(agg.effective_debt_minor ?? 0) -
            Number(agg.payments_all_minor ?? 0) -
            appMinor,
        );
        const currentGap = Math.max(
          0,
          Math.round(collectedOnStoreDebts - localShare),
        );

        // v35 ③: المطابقة الهابطة — الدفاتر تدّعي (سدادّات مؤكدة +
        //  تغطية رصيد + تحصيلات مسجلة) أكثر مما جمع الخادم فعلاً
        //  على ديون هذه النقطة → الفارق تحصيل وهمي (غالباً من عصر
        //  مطابقة POS) يُشذَّب من أحدث صفوف التحصيل ويُمتص في الأساس
        //  حتى لا يعود. سدادّات الكاشير «المؤكدة» فقط في المقارنة:
        //  ما لم يصله الخادم بعد (pending/failed) لا يُحسب عليها.
        const booksClaim =
          cashierSyncedMinor + creditMinor + appMinor;
        const overRecorded = Math.round(booksClaim - collectedOnStoreDebts);
        if (overRecorded > 0) {
          const trimmed = await trimOverRecordedCollections(
            row.customerId,
            row.name,
            overRecorded,
          );
          if (trimmed > 0) {
            trimmedTotal += trimmed;
            logDiag(
              'sila',
              `شُذِّب ${row.name}: حُذف ${(trimmed / 100).toFixed(
                2,
              )}₪ تحصيلات وهمية لا يعرفها خادم صِلة لديون هذه النقطة — دين المتجر استعاد قيمته الصحيحة`,
            );
          }
          // بعد التشذيب أعد قراءة الحصة المحلية (انخفضت بالمشذَّب)
          //  حتى لا يتضخم الفارق غير المسجل في هذه التمريرة نفسها.
          const reagg = await db.execute(
            `SELECT
               (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_payment_queue
                 WHERE customer_id = ? AND state IN ('synced','syncing')) AS cashier_minor,
               (SELECT COALESCE(SUM(credit_covered_minor), 0) FROM sila_debt_queue
                 WHERE customer_id = ?) AS credit_minor,
               (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_app_collections
                 WHERE customer_id = ?) AS app_minor`,
            [row.customerId, row.customerId, row.customerId],
          );
          const re = (reagg.rows?.[0] ?? {}) as {
            cashier_minor?: number | null;
            credit_minor?: number | null;
            app_minor?: number | null;
          };
          localShare =
            Number(re.cashier_minor ?? 0) +
            Number(re.credit_minor ?? 0) +
            Number(re.app_minor ?? 0);
        }

        // First full sight of this customer? Freeze the historical
        // gap as the baseline — pre-existing history (another
        // device's era) must never leak in as fresh collections.
        const cacheRow = await db.execute(
          'SELECT reconcile_offset_minor FROM sila_customers WHERE customer_id = ?',
          [row.customerId],
        );
        const cached = cacheRow.rows?.[0] as
          | {reconcile_offset_minor?: number | null}
          | undefined;
        if (cached == null) {
          newCustomerOffsets.set(row.customerId, currentGap);
          continue; // nothing to record on the very first sight
        }
        const offset = Number(cached.reconcile_offset_minor ?? 0);
        // v35: أساس حارس -1 = شُوهد الزبون أول مرة بلا أرقام جهاز —
        //  هذه أول مشاهدة حاملة للأرقام: جمِّد الفارق الجهازي الحالي
        //  أساساً (لا تاريخ يتسرب ولا صفر مسلّح) وسجل لا شيء الآن.
        if (offset < 0) {
          await db.execute(
            `UPDATE sila_customers SET reconcile_offset_minor = ?
             WHERE customer_id = ?`,
            [currentGap, row.customerId],
          );
          logDiag(
            'sila',
            `جُمّد أساس مطابقة تحصيلات ${row.name} عند أول أرقام جهاز: ${(
              currentGap / 100
            ).toFixed(2)}₪`,
          );
          continue;
        }
        // v34 (الجولة 42 #2): إعادة التجميد الأحادية على الأرقام
        // الجهازية — تُستبدل (لأعلى أو لأسفل) مرة واحدة، لأن أسس
        // v19 كانت بأرقام POS الشاملة (تاريخ متاجر أخرى داخلها)
        // والفارق الجهازي الصحيح أصغر منها عادة. بعدها يستأنف
        // الانضباط المعتاد: الأساس لا ينخفض أبداً.
        if (
          deviceBaselineReset &&
          hasDeviceNumbers &&
          currentGap !== offset
        ) {
          await db.execute(
            `UPDATE sila_customers SET reconcile_offset_minor = ?
             WHERE customer_id = ?`,
            [currentGap, row.customerId],
          );
          logDiag(
            'sila',
            `أُعيد تجميد أساس مطابقة تحصيلات ${row.name} على أرقام هذه
             النقطة عند ${(currentGap / 100).toFixed(2)}₪ (فصل المتاجر)`,
          );
          continue;
        }
        // v19: the one-time baseline freeze for rows created before
        // this update (anchored 0 by the v18 upgrade path) — their
        // current gap is HISTORY, not fresh money. Never lowers an
        // existing anchor.
        if (freezeBaseline && currentGap > offset) {
          await db.execute(
            `UPDATE sila_customers SET reconcile_offset_minor = ?
             WHERE customer_id = ?`,
            [currentGap, row.customerId],
          );
          logDiag(
            'sila',
            `جُمّد أساس مطابقة تحصيلات ${row.name} عند ${(
              currentGap / 100
            ).toFixed(2)}₪ (تاريخ قديم — لن يُسجّل كتحصيل جديد)`,
          );
          continue;
        }
        let unrecorded = collectedOnStoreDebts - localShare - offset;
        if (unrecorded <= 0) {
          continue; // books already know everything above the anchor
        }
        // v35 ②: سقف الدين المحلي — التحصيل لا يتجاوز دين الزبون في
        //  دفاتر هذه النقطة أبداً (يستحيل رصيد سالب حتى لو أخطأ
        //  الخادم في الإسناد أو فقدت الدفاتر تاريخاً).
        if (unrecorded > localOutstanding) {
          unrecorded = localOutstanding;
        }
        if (unrecorded <= 0) {
          continue;
        }
        await db.execute(
          `INSERT INTO sila_app_collections (
             customer_id, customer_name, amount_minor,
             pos_purchases_minor, pos_outstanding_minor, detected_at
           ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          [
            row.customerId,
            row.name,
            Math.round(unrecorded),
            Math.round(purchasesBase),
            Math.round(outstandingBase),
          ],
        );
        recordedTotal += Math.round(unrecorded);
        recordedCount += 1;
        logDiag(
          'sila',
          `تحصيل عبر تطبيق صِلة: ${row.name} — ${(unrecorded / 100).toFixed(
            2,
          )}₪ على ديون المتجر`,
        );
      } catch (error) {
        // One customer's reconciliation failing must never block
        // the rest of the feed — the pass is idempotent, the next
        // cycle retries this customer's gap.
        logDiag(
          'sila',
          `تعذر مطابقة تحصيلات ${row.name}: ${toMessage(error)}`,
          'warn',
        );
      }
    }
    if (recordedCount > 0) {
      logDiag(
        'sila',
        `سُجّل ${recordedCount} تحصيل عبر تطبيق صِلة بإجمالي ${(
          recordedTotal / 100
        ).toFixed(2)}₪`,
      );
    }
    if (skippedNoDevice > 0) {
      logDiag(
        'sila',
        `تخطّي مطابقة ${skippedNoDevice} زبوناً بلا أرقام جهاز (0075) — لا يُسجّل لهم تحصيل إلا ببُرهان هذه النقطة`,
      );
    }
    return {recordedMinor: recordedTotal, trimmedMinor: trimmedTotal};
  },

  /** v35 (الجولة 43): التدقيق الشامل أحادي المرة — شفاء كل تلوث
   *  التحصيلات التاريخي دفعة واحدة.
   *  ─────────────────────────────────────────────────────────────────
   *  تغذية الزبائن تدريجية (updated_since) — زبون لم يتغير لدى
   *  الخادم لا يعود فيظهر، فلو اكتفينا بتشذيب التمريرات العادية
   *  لبقي التلوث القديم (تحصيلات عصر POS الوهمية) جاثماً على دفاتر
   *  من لا يتحرك حسابهم. هذا التدقيق يمسح كل زبائن الكاش مرة واحدة
   *  بعد التحديث، بأرقام الجهاز المخزنة آخر مرة، ويشذِّب كل ادعاء
   *  فوق ما يعرفه الخادم عن ديون هذه النقطة — فاتورة الـ20₪
   *  المستهدمة تعود 20 ديناً كاملة، والرصيد السالب يستقيم.
   *
   *  يعمل فقط حين عرف التطبيق يوماً أرقام جهاز (0075 حي) — كاش
   *  ما قبل 0075 يخزن أصفاراً لا تفرّق بين «لا تاريخ» و«مجهول»،
   *  والتشذيب الأعمى فيها خطر. يُرجع إجمالي ما شذَّبه. */
  async auditAppCollections(): Promise<number> {
    const db = getDb();
    let trimmedGrand = 0;
    let audited = 0;
    try {
      const customers = await db.execute(
        `SELECT customer_id, name,
                device_purchases_minor, device_outstanding_minor,
                reconcile_offset_minor
           FROM sila_customers`,
      );
      for (const raw of customers.rows ?? []) {
        const c = raw as {
          customer_id?: string;
          name?: string | null;
          device_purchases_minor?: number | null;
          device_outstanding_minor?: number | null;
        };
        const customerId = String(c.customer_id ?? '');
        if (customerId.length === 0) {
          continue;
        }
        const devicePurchases = Number(c.device_purchases_minor ?? 0);
        const deviceOutstanding = Number(c.device_outstanding_minor ?? 0);
        // أرقام الجهاز المخزنة صفر/صفر قد تكون «لا تاريخ جهاز»
        //  حقيقة — والدفاتر فوقها وهم بامتياز (الخادم لا يعرف
        //  لديون هذه النقطة شيئاً غير الصفر) — أو «مجهولة» لكاش
        //  ما قبل 0075؛ الفارق يفصل بينهما علم V34 (رأينا الأرقام
        //  يوماً) الذي يفترض المتصل فحصه قبل النداء.
        const serverGap = devicePurchases - deviceOutstanding;
        const agg = await db.execute(
          `SELECT
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_payment_queue
               WHERE customer_id = ? AND state = 'synced') AS cashier_synced_minor,
             (SELECT COALESCE(SUM(credit_covered_minor), 0) FROM sila_debt_queue
               WHERE customer_id = ?) AS credit_minor,
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_app_collections
               WHERE customer_id = ?) AS app_minor`,
          [customerId, customerId, customerId],
        );
        const a = (agg.rows?.[0] ?? {}) as {
          cashier_synced_minor?: number | null;
          credit_minor?: number | null;
          app_minor?: number | null;
        };
        const booksClaim =
          Number(a.cashier_synced_minor ?? 0) +
          Number(a.credit_minor ?? 0) +
          Number(a.app_minor ?? 0);
        const excess = Math.round(booksClaim - serverGap);
        if (excess > 0) {
          const trimmed = await trimOverRecordedCollections(
            customerId,
            c.name ?? 'زبون صِلة',
            excess,
          );
          trimmedGrand += trimmed;
          audited += 1;
        }
      }
      if (trimmedGrand > 0) {
        logDiag(
          'sila',
          `التدقيق الشامل: شُذِّبت تحصيلات وهمية لـ ${audited} زبوناً بإجمالي ${(
            trimmedGrand / 100
          ).toFixed(2)}₪ — كل تحصيل لا يعرفه خادم صِلة لديون هذه النقطة خرج من الدفاتر`,
        );
      } else {
        logDiag('sila', 'التدقيق الشامل للتحصيلات: الدفاتر نظيفة');
      }
    } catch (error) {
      logDiag(
        'sila',
        `تعذر التدقيق الشامل للتحصيلات: ${toMessage(error)}`,
        'warn',
      );
    }
    return trimmedGrand;
  },

  /** v18 (round-24 #1): store-wide totals of the Sila-app collections
   *  ledger — the treasury and the Home dashboard read this so money
   *  collected by صِلة on the store's behalf is never invisible. */
  async appCollectionsTotals(): Promise<{
    allMinor: number;
    allCount: number;
    todayMinor: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(amount_minor), 0) AS all_minor,
           COUNT(*) AS all_count,
           COALESCE(SUM(CASE WHEN date(detected_at, 'localtime') = date('now', 'localtime') THEN amount_minor ELSE 0 END), 0) AS today_minor
         FROM sila_app_collections`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        all_minor?: number | null;
        all_count?: number | null;
        today_minor?: number | null;
      };
      return {
        allMinor: Number(row.all_minor ?? 0),
        allCount: Number(row.all_count ?? 0),
        todayMinor: Number(row.today_minor ?? 0),
      };
    } catch (error) {
      logDiag(
        'sila',
        `تعذر جمع تحصيلات تطبيق صِلة: ${toMessage(error)}`,
        'warn',
      );
      return {allMinor: 0, allCount: 0, todayMinor: 0};
    }
  },

  /** v18 (round-24 #1): Sila-app collections inside a date range
   *  (reports) — by LOCAL day of detected_at (v19: UTC→localday
   *  conversion, same fix as paymentsInRange), the moment the store
   *  learned of them (the actual payment happened server-side
   *  shortly before). */
  async appCollectionsInRange(
    from: string,
    to: string,
  ): Promise<{count: number; minor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_minor), 0) AS minor
         FROM sila_app_collections
         WHERE date(detected_at, 'localtime') >= ?
           AND date(detected_at, 'localtime') <= ?`,
        [from, to],
      );
      const row = (result.rows?.[0] ?? {}) as {
        cnt?: number | null;
        minor?: number | null;
      };
      return {count: Number(row.cnt ?? 0), minor: Number(row.minor ?? 0)};
    } catch {
      return {count: 0, minor: 0};
    }
  },

  /** v18 (round-24 #1): recent collection rows for the merchant's
   *  ledger views (newest first). */
  async recentAppCollections(
    limit = 40,
    offset = 0,
  ): Promise<
    {
      local_id: number;
      customer_id: string;
      customer_name: string | null;
      amount_minor: number;
      pos_purchases_minor: number | null;
      pos_outstanding_minor: number | null;
      detected_at: string;
    }[]
  > {
    try {
      const result = await getDb().execute(
        `SELECT local_id, customer_id, customer_name, amount_minor,
                pos_purchases_minor, pos_outstanding_minor, detected_at
         FROM sila_app_collections
         ORDER BY local_id DESC
         LIMIT ? OFFSET ?`,
        [limit, offset],
      );
      return (result.rows ?? []).map(row => ({
        local_id: Number((row as {local_id?: number}).local_id ?? 0),
        customer_id: String((row as {customer_id?: string}).customer_id ?? ''),
        customer_name: (row as {customer_name?: string}).customer_name ?? null,
        amount_minor: Number(
          (row as {amount_minor?: number}).amount_minor ?? 0,
        ),
        pos_purchases_minor:
          (row as {pos_purchases_minor?: number}).pos_purchases_minor ?? null,
        pos_outstanding_minor:
          (row as {pos_outstanding_minor?: number}).pos_outstanding_minor ??
          null,
        detected_at: String((row as {detected_at?: string}).detected_at ?? ''),
      }));
    } catch {
      return [];
    }
  },

  /** v19 (round-25 #5): total row count of the collections ledger —
   *  the paged السدادّات tab knows whether more pages exist. */
  async appCollectionsCount(): Promise<number> {
    try {
      const result = await getDb().execute(
        'SELECT COUNT(*) AS cnt FROM sila_app_collections',
      );
      const row = (result.rows?.[0] ?? {}) as {cnt?: number};
      return Number(row.cnt ?? 0);
    } catch {
      return 0;
    }
  },

  /** v19 (round-25 #1): removes a MISTAKEN app-collection row after
   *  the merchant reviews it (the «تحصيل 67.10» complaint — old
   *  history dumped by the v18 engine may not belong in today's
   *  books). The removal is logged, and the customer's baseline
   *  anchor absorbs the amount so the self-healing engine NEVER
   *  re-records it on the next pass. */
  async deleteAppCollection(localId: number): Promise<boolean> {
    const db = getDb();
    try {
      const row = await db.execute(
        'SELECT customer_id, customer_name, amount_minor FROM sila_app_collections WHERE local_id = ?',
        [localId],
      );
      const hit = row.rows?.[0] as
        | {customer_id?: string; customer_name?: string; amount_minor?: number}
        | undefined;
      if (hit == null) {
        return false;
      }
      await db.execute('DELETE FROM sila_app_collections WHERE local_id = ?', [
        localId,
      ]);
      // Absorb the deleted amount into the baseline so the next
      // reconciliation pass doesn't resurrect it (idempotency of
      // the merchant's decision, not just of the engine).
      await db.execute(
        `UPDATE sila_customers
           SET reconcile_offset_minor = reconcile_offset_minor + ?
         WHERE customer_id = ?`,
        [
          Math.max(0, Math.round(Number(hit.amount_minor ?? 0))),
          // op-sqlite 11 params cannot be undefined — null keeps the
          // same "matches nothing" runtime behaviour as before.
          hit.customer_id ?? null,
        ],
      );
      logDiag(
        'sila',
        `حُذف تحصيل تطبيق صِلة #${localId} (${hit.customer_name ?? 'زبون'} — ${
          Number(hit.amount_minor ?? 0) / 100
        }₪) بقرار التاجر — أُضيف للمون الأساسي حتى لا يعود`,
        'warn',
      );
      return true;
    } catch (error) {
      logDiag('sila', `تعذر حذف تحصيل تطبيق صِلة: ${toMessage(error)}`, 'warn');
      return false;
    }
  },
};

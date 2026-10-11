/**
 * LocalDebtsRepo — the STORE-LOCAL debt book (round-22 #4).
 * ─────────────────────────────────────────────────────────────────
 * Customer accounts that live ONLY in this store's books: ID
 * number + name + phone, their debts (INV-L-…) and repayments
 * (RCP-L-…). Nothing here is ever uploaded to صِلة — until the
 * merchant explicitly migrates a linked customer's outstanding
 * debts (each takes a FRESH INV-D number through the same
 * collision-proof reservation as new debt sales, then uploads
 * through the normal صِلة queue).
 *
 * Cross-system dedupe is by ID NUMBER:
 *  - local_customers.id_number is UNIQUE (SQLite enforces it),
 *  - creating an account whose ID number already sits in the صِلة
 *    cache (sila_customers.id_number) is refused with guidance —
 *    the same person must not exist on both sides,
 *  - scanning a صِلة QR whose cid matches a LINKED local account
 *    redirects the debt to the LOCAL book (the store keeps a
 *    single truth per person).
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
import {uuidV4} from '../../services/sila/qr';
import type {
  LocalCustomer,
  LocalCustomerBalance,
  LocalDebt,
  LocalPayment,
} from '../../core/types';

function rowToCustomer(row: Record<string, unknown>): LocalCustomer {
  return {
    id: Number(row.id ?? 0),
    id_number: String(row.id_number ?? ''),
    name: String(row.name ?? ''),
    phone: (row.phone as string) ?? null,
    notes: (row.notes as string) ?? null,
    sila_customer_id: (row.sila_customer_id as string) ?? null,
    sila_linked_at: (row.sila_linked_at as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

function rowToDebt(row: Record<string, unknown>): LocalDebt {
  return {
    id: Number(row.id ?? 0),
    local_customer_id: Number(row.local_customer_id ?? 0),
    invoice_ref: String(row.invoice_ref ?? ''),
    amount_minor: Number(row.amount_minor ?? 0),
    description: (row.description as string) ?? null,
    migrated: Number(row.migrated ?? 0),
    migrated_ref: (row.migrated_ref as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

function rowToPayment(row: Record<string, unknown>): LocalPayment {
  return {
    id: Number(row.id ?? 0),
    local_customer_id: Number(row.local_customer_id ?? 0),
    receipt_ref: String(row.receipt_ref ?? ''),
    amount_minor: Number(row.amount_minor ?? 0),
    method: (row.method as LocalPayment['method']) ?? 'cash',
    note: (row.note as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

/** INV-L-YYYYMMDD-NNNN — DB-aware, never-backwards (the local twin
 *  of the debt-queue numbering discipline; a separate series so a
 *  future صِلة migration can always take fresh INV-D numbers). */
async function maxLocalDebtSequence(): Promise<number> {
  let max = 0;
  try {
    const result = await getDb().execute(
      "SELECT invoice_ref FROM local_debts WHERE invoice_ref LIKE 'INV-L-%'",
    );
    for (const row of result.rows ?? []) {
      const match = /^INV-L-\d{8}-(\d+)$/.exec(String(row.invoice_ref ?? ''));
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
  } catch {
    // Fresh installs — MMKV counter alone.
  }
  try {
    const sales = await getDb().execute(
      "SELECT invoice_number FROM sales WHERE invoice_number LIKE 'INV-L-%'",
    );
    for (const row of sales.rows ?? []) {
      const match = /^INV-L-\d{8}-(\d+)$/.exec(
        String(row.invoice_number ?? ''),
      );
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
  } catch {
    // Best effort.
  }
  return max;
}

/** v19 (round-25 #3): the Palestinian registration standards the
 *  merchant asked for — enforced on BOTH the form and the repo so
 *  bad data can never enter the book from any path. */
const ID_NUMBER_RE = /^\d{9}$/;
/** Jawwal prefixes only (056 / 059) — 10 digits total. */
const PHONE_RE = /^05[69]\d{7}$/;

export function isValidIdNumber(value: string): boolean {
  return ID_NUMBER_RE.test(value);
}

export function isValidLocalPhone(value: string): boolean {
  return PHONE_RE.test(value);
}

export const LocalDebtsRepo = {
  /** Reserves the next LOCAL debt number: INV-L-YYYYMMDD-NNNN. */
  async reserveLocalDebtRef(): Promise<string> {
    const today = localToday();
    const compact = today.replace(/-/g, '');
    const dbMax = await maxLocalDebtSequence();
    const lastDay = getString(KEYS.localDebtDay, '');
    const counter = getNumber(KEYS.localDebtCounter, 0);
    const mmkvNext = lastDay === today ? counter + 1 : 1;
    const next = Math.max(mmkvNext, dbMax + 1);
    setNumber(KEYS.localDebtCounter, next);
    setString(KEYS.localDebtDay, today);
    return `INV-L-${compact}-${String(next).padStart(4, '0')}`;
  },

  /** Reserves the next LOCAL receipt number: RCP-L-YYYYMMDD-NNNN. */
  async reserveLocalReceiptRef(): Promise<string> {
    const today = localToday();
    const compact = today.replace(/-/g, '');
    let dbMax = 0;
    try {
      const result = await getDb().execute(
        "SELECT receipt_ref FROM local_payments WHERE receipt_ref LIKE 'RCP-L-%'",
      );
      for (const row of result.rows ?? []) {
        const match = /^RCP-L-\d{8}-(\d+)$/.exec(String(row.receipt_ref ?? ''));
        if (match) {
          dbMax = Math.max(dbMax, parseInt(match[1], 10));
        }
      }
    } catch {
      // Fresh installs.
    }
    const lastDay = getString(KEYS.localReceiptDay, '');
    const counter = getNumber(KEYS.localReceiptCounter, 0);
    const mmkvNext = lastDay === today ? counter + 1 : 1;
    const next = Math.max(mmkvNext, dbMax + 1);
    setNumber(KEYS.localReceiptCounter, next);
    setString(KEYS.localReceiptDay, today);
    return `RCP-L-${compact}-${String(next).padStart(4, '0')}`;
  },

  // ── customers ─────────────────────────────────────────────────

  /**
   * Creates a local debt account. v19 (round-25 #3): the
   * registration standards — ID number EXACTLY 9 digits, mobile
   * EXACTLY 10 digits starting 056/059 (Jawwal), both enforced
   * here (defense in depth behind the form). Refuses (throws with
   * a spoken Arabic message) when the ID number already exists —
   * locally OR in the صِلة cache — so the same person never lives
   * on both sides («لا يتكرر نفس الزبون في الجانبين من خلال رقم
   * الهوية»).
   */
  async createCustomer(input: {
    idNumber: string;
    name: string;
    phone: string | null;
    notes?: string | null;
  }): Promise<LocalCustomer> {
    const idNumber = input.idNumber.replace(/\s+/g, '');
    if (!ID_NUMBER_RE.test(idNumber)) {
      throw new Error('رقم الهوية يجب أن يكون 9 أرقام بالضبط');
    }
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error('اسم الزبون مطلوب');
    }
    const phone = (input.phone ?? '').replace(/[\s-]/g, '');
    if (!PHONE_RE.test(phone)) {
      throw new Error(
        'رقم الجوال مطلوب: 10 أرقام يبدأ بـ 056 أو 059 (مثال: 0591234567)',
      );
    }
    // Local uniqueness (SQLite UNIQUE also guards, but with a nicer message).
    const localHit = await this.byIdNumber(idNumber);
    if (localHit != null) {
      throw new Error(
        `رقم الهوية مسجل مسبقاً لـ«${localHit.name}» في دفتر المتجر`,
      );
    }
    // Cross-system: the same ID on a صِلة account means the debts
    // should flow through صِلة (or be linked after creation).
    try {
      const silaHit = await getDb().execute(
        'SELECT name FROM sila_customers WHERE id_number = ? LIMIT 1',
        [idNumber],
      );
      const silaName = (silaHit.rows?.[0] as {name?: string})?.name;
      if (silaName != null) {
        throw new Error(
          `هذا الرقم مسجل في صِلة لـ«${silaName}» — سجّل ديونته عبر صِلة أو اربط الحسابين من ملفه بعد الإنشاء`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('صِلة')) {
        throw error;
      }
      // Table missing / fresh install — continue.
    }
    await getDb().execute(
      `INSERT INTO local_customers (id_number, name, phone, notes)
       VALUES (?, ?, ?, ?)`,
      [idNumber, name, phone, input.notes?.trim() || null],
    );
    const created = await this.byIdNumber(idNumber);
    if (created == null) {
      throw new Error('تعذر إنشاء حساب الزبون');
    }
    logDiag(
      'localDebts',
      `أُنشئ حساب دين محلي: ${created.name} (هوية ${idNumber})`,
    );
    return created;
  },

  /** v35 (الجولة 43): تعديل بيانات الزبون من نافذته — الاسم والجوال
   *  ورقم الهوية (مع تفرد الهوية داخل الجدول UNIQUE؛ التحقق
   *  المنطقي والتكرار يفحصهما المتصل قبل النداء، والقيد يمنع
   *  التكرار في أسوأ الأحوال). */
  async updateCustomer(
    id: number,
    patch: {
      idNumber?: string;
      name?: string;
      phone?: string | null;
      notes?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    // v45 (round-53): op-sqlite 11 types execute() params as Scalar[]
    const args: (string | number | boolean | null)[] = [];
    if (patch.idNumber != null) {
      sets.push('id_number = ?');
      args.push(patch.idNumber.trim());
    }
    if (patch.name != null) {
      sets.push('name = ?');
      args.push(patch.name.trim());
    }
    if (patch.phone !== undefined) {
      sets.push('phone = ?');
      args.push(patch.phone?.trim() || null);
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      args.push(patch.notes?.trim() || null);
    }
    if (sets.length === 0) {
      return;
    }
    args.push(id);
    await getDb().execute(
      `UPDATE local_customers SET ${sets.join(', ')} WHERE id = ?`,
      args,
    );
  },

  async deleteCustomer(id: number): Promise<void> {
    await getDb().execute('DELETE FROM local_customers WHERE id = ?', [id]);
  },

  async byId(id: number): Promise<LocalCustomer | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_customers WHERE id = ? LIMIT 1',
        [id],
      );
      const row = result.rows?.[0];
      return row ? rowToCustomer(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  async byIdNumber(idNumber: string): Promise<LocalCustomer | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_customers WHERE id_number = ? LIMIT 1',
        [idNumber],
      );
      const row = result.rows?.[0];
      return row ? rowToCustomer(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  /** Local account linked to a صِلة cid (the dedupe guard for QR
   *  sales: a linked person's debts stay in the LOCAL book). */
  async bySilaCustomerId(cid: string): Promise<LocalCustomer | null> {
    if (!cid) {
      return null;
    }
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_customers WHERE sila_customer_id = ? LIMIT 1',
        [cid],
      );
      const row = result.rows?.[0];
      return row ? rowToCustomer(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  /** Links (or re-links) a local account to a صِلة cid — after the
   *  merchant scans that person's صِلة QR from their profile. */
  async linkSila(id: number, silaCustomerId: string): Promise<void> {
    await getDb().execute(
      `UPDATE local_customers
       SET sila_customer_id = ?, sila_linked_at = datetime('now')
       WHERE id = ?`,
      [silaCustomerId, id],
    );
    logDiag('localDebts', `رُبط حساب محلي بحساب صِلة (${silaCustomerId})`);
  },

  async unlinkSila(id: number): Promise<void> {
    await getDb().execute(
      'UPDATE local_customers SET sila_customer_id = NULL, sila_linked_at = NULL WHERE id = ?',
      [id],
    );
  },

  /** All accounts with derived balances, most indebted first. */
  async listWithBalances(): Promise<LocalCustomerBalance[]> {
    try {
      const result = await getDb().execute(
        `SELECT lc.*,
           COALESCE((SELECT SUM(amount_minor) FROM local_debts d
                      WHERE d.local_customer_id = lc.id AND d.migrated = 0), 0) AS debt_minor,
           COALESCE((SELECT SUM(amount_minor) FROM local_payments p
                      WHERE p.local_customer_id = lc.id), 0) AS paid_minor,
           COALESCE((SELECT COUNT(*) FROM local_debts d
                      WHERE d.local_customer_id = lc.id AND d.migrated = 0), 0) AS debts_count,
           COALESCE((SELECT MAX(created_at) FROM (
                      SELECT created_at FROM local_debts WHERE local_customer_id = lc.id
                      UNION ALL
                      SELECT created_at FROM local_payments WHERE local_customer_id = lc.id)), NULL) AS last_activity
         FROM local_customers lc
         ORDER BY (debt_minor - paid_minor) DESC, lc.name COLLATE NOCASE ASC`,
      );
      return (result.rows ?? []).map(row => {
        const customer = rowToCustomer(row as Record<string, unknown>);
        const debtTotalMinor = Number(
          (row as {debt_minor?: number}).debt_minor ?? 0,
        );
        const paidTotalMinor = Number(
          (row as {paid_minor?: number}).paid_minor ?? 0,
        );
        return {
          customer,
          debtTotalMinor,
          paidTotalMinor,
          outstandingMinor: debtTotalMinor - paidTotalMinor,
          debtsCount: Number((row as {debts_count?: number}).debts_count ?? 0),
          lastActivityAt:
            ((row as {last_activity?: string | null})
              .last_activity as string) ?? null,
        };
      });
    } catch (error) {
      logDiag(
        'localDebts',
        `تعذر تحميل دفتر الديون المحلي: ${toMessage(error)}`,
        'warn',
      );
      return [];
    }
  },

  // ── debts & payments ──────────────────────────────────────────

  /** Records a debt on a local account (INV-L series). */
  async addDebt(input: {
    localCustomerId: number;
    amountMinor: number;
    description: string | null;
  }): Promise<LocalDebt> {
    if (input.amountMinor <= 0) {
      throw new Error('مبلغ الدين غير صالح');
    }
    const invoiceRef = await this.reserveLocalDebtRef();
    await getDb().execute(
      `INSERT INTO local_debts (local_customer_id, invoice_ref, amount_minor, description)
       VALUES (?, ?, ?, ?)`,
      [
        input.localCustomerId,
        invoiceRef,
        Math.round(input.amountMinor),
        input.description,
      ],
    );
    const row = await getDb().execute(
      'SELECT * FROM local_debts WHERE invoice_ref = ?',
      [invoiceRef],
    );
    logDiag('localDebts', `دُوّن دين محلي ${invoiceRef}`);
    return rowToDebt(row.rows?.[0] ?? {});
  },

  /** Records a repayment from a local account (RCP-L series).
   *  v19 (round-25 #4): amounts LARGER than the outstanding are
   *  allowed by design — the excess becomes a CREDIT balance
   *  (رصيد دائن، outstanding goes negative) the customer's next
   *  debts consume. The UI confirms the split before recording. */
  async addPayment(input: {
    localCustomerId: number;
    amountMinor: number;
    method: LocalPayment['method'];
    note?: string | null;
  }): Promise<LocalPayment> {
    if (input.amountMinor <= 0) {
      throw new Error('مبلغ السداد غير صالح');
    }
    const receiptRef = await this.reserveLocalReceiptRef();
    await getDb().execute(
      `INSERT INTO local_payments (local_customer_id, receipt_ref, amount_minor, method, note)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.localCustomerId,
        receiptRef,
        Math.round(input.amountMinor),
        input.method,
        input.note?.trim() || null,
      ],
    );
    const row = await getDb().execute(
      'SELECT * FROM local_payments WHERE receipt_ref = ?',
      [receiptRef],
    );
    logDiag('localDebts', `دُوّن سداد محلي ${receiptRef}`);
    return rowToPayment(row.rows?.[0] ?? {});
  },

  async listDebts(customerId: number): Promise<LocalDebt[]> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_debts WHERE local_customer_id = ? ORDER BY id DESC',
        [customerId],
      );
      return (result.rows ?? []).map(row =>
        rowToDebt(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },

  async listPayments(customerId: number): Promise<LocalPayment[]> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_payments WHERE local_customer_id = ? ORDER BY id DESC',
        [customerId],
      );
      return (result.rows ?? []).map(row =>
        rowToPayment(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },

  /** v17 (round-23 #1): the creditor behind an INV-L invoice —
   *  feeds the debt receipt on reprints and the invoice-center
   *  detail card (local-book debts have no صِلة queue row).
   *  v21 (round-27 #6): also returns the local customer id so the
   *  reprint can print the customer's WHOLE outstanding. */
  /** v23 (round-29 #2): the local debt row behind an invoice ref —
   *  the RETURNS engine's state check: an existing unmigrated row
   *  gets its amount shrunk by the return; a migrated (or missing)
   *  row means the debt lives elsewhere (صِلة) and the merchant is
   *  warned before confirming. */
  async debtRowByRef(
    invoiceRef: string,
  ): Promise<{amountMinor: number; migrated: boolean} | null> {
    try {
      const result = await getDb().execute(
        'SELECT amount_minor, migrated FROM local_debts WHERE invoice_ref = ? LIMIT 1',
        [invoiceRef],
      );
      const row = result.rows?.[0] as
        | {amount_minor?: number; migrated?: number}
        | undefined;
      if (row == null) {
        return null;
      }
      return {
        amountMinor: Number(row.amount_minor ?? 0),
        migrated: Number(row.migrated ?? 0) === 1,
      };
    } catch {
      return null;
    }
  },

  async creditorByInvoiceRef(invoiceRef: string): Promise<{
    name: string;
    phone: string | null;
    localCustomerId: number | null;
  } | null> {
    try {
      const result = await getDb().execute(
        `SELECT lc.name AS name, lc.phone AS phone,
                d.local_customer_id AS local_customer_id
         FROM local_debts d
         JOIN local_customers lc ON lc.id = d.local_customer_id
         WHERE d.invoice_ref = ?
         LIMIT 1`,
        [invoiceRef],
      );
      const row = result.rows?.[0] as
        | {
            name?: string;
            phone?: string | null;
            local_customer_id?: number | null;
          }
        | undefined;
      if (row?.name == null) {
        return null;
      }
      return {
        name: String(row.name),
        phone: row.phone ?? null,
        localCustomerId:
          row.local_customer_id == null ? null : Number(row.local_customer_id),
      };
    } catch {
      return null;
    }
  },

  /** v21 (round-27 #6): one local customer's CURRENT outstanding
   *  (unmigrated debts − payments) — the «إجمالي الديون على الزبون»
   *  figure for the local-book debt receipt. Live at call time, so
   *  calling AFTER the sale transaction includes the new invoice. */
  async outstandingFor(localCustomerId: number): Promise<number | null> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE((SELECT SUM(amount_minor) FROM local_debts d
                      WHERE d.local_customer_id = ? AND d.migrated = 0), 0)
           -
           COALESCE((SELECT SUM(amount_minor) FROM local_payments p
                      WHERE p.local_customer_id = ?), 0) AS outstanding`,
        [localCustomerId, localCustomerId],
      );
      const row = result.rows?.[0] as
        | {outstanding?: number | null}
        | undefined;
      return row == null ? null : Number(row.outstanding ?? 0);
    } catch {
      return null;
    }
  },

  /** v17 (round-23 #2): local repayments collected in a range —
   *  the reports' «سدادّات دفتر المتجر» figure. v19 (round-25 #6):
   *  LOCAL-day comparison — local_payments stores UTC via
   *  datetime('now'), and the old raw-string comparison shifted
   *  post-midnight payments into the previous day (UTC+3). */
  async paymentsInRange(
    from: string,
    to: string,
  ): Promise<{count: number; minor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_minor), 0) AS minor
         FROM local_payments
         WHERE date(created_at, 'localtime') >= ?
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

  // ── totals (dashboard + reports) ──────────────────────────────

  /** Store-wide local book totals. */
  async totals(): Promise<{
    outstandingMinor: number;
    debtsMinor: number;
    paymentsMinor: number;
    customersCount: number;
    debtorsCount: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE((SELECT SUM(amount_minor) FROM local_debts WHERE migrated = 0), 0) AS debts_minor,
           COALESCE((SELECT SUM(amount_minor) FROM local_payments), 0) AS pays_minor,
           (SELECT COUNT(*) FROM local_customers) AS customers,
           (SELECT COUNT(*) FROM (
              SELECT lc.id FROM local_customers lc
              WHERE (COALESCE((SELECT SUM(amount_minor) FROM local_debts d
                                WHERE d.local_customer_id = lc.id AND d.migrated = 0), 0)
                     - COALESCE((SELECT SUM(amount_minor) FROM local_payments p
                                WHERE p.local_customer_id = lc.id), 0)) > 0)) AS debtors`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        debts_minor?: number;
        pays_minor?: number;
        customers?: number;
        debtors?: number;
      };
      const debtsMinor = Number(row.debts_minor ?? 0);
      const paymentsMinor = Number(row.pays_minor ?? 0);
      return {
        debtsMinor,
        paymentsMinor,
        outstandingMinor: debtsMinor - paymentsMinor,
        customersCount: Number(row.customers ?? 0),
        debtorsCount: Number(row.debtors ?? 0),
      };
    } catch (error) {
      logDiag(
        'localDebts',
        `تعذر جمع ملخص الدفتر المحلي: ${toMessage(error)}`,
        'warn',
      );
      return {
        outstandingMinor: 0,
        debtsMinor: 0,
        paymentsMinor: 0,
        customersCount: 0,
        debtorsCount: 0,
      };
    }
  },

  /**
   * v17 (round-23 #8): link + AUTO-migrate + settle + delete — ONE
   * action, the merchant's exact requested flow:
   *
   *   «عند ربط حساب زبون محلي بتطبيق صِلة» the outstanding balance
   *   migrates AUTOMATICALLY (no second button), the customer's
   *   prepaid credit in صِلة (when it exists) is recognized as a
   *   settlement (كسداد في المتجر — the server consumes it on
   *   upload, 0067), and the LOCAL account is DELETED afterwards —
   *   the person now lives on the صِلة side only (their QR sales go
   *   straight to صِلة, the redirect guard disappears with the
   *   account).
   *
   * The old manual path had two fatal bugs: its idempotency key
   * (`REF-timestamp`) was NOT a UUID v4, so the server's zod bounced
   * every migration with VALIDATION_ERROR (debts never reached صِلة
   * — «لا يتم ترحيل الديون تلقائياً»), and it never looked at the
   * customer's prepaid credit at all. Now: proper uuidV4 key, the
   * FULL outstanding uploads as ONE purchase (the server consumes
   * the credit itself and shows it as «شراء بالدين» — never a
   * payment), and credit_covered_minor carries the settled part for
   * the store's books.
   */
  async linkAndMigrateToSila(
    customerId: number,
    silaCustomerId: string,
    reserveDebtRef: () => Promise<string>,
    enqueue: (input: {
      idempotencyKey: string;
      customerId: string;
      customerName: string;
      amountMinor: number;
      posInvoiceRef: string;
      description: string;
      creditCoveredMinor: number;
    }) => Promise<void>,
    cachedCreditMinor: number,
  ): Promise<{
    migrated: boolean;
    outstandingMinor: number;
    creditCoveredMinor: number;
    netMinor: number;
  }> {
    const customer = await this.byId(customerId);
    if (customer == null) {
      throw new Error('حساب الزبون غير موجود');
    }
    // 1. Link FIRST (even a zero-balance account becomes linked —
    //    then it's simply deleted below; nothing to migrate).
    await this.linkSila(customerId, silaCustomerId);

    // 2. The NET outstanding of the local book.
    const debts = await this.listDebts(customerId);
    const outstanding = debts.reduce(
      (sum, debt) => sum + (debt.migrated === 0 ? debt.amount_minor : 0),
      0,
    );
    const paid = (await this.listPayments(customerId)).reduce(
      (sum, payment) => sum + payment.amount_minor,
      0,
    );
    const net = Math.round(outstanding - paid);
    if (net <= 0) {
      // Nothing to carry over — the person moves to صِلة with a
      // clean slate; the local account is deleted.
      await this.deleteCustomer(customerId);
      logDiag(
        'localDebts',
        `رُبط ${customer.name} بصِلة — لا رصيد قائم، حُذف الحساب المحلي`,
      );
      return {
        migrated: false,
        outstandingMinor: 0,
        creditCoveredMinor: 0,
        netMinor: 0,
      };
    }

    // 3. The prepaid credit the صِلة side carries for this person —
    //    it settles part (or all) of the migrated balance AT THE
    //    SERVER on upload; for the store's books it's a payment
    //    received (the money was prepaid earlier).
    const creditCovered = Math.max(0, Math.min(cachedCreditMinor, net));

    // 4. ONE queue row for the FULL net outstanding — a single
    //    صِلة purchase (the server consumes the credit itself and
    //    adds only net − credit to the outstanding). Proper UUID
    //    idempotency key — the round-22 bug bounced every migration.
    const freshRef = await reserveDebtRef();
    await enqueue({
      idempotencyKey: uuidV4(),
      customerId: silaCustomerId,
      customerName: customer.name,
      amountMinor: net,
      posInvoiceRef: freshRef,
      description: `ترحيل ديون الدفتر المحلي — ${customer.name} (هوية ${customer.id_number})`,
      creditCoveredMinor: creditCovered,
    });

    // 5. Every unmigrated debt is now صِلة's truth.
    await getDb().execute(
      `UPDATE local_debts
       SET migrated = 1, migrated_ref = ?
       WHERE local_customer_id = ? AND migrated = 0`,
      [freshRef, customerId],
    );

    // 6. Delete the LOCAL account (user's explicit round-23 request)
    //    — the person is a صِلة customer now; their QR sales flow to
    //    صِلة directly (bySilaCustomerId finds nothing → no redirect).
    await this.deleteCustomer(customerId);

    logDiag(
      'localDebts',
      `رُحّل رصيد ${customer.name} إلى صِلة: ${net} وحدة صغرى عبر ${freshRef}` +
        (creditCovered > 0 ? ` (غطّى الرصيد المسبق ${creditCovered})` : '') +
        ' — حُذف الحساب المحلي',
    );
    return {
      migrated: true,
      outstandingMinor: net,
      creditCoveredMinor: creditCovered,
      netMinor: net - creditCovered,
    };
  },
};

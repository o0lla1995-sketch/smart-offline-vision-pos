/**
 * InvoiceService — end-to-end checkout flow:
 * invoice numbering → transactional sale creation → cart clearing →
 * optional thermal printing (non-blocking, errors surfaced as toasts).
 */
import {SaleRepo} from '../database/repositories/SaleRepo';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {getDb} from '../database/connection';
import {localToday} from '../core/format';
import {
  getNumber,
  setNumber,
  getString,
  setString,
  KEYS,
} from '../storage/storage';
import {logDiag} from '../core/diagnostics';
import {buildReceiptJob} from './printer/receipt';
import {buildDebtReceiptJob} from './printer/debtReceipt';
import {buildReturnReceiptJob} from './printer/returnReceipt';
import {ThermalPrinterService} from './printer/ThermalPrinterService';
import {SilaRepo} from './sila/SilaRepo';
import {VoucherService} from './VoucherService';
import {LocalDebtsRepo} from '../database/repositories/LocalDebtsRepo';
import {uuidV4} from './sila/qr';
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
} from '../core/types';
import type {ReceiptSettings} from './printer/receipt';

/** INV-YYYYMMDD-NNNN for a day + sequence (CASH series). */
function formatInvoiceNumber(day: string, seq: number): string {
  return `INV-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** v14 (round-20 #3): INV-D-YYYYMMDD-NNNN — the DEBT series. A
 *  distinctive D segment separates credit invoices from cash
 *  invoices at a glance (list, receipt, debt screen), and keeps
 *  the two counters from ever stealing numbers from each other. */
function formatDebtInvoiceNumber(day: string, seq: number): string {
  return `INV-D-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** v23 (round-29 #2): RET-YYYYMMDD-NNNN — the RETURNS series. */
function formatReturnNumber(day: string, seq: number): string {
  return `RET-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** v23: numeric suffix of a RET number (0 when malformed). */
function returnSequence(number: string): number {
  const match = /^(?:RET-\d{8}-)?(\d+)$/.exec(String(number ?? '').trim());
  return match ? parseInt(match[1], 10) : 0;
}

/** v23: the highest RET sequence already stored for a day prefix. */
async function maxReturnSequenceInDb(prefix: string): Promise<number> {
  let max = 0;
  try {
    const result = await getDb().execute(
      'SELECT return_number AS ref FROM sale_returns WHERE return_number LIKE ?',
      [`${prefix}%`],
    );
    for (const row of result.rows ?? []) {
      const seq = returnSequence(String(row.ref ?? ''));
      if (seq > max) {
        max = seq;
      }
    }
  } catch {
    // Fresh installs (table created later by the migration).
  }
  return max;
}

/** v23 (round-29 #2): DB-AWARE reservation for the RET series —
 *  the same reconciliation discipline as the invoice counters:
 *  next = max(MMKV next, highest stored sequence for today) + 1. */
async function reserveReturnNumber(): Promise<string> {
  const today = localToday();
  const prefix = `RET-${today.replace(/-/g, '')}-`;
  const dbMax = await maxReturnSequenceInDb(prefix);
  const lastDay = getString(KEYS.returnDay, '');
  const counter = getNumber(KEYS.returnCounter, 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.returnCounter, next);
  setString(KEYS.returnDay, today);
  return formatReturnNumber(today, next);
}

/** Parses the numeric suffix of a CASH invoice number (0 when
 *  malformed). INV-D-… numbers deliberately do NOT match — they
 *  belong to the debt series. */
function invoiceSequence(number: string): number {
  const match = /^(?:INV-\d{8}-)?(\d+)$/.exec(String(number ?? '').trim());
  return match ? parseInt(match[1], 10) : 0;
}

/** v14 (round-20 #1): numeric suffix of a DEBT invoice number
 *  (0 when malformed, non-debt numbers included). */
function debtInvoiceSequence(number: string): number {
  const match = /^(?:INV-D-\d{8}-)?(\d+)$/.exec(String(number ?? '').trim());
  return match ? parseInt(match[1], 10) : 0;
}

/** The highest invoice sequence already stored for a day prefix. */
async function maxSequenceInDb(prefix: string): Promise<number> {
  let max = 0;
  try {
    const result = await getDb().execute(
      'SELECT invoice_number FROM sales WHERE invoice_number LIKE ?',
      [`${prefix}%`],
    );
    for (const row of result.rows ?? []) {
      const seq = invoiceSequence(String(row.invoice_number ?? ''));
      if (seq > max) {
        max = seq;
      }
    }
  } catch (error) {
    // The reservation still works from the MMKV counter alone.
    logDiag(
      'sale',
      `تعذر قراءة تسلسل الفواتير: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warn',
    );
  }
  return max;
}

/**
 * v14 (round-20 #1): the highest DEBT sequence for a day across BOTH
 * tables that can remember credit numbers —
 *  - sales (INV-D-… invoices actually on this device),
 *  - sila_debt_queue (the pos_invoice_ref of every debt row ever
 *    enqueued here, INCLUDING failed ones whose sale rows were lost
 *    to an old-backup restore — the exact source of the
 *    «تعارض الدين مع رقم فاتورة مسبق» failures: the reservation used
 *    to regenerate a number the queue still holds, the UNIQUE
 *    constraint fired and the whole debt sale collapsed).
 * Reconciling against the queue too means a freshly generated debt
 * number is always AFTER the last one the queue remembers.
 */
async function maxDebtSequenceInDb(debtPrefix: string): Promise<number> {
  let max = 0;
  const consider = (value: unknown) => {
    const seq = debtInvoiceSequence(String(value ?? ''));
    if (seq > max) {
      max = seq;
    }
  };
  try {
    const salesResult = await getDb().execute(
      'SELECT invoice_number FROM sales WHERE invoice_number LIKE ?',
      [`${debtPrefix}%`],
    );
    for (const row of salesResult.rows ?? []) {
      consider(row.invoice_number);
    }
  } catch {
    // Best effort — the MMKV counter alone stays monotonic.
  }
  try {
    const queueResult = await getDb().execute(
      'SELECT pos_invoice_ref FROM sila_debt_queue WHERE pos_invoice_ref LIKE ?',
      [`${debtPrefix}%`],
    );
    for (const row of queueResult.rows ?? []) {
      consider(row.pos_invoice_ref);
    }
  } catch {
    // Table missing on very old installs — ignore.
  }
  return max;
}

/**
 * v10 (round-16 #1): DB-AWARE invoice reservation.
 * ─────────────────────────────────────────────────────────────────
 * The old reservation trusted the MMKV counter alone. After
 * restoring an old backup the database can hold HIGHER invoice
 * numbers for today than the counter — the next sale then generated
 * a number that already existed, hit the UNIQUE constraint and the
 * whole sale failed ("رقم الفاتورة موجود مسبقاً"). The counter now
 * reconciles with the DATABASE on every reservation: the next number
 * is always max(MMKV next, highest stored sequence for today) + 1,
 * so selling continues right after the last registered invoice no
 * matter where the data came from.
 */
async function reserveInvoiceNumber(): Promise<string> {
  const today = localToday();
  const prefix = `INV-${today.replace(/-/g, '')}-`;
  const dbMax = await maxSequenceInDb(prefix);
  const lastDay = getString(KEYS.invoiceDay, '');
  const counter = getNumber(KEYS.invoiceCounter, 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.invoiceCounter, next);
  setString(KEYS.invoiceDay, today);
  return formatInvoiceNumber(today, next);
}

/**
 * v14 (round-20 #1/#3): DB-AWARE reservation for the DEBT series —
 * the same reconciliation discipline as the cash series, but across
 * the debt counter AND both debt-number sources (sales + the صِلة
 * debt queue). The next credit invoice number is always AFTER the
 * last one any of them remembers, so a restored backup or a failed
 * sync row can never make a new debt sale collide with a number the
 * queue (or the صِلة server behind it) already holds.
 */
async function reserveDebtInvoiceNumber(): Promise<string> {
  const today = localToday();
  const prefix = `INV-D-${today.replace(/-/g, '')}-`;
  const dbMax = await maxDebtSequenceInDb(prefix);
  const lastDay = getString(KEYS.debtInvoiceDay, '');
  const counter = getNumber(KEYS.debtInvoiceCounter, 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.debtInvoiceCounter, next);
  setString(KEYS.debtInvoiceDay, today);
  return formatDebtInvoiceNumber(today, next);
}

/** v14 (round-20 #1): "YYYYMMDD" → "YYYY-MM-DD". */
function dayOf(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * v14 (round-20 #1): NEVER-BACKWARDS counter reconcile.
 * Picks, per series, whichever (day, sequence) is further along —
 * the LATER day wins outright; the same day keeps the HIGHER
 * sequence. An older restore can pull the database behind, but the
 * MMKV counters stay at the furthest point this device ever reached,
 * so the next invoice of that series continues after the last one
 * ever issued here (what the merchant asked for verbatim).
 */
function reconcileNeverBackwards(
  byDay: Map<string, number>,
  dayKey: string,
  counterKey: string,
): void {
  let dbDay = '';
  let dbSeq = 0;
  for (const [day, seq] of byDay) {
    if (day > dbDay) {
      dbDay = day;
      dbSeq = seq;
    } else if (day === dbDay && seq > dbSeq) {
      dbSeq = seq;
    }
  }
  const mmkvDay = getString(dayKey, '');
  const mmkvSeq = getNumber(counterKey, 0);
  if (dbDay === '') {
    return; // Nothing new to learn for this series.
  }
  if (mmkvDay > dbDay || (mmkvDay === dbDay && mmkvSeq >= dbSeq)) {
    // MMKV is already at (or past) the DB — keep it. Moving it
    // backwards here is exactly the rewind that re-issued numbers
    // the صِلة server already holds.
    return;
  }
  setString(dayKey, dbDay);
  setNumber(counterKey, dbSeq);
}

export interface CompleteSaleOptions {
  lines: CartLine[];
  discount: number;
  paymentType: PricingMode;
  /** Print the receipt right after a successful sale. */
  print: boolean;
  receiptSettings: ReceiptSettings;
  /** Callbacks for user feedback. */
  onPrintError?: (message: string) => void;
  productNames?: Map<number, string>;
  /** v11 (SILA §9.2): when set the sale is a SILA deferred debt —
   *  a debt_queue row is created at sale time with ONE idempotency
   *  key (§7 rule 1) and the receipt uses the debt template with
   *  the customer block + pending-sync note. */
  debt?: {
    customerId: string | null;
    customerName: string;
    customerPhoneLast4: string | null;
    customerCard: string | null;
    offlineQr: string | null;
    /** The DEBT amount in minor units — from the signed offline QR
     *  when present, otherwise the invoice total (§4 rules). */
    amountMinor: number;
    /** v17 (round-23 #3): the prepaid-credit part the server is
     *  expected to absorb (min(amount, cached credit)) — the store
     *  books the invoice as PAID by this much. */
    creditCoveredMinor?: number;
  };
  /** v16 (round-22 #4): when set the sale is a STORE-LOCAL credit
   *  sale (دفتر المتجر) — the debt lands ONLY in local_debts (INV-L
   *  series) and never syncs to صِلة. The debt amount is always the
   *  invoice total. */
  localDebt?: {
    localCustomerId: number;
    customerName: string;
    customerPhoneLast4: string | null;
  };
}

export const InvoiceService = {
  async completeSale(options: CompleteSaleOptions): Promise<SaleWithItems> {
    // v10 (round-16 #1): a UNIQUE collision (a number this device
    // didn't know about — e.g. mid-sale restore races) re-reserves
    // from the DB and retries instead of failing the sale.
    // v14 (round-20 #1): debt sales reserve from the SEPARATE
    // INV-D series and v14 (round-20 #2) the debt-queue row joins
    // the SAME transaction — a UNIQUE hit on either sales or
    // sila_debt_queue rolls EVERYTHING back and the loop retries
    // with a fresh number. A failed debt sale is therefore never
    // half-recorded: no invoice, no stock decrement, no queue row.
    const isDebt = options.debt != null;
    const isLocalDebt = options.localDebt != null;
    let result: SaleWithItems | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4 && result == null; attempt += 1) {
      const invoiceNumber = isDebt
        ? await reserveDebtInvoiceNumber()
        : isLocalDebt
        ? await LocalDebtsRepo.reserveLocalDebtRef()
        : await reserveInvoiceNumber();
      try {
        // One atomic transaction: sale + items + stock decrements
        // (+ the debt-queue row for credit sales).
        result = await SaleRepo.createSale({
          invoiceNumber,
          lines: options.lines,
          discount: options.discount,
          paymentType: options.paymentType,
          debtRow:
            options.debt == null
              ? undefined
              : {
                  idempotencyKey: uuidV4(),
                  customerId: options.debt.customerId,
                  customerName: options.debt.customerName,
                  customerPhoneLast4: options.debt.customerPhoneLast4,
                  customerCard: options.debt.customerCard,
                  offlineQr: options.debt.offlineQr,
                  amountMinor: options.debt.amountMinor,
                  creditCoveredMinor: options.debt.creditCoveredMinor ?? 0,
                  description: `بيع بالدين — فاتورة ${invoiceNumber}`,
                  scannedAt: new Date().toISOString(),
                },
          localDebtRow:
            options.localDebt == null
              ? undefined
              : {
                  localCustomerId: options.localDebt.localCustomerId,
                  customerName: options.localDebt.customerName,
                  amountMinor: (() => {
                    // Mirror SaleRepo's total: subtotal − clamped
                    // discount (the debt is ALWAYS the invoice total
                    // for local book sales — no signed QR involved).
                    const subtotal = options.lines.reduce(
                      (sum, line) => sum + line.unitPrice * line.quantity,
                      0,
                    );
                    const discount = Math.min(
                      Math.max(options.discount, 0),
                      subtotal,
                    );
                    return Math.round((subtotal - discount) * 100);
                  })(),
                  description: `بيع بالدين (دفتر المتجر) — فاتورة ${invoiceNumber}`,
                },
        });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/UNIQUE/i.test(message)) {
          throw error;
        }
        logDiag(
          'sale',
          `تضارب رقم الفاتورة ${invoiceNumber} — إعادة الحجز من قاعدة البيانات`,
          'warn',
        );
      }
    }
    if (result == null) {
      throw lastError instanceof Error
        ? lastError
        : new Error(
            isDebt
              ? 'تعذر حجز رقم فاتورة الدين — لم يُسجَّل البيع، أعد المحاولة'
              : 'تعذر حجز رقم فاتورة — حاول مرة أخرى',
          );
    }

    logDiag(
      'sale',
      `تم إتمام البيع ${result.sale.invoice_number}${
        isDebt ? ' (دين)' : ''
      } بمبلغ ${result.sale.total_amount.toFixed(2)} ₪`,
    );

    if (options.print) {
      try {
        const names =
          options.productNames ??
          new Map<number, string>(
            options.lines.map(line => [line.productId, line.name]),
          );
        // v21 (round-27 #6): the debt pair for the receipt — «قيمة
        //  هذا الدين» + «إجمالي الديون على الزبون» (both books).
        //  صِلة: cached server balance (which can't know this fresh
        //  invoice yet) + this invoice's NET debt (amount − prepaid
        //  coverage). Local: the LIVE outstanding after the sale
        //  transaction (the INV-L row was created inside it, so the
        //  new invoice is already included).
        let silaThisDebtMinor: number | null = null;
        let silaTotalDebtsMinor: number | null = null;
        if (options.debt != null) {
          silaThisDebtMinor = Math.max(
            0,
            options.debt.amountMinor - (options.debt.creditCoveredMinor ?? 0),
          );
          if (options.debt.customerId) {
            const cached = await SilaRepo.findCustomer(options.debt.customerId);
            if (cached != null) {
              silaTotalDebtsMinor =
                Math.max(0, cached.outstanding_minor) + silaThisDebtMinor;
            }
          }
        }
        let localTotalDebtsMinor: number | null = null;
        if (options.localDebt != null) {
          localTotalDebtsMinor = await LocalDebtsRepo.outstandingFor(
            options.localDebt.localCustomerId,
          );
        }
        const job =
          options.debt != null
            ? buildDebtReceiptJob(
                {
                  sale: result.sale,
                  items: result.items,
                  productNameById: names,
                  customerName: options.debt.customerName,
                  customerPhoneLast4: options.debt.customerPhoneLast4,
                  referenceCode: null,
                  mode: 'sila',
                  creditCoveredMinor: options.debt.creditCoveredMinor ?? 0,
                  thisDebtMinor: silaThisDebtMinor,
                  customerTotalDebtsMinor: silaTotalDebtsMinor,
                },
                options.receiptSettings,
              )
            : options.localDebt != null
            ? buildDebtReceiptJob(
                {
                  sale: result.sale,
                  items: result.items,
                  productNameById: names,
                  customerName: options.localDebt.customerName,
                  customerPhoneLast4: options.localDebt.customerPhoneLast4,
                  referenceCode: null,
                  mode: 'local',
                  thisDebtMinor: Math.round(result.sale.total_amount * 100),
                  customerTotalDebtsMinor: localTotalDebtsMinor,
                },
                options.receiptSettings,
              )
            : buildReceiptJob(
                {
                  sale: result.sale,
                  items: result.items,
                  productNameById: names,
                },
                options.receiptSettings,
              );
        await ThermalPrinterService.printJob(job);
      } catch (error) {
        // The SALE IS SAVED — printing failure must never roll it back.
        const message = error instanceof Error ? error.message : String(error);
        logDiag('sale', `البيع تم حفظه لكن الطباعة فشلت: ${message}`, 'warn');
        options.onPrintError?.(message);
      }
    }

    return result;
  },

  /** Rebuilds a printable job for an already-saved invoice.
   *  v17 (round-23 #1): DEBT invoices (INV-D صِلة / INV-L دفتر
   *  المتجر) reprint with the DEBT template — the customer block is
   *  the whole point of a debt receipt, and it used to vanish on
   *  every reprint from the invoice center (the normal template has
   *  no customer line). */
  async reprintInvoice(
    saleId: number,
    receiptSettings: ReceiptSettings,
  ): Promise<void> {
    const sale = await SaleRepo.listRecent(500);
    const record = sale.find(entry => entry.id === saleId);
    if (!record) {
      throw new Error('الفاتورة غير موجودة');
    }
    const items = await SaleRepo.getItemsForSale(saleId);
    const names = new Map<number, string>();
    for (const item of items) {
      if (!names.has(item.product_id)) {
        const product = await ProductRepo.getById(item.product_id);
        names.set(item.product_id, product?.name ?? `#${item.product_id}`);
      }
    }

    // ── v17 (round-23 #1): debt-invoice reprints keep the debt look ──
    const ref = record.invoice_number;
    // v23 (round-29 #2): RET rows reprint with the RETURN template —
    //  the original-invoice block + the debt adjustment lines.
    if (ref.startsWith('RET-') || record.return_kind != null) {
      const ret = await SaleRepo.returnByNumber(ref);
      if (ret == null) {
        throw new Error('سجل المرتجع غير موجود');
      }
      const retItems = await SaleRepo.returnItems(ret.id);
      const job = buildReturnReceiptJob(
        {ret, items: retItems},
        receiptSettings,
      );
      await ThermalPrinterService.printJob(job);
      return;
    }
    // v20: VOUCHER redemptions (INV-V) reprint with the voucher
    // template — the campaign block + the official POS-VR reference
    // are the whole point of that receipt.
    if (ref.startsWith('INV-V-')) {
      await VoucherService.reprintByReceiptRef(ref, receiptSettings);
      return;
    }
    if (ref.startsWith('INV-D-')) {
      // صِلة debt — the queue row carries the creditor + the
      // official POS-… reference once synced.
      const debt = await SilaRepo.byInvoiceRef(ref);
      // v21 (round-27 #6): the debt pair. A SYNCED row is already
      //  inside the cached server balance — the pending row's net
      //  debt is added on top of it.
      const silaThisDebt =
        debt != null
          ? Math.max(0, debt.amount_minor - debt.credit_covered_minor)
          : Math.round(record.total_amount * 100);
      let silaTotal: number | null = null;
      if (debt?.customer_id) {
        const cached = await SilaRepo.findCustomer(debt.customer_id);
        if (cached != null) {
          silaTotal =
            debt.state === 'synced'
              ? Math.max(0, cached.outstanding_minor)
              : Math.max(0, cached.outstanding_minor) + silaThisDebt;
        }
      }
      const job = buildDebtReceiptJob(
        {
          sale: record,
          items,
          productNameById: names,
          customerName: debt?.customer_name ?? 'زبون صِلة',
          customerPhoneLast4: debt?.customer_phone_last4 ?? null,
          referenceCode: debt?.reference_code ?? null,
          mode: 'sila',
          creditCoveredMinor: debt?.credit_covered_minor ?? 0,
          thisDebtMinor: silaThisDebt,
          customerTotalDebtsMinor: silaTotal,
        },
        receiptSettings,
      );
      await ThermalPrinterService.printJob(job);
      return;
    }
    if (ref.startsWith('INV-L-')) {
      // دفتر المتجر debt — the local book carries the creditor.
      const local = await LocalDebtsRepo.creditorByInvoiceRef(ref);
      // v21 (round-27 #6): the LIVE outstanding (includes this
      //  invoice — its INV-L row was created with the sale).
      const localTotal =
        local?.localCustomerId != null
          ? await LocalDebtsRepo.outstandingFor(local.localCustomerId)
          : null;
      const job = buildDebtReceiptJob(
        {
          sale: record,
          items,
          productNameById: names,
          customerName: local?.name ?? 'زبون الدفتر',
          customerPhoneLast4: local?.phone
            ? local.phone.replace(/\D/g, '').slice(-4)
            : null,
          referenceCode: null,
          mode: 'local',
          thisDebtMinor: Math.round(record.total_amount * 100),
          customerTotalDebtsMinor: localTotal,
        },
        receiptSettings,
      );
      await ThermalPrinterService.printJob(job);
      return;
    }

    const job = buildReceiptJob(
      {sale: record, items, productNameById: names},
      receiptSettings,
    );
    await ThermalPrinterService.printJob(job);
  },

  /**
   * v11 (SILA): reprints a debt receipt BY INVOICE REFERENCE —
   * includes the customer block and, once synced, the official
   * POS-… reference code.
   */
  async reprintDebtReceiptByRef(
    invoiceRef: string,
    receiptSettings: ReceiptSettings,
  ): Promise<void> {
    const debt = await SilaRepo.byInvoiceRef(invoiceRef);
    if (debt == null) {
      throw new Error('هذه ليست فاتورة دين صِلة');
    }
    const sales = await SaleRepo.listRecent(500);
    const record = sales.find(entry => entry.invoice_number === invoiceRef);
    if (!record) {
      throw new Error('الفاتورة غير موجودة');
    }
    const items = await SaleRepo.getItemsForSale(record.id);
    const names = new Map<number, string>();
    for (const item of items) {
      if (!names.has(item.product_id)) {
        const product = await ProductRepo.getById(item.product_id);
        names.set(item.product_id, product?.name ?? `#${item.product_id}`);
      }
    }
    // v21 (round-27 #6): the debt pair — synced rows are already in
    //  the cached server balance; pending rows add their net debt.
    const silaThisDebt = Math.max(
      0,
      debt.amount_minor - debt.credit_covered_minor,
    );
    let silaTotal: number | null = null;
    if (debt.customer_id) {
      const cached = await SilaRepo.findCustomer(debt.customer_id);
      if (cached != null) {
        silaTotal =
          debt.state === 'synced'
            ? Math.max(0, cached.outstanding_minor)
            : Math.max(0, cached.outstanding_minor) + silaThisDebt;
      }
    }
    const job = buildDebtReceiptJob(
      {
        sale: record,
        items,
        productNameById: names,
        customerName: debt.customer_name ?? 'زبون صِلة',
        customerPhoneLast4: debt.customer_phone_last4,
        referenceCode: debt.reference_code,
        mode: 'sila',
        creditCoveredMinor: debt.credit_covered_minor,
        thisDebtMinor: silaThisDebt,
        customerTotalDebtsMinor: silaTotal,
      },
      receiptSettings,
    );
    await ThermalPrinterService.printJob(job);
  },

  /**
   * v10 (round-16 #1) → v14 (round-20 #1): re-syncs the MMKV invoice
   * counters with the DATABASE after a backup restore.
   * ─────────────────────────────────────────────────────────────────
   * v10 reconciled by OVERWRITING the counter from the DB — correct
   * when the restore brought NEWER numbers, but it also moved the
   * counter BACKWARDS when the restore was OLDER than what this
   * device had already issued. The next sale then regenerated a
   * number the صِلة server still remembers (it never forgets a
   * pos_invoice_ref) → DUPLICATE_INVOICE_REF → «عملية الدين فاشلة»
   * — the merchant's exact complaint: the debt conflicted with a
   * pre-existing invoice number because no invoice was created after
   * the last one.
   * v14 rule: the counters only ever move FORWARD. For each series
   * (cash INV-… and debt INV-D-…) the reconcile picks whichever
   * (day, sequence) is further along — the later day wins, and
   * within the same day the higher sequence wins. Restoring an old
   * backup can therefore lower the DATABASE contents but never the
   * numbering: the next invoice of each series is always issued
   * AFTER the last one this device ever printed, exactly as the
   * merchant expects. Debt numbers additionally reconcile against
   * the sila_debt_queue refs (failed rows can outlive their sales).
   */
  async syncInvoiceCounterFromDb(): Promise<void> {
    try {
      const result = await getDb().execute('SELECT invoice_number FROM sales');
      const cashByDay = new Map<string, number>();
      const debtByDay = new Map<string, number>();
      for (const row of result.rows ?? []) {
        const value = String(row.invoice_number ?? '').trim();
        let match = /^INV-(\d{8})-(\d+)$/.exec(value);
        if (match != null) {
          const day = dayOf(match[1]);
          cashByDay.set(
            day,
            Math.max(cashByDay.get(day) ?? 0, parseInt(match[2], 10)),
          );
          continue;
        }
        match = /^INV-D-(\d{8})-(\d+)$/.exec(value);
        if (match != null) {
          const day = dayOf(match[1]);
          debtByDay.set(
            day,
            Math.max(debtByDay.get(day) ?? 0, parseInt(match[2], 10)),
          );
        }
      }
      // Debt refs also live in the queue — failed rows can outlive
      // their sales rows (old-backup restores), so count them too.
      try {
        const queue = await getDb().execute(
          'SELECT pos_invoice_ref FROM sila_debt_queue',
        );
        for (const row of queue.rows ?? []) {
          const match = /^INV-D-(\d{8})-(\d+)$/.exec(
            String(row.pos_invoice_ref ?? '').trim(),
          );
          if (match != null) {
            const day = dayOf(match[1]);
            debtByDay.set(
              day,
              Math.max(debtByDay.get(day) ?? 0, parseInt(match[2], 10)),
            );
          }
        }
      } catch {
        // Very old installs without the table — sales cover it.
      }

      reconcileNeverBackwards(cashByDay, KEYS.invoiceDay, KEYS.invoiceCounter);
      reconcileNeverBackwards(
        debtByDay,
        KEYS.debtInvoiceDay,
        KEYS.debtInvoiceCounter,
      );

      logDiag(
        'sale',
        `تمت مزامنة عدادات الفواتير (نقدي ${getString(
          KEYS.invoiceDay,
          '',
        )} #${getNumber(KEYS.invoiceCounter, 0)} / دين ${getString(
          KEYS.debtInvoiceDay,
          '',
        )} #${getNumber(
          KEYS.debtInvoiceCounter,
          0,
        )}) — لا تتراجع الأرقام أبداً`,
      );
    } catch (error) {
      // The DB-aware reservation still recovers on the next sale.
      logDiag(
        'sale',
        `تعذر مزامنة عداد الفواتير: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'warn',
      );
    }
  },

  /** v16 (round-22 #1): a FRESH debt number for renumbering a debt
   *  whose upload collided server-side (DUPLICATE_INVOICE_REF after a
   *  reinstall restarted the numbering). Uses the same DB-aware
   *  never-rewind reservation as a new sale. */
  async reserveDebtNumberForRenumber(): Promise<string> {
    return reserveDebtInvoiceNumber();
  },

  /**
   * v16 (round-22 #1): advance the TODAY counters past refs the صِلة
   * server already remembers.
   * ─────────────────────────────────────────────────────────────────
   * The server NEVER forgets a pos_invoice_ref / pos_receipt_ref — a
   * fresh install (or an old-backup restore) can re-issue numbers the
   * server holds from an earlier device, so every upload answers
   * DUPLICATE_*_REF. The refs the server knows are visible in the
   * customers feed (recent_entries / recent_pos_refs) — after pairing
   * and after a restore we bump today's debt + receipt counters beyond
   * the highest sequence seen there, so most new numbers are fresh
   * from the start (the renumber path covers whatever the feed didn't
   * show — it only carries the last entries per customer).
   */
  async advanceCountersFromServerRefs(
    refs: string[],
  ): Promise<{debt: number; receipts: number}> {
    const today = localToday();
    const compact = today.replace(/-/g, '');
    let debtMax = 0;
    let receiptMax = 0;
    for (const raw of refs) {
      const value = String(raw ?? '').trim();
      let match = /^INV-D-(\d{8})-(\d+)$/.exec(value);
      if (match != null) {
        if (match[1] === compact) {
          debtMax = Math.max(debtMax, parseInt(match[2], 10));
        }
        continue;
      }
      match = /^RCP-(\d{8})-(\d+)$/.exec(value);
      if (match != null && match[1] === compact) {
        receiptMax = Math.max(receiptMax, parseInt(match[2], 10));
      }
    }
    // Debt series.
    const debtDay = getString(KEYS.debtInvoiceDay, '');
    const debtCounter = getNumber(KEYS.debtInvoiceCounter, 0);
    const debtNext = Math.max(
      debtDay === today ? debtCounter + 1 : 1,
      debtMax + 1,
    );
    if (debtNext > (debtDay === today ? debtCounter + 1 : 1)) {
      setNumber(KEYS.debtInvoiceCounter, debtNext);
      setString(KEYS.debtInvoiceDay, today);
      logDiag('sale', `تقدّم عداد ديون اليوم خلف صِلة حتى #${debtNext}`);
    }
    // Receipt series.
    const receiptDay = getString(KEYS.paymentReceiptDay, '');
    const receiptCounter = getNumber(KEYS.paymentReceiptCounter, 0);
    const receiptNext = Math.max(
      receiptDay === today ? receiptCounter + 1 : 1,
      receiptMax + 1,
    );
    if (receiptNext > (receiptDay === today ? receiptCounter + 1 : 1)) {
      setNumber(KEYS.paymentReceiptCounter, receiptNext);
      setString(KEYS.paymentReceiptDay, today);
      logDiag('sila', `تقدّم عداد إيصالات اليوم خلف صِلة حتى #${receiptNext}`);
    }
    return {debt: debtMax, receipts: receiptMax};
  },

  // ── v23 (round-29 #2): THE RETURNS FLOW ─────────────────────

  /** Everything the ReturnSheet needs before the merchant picks
   *  quantities: the invoice's lines with their remaining (not yet
   *  returned) quantities, the book this invoice belongs to, the
   *  debt rows' state and the pro-rata discount ratio.
   *
   *  Blocks impossible returns up front with a THROWN Arabic reason:
   *  voucher invoices (INV-V — settled with the institution, not
   *  returnable here), return receipts themselves (RET-), and a
   *  صِلة debt still mid-upload ('syncing' — wait for the sync). */
  async prepareReturn(saleId: number): Promise<{
    sale: SaleRecord;
    lines: {
      item: SaleItemRecord;
      productName: string;
      remaining: number;
    }[];
    book: ReturnBook;
    /** Pro-rata ratio: invoice total / pre-discount subtotal. */
    discountRatio: number;
    /** The debt context for the confirmation card. */
    debtLabel: string | null;
    debtState:
      | {kind: 'sila-synced'; amountMinor: number}
      | {kind: 'sila-pending'; amountMinor: number}
      | {kind: 'local'; amountMinor: number}
      | {kind: 'migrated'}
      | {kind: 'missing'}
      | {kind: 'none'}
      | {kind: 'blocked'; reason: string};
    returnsSoFar: SaleReturnRecord[];
  }> {
    const sale = await SaleRepo.getById(saleId);
    if (sale == null) {
      throw new Error('الفاتورة غير موجودة');
    }
    const ref = sale.invoice_number;
    if (ref.startsWith('RET-') || sale.return_kind != null) {
      throw new Error('هذه فاتورة مرتجع — لا يمكن الإرجاع من مرتجع');
    }
    if (ref.startsWith('INV-V-')) {
      throw new Error(
        'فواتير القسائم تُسوّى مع المؤسسة عبر صفحة القسائم — لا تُرجع من هنا',
      );
    }

    const items = await SaleRepo.getItemsForSale(saleId);
    if (items.length === 0) {
      throw new Error('لا أصناف في هذه الفاتورة');
    }
    const returnedQty = await SaleRepo.returnedQtyByLine(saleId);
    const returnsSoFar = await SaleRepo.returnsForSale(saleId);

    const nameMap = new Map<number, string>();
    for (const item of items) {
      if (!nameMap.has(item.product_id)) {
        const product = await ProductRepo.getById(item.product_id);
        nameMap.set(item.product_id, product?.name ?? `#${item.product_id}`);
      }
    }
    const lines = items
      .map(item => ({
        item,
        // v35 (الجولة 43): وصف المتغير مع الاسم — «تيشيرت (أسود · L)»
        //  أو «شاي (كبير)» — كي يميز التاجر الأصناف المتشابهة.
        productName:
          (nameMap.get(item.product_id) ?? `#${item.product_id}`) +
          (item.variant_label ? ` (${item.variant_label})` : ''),
        remaining: Math.max(0, item.quantity - (returnedQty.get(item.id) ?? 0)),
      }))
      .filter(line => line.remaining > 0.0001);
    if (lines.length === 0) {
      throw new Error('أُرجعت كل أصناف هذه الفاتورة سابقاً');
    }

    const subtotal = sale.total_amount + sale.discount;
    const discountRatio = subtotal > 0.0001 ? sale.total_amount / subtotal : 1;

    // ── The book + the debt context ──
    let book: ReturnBook = 'cash';
    let debtLabel: string | null = null;
    let debtState:
      | {kind: 'sila-synced'; amountMinor: number}
      | {kind: 'sila-pending'; amountMinor: number}
      | {kind: 'local'; amountMinor: number}
      | {kind: 'migrated'}
      | {kind: 'missing'}
      | {kind: 'none'}
      | {kind: 'blocked'; reason: string} = {kind: 'none'};

    if (ref.startsWith('INV-D-')) {
      book = 'sila';
      const debt = await SilaRepo.byInvoiceRef(ref);
      debtLabel = debt?.customer_name ?? 'زبون صِلة';
      if (debt == null) {
        debtState = {
          kind: 'missing',
        };
      } else if (debt.state === 'syncing') {
        debtState = {
          kind: 'blocked',
          reason:
            'دين صِلة قيد الرفع للخادم الآن — انتظر اكتمال المزامنة ثم أعد المحاولة',
        };
      } else if (debt.state === 'synced') {
        debtState = {kind: 'sila-synced', amountMinor: debt.amount_minor};
      } else {
        debtState = {kind: 'sila-pending', amountMinor: debt.amount_minor};
      }
    } else if (ref.startsWith('INV-L-')) {
      book = 'local';
      const debt = await LocalDebtsRepo.debtRowByRef(ref);
      const creditor = await LocalDebtsRepo.creditorByInvoiceRef(ref);
      debtLabel = creditor?.name ?? 'زبون الدفتر';
      if (debt == null) {
        debtState = {kind: 'missing'};
      } else if (debt.migrated) {
        debtState = {kind: 'migrated'};
      } else {
        debtState = {kind: 'local', amountMinor: debt.amountMinor};
      }
    }

    return {
      sale,
      lines,
      book,
      discountRatio,
      debtLabel,
      debtState,
      returnsSoFar,
    };
  },

  /** v23 (round-29 #2): executes a return — reserves the RET number
   *  (DB-aware, UNIQUE-retry), runs the ONE-transaction return in
   *  SaleRepo, then prints the return slip (a print failure never
   *  rolls the return back — same discipline as sales). */
  async createReturn(input: {
    saleId: number;
    lines: ReturnLineInput[];
    refundMethod: 'none' | 'cash';
    note?: string | null;
    print: boolean;
    receiptSettings: ReceiptSettings;
    onPrintError?: (message: string) => void;
    /** v36→v40 (الجولة 48 #2): الاستبدال بقيمة المرجع — الفرق بين
     *  قيمة المرتجع وقيمة البدائل يُسوّى مالياً: زبون دين (محلي أو
     *  صلة) يزيد أو ينقص دينه بالفرق؛ زبون نقدي يستلم الفرق من
     *  الخزينة أو يدفعه إليها (عبر صف RET الصافي). */
    exchange?: ExchangeLineInput[];
  }): Promise<SaleReturnRecord> {
    const prep = await this.prepareReturn(input.saleId);

    // Re-validate against the PREP state (the sheet may be stale).
    if (prep.debtState.kind === 'blocked') {
      throw new Error(prep.debtState.reason);
    }
    for (const line of input.lines) {
      const known = prep.lines.find(l => l.item.id === line.saleItemId);
      if (known == null || line.quantity > known.remaining + 0.0001) {
        throw new Error(
          `الكمية المطلوب إرجاعها من «${line.productName}» أكبر من المتبقي`,
        );
      }
      if (line.quantity <= 0) {
        throw new Error('كمية الإرجاع غير صالحة');
      }
    }

    // ── v40 (الجولة 48 #2): الفرق بالسعر بين المرتجع والبدائل ──
    const exchangeMode = (input.exchange?.length ?? 0) > 0;
    const refundDiffMinor = exchangeMode
      ? Math.round(
          (input.lines.reduce(
            (sum, line) => sum + line.unitPrice * line.quantity,
            0,
          ) -
            (input.exchange ?? []).reduce(
              (sum, line) => sum + line.unitPrice * line.quantity,
              0,
            )) *
            prep.discountRatio *
            100,
        )
      : 0;
    // v40: دين محلي مفقود (سُدّد وحُذف) + بدائل أغلى = زيادة دين لا
    // يمكن تسجيلها تلقائياً (الصف غير موجود لنعرف الزبون) — تُرفض
    // العملية برسالة واضحة قبل أي كتابة، والتاجر يسجلها يدوياً من
    // دفتر الزبائن (نفس انضباط migrated في الإرجاع العادي).
    if (
      exchangeMode &&
      prep.book === 'local' &&
      refundDiffMinor < 0 &&
      prep.debtState.kind === 'missing'
    ) {
      throw new Error(
        'دين هذه الفاتورة مسدَّد ومحذوف من الدفتر — لا يمكن زيادة دين غير موجود تلقائياً؛ سجّل الفرق يدوياً من دفتر الزبائن أو أرجع مالياً وبِع البدائل',
      );
    }

    // The sila reversal payload — ONLY for already-synced debts (the
    // queue row keeps its amount; the reversal payment reduces the
    // customer's debt on the صلة server, exactly like a repayment).
    // The upload receipt ref uses the API's own RCP-… series (kept
    // unique by the same reservation as cashier repayments).
    // v40 (الجولة 48 #2): في وضع الاستبدال مبلغ العكس = الفرق فقط
    // حين يكون المرتجع أغلى (فرق موجب)؛ البدائل الأغلى تتحول إلى
    // زيادة دين (silaDebtIncrease أدناه) بدل العكس.
    let silaReversal: {
      customerId: string | null;
      customerName: string | null;
      customerPhoneLast4: string | null;
      amountMinor: number;
      posReceiptRef: string;
      idempotencyKey: string;
    } | null = null;
    // v40: زيادة دين صلة المتزامن — البدائل أغلى من المرتجع بفارق
    // يُرفع للخادم كصف دين جديد فوري التسمية (رقم الإشعار + -EX).
    let silaDebtIncrease: {
      customerId: string | null;
      customerName: string | null;
      customerPhoneLast4: string | null;
      amountMinor: number;
      posInvoiceRef: string;
      idempotencyKey: string;
      description: string;
    } | null = null;
    if (prep.book === 'sila' && prep.debtState.kind === 'sila-synced') {
      const debt = await SilaRepo.byInvoiceRef(prep.sale.invoice_number);
      if (debt != null) {
        if (!exchangeMode || refundDiffMinor > 0) {
          // الإرجاع العادي: عكس كامل قيمة المرتجع؛ الاستبدال بمرتجع
          // أغلى: عكس الفرق فقط.
          const reverseMinor = exchangeMode
            ? refundDiffMinor
            : Math.round(
                input.lines.reduce(
                  (sum, line) => sum + line.unitPrice * line.quantity,
                  0,
                ) *
                  prep.discountRatio *
                  100,
              );
          silaReversal = {
            customerId: debt.customer_id,
            customerName: debt.customer_name,
            customerPhoneLast4: debt.customer_phone_last4,
            amountMinor: Math.min(reverseMinor, debt.amount_minor),
            posReceiptRef: await SilaRepo.reserveReceiptRef(),
            idempotencyKey: uuidV4(),
          };
        } else if (exchangeMode && refundDiffMinor < 0) {
          // v40: البدائل أغلى — دين إضافي على الزبون يرفع للخادم.
          silaDebtIncrease = {
            customerId: debt.customer_id,
            customerName: debt.customer_name,
            customerPhoneLast4: debt.customer_phone_last4,
            amountMinor: -refundDiffMinor,
            posInvoiceRef: '',
            idempotencyKey: uuidV4(),
            description: '',
          };
        }
      }
    }

    let result: SaleReturnRecord | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4 && result == null; attempt += 1) {
      const returnNumber = await reserveReturnNumber();
      try {
        // v40 (الجولة 48 #2): مرجع زيادة دين صلة يُشتق من رقم هذا
        // الإشعار نفسه — فريد بحكم تفرّد الأرقام، ومستقر عبر محاولات
        // UNIQUE-retry (كل محاولة برقمها ومعرّف تكرار جديد).
        const debtIncreasePayload =
          silaDebtIncrease != null
            ? {
                ...silaDebtIncrease,
                posInvoiceRef: `${returnNumber}-EX`,
                description: `فرق استبدال بضاعة — فاتورة ${prep.sale.invoice_number} (إشعار ${returnNumber})`,
              }
            : null;
        result = await SaleRepo.createReturn({
          returnNumber,
          saleId: input.saleId,
          invoiceRef: prep.sale.invoice_number,
          book: prep.book,
          refundMethod: input.refundMethod,
          discountRatio: prep.discountRatio,
          lines: input.lines,
          silaReversal,
          note: input.note,
          exchange: input.exchange,
          silaDebtIncrease: debtIncreasePayload,
        });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/UNIQUE/i.test(message)) {
          throw error;
        }
        logDiag(
          'sale',
          `تضارب رقم المرتجع ${returnNumber} — إعادة الحجز من قاعدة البيانات`,
          'warn',
        );
      }
    }
    if (result == null) {
      throw lastError instanceof Error
        ? lastError
        : new Error('تعذر حجز رقم مرتجع — حاول مرة أخرى');
    }

    if ((input.exchange?.length ?? 0) > 0) {
      // v40 (الجولة 48 #2): رسالة السجل تشرح تسوية الفرق — نقدي
      // (خرج/دخل الخزينة) أو دين (خصم/زيادة) أو استبدال متكافئ.
      const diffText =
        refundDiffMinor === 0
          ? 'استبدال متكافئ — لا فرق'
          : refundDiffMinor > 0
          ? `الفرق ${(refundDiffMinor / 100).toFixed(2)} ₪ لصالح الزبون — ${
              prep.book === 'cash'
                ? 'سُلِّم نقداً من الخزينة'
                : 'خُصم من دينه'
            }`
          : `الفرق ${(-refundDiffMinor / 100).toFixed(2)} ₪ على الزبون — ${
              prep.book === 'cash'
                ? 'قُبض نقداً للخزينة'
                : 'زاد به دينه'
            }`;
      logDiag(
        'sale',
        `استبدال بقيمة المرجع: ${input.lines.length} صنف مرتجع و${
          (input.exchange ?? []).length
        } بديل من ${prep.sale.invoice_number} بإيصال ${
          result.return_number
        } — ${diffText}`,
      );
    } else {
      logDiag(
        'sale',
        `تم إرجاع ${input.lines.length} صنف من ${
          prep.sale.invoice_number
        } بإيصال ${result.return_number} بقيمة ${(
          result.refund_minor / 100
        ).toFixed(2)} ₪`,
      );
    }

    // v26 (round-34 #3): a synced-debt return left a reversal payment
    // in the queue — push it to the صِلة server RIGHT AWAY (fire and
    // forget) so the customer's debt drops server-side and the
    // refreshed balances reach the Home/reports screens on the next
    // focus, instead of waiting for the periodic cycle. Lazy require:
    // SilaSync imports THIS module (counters), so a top-level import
    // would create a cycle.
    // v40 (الجولة 48 #2): زيادة دين الاستبدال في الطابور أيضاً —
    // نفس الدفعة الفورية كي يرتفع دين الزبون على الخادم فوراً.
    if (silaReversal != null || silaDebtIncrease != null) {
      try {
        const {SilaSync} = require('./sila/SilaSync') as typeof import(
          './sila/SilaSync'
        );
        void SilaSync.syncNow().catch(() => undefined);
      } catch {
        // The sync engine is unavailable mid-test — the queue keeps
        // the row; the next cycle uploads it either way.
      }
    }

    if (input.print) {
      try {
        const items: SaleReturnItem[] = await SaleRepo.returnItems(result.id);
        const exchanges: SaleReturnExchange[] = await SaleRepo.returnExchanges(
          result.id,
        );
        const job = buildReturnReceiptJob(
          {ret: result, items, exchanges},
          input.receiptSettings,
        );
        await ThermalPrinterService.printJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDiag('sale', `المرتجع سُجّل لكن الطباعة فشلت: ${message}`, 'warn');
        input.onPrintError?.(message);
      }
    }

    return result;
  },
};

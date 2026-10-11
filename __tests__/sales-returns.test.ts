/**
 * SALES + RETURNS — the full v23 returns matrix against the REAL
 * InvoiceService/SaleRepo/SilaRepo/LocalDebtsRepo code:
 *
 *  cash sale        → partial return nets revenue, restores stock,
 *                     marks the original invoice (returned_minor)
 *  full return      → pro-rata discount refunds EXACTLY the total
 *  sila debt pending → the queue row shrinks; zero → row deleted
 *  sila debt synced  → a kind='return_reversal' payment is enqueued
 *                      (never counted as collected cash)
 *  local debt       → the local_debts row shrinks, never below 0
 *  guards           → over-return, return-of-return, voucher
 *                     invoices, syncing debts, empty selection
 */
import {freshApp, load} from './helpers/app';

const NO_PRINT = {
  print: false,
  receiptSettings: {
    storeName: 'متجر الاختبار',
    footerText: '',
    width: 58,
    showLogo: false,
    logoPath: null,
  } as never,
};

function line(
  product: {id: number; name: string; retail: number; cost: number},
  quantity: number,
) {
  return {
    key: `p${product.id}`,
    productId: product.id,
    name: product.name,
    unitPrice: product.retail,
    costPrice: product.cost,
    retailPrice: product.retail,
    wholesalePrice: product.retail,
    quantity,
    availableStock: 999,
    unitId: null,
    unitName: 'قطعة',
    conversion: 1,
  };
}

async function seedProduct(name: string, retail: number, cost: number, stock: number) {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const id = await ProductRepo.create({
    name,
    cost_price: cost,
    retail_price: retail,
    wholesale_price: retail,
    stock_quantity: stock,
    category_id: null,
    image_uri: null,
  });
  return {id, name, retail, cost};
}

async function stockOf(productId: number): Promise<number> {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const product = await ProductRepo.getById(productId);
  return Number(product?.stock_quantity ?? 0);
}

describe('cash sales + returns', () => {
  test('cash sale decrements stock atomically and numbers INV-', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');

    const cola = await seedProduct('كولا', 8, 5, 100);
    const result = await InvoiceService.completeSale({
      lines: [line(cola, 3)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);

    expect(result.sale.invoice_number).toMatch(/^INV-\d{8}-0001$/);
    expect(result.sale.total_amount).toBeCloseTo(24, 5);
    expect(await stockOf(cola.id)).toBe(97);

    // Second sale same day continues the series.
    const second = await InvoiceService.completeSale({
      lines: [line(cola, 1)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    expect(second.sale.invoice_number).toMatch(/-0002$/);
    expect(await SaleRepo.countAll()).toBe(2);
  });

  test('oversell is rejected and rolls the whole sale back', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');

    const chips = await seedProduct('شيبس', 3, 2, 2);
    await expect(
      InvoiceService.completeSale({
        lines: [line(chips, 5)],
        discount: 0,
        paymentType: 'RETAIL',
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow('غير كافية');

    expect(await SaleRepo.countAll()).toBe(0); // nothing half-recorded
    expect(await stockOf(chips.id)).toBe(2); // stock untouched
  });

  test('partial return: nets revenue, restores stock, marks the invoice', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');

    const cola = await seedProduct('كولا', 8, 5, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 10)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    expect(await stockOf(cola.id)).toBe(90);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.book).toBe('cash');
    expect(prep.lines).toHaveLength(1);
    expect(prep.lines[0].remaining).toBe(10);

    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 4,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 8,
          costPrice: 5,
        },
      ],
      refundMethod: 'cash',
      ...NO_PRINT,
    } as never);

    expect(ret.return_number).toMatch(/^RET-\d{8}-0001$/);
    expect(ret.refund_minor).toBe(3200); // 4 × 8₪
    expect(ret.book).toBe('cash');

    // Stock back up by the returned base quantity.
    expect(await stockOf(cola.id)).toBe(94);

    // The ORIGINAL invoice is marked («تعديل الفاتورة التي تم الإرجاع منها»).
    const original = await SaleRepo.getById(sale.sale.id);
    expect(Number(original?.returned_minor)).toBe(3200);
    expect(original?.return_kind).toBeNull(); // the SOURCE keeps its kind; the RET row carries it

    // The RET negative invoice nets revenue: 80 − 32 = 48.
    const revenue = await SaleRepo.allTimeRevenue();
    expect(revenue).toBeCloseTo(48, 5);

    // The RET row itself is flagged as a return of the cash book.
    const retSale = await SaleRepo.returnByNumber(ret.return_number);
    expect(retSale).not.toBeNull();
  });

  test('full return with invoice discount refunds EXACTLY the paid total (pro-rata)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');

    const cola = await seedProduct('كولا', 10, 6, 50);
    const bread = await seedProduct('خبز', 5, 2, 50);
    // Subtotal 40₪, discount 10₪ → total 30₪.
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 2), line(bread, 4)],
      discount: 10,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    expect(sale.sale.total_amount).toBeCloseTo(30, 5);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.discountRatio).toBeCloseTo(0.75, 5);

    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: prep.lines.map(l => ({
        saleItemId: l.item.id,
        productId: l.item.product_id,
        productName: l.productName,
        quantity: l.remaining,
        unitName: l.item.unit_name,
        basePerUnit: 1,
        unitPrice: l.item.unit_price,
        costPrice: l.item.cost_price,
      })),
      refundMethod: 'cash',
      ...NO_PRINT,
    } as never);
    // 20×0.75 + 20×0.75 = 30₪ exactly — not the pre-discount 40₪.
    expect(ret.refund_minor).toBe(3000);

    // A second return attempt must reject: everything already returned.
    await expect(
      InvoiceService.prepareReturn(sale.sale.id),
    ).rejects.toThrow('أُرجعت كل أصناف');
  });

  test('guards: over-return, zero quantity, return-of-return, voucher invoices', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');

    const cola = await seedProduct('كولا', 8, 5, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);

    // Over-return.
    await expect(
      InvoiceService.createReturn({
        saleId: sale.sale.id,
        lines: [
          {
            saleItemId: prep.lines[0].item.id,
            productId: cola.id,
            productName: 'كولا',
            quantity: 6,
            unitName: 'قطعة',
            basePerUnit: 1,
            unitPrice: 8,
            costPrice: 5,
          },
        ],
        refundMethod: 'cash',
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow('أكبر من المتبقي');

    // Zero quantity.
    await expect(
      InvoiceService.createReturn({
        saleId: sale.sale.id,
        lines: [
          {
            saleItemId: prep.lines[0].item.id,
            productId: cola.id,
            productName: 'كولا',
            quantity: 0,
            unitName: 'قطعة',
            basePerUnit: 1,
            unitPrice: 8,
            costPrice: 5,
          },
        ],
        refundMethod: 'cash',
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow('غير صالحة');

    // Return-of-a-return: create a real return then try returning IT.
    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 1,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 8,
          costPrice: 5,
        },
      ],
      refundMethod: 'cash',
      ...NO_PRINT,
    } as never);
    const retSaleRow = await SaleRepo.returnByNumber(ret.return_number);
    expect(retSaleRow).not.toBeNull();
    // The RET row lives in sale_returns; find its sales row by number:
    const salesList = await SaleRepo.listRecent(10);
    const retInvoice = salesList.find(s => s.invoice_number === ret.return_number);
    expect(retInvoice).toBeDefined();
    await expect(InvoiceService.prepareReturn(retInvoice!.id)).rejects.toThrow(
      'لا يمكن الإرجاع من مرتجع',
    );

    // Voucher invoice (INV-V) is rejected from returns.
    const {SaleRepo: SR} = load('src/database/repositories/SaleRepo');
    const voucherSaleId = await SR.createSale({
      invoiceNumber: 'INV-V-20260101-0001',
      lines: [line(cola, 1)],
      discount: 0,
      paymentType: 'RETAIL',
    });
    await expect(
      InvoiceService.prepareReturn(voucherSaleId.sale.id),
    ).rejects.toThrow('فواتير القسائم');
  });
});

describe('SILA debt returns (the reverse operation)', () => {
  test('PENDING debt: return shrinks the queue row; zero deletes it', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const cola = await seedProduct('كولا', 10, 6, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      debt: {
        customerId: 'cus-1',
        customerName: 'أحمد',
        customerPhoneLast4: '1234',
        customerCard: null,
        offlineQr: null,
        amountMinor: 5000,
      },
      ...NO_PRINT,
    } as never);
    expect(sale.sale.invoice_number).toMatch(/^INV-D-/);

    // Partial return of 2 items (20₪) — queue shrinks 5000 → 3000.
    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.book).toBe('sila');
    expect(prep.debtState).toEqual({kind: 'sila-pending', amountMinor: 5000});

    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 2,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 10,
          costPrice: 6,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);
    expect(ret.debt_adjusted_minor).toBe(2000);

    const debt = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    expect(Number(debt?.amount_minor)).toBe(3000);
    expect(await stockOf(cola.id)).toBe(97); // 100 − 5 + 2

    // Return the REST — the queue row disappears entirely.
    const prep2 = await InvoiceService.prepareReturn(sale.sale.id);
    await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep2.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 3,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 10,
          costPrice: 6,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);
    expect(await SilaRepo.byInvoiceRef(sale.sale.invoice_number)).toBeNull();
    expect(await stockOf(cola.id)).toBe(100);
  });

  test('SYNCED debt: return enqueues a return_reversal payment (never counted as cash)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const tuna = await seedProduct('تونة', 12, 8, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(tuna, 4)],
      discount: 0,
      paymentType: 'RETAIL',
      debt: {
        customerId: 'cus-2',
        customerName: 'سليم',
        customerPhoneLast4: '5678',
        customerCard: null,
        offlineQr: null,
        amountMinor: 4800,
      },
      ...NO_PRINT,
    } as never);

    // Simulate the sync engine's success path.
    const debtRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    await SilaRepo.markSynced(debtRow!.local_id, {
      referenceCode: 'POS-123',
      transactionId: 'txn-1',
      outstandingAfter: 4800,
    });

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.debtState).toEqual({kind: 'sila-synced', amountMinor: 4800});

    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: tuna.id,
          productName: 'تونة',
          quantity: 1,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 12,
          costPrice: 8,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);

    // The queue row KEEPS its amount (the server already holds the debt)…
    const debt = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    expect(Number(debt?.amount_minor)).toBe(4800);

    // …and a return_reversal payment was enqueued for the refund.
    // v27 (round-35 #1): the cashier payments LIST never shows
    // reversals («اصلا هو مرتجع وليس مسدد») — the row is verified
    // straight from the queue table instead.
    const queueRows = await app.connection
      .getDb()
      .execute(
        "SELECT * FROM sila_payment_queue WHERE COALESCE(kind,'repayment') = 'return_reversal'",
      );
    const reversal = (queueRows.rows ?? [])[0] as {
      amount_minor?: number;
      payment_method?: string;
      state?: string;
    };
    expect(reversal).toBeDefined();
    expect(Number(reversal!.amount_minor)).toBe(1200);
    expect(reversal!.payment_method).toBe('other');
    expect(reversal!.state).toBe('pending');
    expect(ret.debt_adjusted_minor).toBe(1200);
    // And the cashier book itself stays clean of it.
    const payments = await SilaRepo.recentPayments(10);
    expect(payments.find(p => p.kind === 'return_reversal')).toBeUndefined();

    // The reversal must NEVER enter the collections statistics.
    const {SilaRepo: SR} = load('src/services/sila/SilaRepo');
    const reversalsTotal = await SR.returnReversalsTotal();
    expect(reversalsTotal).toBe(1200);
    const paymentsTotals = await SR.paymentsTotals();
    expect(Number(paymentsTotals.allMinor)).toBe(0); // no real repayments yet
  });

  test('SYNCING debt: the return is blocked until the sync settles', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const cola = await seedProduct('كولا', 10, 6, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 2)],
      discount: 0,
      paymentType: 'RETAIL',
      debt: {
        customerId: 'cus-3',
        customerName: 'خالد',
        customerPhoneLast4: '9999',
        customerCard: null,
        offlineQr: null,
        amountMinor: 2000,
      },
      ...NO_PRINT,
    } as never);

    const debtRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    await SilaRepo.markSyncing([debtRow!.local_id]);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.debtState.kind).toBe('blocked');
    await expect(
      InvoiceService.createReturn({
        saleId: sale.sale.id,
        lines: [
          {
            saleItemId: prep.lines[0].item.id,
            productId: cola.id,
            productName: 'كولا',
            quantity: 1,
            unitName: 'قطعة',
            basePerUnit: 1,
            unitPrice: 10,
            costPrice: 6,
          },
        ],
        refundMethod: 'none',
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow('قيد الرفع');
  });
});

describe('LOCAL book debt returns', () => {
  test('return shrinks the local_debts row (never below zero)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const LocalDebts = load('src/database/repositories/LocalDebtsRepo');
    const {LocalDebtsRepo} = LocalDebts;

    const customer = await LocalDebtsRepo.createCustomer({
      name: 'محمد',
      idNumber: '400123456',
      phone: '0561234567',
      notes: null,
    });
    expect(LocalDebts.isValidIdNumber('400123456')).toBe(true);
    expect(LocalDebts.isValidLocalPhone('0561234567')).toBe(true);

    const milk = await seedProduct('حليب', 6, 4, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(milk, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'محمد',
        customerPhoneLast4: '4567',
      },
      ...NO_PRINT,
    } as never);
    expect(sale.sale.invoice_number).toMatch(/^INV-L-/);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.book).toBe('local');
    expect(prep.debtState).toEqual({kind: 'local', amountMinor: 3000});

    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: milk.id,
          productName: 'حليب',
          quantity: 2,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 6,
          costPrice: 4,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);
    expect(ret.debt_adjusted_minor).toBe(1200);

    const debt = await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number);
    expect(Number(debt?.amountMinor)).toBe(1800);
    expect(await stockOf(milk.id)).toBe(97);

    // The live outstanding follows.
    const outstanding = await LocalDebtsRepo.outstandingFor(customer.id);
    expect(Number(outstanding)).toBe(1800);
  });
});

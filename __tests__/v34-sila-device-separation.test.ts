/**
 * v34 (الجولة 42 #2) — فصل حسابات صِلة بين المتاجر:
 * ─────────────────────────────────────────────────────────────────
 *  • المطابقة الجهازية: تحصيل التطبيق على ديون هذه النقطة فقط
 *    (device_purchases − device_outstanding) — لا أرقام POS الشاملة
 *    المختلطة بفواتير متاجر التاجر الأخرى.
 *  • سداد تطبيق على ديون متجر آخر → لا يُسجّل هنا إطلاقاً.
 *  • التوافق الرجعي: خادم بلا حقول 0075 → الرجوع لأرقام POS.
 *  • إعادة التجميد الأحادية للأسس على المقياس الجهازي (مرة واحدة).
 *  • حدّ أدنى صفر لكل زبون: فائض التحصيل لا يخصم من ديون غيره.
 *  • الخزينة: تحصيل التطبيق الجهازي يدخل النقد ويخفض الدين —
 *    وتحصيل متجر آخر لا يمس خزينة هذه النقطة.
 *  • الرئيسية: بطاقة واحدة موحّدة (خزينة + ديون + اليوم).
 */
import {freshApp, load} from './helpers/app';

const NO_PRINT = {
  print: false,
  receiptSettings: {} as never,
};

function line(product: {id: number; name: string; retail: number; cost: number}, quantity: number) {
  return {
    key: `p${product.id}`,
    productId: product.id,
    name: product.name,
    unitPrice: product.retail,
    costPrice: product.cost,
    retailPrice: product.retail,
    wholesalePrice: product.retail,
    quantity,
    availableStock: 9999,
    unitId: null,
    unitName: 'قطعة',
    conversion: 1,
  };
}

async function seedProduct(name: string, retail: number) {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const id = await ProductRepo.create({
    name,
    cost_price: retail * 0.5,
    retail_price: retail,
    wholesale_price: retail,
    stock_quantity: 100,
    category_id: null,
    image_uri: null,
  } as never);
  return {id, name, retail, cost: retail * 0.5};
}

/** بيع بالدين عبر صِلة لزبون محدد. */
async function silaDebtSale(
  product: {id: number; name: string; retail: number; cost: number},
  quantity: number,
  customerId: string,
  customerName: string,
) {
  const {InvoiceService} = load('src/services/InvoiceService');
  const total = Math.round(product.retail * quantity * 100);
  return InvoiceService.completeSale({
    lines: [line(product, quantity)],
    discount: 0,
    paymentType: 'RETAIL',
    debt: {
      customerId,
      customerName,
      customerPhoneLast4: '1234',
      customerCard: null,
      offlineQr: null,
      amountMinor: total,
    },
    ...NO_PRINT,
  } as never);
}

/** صف زبون في كاش صِلة (كي يراه المحرك «موجوداً» ويعامل أساسه). */
async function seedSilaCustomer(
  customerId: string,
  name: string,
  extra: Partial<{
    posPurchasesMinor: number;
    posOutstandingMinor: number;
    devicePurchasesMinor: number;
    deviceOutstandingMinor: number;
    reconcileOffsetMinor: number;
  }> = {},
) {
  const {SilaRepo} = load('src/services/sila/SilaRepo');
  await SilaRepo.upsertCustomers(
    [
      {
        customerId,
        name,
        phoneLast4: '1234',
        outstandingMinor: extra.posOutstandingMinor ?? 0,
        creditMinor: 0,
        posOutstandingMinor: extra.posOutstandingMinor ?? 0,
        appOutstandingMinor: 0,
        otherMinor: 0,
        posPurchasesMinor: extra.posPurchasesMinor ?? 0,
        appPurchasesMinor: 0,
        deviceOutstandingMinor: extra.deviceOutstandingMinor ?? 0,
        devicePurchasesMinor: extra.devicePurchasesMinor ?? 0,
        devicePaymentsMinor: 0,
        lastPaymentAt: null,
        lastPaymentAmountMinor: null,
        reconcileOffsetMinor: extra.reconcileOffsetMinor ?? null,
      },
    ],
    new Date().toISOString(),
  );
}

describe('v34 — المطابقة الجهازية: تحصيل التطبيق على ديون هذه النقطة فقط', () => {
  test('سدد الزبون 60₪ عبر التطبيق على دين هذه النقطة → تُسجَّل هنا بالضبط', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // دين 100₪ وُلد هنا (فاتورة هذا المتجر).
    const tuna = await seedProduct('تونة', 10, );
    await silaDebtSale(tuna, 10, 'cus-a', 'أحمد');
    // الزبون في الكاش بأساس صفر — أول تمريرة جمّدت الفارق صفراً.
    await seedSilaCustomer('cus-a', 'أحمد', {
      posPurchasesMinor: 10000,
      posOutstandingMinor: 4000,
      devicePurchasesMinor: 10000,
      deviceOutstandingMinor: 4000,
      reconcileOffsetMinor: 0,
    });

    // الخادم: التطبيق سدّد 60₪ (دين النقطة نزل 100→40) — وأرقام POS
    // الشاملة فيها تاريخ متجر آخر (12000 مشتريات منها 4000 قائمة).
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-a',
          name: 'أحمد',
          posPurchasesMinor: 22000, // 10000 هنا + 12000 متجر آخر
          posOutstandingMinor: 14000, // 4000 هنا + 10000 متجر آخر
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: 4000,
        },
      ],
      new Map<string, number>(),
    );
    // قبل v34 كانت المطابقة POS-الشاملة: 22000−14000−0 = 80₪ تُسجَّل
    // هنا خطأً (60 حقيقية + 20 من تاريخ المتجر الآخر). الآن: 60 فقط.
    expect(outcome.recordedMinor).toBe(6000);
    expect(outcome.trimmedMinor).toBe(0);

    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-a')).toBe(4000); // 10000 − 6000 تحصيل تطبيق

    // والخزينة رأت التحصيل الجهازي فقط.
    const {ReportService} = load('src/services/ReportService');
    const treasury = await ReportService.treasurySnapshot();
    expect(treasury.appCollectionsAllTime).toBeCloseTo(60, 5);
    expect(treasury.cashTotal).toBeCloseTo(60, 5);
  });

  test('سدد الزبون عبر التطبيق ديناً لمتجر آخر (أحدث) → لا شيء يُسجَّل هنا', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // دين 100₪ هنا لم يُسدد منه شيء.
    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 10, 'cus-b', 'سامر');
    await seedSilaCustomer('cus-b', 'سامر', {
      posPurchasesMinor: 10000,
      posOutstandingMinor: 10000,
      devicePurchasesMinor: 10000,
      deviceOutstandingMinor: 10000,
      reconcileOffsetMinor: 0,
    });

    // الخادم: الزبون سدّد 50₪ عبر التطبيق على دين متجر آخر (أقدم —
    // إسناد FIFO ثنائي المرحلة أطفأه هناك) → دين هذه النقطة لم يمسّ.
    // أرقام POS الشاملة تنخفض (المطابقة القديمة كانت ستسجل 50 هنا!)
    // لكن أرقام الجهاز ثابتة.
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-b',
          name: 'سامر',
          posPurchasesMinor: 15000, // 10000 هنا + 5000 متجر آخر
          posOutstandingMinor: 10000, // دين النقطة كامل + الآخر سُدد
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: 10000, // لم ينقص — السداد أطفأ المتجر الآخر
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.recordedMinor).toBe(0);
    expect(outcome.trimmedMinor).toBe(0);

    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-b')).toBe(10000); // الدين القائم هنا كامل

    const {ReportService} = load('src/services/ReportService');
    const treasury = await ReportService.treasurySnapshot();
    // خزينة هذه النقطة لم ترَ شيئاً من سداد المتجر الآخر.
    expect(treasury.appCollectionsAllTime).toBeCloseTo(0, 5);
    expect(treasury.cashTotal).toBeCloseTo(0, 5);
  });

  test('v35: خادم بلا حقول 0075 → تخطّي كامل — لا تسجيل من أرقام POS الشاملة أبداً', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 8, 'cus-c', 'وسيم');
    await seedSilaCustomer('cus-c', 'وسيم', {
      posPurchasesMinor: 8000,
      posOutstandingMinor: 3000,
      reconcileOffsetMinor: 0,
    });

    // نفس خادم ما قبل 0075 الذي كان يسجّل 5000 (فارق POS الشامل
    // المختلط بتاريخ متاجر التاجر الأخرى — شكوى «فاتورة 20₪ سُجّل
    // منها 5 فقط»): الآن لا شيء يُسجّل بلا برهان أرقام هذه النقطة.
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-c',
          name: 'وسيم',
          posPurchasesMinor: 8000,
          posOutstandingMinor: 3000,
          devicePurchasesMinor: null, // خادم أقدم — الحقول غائبة
          deviceOutstandingMinor: null,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.recordedMinor).toBe(0);
    expect(outcome.trimmedMinor).toBe(0);

    // الدين القائم كامل — فارق POS لم يأكل منه شيئاً.
    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-c')).toBe(8000);
  });

  test('إعادة التجميد الأحادية: أسس v19 الشاملة تنزل للمقياس الجهازي مرة واحدة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');
    const {getDb} = load('src/database/connection');

    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 10, 'cus-d', 'خليل');
    // أساس v19 جُمّد على أرقام POS الشاملة: 50₪ (فيها تاريخ متجر آخر).
    await seedSilaCustomer('cus-d', 'خليل', {
      posPurchasesMinor: 15000,
      posOutstandingMinor: 10000,
      devicePurchasesMinor: 10000,
      deviceOutstandingMinor: 10000,
      reconcileOffsetMinor: 5000,
    });

    // أول تمريرة جهازية (deviceBaselineReset): الأساس يُستبدل بالفارق
    // الجهازي الحالي (صفر) — كان بقاء 5000 سيبتلع أول 50₪ تحصيل حقيقي.
    const pass1 = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-d',
          name: 'خليل',
          posPurchasesMinor: 15000,
          posOutstandingMinor: 10000,
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: 10000,
        },
      ],
      new Map<string, number>(),
      false,
      true, // deviceBaselineReset
    );
    expect(pass1.recordedMinor).toBe(0); // إعادة التجميد لا تسجّل شيئاً بنفسها
    const row = await getDb().execute(
      'SELECT reconcile_offset_minor AS o FROM sila_customers WHERE customer_id = ?',
      ['cus-d'],
    );
    expect(Number((row.rows?.[0] as {o?: number})?.o ?? 0)).toBe(0);

    // الآن سداد تطبيق 30₪ على دين هذه النقطة → يُسجَّل كاملاً.
    const pass2 = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-d',
          name: 'خليل',
          posPurchasesMinor: 15000,
          posOutstandingMinor: 7000,
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: 7000,
        },
      ],
      new Map<string, number>(),
    );
    expect(pass2.recordedMinor).toBe(3000);
  });
});

describe('v34 — حدّ أدنى صفر لكل زبون (لا خصم صامت من الدين القائم)', () => {
  test('فائض تحصيل فوق دين الزبون لا ينقلب سالباً يخصم من ديون غيره', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // زبون 1: دين 50₪ + سجل تحصيل تطبيق ملوّث قديم 80₪ (قبل فصل
    // المطابقة) → سالب 30₪ كان يخصم من إجمالي الدين القائم.
    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 5, 'cus-x', 'زبون أول');
    const {getDb} = load('src/database/connection');
    await getDb().execute(
      `INSERT INTO sila_app_collections (
         customer_id, customer_name, amount_minor,
         pos_purchases_minor, pos_outstanding_minor, detected_at
       ) VALUES (?, ?, ?, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ['cus-x', 'زبون أول', 8000],
    );
    // زبون 2: دين 70₪ سليم.
    const milk = await seedProduct('حليب', 7);
    await silaDebtSale(milk, 10, 'cus-y', 'زبون ثان');

    const ownMap = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(ownMap.get('cus-x')).toBe(0); // ليست −30₪
    expect(ownMap.get('cus-y')).toBe(7000);

    // الإجمالي 70₪ فقط — لا يُخصم سالب الأول من ديون الثاني.
    const totals = await SilaRepo.storeOwnOutstandingTotal();
    expect(totals.ownMinor).toBe(7000);
    expect(totals.debtorsCount).toBe(1); // الأول ليس مديناً
  });
});

describe('v34 — الرئيسية: بطاقة واحدة موحّدة (خزينة + ديون + اليوم)', () => {
  const read = (path: string) =>
    require('fs').readFileSync(path, 'utf8') as string;
  const HOME = 'src/screens/HomeScreen.tsx';

  test('صف اليوم داخل بطاقة الخزينة والديون نفسها', () => {
    const src = read(HOME);
    // الصف المدموج بعد صف الرصيد/الدين وداخل نفس البطاقة.
    const moneyCard = src.indexOf('styles.moneyCard}');
    const moneyRow = src.indexOf('styles.moneyRow}');
    const todayWrap = src.indexOf('styles.todayWrap}');
    const cardEnd = src.indexOf('</Card>', moneyCard);
    expect(moneyCard).toBeGreaterThan(-1);
    expect(todayWrap).toBeGreaterThan(moneyRow);
    expect(todayWrap).toBeLessThan(cardEnd);
    // قيم اليوم داخل الصف المدموج.
    expect(src).toContain('مبيعات اليوم');
    expect(src).toContain('صافي ربح اليوم');
  });

  test('قسم اليوم المستقل حُذف — لا SectionTitle منفصل له', () => {
    const src = read(HOME);
    expect(src).not.toContain('title="اليوم"');
    expect(src).not.toContain('styles.statsGrid');
  });

  test('الدين القائم يشمل دفتر المتجر + ديون صلة (هذا المتجر) + الحملات', () => {
    const src = read(HOME);
    expect(src).toContain(
      'localOutstandingShekels + silaOutstandingShekels + campaignDueShekels',
    );
    // ديون صلة من الدفاتر المحلية للمتجر — لا أرصدة الخادم.
    expect(src).toContain('storeOwnOutstandingTotal');
  });
});

describe('v34 — السداد والإرجاع في دفاتر هذه النقطة (سلامة شاملة)', () => {
  test('دين صلة + سداد كاشير + إرجاع جزئي = دين صحيح وخزينة صحيحة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');
    const {ReportService} = load('src/services/ReportService');

    // دين 100₪ (متزامن مع الخادم).
    const tuna = await seedProduct('تونة', 10);
    const sale = await silaDebtSale(tuna, 10, 'cus-e', 'نبيل');
    const debtRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    await SilaRepo.markSynced(debtRow!.local_id, {
      referenceCode: 'POS-1',
      transactionId: 'txn-1',
      outstandingAfter: 10000,
    });

    // سداد 40₪ نقداً عند الكاشير.
    await SilaRepo.enqueuePayment({
      idempotencyKey: 'pay-e1',
      customerId: 'cus-e',
      customerName: 'نبيل',
      customerPhoneLast4: '1234',
      amountMinor: 4000,
      paymentMethod: 'cash',
      posReceiptRef: 'RCP-20260101-0001',
      description: 'سداد نقدي',
      paidAt: new Date().toISOString(),
    });

    let own = await SilaRepo.storeOwnOutstandingTotal();
    expect(own.ownMinor).toBe(6000);
    let treasury = await ReportService.treasurySnapshot();
    expect(treasury.cashierCollectionsAllTime).toBeCloseTo(40, 5);
    expect(treasury.cashTotal).toBeCloseTo(40, 5);

    // إرجاع صنفين (20₪) — العملية العكسية تُرفع للخادم ولا تعد تحصيلاً.
    const {InvoiceService} = load('src/services/InvoiceService');
    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: tuna.id,
          productName: 'تونة',
          quantity: 2,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 10,
          costPrice: 5,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);

    own = await SilaRepo.storeOwnOutstandingTotal();
    // 100 دين − 40 سداد − 20 عكس مرتجع = 40₪ قائمة.
    expect(own.ownMinor).toBe(4000);
    expect(own.debtorsCount).toBe(1);

    treasury = await ReportService.treasurySnapshot();
    // السداد وحده نقد؛ العكس ليس تحصيلاً ولا نقداً.
    expect(treasury.cashierCollectionsAllTime).toBeCloseTo(40, 5);
    expect(treasury.cashTotal).toBeCloseTo(40, 5);
    // الإيراد صافي المرتجع، والائتمان صافٍ كذلك.
    expect(treasury.revenueAllTime).toBeCloseTo(80, 5);
    expect(treasury.creditSalesAllTime).toBeCloseTo(80, 5);
  });
});

/**
 * v35 (الجولة 43) — سلامة ديون صِلة: فاتورة الدين تُسجَّل كاملة.
 * ─────────────────────────────────────────────────────────────────
 * شكوى التاجر الجوهرية: «عند تسجيل دين على زبون صلة لأول مرة
 * ورصيده صفر، فاتورة 20₪ سُجّل منها 5 دين فقط والباقي عُوّض
 * بتحصيلات عبر التطبيق — كأن هناك تداخلاً بفواتير متاجر أخرى أو
 * قديمة، ويصبح الدين المسجّل بالسالب أو فيه دفعة محصّلة».
 *
 * الطبقات الثلاث للإصلاح:
 *  ① لا مطابقة إلا بأرقام الجهاز (0075) — غيابها = تخطٍّ كامل
 *     (لا رجوع لأرقام POS الشاملة التي تجمع تحصيلات المتاجر
 *     الأخرى — مصدر التلوث كله).
 *  ② سقف الدين المحلي — التحصيل المسجّل لا يتجاوز دين الزبون في
 *     دفاتر هذه النقطة أبداً (لا رصيد سالب).
 *  ③ المطابقة الهابطة (التشذيب) — الدفاتر فوق ما يعرفه الخادم
 *     = تحصيل وهمي يُحذف ويُمتص في الأساس: شفاء تلقائي لكل
 *     التلوث التاريخي (والتدقيق الشامل للزبائن الساكنين).
 */
import {freshApp, load} from './helpers/app';

const NO_PRINT = {
  print: false,
  receiptSettings: {} as never,
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

/** بيع بالدين عبر صِلة — فاتورة دين كاملة المبلغ. */
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

/** زرع تحصيل تطبيق وهمي (تلوث عصر POS في دفاتر التاجر الحقيقية). */
async function plantFabricatedCollection(
  customerId: string,
  name: string,
  amountMinor: number,
) {
  const {getDb} = load('src/database/connection');
  await getDb().execute(
    `INSERT INTO sila_app_collections (
       customer_id, customer_name, amount_minor,
       pos_purchases_minor, pos_outstanding_minor, detected_at
     ) VALUES (?, ?, ?, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [customerId, name, amountMinor],
  );
}

async function enqueueSyncedCashierPayment(
  customerId: string,
  name: string,
  amountMinor: number,
  ref: string,
) {
  const {SilaRepo} = load('src/services/sila/SilaRepo');
  const row = await SilaRepo.enqueuePayment({
    idempotencyKey: `pay-${ref}`,
    customerId,
    customerName: name,
    customerPhoneLast4: '1234',
    amountMinor,
    paymentMethod: 'cash',
    posReceiptRef: `RCP-20260101-${ref}`,
    description: 'سداد نقدي',
    paidAt: new Date().toISOString(),
  });
  await SilaRepo.markPaymentSynced(row.local_id, {
    referenceCode: `POS-${ref}`,
    transactionId: `txn-${ref}`,
    outstandingAfter: 0,
  });
}

describe('v35 ① — لا مطابقة إلا ببرهان أرقام الجهاز', () => {
  test('سيناريو التاجر حرفياً: أول فاتورة دين 20₪ على زبون رصيده صفر — فارق POS من متاجر أخرى لا يأكل منها شيئاً', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // الزبون في كاش صلة (شوهد أول مرة بلا ديون علينا) — وأرقام POS
    // الشاملة تحمل تاريخاً مدفوعاً لمتاجر التاجر الأخرى (15₪ سُدّدت
    // هناك عبر التطبيق — الرصيد الكلي صفر كما وصف التاجر).
    await seedSilaCustomer('cus-1', 'زبون أول مرة', {
      posPurchasesMinor: 1500,
      posOutstandingMinor: 0,
      reconcileOffsetMinor: 0,
    });

    // أول عملية في هذا المتجر: فاتورة دين 20₪.
    const tuna = await seedProduct('تونة', 4);
    await silaDebtSale(tuna, 5, 'cus-1', 'زبون أول مرة');

    // التغذية بلا أرقام جهاز (خادم يتردد في إرسالها) — فارق POS
    // الشامل صار 15₪ (1500+2000 مشتريات − 2000 قائم).
    // قبل v35: كان يُسجَّل 15₪ تحصيل وهمياً → الدين 5₪ فقط!
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-1',
          name: 'زبون أول مرة',
          posPurchasesMinor: 3500,
          posOutstandingMinor: 2000,
          devicePurchasesMinor: null,
          deviceOutstandingMinor: null,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.recordedMinor).toBe(0);
    expect(outcome.trimmedMinor).toBe(0);

    // الدين كامل 20₪ — مبلغ الفاتورة بالكامل كما طلب التاجر.
    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-1')).toBe(2000);
  });

  test('بأرقام الجهاز أيضاً: أول فاتورة 20₪ والخادم يعرف 20/20 → لا تحصيل ولا نقصان', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const tuna = await seedProduct('تونة', 4);
    await silaDebtSale(tuna, 5, 'cus-2', 'زبون جهاز');
    await seedSilaCustomer('cus-2', 'زبون جهاز', {
      devicePurchasesMinor: 2000,
      deviceOutstandingMinor: 2000,
      reconcileOffsetMinor: 0,
    });

    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-2',
          name: 'زبون جهاز',
          posPurchasesMinor: 2000,
          posOutstandingMinor: 2000,
          devicePurchasesMinor: 2000,
          deviceOutstandingMinor: 2000,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.recordedMinor).toBe(0);
    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-2')).toBe(2000);
  });

  test('الأساس الحارس ‎-1‎: أول مشاهدة بلا أرقام ثم مشاهدة بتاريخ جهاز قديم → تجميد لا انفجار', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');
    const {getDb} = load('src/database/connection');

    // أول مشاهدة: خادم بلا أرقام جهاز (زبون جديد) → أساس حارس -1.
    const offsets = new Map<string, number>();
    const pass1 = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-3',
          name: 'زبون حارس',
          posPurchasesMinor: 900,
          posOutstandingMinor: 900,
          devicePurchasesMinor: null,
          deviceOutstandingMinor: null,
        },
      ],
      offsets,
    );
    expect(pass1.recordedMinor).toBe(0);
    expect(offsets.get('cus-3')).toBe(-1);
    // الصف يُخلق بالأساس الحارس (upsert من المتصل كما في الدورة).
    await SilaRepo.upsertCustomers(
      [
        {
          customerId: 'cus-3',
          name: 'زبون حارس',
          phoneLast4: '1234',
          outstandingMinor: 900,
          creditMinor: 0,
          posOutstandingMinor: 900,
          appOutstandingMinor: 0,
          otherMinor: 0,
          posPurchasesMinor: 900,
          appPurchasesMinor: 0,
          deviceOutstandingMinor: 0,
          devicePurchasesMinor: 0,
          devicePaymentsMinor: 0,
          lastPaymentAt: null,
          lastPaymentAmountMinor: null,
          reconcileOffsetMinor: offsets.get('cus-3'),
        },
      ],
      new Date().toISOString(),
    );

    // فاتورة دين جديدة 20₪ هنا.
    const tuna = await seedProduct('تونة', 4);
    await silaDebtSale(tuna, 5, 'cus-3', 'زبون حارس');

    // أول مشاهدة بأرقام جهاز تحمل تاريخاً قديماً (9₪ مجموع ما طُفئ
    // من ديون هذه النقطة قبل أن نعرفها): تجميد على الفارق الحالي
    // (9₪) — لا انفجار تحصيل مؤرخ اليوم.
    const pass2 = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-3',
          name: 'زبون حارس',
          posPurchasesMinor: 2900,
          posOutstandingMinor: 2000,
          devicePurchasesMinor: 2900,
          deviceOutstandingMinor: 2000,
        },
      ],
      new Map<string, number>(),
    );
    expect(pass2.recordedMinor).toBe(0);
    const row = await getDb().execute(
      'SELECT reconcile_offset_minor AS o FROM sila_customers WHERE customer_id = ?',
      ['cus-3'],
    );
    expect(
      Number((row.rows?.[0] as {o?: number})?.o ?? 0),
    ).toBe(900);

    // الدين كامل 20₪.
    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-3')).toBe(2000);
  });
});

describe('v35 ② — سقف الدين المحلي: لا رصيد سالب أبداً', () => {
  test('أرقام جهاز تدّعي تحصيلاً فوق دين الكتب → يُسجَّل بحدّ الدين فقط', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // دين 100₪ في الدفاتر (فواتير هذا المتجر).
    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 10, 'cus-cap', 'زبون السقف');
    await seedSilaCustomer('cus-cap', 'زبون السقف', {
      devicePurchasesMinor: 10000,
      deviceOutstandingMinor: 10000,
      reconcileOffsetMinor: 0,
    });

    // الخادم يدّعي أن 150₪ طُفئت من ديون هذه النقطة (إسناد خاطئ
    // أو تاريخ مضاعف) — الكتب لا تعرف إلا 100₪ ديناً: يُسجَّل 100
    // (حدّ الدين) ويقف الرصيد عند صفر، لا سالب 50.
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-cap',
          name: 'زبون السقف',
          posPurchasesMinor: 10000,
          posOutstandingMinor: -5000,
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: -5000,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.recordedMinor).toBe(10000);
    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-cap')).toBe(0); // وليس −5000
  });
});

describe('v35 ③ — المطابقة الهابطة: شفاء التلوث التاريخي', () => {
  test('تلوث عصر POS (15₪ وهمية أمام فاتورة 20₪) + تغذية جهاز نظيفة → تشذيب كامل وعودة الدين 20₪', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');
    const {getDb} = load('src/database/connection');

    // فاتورة 20₪ + تحصيل وهمي 15₪ من مطابقة POS القديمة
    // (حالة التاجر الحرفية: الدين ظهر 5₪ فقط).
    const tuna = await seedProduct('تونة', 4);
    await silaDebtSale(tuna, 5, 'cus-heal', 'زبون الشفاء');
    await plantFabricatedCollection('cus-heal', 'زبون الشفاء', 1500);
    await seedSilaCustomer('cus-heal', 'زبون الشفاء', {
      devicePurchasesMinor: 2000,
      deviceOutstandingMinor: 2000, // الخادم: لا شيء سُدّد
      reconcileOffsetMinor: 0,
    });
    let own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-heal')).toBe(500); // التلوث كما رآه التاجر

    // تمريرة عادية بأرقام جهاز صادقة: الدفاتر تدّعي 15₪ والخادم
    // يعرف صفراً → تشذيب 15₪ كاملة.
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-heal',
          name: 'زبون الشفاء',
          posPurchasesMinor: 2000,
          posOutstandingMinor: 2000,
          devicePurchasesMinor: 2000,
          deviceOutstandingMinor: 2000,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.recordedMinor).toBe(0);
    expect(outcome.trimmedMinor).toBe(1500);

    // الدين استعاد قيمته الصحيحة كاملاً.
    own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-heal')).toBe(2000);

    // إيديموتية: التمريرة التالية لا تعيد التسجيل (امتصاص الأساس).
    const again = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-heal',
          name: 'زبون الشفاء',
          posPurchasesMinor: 2000,
          posOutstandingMinor: 2000,
          devicePurchasesMinor: 2000,
          deviceOutstandingMinor: 2000,
        },
      ],
      new Map<string, number>(),
    );
    expect(again.recordedMinor).toBe(0);
    expect(again.trimmedMinor).toBe(0);
    own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-heal')).toBe(2000);

    // وسجل التحصيلات نظيف.
    const rows = await getDb().execute(
      'SELECT COUNT(*) AS cnt FROM sila_app_collections WHERE customer_id = ?',
      ['cus-heal'],
    );
    expect(
      Number((rows.rows?.[0] as {cnt?: number})?.cnt ?? 0),
    ).toBe(0);
  });

  test('مزيج حقيقي ووهمي: 40 سداد كاشير + 20 تحصيل حقيقي + 15 وهمياً → تُشذَّب الـ15 وحدها', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // دين 100₪، سداد كاشير 40₪ (مرفوع)، تحصيل تطبيق حقيقي 20₪
    // (سجله المحرك من أرقام الجهاز)، وتحصيل وهمي 15₪ من عصر POS.
    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 10, 'cus-mix', 'زبون المزيج');
    await enqueueSyncedCashierPayment('cus-mix', 'زبون المزيج', 4000, 'M1');
    await plantFabricatedCollection('cus-mix', 'زبون المزيج', 2000); // حقيقي
    await plantFabricatedCollection('cus-mix', 'زبون المزيج', 1500); // وهمي (الأحدث)
    await seedSilaCustomer('cus-mix', 'زبون المزيج', {
      devicePurchasesMinor: 10000,
      deviceOutstandingMinor: 4000, // الخادم: 40 سداد + 20 تطبيق طُفئا
      reconcileOffsetMinor: 0,
    });
    let own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-mix')).toBe(2500); // 100−40−20−15 (ملوّث)

    // الخادم يعرف 60₪ مطفأة (40+20) والدفاتر تدّعي 75₪ → الفارق
    // 15₪ بالضبط: تُشذَّب الوهمية الأحدث وحدها، والحقيقية تبقى.
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-mix',
          name: 'زبون المزيج',
          posPurchasesMinor: 10000,
          posOutstandingMinor: 4000,
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: 4000,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.trimmedMinor).toBe(1500);
    own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-mix')).toBe(4000); // 100−40−20 (سليم)
  });

  test('سداد كاشير لم يصله الخادم بعد لا يُحسب ادعاءً ولا يُشذَّب بسببه تحصيل حقيقي', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // دين 100₪، سداد كاشير 40₪ لم يُرفع بعد (pending — الخادم لا
    // يعرفه)، تحصيل تطبيق حقيقي 20₪: الخادم يعرف 20₪ فقط مطفأة.
    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 10, 'cus-lag', 'زبون التأجيل');
    const {SilaRepo: Repo} = load('src/services/sila/SilaRepo');
    await Repo.enqueuePayment({
      idempotencyKey: 'pay-lag',
      customerId: 'cus-lag',
      customerName: 'زبون التأجيل',
      customerPhoneLast4: '1234',
      amountMinor: 4000,
      paymentMethod: 'cash',
      posReceiptRef: 'RCP-20260101-LAG',
      description: 'سداد نقدي',
      paidAt: new Date().toISOString(),
    });
    await plantFabricatedCollection('cus-lag', 'زبون التأجيل', 2000); // حقيقي
    await seedSilaCustomer('cus-lag', 'زبون التأجيل', {
      devicePurchasesMinor: 10000,
      deviceOutstandingMinor: 8000, // الخادم يعرف 20₪ مطفأة فقط
      reconcileOffsetMinor: 0,
    });

    // السداد المعلق ليس «مؤكداً» فلا يدخل في الادعاء: الكتب تدّعي
    // 20₪ والخادم يعرف 20₪ → لا تشذيب (التحصيل الحقيقي يبقى).
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-lag',
          name: 'زبون التأجيل',
          posPurchasesMinor: 10000,
          posOutstandingMinor: 8000,
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: 8000,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.trimmedMinor).toBe(0);
    expect(outcome.recordedMinor).toBe(0);
    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-lag')).toBe(4000); // 100−40−20
  });

  test('التدقيق الشامل: زبون ساكن (لا يظهر في التغذية أبداً) يُشذَّب تلوثه من الكاش', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // زبون بلا فواتير محلية إطلاقاً — لكن عصر POS سجّل عليه 80₪
    // تحصيلات وهمية (انفجار تاريخي كامل). لا تغذية ستحضره (لا
    // شيء تغير لدى الخادم) — التدقيق الشامل وحده يصل إليه.
    await seedSilaCustomer('cus-quiet', 'زبون ساكن', {
      devicePurchasesMinor: 0,
      deviceOutstandingMinor: 0, // الخادم: لا ديون لهذه النقطة
      reconcileOffsetMinor: 0,
    });
    await plantFabricatedCollection('cus-quiet', 'زبون ساكن', 5000);
    await plantFabricatedCollection('cus-quiet', 'زبون ساكن', 3000);
    let own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-quiet')).toBe(0); // لا دين أصلاً (المجموع سالب → صفر)

    const trimmed = await SilaRepo.auditAppCollections();
    expect(trimmed).toBe(8000); // التلوث كله خرج من الدفاتر

    own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-quiet') ?? 0).toBe(0); // لا دين ولا صفوف
    // وسجل التحصيلات نظيف تماماً.
    const totals = await SilaRepo.appCollectionsTotals();
    expect(totals.allMinor).toBe(0);
    expect(totals.allCount).toBe(0);
  });
});

describe('v35 — التحصيل الحقيقي ما زال يعمل كما يجب', () => {
  test('سداد تطبيق حقيقي 60₪ على دين هذه النقطة → يُسجَّل بالضبط والدين ينقص', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const tuna = await seedProduct('تونة', 10);
    await silaDebtSale(tuna, 10, 'cus-real', 'زبون واقعي');
    await seedSilaCustomer('cus-real', 'زبون واقعي', {
      devicePurchasesMinor: 10000,
      deviceOutstandingMinor: 10000,
      reconcileOffsetMinor: 0,
    });

    // الزبون سدّد 60₪ عبر تطبيق صِلة على دين هذه النقطة.
    const outcome = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-real',
          name: 'زبون واقعي',
          posPurchasesMinor: 10000,
          posOutstandingMinor: 4000,
          devicePurchasesMinor: 10000,
          deviceOutstandingMinor: 4000,
        },
      ],
      new Map<string, number>(),
    );
    expect(outcome.recordedMinor).toBe(6000);
    expect(outcome.trimmedMinor).toBe(0);
    const own = await SilaRepo.storeOwnOutstandingByCustomer();
    expect(own.get('cus-real')).toBe(4000);
  });
});

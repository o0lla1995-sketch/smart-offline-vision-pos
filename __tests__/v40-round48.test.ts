/**
 * v40 — الجولة 48: تسوية فرق الاستبدال + المسح الذكي للأحجام +
 * شكل عرض المنتجات + معاينة الفاتورة كصورة.
 * ─────────────────────────────────────────────────────────────────
 * ① الاستبدال بالفرق (functional — الاتجاهات الأربعة):
 *    • نقدي + مرتجع أغلى → الزبون يستلم الفرق نقداً (إيراد الخزينة
 *      ينقص بالفرق عبر صف RET الصافي).
 *    • نقدي + بدائل أغلى → الزبون يدفع الفرق نقداً (الإيراد يزيد).
 *    • دين دفتر + بدائل أغلى → الدين يزيد بالفرق.
 *    • دين صلة معلّق (pending) + فرق بأي اتجاه → صف الطابور يعدّل
 *      بالفرق (نقصاناً أو زيادة).
 *    • دين محلي مفقود (سُدّد وحُذف) + بدائل أغلى → رفض برسالة
 *      واضحة قبل أي كتابة.
 * ② المسح الذكي (source guards): باركود منتج الأحجام (kind='size')
 *    يفتح نافذة البيع فوراً كالملابس تماماً — باركود وبصرياً.
 * ③ شكل عرض المنتجات (source guards): زر بجانب جملة/مفرق + إعداد
 *    محفوظ + الأيقونات + الأشكال الثلاثة.
 * ④ معاينة الفاتورة كصورة (source guards): الزر بجانب الطباعة
 *    التجريبية + خدمة البناء + الربط الأصلي.
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

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

async function seedProduct(
  name: string,
  retail: number,
  cost: number,
  stock: number,
) {
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

function returnLine(
  prep: {lines: {item: {id: number}}[]},
  product: {id: number; name: string; retail: number; cost: number},
  quantity: number,
) {
  return {
    saleItemId: prep.lines[0].item.id,
    productId: product.id,
    productName: product.name,
    quantity,
    unitName: 'قطعة',
    basePerUnit: 1,
    unitPrice: product.retail,
    costPrice: product.cost,
  };
}

describe('v40 — تسوية فرق الاستبدال (الاتجاهات الأربعة)', () => {
  test('نقدي + بدائل أغلى: الزبون يدفع الفرق نقداً والإيراد يزيد', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');

    const cola = await seedProduct('كولا', 8, 5, 100);
    const water = await seedProduct('مياه', 3, 2, 50);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 10)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    // البيع 80₪.
    expect(await SaleRepo.allTimeRevenue()).toBeCloseTo(80, 5);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [returnLine(prep, cola, 4)], // مرتجع 32₪
      refundMethod: 'none',
      exchange: [
        {
          productId: water.id,
          productName: 'مياه',
          quantity: 14, // بدائل 42₪ — أغلى بـ 10₪
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 3,
          costPrice: 2,
        },
      ],
      ...NO_PRINT,
    } as never);

    expect(ret.is_exchange).toBe(1);
    expect(ret.exchange_minor).toBe(4200);
    // المخزون: المرتجع عاد والبديل خرج.
    expect(await stockOf(cola.id)).toBe(94);
    expect(await stockOf(water.id)).toBe(36);
    // v40: صف RET يحمل +10 (البديل أغلى) — الزبون دفع الفرق نقداً
    // فدخل الخزينة: الإيراد 80 + 10 = 90₪.
    expect(await SaleRepo.allTimeRevenue()).toBeCloseTo(90, 5);
    // صف RET نفسه: المجموع الموجب = دخل نقدي.
    const retSaleRow = (await SaleRepo.listRecent(10)).find(
      s => s.invoice_number === ret.return_number,
    );
    expect(retSaleRow).toBeDefined();
    expect(retSaleRow!.total_amount).toBeCloseTo(10, 5);
  });

  test('دين دفتر + بدائل أغلى: الدين يزيد بالفرق', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const LocalDebts = load('src/database/repositories/LocalDebtsRepo');
    const {LocalDebtsRepo} = LocalDebts;

    const customer = await LocalDebtsRepo.createCustomer({
      name: 'سامر',
      idNumber: '400999888',
      phone: '0569998888',
      notes: null,
    });
    const milk = await seedProduct('حليب', 6, 4, 100);
    const bread = await seedProduct('خبز', 2, 1, 80);
    const sale = await InvoiceService.completeSale({
      lines: [line(milk, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'سامر',
        customerPhoneLast4: '8888',
      },
      ...NO_PRINT,
    } as never);
    expect(sale.sale.invoice_number).toMatch(/^INV-L-/);
    // الدين = 30₪.
    expect(
      Number(
        (await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number))
          ?.amountMinor ?? 0,
      ),
    ).toBe(3000);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [returnLine(prep, milk, 2)], // مرتجع 12₪
      refundMethod: 'none',
      exchange: [
        {
          productId: bread.id,
          productName: 'خبز',
          quantity: 10, // بدائل 20₪ — أغلى بـ 8₪
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 2,
          costPrice: 1,
        },
      ],
      ...NO_PRINT,
    } as never);

    expect(ret.is_exchange).toBe(1);
    // v40: الدين زاد بالفرق 30 → 38₪، ولا خصم (debt_adjusted = 0).
    expect(ret.debt_adjusted_minor).toBe(0);
    const after = await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number);
    expect(after).not.toBeNull();
    expect(Number(after!.amountMinor)).toBe(3800);
    // المخزون.
    expect(await stockOf(milk.id)).toBe(97);
    expect(await stockOf(bread.id)).toBe(70);
  });

  test('دين صلة معلق: الفرق يعدّل صف الطابور في الاتجاهين', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const cola = await seedProduct('كولا', 10, 6, 100);
    const water = await seedProduct('مياه', 4, 2, 60);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      debt: {
        customerId: 'cus-v40',
        customerName: 'ليلى',
        customerPhoneLast4: '4040',
        customerCard: null,
        offlineQr: null,
        amountMinor: 5000,
      },
      ...NO_PRINT,
    } as never);
    expect(sale.sale.invoice_number).toMatch(/^INV-D-/);
    // الطابور معلق (لم يُرفع بعد): 50₪.
    let queueRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    expect(queueRow?.state).toBe('pending');
    expect(Number(queueRow?.amount_minor ?? 0)).toBe(5000);

    // الاستبدال ①: مرتجع 20₪ مقابل بدائل 12₪ — الدين ينقص 8₪ (50→42).
    let prep = await InvoiceService.prepareReturn(sale.sale.id);
    await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [returnLine(prep, cola, 2)],
      refundMethod: 'none',
      exchange: [
        {
          productId: water.id,
          productName: 'مياه',
          quantity: 3, // 12₪
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 4,
          costPrice: 2,
        },
      ],
      ...NO_PRINT,
    } as never);
    queueRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    expect(Number(queueRow?.amount_minor ?? 0)).toBe(4200);

    // الاستبدال ②: مرتجع 10₪ مقابل بدائل 28₪ — الدين يزيد 18₪ (42→60).
    prep = await InvoiceService.prepareReturn(sale.sale.id);
    await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [returnLine(prep, cola, 1)],
      refundMethod: 'none',
      exchange: [
        {
          productId: water.id,
          productName: 'مياه',
          quantity: 7, // 28₪
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 4,
          costPrice: 2,
        },
      ],
      ...NO_PRINT,
    } as never);
    queueRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    expect(Number(queueRow?.amount_minor ?? 0)).toBe(6000);
    // الطابور كله صف واحد دائماً (لا صفوف زيادة للمعلق).
    const pending = await SilaRepo.pendingBatch();
    const own = pending.filter(r => r.pos_invoice_ref === sale.sale.invoice_number);
    expect(own).toHaveLength(1);
  });

  test('دين محلي مفقود + بدائل أغلى: رفض واضح قبل أي كتابة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const LocalDebts = load('src/database/repositories/LocalDebtsRepo');
    const {LocalDebtsRepo} = LocalDebts;

    const customer = await LocalDebtsRepo.createCustomer({
      name: 'وليد',
      idNumber: '400777666',
      phone: '0567776666',
      notes: null,
    });
    const milk = await seedProduct('حليب', 6, 4, 100);
    const bread = await seedProduct('خبز', 2, 1, 80);
    const sale = await InvoiceService.completeSale({
      lines: [line(milk, 4)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'وليد',
        customerPhoneLast4: '6666',
      },
      ...NO_PRINT,
    } as never);
    // سدّد الدين كاملاً وحذف الصف (نمط v26: الاستهلاك الكامل يحذف).
    await app.connection
      .getDb()
      .execute(
        'DELETE FROM local_debts WHERE invoice_ref = ?',
        [sale.sale.invoice_number],
      );

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.debtState.kind).toBe('missing');
    await expect(
      InvoiceService.createReturn({
        saleId: sale.sale.id,
        lines: [returnLine(prep, milk, 2)], // 12₪
        refundMethod: 'none',
        exchange: [
          {
            productId: bread.id,
            productName: 'خبز',
            quantity: 10, // 20₪ — أغلى بـ 8₪
            unitName: 'قطعة',
            basePerUnit: 1,
            unitPrice: 2,
            costPrice: 1,
          },
        ],
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow(/لا يمكن زيادة دين غير موجود/);
    // ولا شيء تغيّر.
    expect(await stockOf(milk.id)).toBe(96);
    expect(await stockOf(bread.id)).toBe(80);
  });

  test('نقدي: استبدال متكافئ — لا فرق إطلاقاً', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');

    const cola = await seedProduct('كولا', 8, 5, 100);
    const water = await seedProduct('مياه', 4, 2, 50);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [returnLine(prep, cola, 2)], // 16₪
      refundMethod: 'none',
      exchange: [
        {
          productId: water.id,
          productName: 'مياه',
          quantity: 4, // 16₪ — تكافؤ تام
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 4,
          costPrice: 2,
        },
      ],
      ...NO_PRINT,
    } as never);
    expect(ret.is_exchange).toBe(1);
    // الإيراد لم يتحرك إطلاقاً: 40₪ كما هي.
    expect(await SaleRepo.allTimeRevenue()).toBeCloseTo(40, 5);
    expect(await stockOf(cola.id)).toBe(97);
    expect(await stockOf(water.id)).toBe(46);
  });
});

describe('v40 — حرّوس المصدر: المسح الذكي والأشكال والمعاينة', () => {
  const POS = 'src/screens/PosScreen.tsx';
  const SETTINGS = 'src/stores/settingsStore.ts';
  const ICONS = 'src/components/Icon.tsx';
  const PRINTER = 'src/screens/printer/PrinterSettingsScreen.tsx';
  const PREVIEW = 'src/services/printer/receiptPreview.ts';
  const BRIDGE = 'src/native/nativeBridge.ts';
  const NATIVE =
    'android/app/src/main/java/com/sela/pal/native_modules/PlatformUtilsModule.kt';

  test('المسح الذكي: منتج الأحجام (kind=size) يفتح نافذة البيع كالملابس', () => {
    const src = read(POS);
    // مسار الباركود العام: متغيرات أو أحجام → إغلاق الماسح + نافذة البيع.
    expect(src).toContain(
      "v => v.kind === 'variant' || v.kind === 'size'",
    );
    // المسار البصري: نفس التمييز — البصمة للمنتج ككل لا للمتغير.
    expect(src).toContain('اختر الخصائص الآن');
    // v39 (الأصل): منتج الوزن والمتغيرات يظلان كما هما.
    expect(src).toContain('closeScannerNow');
    expect(src).toContain('أدخل وزنه الآن');
  });

  test('شكل عرض المنتجات: زر بجانب جملة/مفرق + إعداد محفوظ + ثلاثة أشكال', () => {
    const src = read(POS);
    expect(src).toContain('posProductView');
    expect(src).toContain('viewShapeBtn');
    expect(src).toContain('شكل المنتجات في نقطة البيع');
    expect(src).toContain('شبكة مربعات');
    expect(src).toContain('قائمة مضغوطة');
    expect(src).toContain('بطاقات كبيرة');
    // الأشكال الثلاثة مبنية فعلاً.
    expect(src).toContain('styles.listRow');
    expect(src).toContain('styles.cardTile');
    expect(src).toContain('styles.grid');

    const settings = read(SETTINGS);
    expect(settings).toContain(
      "export type PosProductView = 'grid' | 'list' | 'cards'",
    );
    expect(settings).toContain("posProductView: 'grid'");

    const icons = read(ICONS);
    expect(icons).toContain("'layoutGrid'");
    expect(icons).toContain("'layoutList'");
    expect(icons).toContain("'layoutCards'");
  });

  test('معاينة الفاتورة كصورة: الزر + الخدمة + الربط الأصلي', () => {
    const printer = read(PRINTER);
    expect(printer).toContain('تحميل شكل الفاتورة كصورة');
    expect(printer).toContain('exportReceiptPreviewImage');
    // بجانب الطباعة التجريبية في صف واحد.
    expect(printer).toContain('previewButtonsRow');

    const preview = read(PREVIEW);
    expect(preview).toContain('buildReceiptPreviewRows');
    expect(preview).toContain('exportReceiptPreviewImage');

    const bridge = read(BRIDGE);
    expect(bridge).toContain('exportReceiptImage(');

    const native = read(NATIVE);
    expect(native).toContain('fun exportReceiptImage(');
    expect(native).toContain('Tajawal');
    expect(native).toContain('image/png');
  });

  test('الإصدار: 45.0.0 (53) في الإعدادات والبناء (محدّث للجولة 53)', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '45.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 53');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionCode 53');
    expect(gradle).toContain('versionName "45.0.0"');
  });
});

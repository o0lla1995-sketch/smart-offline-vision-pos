/**
 * v38 — الجولة 46: إصلاحات المخزون والوحدات + الجرد بالمتحولات +
 * نوافذ البيع والإرجاع.
 * ─────────────────────────────────────────────────────────────────
 * ① وظيفي (على الوحدات الحقيقية):
 *    • جرد متغيرات الملابس: صف مستقل لكل (لون × مقاس)، تسوية كل
 *      متغير على صفه، وإعادة توليد إجمالي الموديل من مجموع
 *      متغيراته — والمنتجات العادية تبقى صفوفاً واحدة.
 *    • ترحيل v22: عمودا variant_id/variant_label + فهرس الفردية
 *      المركب، وجلسة قديمة مفتوحة تُرحّل بلا فقدان.
 *    • stockStateOf: منتج بلا تتبع = 'untracked' لا 'out' (لا
 *      شارة «نفد» على صنف خدمة).
 *    • السلة: addProduct بكمية — ٣ علب × تحويل ١٠ = ٣٠ قطعة تُخصم
 *      من الحرس، والسطر نفسه تتراكم كميته، وطلباً فوق المتوفر
 *      يُرفض برسالة واضحة.
 * ② حرّوس المصدر لإصلاحات الواجهة في هذه الجولة.
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const POS = 'src/screens/PosScreen.tsx';
const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';
const STOCKTAKE = 'src/database/repositories/StocktakeRepo.ts';
const STOCKTAKE_SCREEN = 'src/screens/inventory/StocktakeScreen.tsx';
const TYPES = 'src/core/types.ts';
const CART = 'src/stores/cartStore.ts';
const CONNECTION = 'src/database/connection.ts';
const BACKUP = 'src/services/BackupService.ts';

describe('v38 #9 — جرد متغيرات الملابس (وظيفي كامل)', () => {
  test('صف مستقل لكل (لون × مقاس) والمنتج العادي صف واحد', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {VariantRepo} = load('src/database/repositories/VariantRepo');
    const {StocktakeRepo} = load(STOCKTAKE);

    // موديل ملابس بمتغيرين: (أسود، L) و (أبيض، M).
    const modelId = await ProductRepo.create({
      name: 'تيشيرت قطن',
      cost_price: 10,
      retail_price: 25,
      wholesale_price: 20,
      stock_quantity: 8,
      category_id: null,
      image_uri: null,
      has_variants: 1,
      base_unit_name: 'قطعة',
    });
    await VariantRepo.replaceForProduct(modelId, [
      {kind: 'variant', color: 'أسود', size: 'L', stock_quantity: 5},
      {kind: 'variant', color: 'أبيض', size: 'M', stock_quantity: 3},
    ]);
    // منتج عادي (بقالة) — يجب أن يبقى صفه واحداً.
    const groceryId = await ProductRepo.create({
      name: 'شوكولاتة',
      cost_price: 2,
      retail_price: 3.5,
      wholesale_price: 3,
      stock_quantity: 40,
      category_id: null,
      image_uri: null,
    });

    const session = await StocktakeRepo.start();
    const items = await StocktakeRepo.listItems(session.id);

    // الموديل: صفان (متغيران) بلا صف منتج — والبقالة صف واحد.
    const modelRows = items.filter(i => i.product_id === modelId);
    const groceryRows = items.filter(i => i.product_id === groceryId);
    expect(modelRows.length).toBe(2);
    expect(groceryRows.length).toBe(1);
    expect(modelRows.every(r => r.variantId != null)).toBe(true);
    expect(modelRows.map(r => r.variantLabel).sort()).toEqual(
      ['أبيض · M', 'أسود · L'].sort(),
    );
    expect(modelRows.find(r => r.variantLabel === 'أسود · L')?.system_qty).toBe(
      5,
    );
    expect(groceryRows[0].variantId).toBeNull();
    expect(groceryRows[0].system_qty).toBe(40);

    // العدّ على صف المتغير تحديداً — لا يطال أخاه ولا المنتج.
    await StocktakeRepo.setCounted(
      session.id,
      modelId,
      4,
      modelRows.find(r => r.variantLabel === 'أسود · L')!.variantId,
    );
    const afterCount = await StocktakeRepo.listItems(session.id);
    const black = afterCount.find(
      i => i.product_id === modelId && i.variantLabel === 'أسود · L',
    );
    const white = afterCount.find(
      i => i.product_id === modelId && i.variantLabel === 'أبيض · M',
    );
    expect(black?.counted_qty).toBe(4);
    expect(white?.counted_qty).toBeNull();

    // التسوية: المتغير المعدود يُكتب، وإجمالي الموديل يُعاد توليده
    // من مجموع متغيراته (4 + 3 = 7) — عقد البيع/الإرجاع نفسه.
    await StocktakeRepo.complete(session.id, true);
    const variants = await VariantRepo.listByProduct(modelId);
    expect(
      variants.find(v => v.color === 'أسود' && v.size === 'L')
        ?.stock_quantity,
    ).toBe(4);
    expect(
      variants.find(v => v.color === 'أبيض' && v.size === 'M')
        ?.stock_quantity,
    ).toBe(3);
    const model = await ProductRepo.getById(modelId);
    expect(model?.stock_quantity).toBe(7);
  });

  test('ملخص الجرد يعدّ صفوف المتغيرات أصنافاً مستقلة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {VariantRepo} = load('src/database/repositories/VariantRepo');
    const {StocktakeRepo} = load(STOCKTAKE);

    const modelId = await ProductRepo.create({
      name: 'بنطال جينز',
      cost_price: 30,
      retail_price: 60,
      wholesale_price: 50,
      stock_quantity: 6,
      category_id: null,
      image_uri: null,
      has_variants: 1,
    });
    await VariantRepo.replaceForProduct(modelId, [
      {kind: 'variant', color: 'أزرق', size: '40', stock_quantity: 6},
      {kind: 'variant', color: 'أزرق', size: '42', stock_quantity: 0},
    ]);

    const session = await StocktakeRepo.start();
    const summary = await StocktakeRepo.summary(session.id);
    expect(summary.totalItems).toBe(2);
    expect(summary.totalSystem).toBe(6);
  });
});

describe('v38 #9 — ترحيل v22 لقاعدة قديمة', () => {
  test('stocktake_items تحمل variant_id وvariant_label وفهرس الفردية المركب', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const db = (app as unknown as {
      connection: {getDb: () => any};
    }).connection
      ? (load('src/database/connection') as {getDb(): any}).getDb()
      : null;
    expect(db).not.toBeNull();

    const cols = await db.execute(
      `SELECT name FROM pragma_table_info('stocktake_items')`,
    );
    const names = (cols.rows ?? []).map(
      (r: {name: string}) => r.name,
    );
    expect(names).toContain('variant_id');
    expect(names).toContain('variant_label');

    // فهرس الفردية المركب موجود.
    const idx = await db.execute(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_stocktake_items_line'`,
    );
    expect((idx.rows ?? []).length).toBe(1);

    // صفان لنفس المنتج (واحد عادي وواحد لمتغير) معاً بلا تعارض.
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {VariantRepo} = load('src/database/repositories/VariantRepo');
    const {StocktakeRepo} = load(STOCKTAKE);
    const productId = await ProductRepo.create({
      name: 'فستان صيفي',
      cost_price: 40,
      retail_price: 90,
      wholesale_price: 80,
      stock_quantity: 4,
      category_id: null,
      image_uri: null,
      has_variants: 1,
    });
    await VariantRepo.replaceForProduct(productId, [
      {kind: 'variant', color: 'وردي', size: 'M', stock_quantity: 4},
    ]);
    const session = await StocktakeRepo.start();
    const items = await StocktakeRepo.listItems(session.id);
    expect(items.filter(i => i.product_id === productId).length).toBe(1);
    expect(items[0].variantId).not.toBeNull();
  });
});

describe('v38 #4 — بلا تتبع ليست «نفد»', () => {
  test('stockStateOf ترجع untracked للمنتج بلا تتبع مهما كانت كميته', () => {
    freshApp();
    const {stockStateOf} = load(TYPES);
    expect(
      stockStateOf(
        {stock_quantity: 0, low_stock_threshold: null, stock_untracked: 1},
        5,
      ),
    ).toBe('untracked');
    expect(
      stockStateOf(
        {stock_quantity: 7, low_stock_threshold: null, stock_untracked: 1},
        5,
      ),
    ).toBe('untracked');
    // المتتبع كما كان: صفر = نفد، وقرب الحد = منخفض.
    expect(
      stockStateOf(
        {stock_quantity: 0, low_stock_threshold: null, stock_untracked: 0},
        5,
      ),
    ).toBe('out');
    expect(
      stockStateOf(
        {stock_quantity: 3, low_stock_threshold: null, stock_untracked: 0},
        5,
      ),
    ).toBe('low');
  });

  test('قائمة المخزون تعرض «بلا تتبع» لا «نفد» على الصنف الخدمي', () => {
    const source = read(
      'src/screens/inventory/InventoryScreen.tsx',
    );
    expect(source).toContain("state === 'untracked'");
    expect(source).toContain("'بلا تتبع'");
  });
});

describe('v38 #5 — السلة تقبل كمية من نافذة البيع', () => {
  test('addProduct بكمية ووحدة: 3 علب × تحويل 10 = سطر كمية 3 وحرس 30 قطعة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {useCartStore} = load(CART);

    const product = {
      id: 101,
      name: 'بانادول إكسترا',
      cost_price: 8,
      retail_price: 12,
      wholesale_price: 10,
      stock_quantity: 60,
      category_id: null,
      image_uri: null,
      low_stock_threshold: null,
      barcode: null,
      sold_by_weight: 0,
      is_archived: 0,
      expiry_date: null,
      style_group: null,
      variant_size: null,
      variant_color: null,
      has_variants: 0,
      base_unit_name: 'شريط',
      stock_untracked: 0,
      sizes_count: null,
      created_at: '',
    };
    const unit = {
      id: 7,
      product_id: 101,
      unit_id: 7,
      unitName: 'علبة',
      unitShort: 'علبة',
      conversion: 10,
      barcode: null,
      retail_price: 110,
      wholesale_price: 95,
    };

    const store = useCartStore.getState();
    // 3 علب دفعة واحدة — كانت تضيف 1 فقط مهما ضُبط العدّاد.
    const result = store.addProduct(
      product as never,
      'RETAIL',
      unit as never,
      3,
    );
    expect(result.added).toBe(true);
    const line = useCartStore
      .getState()
      .lines.find(l => l.productId === 101);
    expect(line?.quantity).toBe(3);
    expect(line?.conversion).toBe(10);

    // حرس المخزون بالمُعامل: 60 قطعة متاحة = 6 علب (60) فقط؛
    // طلب 70 قطعة يُرفض برسالة عربية.
    const blocked = useCartStore
      .getState()
      .addProduct(product as never, 'RETAIL', null, 70);
    expect(blocked.added).toBe(false);
    expect(blocked.reason).toContain('نفدت الكمية');

    // إضافة كمية أخرى على السطر نفسه تتراكم (3 + 2 = 5).
    useCartStore.getState().addProduct(product as never, 'RETAIL', unit as never, 2);
    expect(
      useCartStore.getState().lines.find(l => l.productId === 101)?.quantity,
    ).toBe(5);
  });

  test('نافذة البيع الصيدلانية تمرر الكمية من العدّاد إلى onAddUnit', () => {
    const pos = read(POS);
    expect(pos).toContain('onAddUnit(product, pickedUnitRow, qty)');
    expect(pos).toContain('tryAdd(product, unit, qty)');
    expect(pos).toContain('quantity ?? 1');
  });
});

describe('v38 #2 — حرّوس رياضيات وحدة الإدخال في صفحة المنتج', () => {
  test('المؤثر الموحد لإعادة التعبير + مرجع آخر معامل صالح موجودان', () => {
    const form = read(FORM);
    expect(form).toContain('lastStockConvRef');
    // إعادة التعبير عند تغيّر المعامل (لا صمت بعد اليوم).
    expect(form).toContain('basePieces / effective');
    // العودة للأساس عند فقدان المعامل.
    expect(form).toContain('setStockUnitId(null)');
    // switchStockUnit لم يعد يحوّل بنفسه (المؤثر مصدر التحويل الوحيد).
    expect(form).not.toContain('const next = basePieces / newConv');
  });

  test('حارس الانهيار إلى الصفر يوقف الحفظ برسالة عربية', () => {
    const form = read(FORM);
    expect(form).toContain('stockValue <= 0');
    expect(form).toContain('أصغر من وحدة الأساس');
  });

  test('addUnitRow لم يعد يقع على وحدة من نوع خاطئ', () => {
    const form = read(FORM);
    expect(form).not.toContain(
      'units.find(unit => !used.has(unit.id)))',
    );
    expect(form).toContain('وحدات القطع مستخدمة');
  });
});

describe('v38 #3 — نظام الإدخال/التعبئة (إضافة لا استبدال)', () => {
  test('مبدّل الإضافة/التعيين ومتوسط التكلفة المرجّح في المصدر', () => {
    const form = read(FORM);
    expect(form).toContain('intakeAdd');
    expect(form).toContain('loadedStockRef.current + cartonMath.totalPieces');
    expect(form).toContain('loadedStockRef.current + bagMath.totalKg');
    expect(form).toContain('إضافة للمخزون الحالي');
    expect(form).toContain('تعيين الكمية الإجمالية');
    // شرح التعبئة داخل قسم الوحدات.
    expect(form).toContain('التعبئة (فتح علبة/كرتونة) لا تحتاج أي عملية');
  });
});

describe('v38 #6 — الاستبدال في الفاتورة النقدية بلا زبون', () => {
  test('زر الاستبدال يظهر ما دامت أصناف قابلة للإرجاع والضغط بلا كميات يرشد', () => {
    const invoices = read(INVOICES);
    expect(invoices).toContain('{lines.length > 0 ? (');
    expect(invoices).toContain(
      'اختر كميات المرتجع أولاً — الاستبدال يقابل قيمة ما تُرجعه',
    );
    // الشريحة الملغومة أعيدت تسميتها بدقة.
    expect(invoices).toContain('إرجاع بلا استرداد نقدي');
    expect(invoices).not.toContain('استبدال بضاعة (بلا استرداد)');
  });
});

describe('v38 #7 — ضغط أحجام نافذتي الإرجاع والاستبدال', () => {
  test('الصفوف والأزرار والخطوط صُغّرت في النافذتين', () => {
    const invoices = read(INVOICES);
    // صف المرتجع: حشوة 8 وأزرار 28 مع hitSlop.
    expect(invoices).toContain('padding: 8,');
    expect(invoices).toContain('width: 28,');
    expect(invoices).toMatch(/hitSlop=\{\{top: 8, bottom: 8/);
    // صف نتيجة الاستبدال: حشوة 7.
    expect(invoices).toContain('padding: 7,');
  });
});

describe('v38 #8 — المقاس/اللون المخصص يظهر بجانب الافتراضية', () => {
  test('رقائق الملابس تعرض اتحاد الافتراضي + المخصص', () => {
    const form = read(FORM);
    expect(form).toContain(
      '[...new Set([...(modeConfig.variantSizes ?? []), ...lotSizes])]',
    );
    expect(form).toContain(
      '[...new Set([...(modeConfig.variantColors ?? []), ...lotColors])]',
    );
  });
});

describe('v38 #9 — حرّوس شاشة الجرد والنسخ الاحتياطي', () => {
  test('شاشة الجرد تعرض المتغير وتفتح مفتاحاً مركباً', () => {
    const screen = read(STOCKTAKE_SCREEN);
    expect(screen).toContain('item.variantLabel');
    expect(screen).toContain('`${item.product_id}:${item.variantId ?? 0}`');
    expect(screen).toContain('row.variantId ?? null');
  });

  test('النسخة الاحتياطية تحمل عمودي المتغير وتعيد ربطه عند الاستعادة', () => {
    const backup = read(BACKUP);
    expect(backup).toContain('variant_id, variant_label, system_qty, counted_qty');
    expect(backup).toContain('variant_label ?? null');
  });

  test('الترحيل v22 في سلسلة الترحيلات', () => {
    const connection = read(CONNECTION);
    expect(connection).toContain('if (version < 22)');
    expect(connection).toContain('stocktake_items_v22');
    expect(connection).toContain('idx_stocktake_items_line');
  });
});

/**
 * v45 — الجولة 53 (رفض Google Play: استهداف API 36 + متطلب 16 KB):
 * ─────────────────────────────────────────────────────────────────
 * ① رفع compileSdk/targetSdk من 34 إلى 36 (Android 16) — Google Play
 *    يرفض منذ 31/08/2026 أي تحديث لا يستهدف API 36 على الأقل.
 * ② متطلب 16 KB page size (إلزامي لكل تطبيق يستهدف API 35+ على
 *    أجهزة 64-بت): ترقية React Native 0.74.6 → 0.77.3 (نواة RN
 *    وألغوريزماتها الأصلية أصبحت محاذاة على 16 KB منذ 0.76)، و
 *    NDK r27 (يبني كل المكتبات المترجمة من المصدر بمحاذاة 16 KB
 *    افتراضياً)، و mmkv 1.3.15 (نفس خط 1.3.x لكن محاذاة)، واستبعاد
 *    امتدادَي op-sqlite الاختياريَين غير المستخدمَين (crsqlite و
 *    sqlite_vec — كلاهما 4 KB ولا يستدعيهما التطبيق إطلاقاً).
 * ③ حماية سلوك التطبيق عند targetSdk 36 دون أي تغيير مرئي:
 *    تعطيل الإرجاع التنبؤي (enableOnBackInvokedCallback=false —
 *    RN 0.77 لا يزال يستخدم onBackPressed القديم) والانسحاب من
 *    فرض edge-to-edge في Android 15/16 (windowOptOutEdgeToEdge
 *    Enforcement) فتبقى الواجهة والزر الخلفي كما هما تماماً.
 * ④ تنظيف: حذف react-native-reanimated و react-native-gesture-handler
 *    (لم يكن أي منهما مستخدماً من JS إطلاقاً) مع ترقية عائلة
 *    المكتبات لما يطابق RN 0.77، والبقاء على React 18.3.1 و
 *    react-navigation 6 دون أي تغيير في منطق التطبيق.
 * ⑤ ترحيل واجهة op-sqlite إلى الصيغة الجديدة (rows مصفوفة مباشرة
 *    بدل rows._array) في الكود والاختبارات والمحاكاة معاً.
 */
const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

describe('v45 — حرّوس المصدر: الجولة 53 (API 36 + 16 KB)', () => {
  test('① SDK 36: compile/target 36 و buildTools 36 في build.gradle الجذر', () => {
    const gradle = read('android/build.gradle');
    expect(gradle).toContain('compileSdkVersion = 36');
    expect(gradle).toContain('targetSdkVersion = 36');
    expect(gradle).toContain('buildToolsVersion = "36.0.0"');
    expect(gradle).not.toContain('compileSdkVersion = 34');
    expect(gradle).not.toContain('targetSdkVersion = 34');
    // راية كتم تحذير AGP 8.7.2 مع compileSdk 36.
    const props = read('android/gradle.properties');
    expect(props).toContain('android.suppressUnsupportedCompileSdk=36');
  });

  test('② NDK r27 (محاذاة 16 KB افتراضية لكل ما يبنى من المصدر)', () => {
    const gradle = read('android/build.gradle');
    expect(gradle).toContain('ndkVersion = "27.1.12297006"');
    expect(gradle).not.toContain('26.1.10909125');
    // CI يثبّت نفس NDK + منصة android-36 في وظيفتَي البناء معاً.
    const ci = read('.github/workflows/android-release.yml');
    expect(ci.match(/ndk;27\.1\.12297006/g)?.length).toBe(2);
    expect(ci.match(/platforms;android-36/g)?.length).toBe(2);
    expect(ci.match(/build-tools;36\.0\.0/g)?.length).toBe(2);
  });

  test('② mmkv 1.3.15 (محاذاة 16 KB) بدل 1.3.9 (كانت 4 KB)', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('com.tencent:mmkv:1.3.15');
    expect(gradle).not.toContain('com.tencent:mmkv:1.3.9');
  });

  test('② استبعاد امتدادَي op-sqlite غير المستخدمَين (4 KB) من الحزمة', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('**/libcrsqlite.so');
    expect(gradle).toContain('**/libsqlite_vec.so');
    // ولا يستدعي التطبيق أي امتداد SQLite أبداً.
    const src = read('src/database/connection.ts');
    expect(src).not.toContain('loadExtension');
  });

  test('② React Native 0.77.3 + React 18.3.1 وحذف المكتبات غير المستخدمة', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies['react-native']).toBe('0.77.3');
    expect(pkg.dependencies['react']).toBe('18.3.1');
    // مكتبتان محذوفتان (لم تُستخدما من JS قط).
    expect(pkg.dependencies['react-native-reanimated']).toBeUndefined();
    expect(pkg.dependencies['react-native-gesture-handler']).toBeUndefined();
    // عائلة المكتبات المطابقة لعهد RN 0.77.
    expect(pkg.dependencies['react-native-screens']).toBe('4.13.1');
    expect(pkg.dependencies['react-native-svg']).toBe('15.12.1');
    expect(pkg.dependencies['react-native-safe-area-context']).toBe('5.2.0');
    expect(pkg.dependencies['react-native-mmkv']).toBe('3.2.0');
    expect(pkg.dependencies['@op-engineering/op-sqlite']).toBe('11.2.6');
    // التنقل بقي على الجيل السادس — لا تغيير في منطق الشاشات.
    expect(pkg.dependencies['@react-navigation/native']).toBe('6.1.18');
    // RN 0.77 لم تعد تحزم الـ CLI — أمر autolinking الافتراضي
    // (npx @react-native-community/cli config) يحتاجها مثبتة، وإلا
    // نزّل npx أحدث نسخة غير متوافقة وأنتج config فارغاً فيفشل
    // البناء عند generateAutolinkingPackageList. الإصدار 18 هو
    // المقابل لعهد RN 0.77.
    expect(pkg.devDependencies['@react-native-community/cli']).toBe(
      '18.0.0',
    );
    // وإضافة reanimated اختفت من إعدادات babel (السطر الوظيفي فقط —
    // التعليقات قد تذكر الاسم توثيقاً).
    const babel = read('babel.config.js');
    expect(babel).not.toContain("'module:react-native-reanimated/plugin'");
  });

  test('③ زر الرجوع: تعطيل الإرجاع التنبؤي (RN 0.77 يستخدم onBackPressed القديم)', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:enableOnBackInvokedCallback="false"');
  });

  test('③ الواجهة: الانسحاب من فرض edge-to-edge في Android 15/16', () => {
    const styles = read('android/app/src/main/res/values/styles.xml');
    expect(styles).toContain('android:windowOptOutEdgeToEdgeEnforcement');
    // ألوان شريط الحالة/التنقل الداكنة باقية كما كانت.
    expect(styles).toContain('android:statusBarColor');
    expect(styles).toContain('android:navigationBarColor');
  });

  test('④ SoLoader بالخريطة المدمجة (شرط RN 0.76+) والإصدار 45.0.0 (53)', () => {
    const app = read(
      'android/app/src/main/java/com/sela/pal/MainApplication.kt',
    );
    expect(app).toContain('SoLoader.init(this, OpenSourceMergedSoMapping)');
    expect(app).not.toContain('SoLoader.init(this, false)');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionName "45.0.0"');
    expect(gradle).toContain('versionCode 53');
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '45.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 53');
  });

  test('④ autolinking الجديد داخل Gradle Plugin (صيغة RN 0.77)', () => {
    const settings = read('android/settings.gradle');
    expect(settings).toContain('com.facebook.react.settings');
    expect(settings).toContain('autolinkLibrariesFromCommand');
    expect(settings).not.toContain('applyNativeModulesSettingsGradle(settings)');
    // غلاف Gradle المطابق لـ RN 0.77.
    const wrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
    expect(wrapper).toContain('gradle-8.11.1-all.zip');
    // ولا أثر لخطّاف cli-platform-android القديم (حُذف من RN 0.77
    // وكان يفشل البناء لعدم وجود الملف).
    const appGradle = read('android/app/build.gradle');
    expect(appGradle).not.toContain('applyNativeModulesAppBuildGradle');
    // وربط مشاريع المكتبات باعتماديات التطبيق (شرط RN 0.75+ وإلا
    // فشل configureCMake لأن مجلدات codegen لا تُنشأ).
    expect(appGradle).toContain('autolinkLibrariesWithApp()');
    expect(appGradle).not.toContain(
      'node_modules/@react-native-community/cli-platform-android',
    );
  });

  test('⑤ صيغة op-sqlite الجديدة: لا وجود لـ _array في أي ملف مصدر', () => {
    const srcs = [
      'src/database/connection.ts',
      'src/services/BackupService.ts',
      'src/services/InvoiceService.ts',
      'src/services/sila/SilaRepo.ts',
      'src/services/sila/VouchersRepo.ts',
      'src/database/repositories/SaleRepo.ts',
    ];
    for (const f of srcs) {
      expect(read(f)).not.toContain('_array');
    }
    // والمحاكاة في الاختبارات تعيد rows كمصفوفة مباشرة.
    const mock = read('__tests__/helpers/op-sqlite-mock.js');
    expect(mock).not.toContain('_array');
  });
});

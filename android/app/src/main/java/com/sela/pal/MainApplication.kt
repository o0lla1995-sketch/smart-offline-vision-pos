package com.sela.pal

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import com.sela.pal.native_modules.SelaPackage
import com.sela.pal.native_modules.StockAlertsWorker
import java.util.Locale

class MainApplication : Application(), ReactApplication {

  /**
   * سيلا Arabic-first, process-wide. Forcing the ar locale + RTL layout
   * direction on the APPLICATION context means every derived context —
   * every Activity, the React context, and the system notifications we
   * build from it — carries an Arabic RTL configuration regardless of
   * the device's own locale (Hebrew/English devices included). This is
   * what makes stock-alert notifications render right-to-left with no
   * left-edge cutoff, and keeps I18nManager.isRTL true from launch.
   */
  override fun attachBaseContext(base: Context) {
    val locale = Locale("ar")
    Locale.setDefault(locale)
    val config = Configuration(base.resources.configuration)
    config.setLocale(locale)
    config.setLayoutDirection(locale)
    super.attachBaseContext(base.createConfigurationContext(config))
  }

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Hand-written native modules:
              // thermal printer + platform utils + image decoder + notifications.
              add(SelaPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // v45 (round-53): RN 0.76+ merged the native libraries — SoLoader
    // must be handed the merged .so mapping instead of the legacy
    // `false` flag, otherwise the merged libreactnative.so fails to
    // load at startup.
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in to the New Architecture, we load the native entry point for this app.
      load()
    }
    // v33 (round-41 #3): تنبيهات المخزون خارج التطبيق — عامل WorkManager
    // دوري يقرأ قاعدة البيانات ويرسل إشعارات النظام حتى والتطبيق
    // مغلق. الجدولة KEEP — تستمر عبر إعادة تشغيل الجهاز.
    try {
      StockAlertsWorker.ensureScheduled(this)
    } catch (e: Exception) {
      // WorkManager غير متاح على رومات نادرة — التطبيق يعمل بدونه.
    }
  }
}

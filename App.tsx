/**
 * App root — سيلا (Sela).
 * ─────────────────────────────────────────────────────────────────
 * Boot order:
 *  1. SQLite schema bootstrap + migrations (blocking)
 *  2. Catalog + embeddings index refresh
 *  3. Stock alerts evaluation (notifications)
 *  4. TFLite vision model load (async — manual fallback if it fails)
 *  5. Printer auto-reconnect (silent best-effort)
 *
 * Everything renders inside a root ErrorBoundary — a crash anywhere
 * shows a recovery screen instead of a black activity.
 */
import React, {useEffect, useState} from 'react';
import {
  Appearance,
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import {RootNavigator} from './src/navigation/RootNavigator';
import {LicenseGate} from './src/components/LicenseGate';
import {AppLockGate} from './src/components/AppLockGate';
import {Toaster as UIToaster} from './src/components/ui';
import {ErrorBoundary as Boundary} from './src/components/ErrorBoundary';
import {initDatabase} from './src/database/connection';
import {useCatalogStore} from './src/stores/catalogStore';
import {useCartStore} from './src/stores/cartStore';
import {useSettingsStore} from './src/stores/settingsStore';
import {usePrinterStore} from './src/stores/printerStore';
import {useSilaStore} from './src/stores/silaStore';
import {SilaSync} from './src/services/sila/SilaSync';
import {VisionRecognitionService} from './src/services/vision/VisionRecognitionService';
import {StockAlertsService} from './src/services/StockAlertsService';
// v28 (round-36 #4): Google Drive auto-backup scheduler — a no-op
// until the merchant links an account AND enables auto-upload.
import {startAutoScheduler} from './src/services/GoogleDriveService';
import {logDiag} from './src/core/diagnostics';
import {
  colors,
  fonts,
  spacing,
  typography,
  useThemeStore,
  useThemeColors,
} from './src/core/theme';

type BootState = 'booting' | 'ready' | 'error';

export default function App(): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>('booting');
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const bootAsync = async () => {
      try {
        // 1. Database schema (must succeed).
        await initDatabase();

        // 2. Catalog & vision index.
        await useCatalogStore.getState().refresh();

        // 3. Stock alerts (best-effort, never blocks boot).
        try {
          await StockAlertsService.evaluate();
        } catch {
          // Notifications are never fatal.
        }

        // 4. Vision model — failure keeps the app usable manually.
        await VisionRecognitionService.loadModel();

        // 5. Apply default pricing mode to a fresh cart.
        const settings = useSettingsStore.getState().settings;
        const cart = useCartStore.getState();
        if (cart.lines.length === 0) {
          cart.setPricingMode(settings.defaultPricingMode);
        }

        // 6. Silent printer auto-reconnect.
        void usePrinterStore.getState().connectSaved();

        // 7. v11 (SILA): load the merchant pairing + queue counts
        //    and start the 60-second Store & Forward loop when the
        //    device is paired (SILA_POS_API §8). Quiet when offline —
        //    the health probe fails fast and retries next cycle.
        useSilaStore.getState().load();
        if (useSilaStore.getState().pairing != null) {
          SilaSync.start();
        }

        // 8. v28 (round-36 #4): Google Drive auto-backup scheduler —
        //    first check ~25s after boot, then every 15 minutes.
        //    Fully silent no-op while not linked / not enabled /
        //    not due / offline.
        startAutoScheduler();

        if (mounted) {
          setBoot('ready');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDiag('boot', `فشل إقلاع التطبيق: ${message}`, 'error');
        if (mounted) {
          setBootError(message);
          setBoot('error');
        }
      }
    };
    void bootAsync();
    return () => {
      mounted = false;
    };
  }, []);

  // Keep the resolved theme in sync with the OS when mode = 'system'.
  useEffect(() => {
    const subscription = Appearance.addChangeListener(() => {
      useThemeStore.getState().syncSystem();
    });
    return () => subscription.remove();
  }, []);

  return (
    // v45 (round-53): GestureHandlerRootView removed with the unused
    // react-native-gesture-handler dependency (zero JS usage — plain
    // View keeps the same root layout).
    <View style={styles.root}>
      <SafeAreaProvider>
        <ThemedChrome />
        <Boundary label="التطبيق">
          {boot === 'booting' ? (
            <BootSplash />
          ) : boot === 'error' ? (
            <BootError message={bootError ?? 'خطأ غير معروف'} />
          ) : (
            // v13 (round-19 #2): cold-start lock — when fingerprint
            // and/or a 4-digit PIN is configured the gate paints a
            // full-screen lock overlay above everything (fingerprint
            // prompt fires automatically); the app tree stays mounted
            // underneath so nothing is lost on unlock.
            <AppLockGate>
              <LicenseGate>
                <RootNavigator />
              </LicenseGate>
            </AppLockGate>
          )}
          <UIToaster />
        </Boundary>
      </SafeAreaProvider>
    </View>
  );
}

/** StatusBar + root background follow the active theme. */
function ThemedChrome(): null | React.JSX.Element {
  const c = useThemeColors();
  return (
    <StatusBar
      barStyle={
        useThemeStore.getState().resolved === 'dark'
          ? 'light-content'
          : 'dark-content'
      }
      backgroundColor={c.bg}
    />
  );
}

function BootSplash(): React.JSX.Element {
  const c = useThemeColors();
  return (
    <View style={[styles.center, {backgroundColor: c.bg}]}>
      <View style={[styles.splashMark, {backgroundColor: c.accent}]}>
        <Text style={styles.splashGlyph}>S</Text>
      </View>
      <Text style={[styles.splashTitle, {color: c.text}]}>sela</Text>
      <Text style={[styles.splashSubtitle, {color: c.textDim}]}>
        نقطة بيع ذكية — تعمل بلا إنترنت
      </Text>
      <ActivityIndicator
        color={c.accent}
        size="large"
        style={{marginTop: spacing.xl}}
      />
    </View>
  );
}

function BootError({message}: {message: string}): React.JSX.Element {
  const c = useThemeColors();
  return (
    <View style={[styles.center, {backgroundColor: c.bg}]}>
      <View style={[styles.splashMark, {backgroundColor: c.danger}]}>
        <Text style={styles.splashGlyph}>S</Text>
      </View>
      <Text style={[styles.errorTitle, {color: c.danger}]}>
        تعذّر تشغيل التطبيق
      </Text>
      <Text style={[styles.errorText, {color: c.text}]}>{message}</Text>
      <Text style={[styles.errorText, {color: c.textDim}]}>
        أعد تشغيل التطبيق — إذا استمرت المشكلة جرّب «مسح البيانات» من إعدادات
        أندرويد ثم أعد فتح التطبيق
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
  splashMark: {
    width: 92,
    height: 92,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  splashGlyph: {
    color: colors.onAccent,
    fontFamily: fonts.black,
    fontSize: 52,
    lineHeight: 64,
    marginTop: 6,
  },
  splashTitle: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: 32,
  },
  splashSubtitle: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.caption,
    marginTop: spacing.xs,
  },
  errorTitle: {
    color: colors.danger,
    fontFamily: fonts.black,
    fontSize: typography.heading,
    marginBottom: spacing.md,
  },
  errorText: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.caption,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
});

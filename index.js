/**
 * @format
 */

import {AppRegistry, I18nManager, UIManager} from 'react-native';

import App from './App';
import {name as appName} from './app.json';

// Enable LayoutAnimation presets on Android (camera sheet slide).
try {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
} catch {
  // Older Android versions simply skip animated layout changes.
}

// The app UI is fully Arabic — force RTL layout from the very first launch.
// Setting this before registerComponent applies on first run; on later runs
// it is a no-op because the preference is already persisted natively.
try {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
} catch (rtlError) {
  // Never crash the app because of RTL configuration issues.
  console.warn('[index] Failed to force RTL layout:', rtlError);
}

AppRegistry.registerComponent(appName, () => App);

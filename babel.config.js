module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // v45 (round-53): the reanimated babel plugin was removed together
  // with the react-native-reanimated dependency — it was never used
  // from JS (zero imports) and the plugin would fail to resolve after
  // the package removal.
};

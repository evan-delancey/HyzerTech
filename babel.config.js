module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Required for react-native-vision-camera frame processors:
      // compiles the 'worklet' directive into a real worklet function
      // so it can run on the camera thread. Must be listed last.
      'react-native-worklets-core/plugin',
    ],
  };
};

/* eslint-disable no-undef -- Babel loads this file with require(); the repository lint config
   declares Node globals only for its own scripts. */
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};

'use strict';
// わざと壊した実装（normalizePresets が DEFAULT_PRESETS を同一参照で返す）。
const real = require('../../../src/lib/volume.js');
const api = Object.assign({}, real);
api.normalizePresets = function (list, opts) {
  if (!Array.isArray(list)) { return api.DEFAULT_PRESETS; }
  return real.normalizePresets(list, opts);
};
module.exports = api;

'use strict';
// わざと壊した実装（解釈不能な値で fallback を返さず NaN を返す）。
const real = require('../../../src/lib/volume.js');
const api = Object.assign({}, real);
api.clampVolume = function (value, opts) {
  const max = (opts && opts.boost) ? 300 : 100;
  return Math.min(max, Math.max(0, Math.round(Number(value))));
};
module.exports = api;

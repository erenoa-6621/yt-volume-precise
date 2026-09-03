'use strict';
// わざと壊した実装（上限クランプを外した）。
// 「clampVolume の上限テストが本当に落ちるか」を実測するためだけの検体。
const real = require('../../../src/lib/volume.js');
const api = Object.assign({}, real);
api.clampVolume = function (value, opts) {
  const n = Number(value);
  if (!Number.isFinite(n)) { return (opts && opts.fallback !== undefined) ? opts.fallback : 50; }
  return Math.round(n) < 0 ? 0 : Math.round(n); // 上限を掛けない
};
module.exports = api;

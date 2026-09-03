'use strict';
// わざと壊した実装（parseVolumeInput がクランプしてしまう）。
const real = require('../../../src/lib/volume.js');
const api = Object.assign({}, real);
api.parseVolumeInput = function (raw) {
  const v = real.parseVolumeInput(raw);
  if (v === null) { return null; }
  return Math.min(100, Math.max(0, v));
};
module.exports = api;

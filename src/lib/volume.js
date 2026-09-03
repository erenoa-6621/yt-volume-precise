;(function (root) {
  'use strict';

  var MIN_VOL = 0;
  var MAX_VOL_PLAIN = 100;
  var MAX_VOL_BOOST = 300;
  var DEFAULT_PRESETS = [15, 30, 50, 70, 100];

  var FULLWIDTH_DIGITS = /[０-９]/g;
  var INTEGER_RE = /^[+-]?\d+$/;

  // 数値として解釈できるなら有限の Number を、できないなら null を返す内部関数。
  // null / undefined / boolean / 配列 / オブジェクト / 非数文字列 / NaN / Infinity は null。
  function toFiniteNumber(value) {
    if (typeof value === 'number') {
      return isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (trimmed === '') { return null; }
      var n = Number(trimmed);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  function maxFor(boost) {
    return boost ? MAX_VOL_BOOST : MAX_VOL_PLAIN;
  }

  function clampVolume(value, opts) {
    opts = opts || {};
    var boost = opts.boost === true;
    var fallback = (opts.fallback === undefined) ? 50 : opts.fallback;
    var n = toFiniteNumber(value);
    if (n === null) { return fallback; }
    var rounded = Math.round(n);
    if (rounded < MIN_VOL) { return MIN_VOL; }
    var max = maxFor(boost);
    if (rounded > max) { return max; }
    return rounded;
  }

  function parseVolumeInput(raw) {
    if (raw === null || raw === undefined) { return null; }
    var s;
    if (typeof raw === 'number') {
      if (!isFinite(raw)) { return null; }
      s = String(raw);
    } else if (typeof raw === 'string') {
      s = raw;
    } else {
      return null;
    }
    s = s.trim();
    if (s === '') { return null; }
    s = s.replace(FULLWIDTH_DIGITS, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30);
    });
    if (s.charAt(s.length - 1) === '%') {
      s = s.slice(0, -1).trim();
    }
    if (s === '' || !INTEGER_RE.test(s)) { return null; }
    var n = parseInt(s, 10);
    return isNaN(n) ? null : n;
  }

  function normalizePresets(list, opts) {
    opts = opts || {};
    var boost = opts.boost === true;
    if (!Array.isArray(list)) { return DEFAULT_PRESETS.slice(); }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (toFiniteNumber(list[i]) === null) { continue; }
      var v = clampVolume(list[i], { boost: boost });
      if (out.indexOf(v) === -1) { out.push(v); }
    }
    if (out.length === 0) { return DEFAULT_PRESETS.slice(); }
    out.sort(function (a, b) { return a - b; });
    return out.slice(0, 8);
  }

  function volumeToGain(volume) {
    return clampVolume(volume, { boost: true }) / 100;
  }

  function channelKey(raw) {
    if (typeof raw !== 'string') { return null; }
    var s = raw.trim();
    if (s.charAt(0) === '@') { s = s.slice(1); }
    s = s.toLowerCase();
    return s === '' ? null : s;
  }

  function stepFromWheel(current, deltaY, opts) {
    opts = opts || {};
    var boost = opts.boost === true;
    var step = opts.shift === true ? 5 : 1;
    var base = clampVolume(current, { boost: boost });
    var d = toFiniteNumber(deltaY);
    if (d === null || d === 0) { return base; }
    var next = d < 0 ? base + step : base - step;
    return clampVolume(next, { boost: boost });
  }

  var api = {
    MIN_VOL: MIN_VOL,
    MAX_VOL_PLAIN: MAX_VOL_PLAIN,
    MAX_VOL_BOOST: MAX_VOL_BOOST,
    DEFAULT_PRESETS: DEFAULT_PRESETS,
    clampVolume: clampVolume,
    parseVolumeInput: parseVolumeInput,
    normalizePresets: normalizePresets,
    volumeToGain: volumeToGain,
    channelKey: channelKey,
    stepFromWheel: stepFromWheel
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  root.YTVP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

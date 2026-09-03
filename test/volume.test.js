'use strict';
// SPEC.md 第2章の表を1行ずつ検査する。実装は src/lib/volume.js。
// このファイルは検査のみで、赤くても src を直さない。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// 既定は実装本体。YTVP_VOLUME_PATH を指定すると差し替えられる。
// これは tools/tests/run_scanner_regress.sh が「わざと壊した実装」を食わせて
// 『このテストが本当に落ちること』を実測するためだけの口。通常運用では使わない。
const MODULE_PATH = process.env.YTVP_VOLUME_PATH
  ? path.resolve(process.env.YTVP_VOLUME_PATH)
  : path.join(__dirname, '..', 'src', 'lib', 'volume.js');
const V = require(MODULE_PATH);

test('API 形状: SPEC のひな形どおり module.exports に全 API がある', () => {
  const fns = ['clampVolume', 'parseVolumeInput', 'normalizePresets',
               'volumeToGain', 'channelKey', 'stepFromWheel'];
  for (const name of fns) {
    assert.strictEqual(typeof V[name], 'function', name + ' が関数でない');
  }
});

test('定数: MIN_VOL / MAX_VOL_PLAIN / MAX_VOL_BOOST / DEFAULT_PRESETS', () => {
  assert.strictEqual(V.MIN_VOL, 0);
  assert.strictEqual(V.MAX_VOL_PLAIN, 100);
  assert.strictEqual(V.MAX_VOL_BOOST, 300);
  assert.deepStrictEqual(V.DEFAULT_PRESETS, [15, 30, 50, 70, 100]);
});

// ---------------------------------------------------------------- clampVolume
test('clampVolume: 通常域はそのまま', () => {
  assert.strictEqual(V.clampVolume(0), 0);
  assert.strictEqual(V.clampVolume(50), 50);
  assert.strictEqual(V.clampVolume(100), 100);
});

test('clampVolume: 上限 boost なし=100 / boost あり=300', () => {
  assert.strictEqual(V.clampVolume(101), 100);
  assert.strictEqual(V.clampVolume(150), 100);
  assert.strictEqual(V.clampVolume(150, {}), 100);
  assert.strictEqual(V.clampVolume(150, { boost: false }), 100);
  assert.strictEqual(V.clampVolume(150, { boost: true }), 150);
  assert.strictEqual(V.clampVolume(300, { boost: true }), 300);
  assert.strictEqual(V.clampVolume(301, { boost: true }), 300);
  assert.strictEqual(V.clampVolume(99999, { boost: true }), 300);
});

test('clampVolume: 下限は 0', () => {
  assert.strictEqual(V.clampVolume(-1), 0);
  assert.strictEqual(V.clampVolume(-9999), 0);
  assert.strictEqual(V.clampVolume(-9999, { boost: true }), 0);
});

test('clampVolume: 小数は Math.round', () => {
  assert.strictEqual(V.clampVolume(50.4), 50);
  assert.strictEqual(V.clampVolume(50.5), 51);
  assert.strictEqual(V.clampVolume(49.6), 50);
  assert.strictEqual(V.clampVolume(100.4), 100);
  assert.strictEqual(V.clampVolume(0.4), 0);
});

test('clampVolume: 解釈不能な値は fallback（既定 50）', () => {
  assert.strictEqual(V.clampVolume(null), 50);
  assert.strictEqual(V.clampVolume(undefined), 50);
  assert.strictEqual(V.clampVolume(NaN), 50);
  assert.strictEqual(V.clampVolume(Infinity), 50);
  assert.strictEqual(V.clampVolume(-Infinity), 50);
  assert.strictEqual(V.clampVolume('abc'), 50);
  assert.strictEqual(V.clampVolume({}), 50);
  assert.strictEqual(V.clampVolume([]), 50);
});

test('clampVolume: fallback は opts で差し替えできる', () => {
  assert.strictEqual(V.clampVolume(null, { fallback: 70 }), 70);
  assert.strictEqual(V.clampVolume('abc', { fallback: 0 }), 0);
  assert.strictEqual(V.clampVolume(NaN, { boost: true, fallback: 200 }), 200);
});

test('clampVolume: fallback はクランプしない（SPEC 2-b）', () => {
  assert.strictEqual(V.clampVolume(null, { fallback: 500 }), 500);
  assert.strictEqual(V.clampVolume('abc', { fallback: -10 }), -10);
});

test('clampVolume: 数値文字列は数値として解釈する', () => {
  assert.strictEqual(V.clampVolume('80'), 80);
  assert.strictEqual(V.clampVolume('80.6'), 81);
});

test('clampVolume: 戻り値は必ず整数', () => {
  const inputs = [0, 50.5, 100.4, -3, 'abc', null, undefined, NaN, Infinity, 250.7];
  for (const v of inputs) {
    const r = V.clampVolume(v, { boost: true });
    assert.ok(Number.isInteger(r), 'integer でない: ' + String(v) + ' -> ' + String(r));
  }
});

// ----------------------------------------------------------- parseVolumeInput
test('parseVolumeInput: 前後空白を除去する', () => {
  assert.strictEqual(V.parseVolumeInput(' 42 '), 42);
  assert.strictEqual(V.parseVolumeInput('\t7\n'), 7);
});

test('parseVolumeInput: 末尾の % を除去する', () => {
  assert.strictEqual(V.parseVolumeInput('42%'), 42);
  assert.strictEqual(V.parseVolumeInput(' 100% '), 100);
});

test('parseVolumeInput: 全角数字を半角化する', () => {
  assert.strictEqual(V.parseVolumeInput('１２３'), 123);
  assert.strictEqual(V.parseVolumeInput(' ８０%'), 80);
});

test('parseVolumeInput: クランプしない', () => {
  assert.strictEqual(V.parseVolumeInput('150'), 150);
  assert.strictEqual(V.parseVolumeInput('500'), 500);
  assert.strictEqual(V.parseVolumeInput('0'), 0);
});

test('parseVolumeInput: 数値もそのまま受ける', () => {
  assert.strictEqual(V.parseVolumeInput(42), 42);
  assert.strictEqual(V.parseVolumeInput(150), 150);
});

test('parseVolumeInput: 解釈できなければ null', () => {
  assert.strictEqual(V.parseVolumeInput('abc'), null);
  assert.strictEqual(V.parseVolumeInput('%'), null);
  assert.strictEqual(V.parseVolumeInput('12abc'), null);
  assert.strictEqual(V.parseVolumeInput({}), null);
  assert.strictEqual(V.parseVolumeInput([]), null);
});

test('parseVolumeInput: 空文字・空白のみ・null・undefined は null', () => {
  assert.strictEqual(V.parseVolumeInput(''), null);
  assert.strictEqual(V.parseVolumeInput('   '), null);
  assert.strictEqual(V.parseVolumeInput(null), null);
  assert.strictEqual(V.parseVolumeInput(undefined), null);
});

test('parseVolumeInput: 整数のみ受ける（SPEC 2-b）', () => {
  assert.strictEqual(V.parseVolumeInput('12.5'), null);
  assert.strictEqual(V.parseVolumeInput('87.5'), null);
});

test('parseVolumeInput: 除去する % は半角のみ。全角％は null（SPEC 2-b）', () => {
  assert.strictEqual(V.parseVolumeInput('８０％'), null);
  assert.strictEqual(V.parseVolumeInput('80％'), null);
  assert.strictEqual(V.parseVolumeInput('80%'), 80);
});

// ----------------------------------------------------------- normalizePresets
test('normalizePresets: 配列以外は DEFAULT_PRESETS のコピー', () => {
  for (const bad of [undefined, null, 'x', 42, {}]) {
    const r = V.normalizePresets(bad);
    assert.deepStrictEqual(r, V.DEFAULT_PRESETS, '入力: ' + String(bad));
    assert.notStrictEqual(r, V.DEFAULT_PRESETS, 'DEFAULT_PRESETS と同一参照を返している');
  }
});

test('normalizePresets: 結果が空なら DEFAULT_PRESETS のコピー', () => {
  const r = V.normalizePresets([]);
  assert.deepStrictEqual(r, V.DEFAULT_PRESETS);
  assert.notStrictEqual(r, V.DEFAULT_PRESETS);
  const r2 = V.normalizePresets(['abc', null, undefined]);
  assert.deepStrictEqual(r2, V.DEFAULT_PRESETS);
  assert.notStrictEqual(r2, V.DEFAULT_PRESETS);
});

test('normalizePresets: 返り値を壊しても DEFAULT_PRESETS は不変', () => {
  const r = V.normalizePresets('not-an-array');
  r.push(999);
  r[0] = -1;
  assert.deepStrictEqual(V.DEFAULT_PRESETS, [15, 30, 50, 70, 100]);
});

test('normalizePresets: 整数化する', () => {
  assert.deepStrictEqual(V.normalizePresets([30.4, 60.5]), [30, 61]);
  assert.deepStrictEqual(V.normalizePresets(['50']), [50]);
});

test('normalizePresets: 解釈不能な要素は捨てる（fallback で埋めない）', () => {
  assert.deepStrictEqual(V.normalizePresets([null, 'abc', 30, undefined, NaN]), [30]);
});

test('normalizePresets: 重複を除去する', () => {
  assert.deepStrictEqual(V.normalizePresets([50, 50, 50]), [50]);
  assert.deepStrictEqual(V.normalizePresets([50, 50.4, '50']), [50]);
});

test('normalizePresets: 昇順にソートする', () => {
  assert.deepStrictEqual(V.normalizePresets([100, 15, 30]), [15, 30, 100]);
  assert.deepStrictEqual(V.normalizePresets([9, 100, 20]), [9, 20, 100]);
});

test('normalizePresets: 先頭 8 件まで', () => {
  const r = V.normalizePresets([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.strictEqual(r.length, 8);
  assert.deepStrictEqual(r, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('normalizePresets: boost で上限が変わる', () => {
  assert.deepStrictEqual(V.normalizePresets([200]), [100]);
  assert.deepStrictEqual(V.normalizePresets([200], { boost: true }), [200]);
  assert.deepStrictEqual(V.normalizePresets([150, 200, 400], { boost: true }), [150, 200, 300]);
});

// --------------------------------------------------------------- volumeToGain
test('volumeToGain: 100->1 / 250->2.5 / 0->0', () => {
  assert.strictEqual(V.volumeToGain(100), 1);
  assert.strictEqual(V.volumeToGain(250), 2.5);
  assert.strictEqual(V.volumeToGain(0), 0);
});

test('volumeToGain: boost 上限 300 でクランプ、下限 0', () => {
  assert.strictEqual(V.volumeToGain(300), 3);
  assert.strictEqual(V.volumeToGain(400), 3);
  assert.strictEqual(V.volumeToGain(-50), 0);
});

test('volumeToGain: 解釈不能な値は clampVolume の fallback 経由（50 -> 0.5）', () => {
  assert.strictEqual(V.volumeToGain(null), 0.5);
  assert.strictEqual(V.volumeToGain('abc'), 0.5);
});

// ----------------------------------------------------------------- channelKey
test('channelKey: 先頭 @ を1個だけ除去して小文字化', () => {
  assert.strictEqual(V.channelKey('@Foo'), 'foo');
  assert.strictEqual(V.channelKey('Foo'), 'foo');
  assert.strictEqual(V.channelKey(' @Bar '), 'bar');
  assert.strictEqual(V.channelKey('@@x'), '@x');
  assert.strictEqual(V.channelKey('MixedCase'), 'mixedcase');
});

test('channelKey: 空になるものは null', () => {
  assert.strictEqual(V.channelKey(''), null);
  assert.strictEqual(V.channelKey('   '), null);
  assert.strictEqual(V.channelKey('@'), null);
  assert.strictEqual(V.channelKey(' @ '), null);
});

test('channelKey: 文字列以外は null', () => {
  for (const bad of [null, undefined, 123, {}, [], true, NaN]) {
    assert.strictEqual(V.channelKey(bad), null, '入力: ' + String(bad));
  }
});

// -------------------------------------------------------------- stepFromWheel
test('stepFromWheel: deltaY<0 で増、deltaY>0 で減（既定 1 刻み）', () => {
  assert.strictEqual(V.stepFromWheel(50, -1), 51);
  assert.strictEqual(V.stepFromWheel(50, 1), 49);
  assert.strictEqual(V.stepFromWheel(50, -120), 51);
  assert.strictEqual(V.stepFromWheel(50, 120), 49);
});

test('stepFromWheel: shift で 5 刻み', () => {
  assert.strictEqual(V.stepFromWheel(50, -1, { shift: true }), 55);
  assert.strictEqual(V.stepFromWheel(50, 1, { shift: true }), 45);
});

test('stepFromWheel: deltaY===0 / 非数は clampVolume(current) を返す', () => {
  assert.strictEqual(V.stepFromWheel(50, 0), 50);
  assert.strictEqual(V.stepFromWheel(50.4, 0), 50);
  assert.strictEqual(V.stepFromWheel(150, 0), 100);
  assert.strictEqual(V.stepFromWheel(150, 0, { boost: true }), 150);
  assert.strictEqual(V.stepFromWheel(50, NaN), 50);
  assert.strictEqual(V.stepFromWheel(50, 'abc'), 50);
  assert.strictEqual(V.stepFromWheel(150, undefined, { boost: true }), 150);
});

test('stepFromWheel: 上限で飽和する', () => {
  assert.strictEqual(V.stepFromWheel(100, -1), 100);
  assert.strictEqual(V.stepFromWheel(99, -1, { shift: true }), 100);
  assert.strictEqual(V.stepFromWheel(300, -1, { boost: true }), 300);
  assert.strictEqual(V.stepFromWheel(298, -1, { shift: true, boost: true }), 300);
  assert.strictEqual(V.stepFromWheel(100, -1, { boost: true }), 101);
});

test('stepFromWheel: 下限で飽和する', () => {
  assert.strictEqual(V.stepFromWheel(0, 1), 0);
  assert.strictEqual(V.stepFromWheel(2, 1, { shift: true }), 0);
  assert.strictEqual(V.stepFromWheel(0, 1, { boost: true }), 0);
});

test('stepFromWheel: 戻り値は整数', () => {
  const r = V.stepFromWheel(50.5, -1);
  assert.ok(Number.isInteger(r), 'integer でない: ' + String(r));
});

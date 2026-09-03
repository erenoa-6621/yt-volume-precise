'use strict';
/*
 * わざと継ぎ目を壊した検体（継ぎ目2・外科的な版）。
 * getSettings の応答はそのままに、setSettings の応答だけを
 * boostAllowed を欠いた部分オブジェクトにする。
 *
 * これは「応答が部分オブジェクトだと popup 側で boostAllowed が false に落ち、
 * ブースト許可がトグル操作で勝手に消える」そのものの再現。
 * patch_content_partial_settings.js は settingsReply 全体を壊すので、
 * popup はそもそも上限 300 に到達せず、トグル後の劣化を見たことにならない。
 *
 * ★v0.7 の変化（実測 2026-09-03）: 落ちるのは seam2 だけになり、seam2e2e は緑になる。
 * ポップアップが自前で描くのをやめ、上限は overlay が getState で受け取る
 * **真の状態**から引くようになったので、応答が欠けても表示は自力で直る。
 * つまり e2e の症状は消えた（二重実装をやめたことの副産物）。契約違反そのものは
 * 残るので、run_scanner_regress.sh はこの検体を seam2 に対して使う。
 *
 * 本物の src/content.js を1点だけ書き換える。当たらなくなったら例外で赤くする。
 */
const ANCHOR = 'applySettings(patch).then(';
const WINDOW = 400;
const PARTIAL = '({ ok: true, settings: { presets: settings.presets.slice() } })';

module.exports = function patch(source) {
  const i = source.indexOf(ANCHOR);
  if (i === -1) {
    throw new Error('検体が腐っている: src/content.js に ' + ANCHOR + ' が無い');
  }
  const seg = source.slice(i, i + WINDOW);
  const n = seg.split('settingsReply()').length - 1;
  if (n !== 2) {
    throw new Error('検体が腐っている: setSettings の枝の settingsReply() が ' + n + ' 箇所（2 のはず）');
  }
  return source.slice(0, i) + seg.split('settingsReply()').join(PARTIAL) + source.slice(i + WINDOW);
};

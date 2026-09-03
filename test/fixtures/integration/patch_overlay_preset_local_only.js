'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・SPEC 12-a）。
 *
 * 入れるバグ: ⚙ の「適用」が入力欄を読むだけで、bridge.setSettings へ流さない。
 * ⚙ は出るし、欄も開くし、押した感触もある。**保存されないことだけが起きない。**
 * パネルを開き直すまで誰も気付かないので、UI を見ているだけの検査は全部素通りする。
 *
 * 実測（2026-09-03）で落ちるのは4本:
 *   seam8-gear-opens-and-applies … 狙い。overlay 層（bridge.setSettings が呼ばれない）
 *   seam8-panel-preset-e2e       … 狙い。content 層（storage に届かない）
 *   seam1 / seam2e2e             … ポップアップも v0.7 から**同じ部品**で編集するので、
 *                                  ここを塞ぐとポップアップ側の setSettings も出なくなる。
 *                                  二重実装をやめた結果であって、検体の副作用ではない。
 */
const FROM = '      settle(safeCall(bridge.setSettings, bridge, { presets: readPresetInput() }));';
const TO = '      readPresetInput();   // 検体: 読むだけで保存へ流さない（パネルの中で閉じた設定）';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の applyPresets の送信が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

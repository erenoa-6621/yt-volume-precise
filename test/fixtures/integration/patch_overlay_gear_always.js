'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・SPEC 12-a）。
 *
 * 入れるバグ: bridge に setSettings があるかを見ずに、⚙ を常に生成する。
 * 保存先を持たない相手（配線前の content.js・旧版と同居している状態）でも
 * ⚙ が出るので、**押せるのに何も起きないボタン**が画面に並ぶ。
 * 例外は出ないし、権限も通信も DOM の総数もほとんど変わらないので、
 * 他のどの検査にも掛からない。
 *
 * 落ちるべきは seam8-gear-only-with-setsettings だけ。
 * 赤くならないなら、あの検査は「⚙ が出ること」しか見ておらず、
 * 「出ないべきときに出ないこと」を検査していない。
 */
const FROM = '    var canSettings = isFn(bridge.setSettings);';
const TO = '    var canSettings = true;   // 検体: 保存先の有無を見ずに ⚙ を出す';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の canSettings の判定が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

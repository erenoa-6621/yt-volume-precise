'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・v0.6 の開閉）。
 *
 * 入れるバグ: 自動クローズが「入力中かどうか」を見ない。
 * 打っている途中でマウスがパネルの外へ出ただけでパネルが畳まれ、
 * blur の意味論（適用せず現在値へ戻す）が走って**打ちかけの文字が消える**。
 * この製品の出発点は「数値で入れたい」なので、これは機能の中心が壊れた状態である。
 *
 * 落ちるべきは2本（音量欄とプリセット欄。どちらもこの検体の狙い）:
 *   seam8-no-close-while-typing
 *   seam8-no-close-while-typing-presets
 * 片方しか落ちないなら、どちらかの欄が保護から漏れているということ。
 */
const FROM = '        if (isTypingAnywhere()) { scheduleClose(); return; }';
const TO = '        // 検体: 編集中でも構わず閉じる';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の scheduleClose の編集中判定が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

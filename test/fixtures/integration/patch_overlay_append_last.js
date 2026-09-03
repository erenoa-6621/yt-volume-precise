'use strict';
/*
 * わざとバグを戻した検体（継ぎ目7・SPEC 9-a の「先頭」）。
 *
 * 戻す状態: insertFirst が先頭ではなく末尾に差し込む。
 * ボタンは .ytp-right-controls の中に居るし、押せばパネルも開くので、
 * 「ネイティブ統合が動いているか」だけを見る検査は全部通ってしまう。
 * だが SPEC 9-a が指定しているのは **先頭**（全画面ボタンの右外に出ない位置）で、
 * 末尾に入れると YouTube の既存ボタンの並びを崩す。
 *
 * この検体は「継ぎ目7 が『入ったかどうか』ではなく『どこに入ったか』まで
 * 見ているか」の判定点。落ちるべきは 先頭を見ているアサーションだけ。
 *
 * 本物の src/overlay.js を書き換える方式（写しを置くと src の変更で腐るため）。
 * 当たらなくなったら例外を投げて赤くする。
 */
function replaceOnce(source, from, to, what) {
  const n = source.split(from).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の ' + what + ' が ' + n + ' 箇所（1 のはず）: ' + from);
  }
  return source.split(from).join(to);
}

const FROM = '    if (isFn(parent.prepend)) { parent.prepend(node); return true; }';
const TO = '    if (isFn(parent.appendChild)) { parent.appendChild(node); return true; }   // 検体: 先頭ではなく末尾に入れる';

module.exports = function patch(source) {
  return replaceOnce(source, FROM, TO, '先頭への挿入');
};

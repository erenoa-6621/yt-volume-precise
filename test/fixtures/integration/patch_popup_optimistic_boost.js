'use strict';
/*
 * わざとバグを戻した検体（継ぎ目4・popup 側の楽観更新）。
 *
 * 戻すバグ: setBoost の応答を待たずに、押した瞬間の値を表示へ反映する。
 * content が死んでいても UI だけ ON/OFF が動くので、ユーザーには効いたように見える。
 *
 * ★v0.7 でアンカーを張り替えた。ポップアップは自分では描かなくなり、表示を動かす
 * 手段は「購読者（overlay の update）へ状態を流す」＝ notify() だけになった。
 * 旧アンカー（popup.js が自分で render() を呼んでいた行）は src から消えている。
 * ここでは送信の**前**に notify() を打つ。overlay は届いた状態をそのまま描くので、
 * content が何も確認していない値が画面に出る＝楽観更新そのものになる。
 *
 * この検体で seam4-no-optimistic が赤くならないなら、あの検査は空振りである。
 * （seam4-no-optimistic は表示の差分をブーストの表示だけに絞り、かつ
 *   「クリックの直後・応答の処理前」という時点で見ているので、絞ったあとでも
 *   楽観更新を捕まえられることを、この検体で実測する。）
 */
const FROM = "        send({ type: 'setBoost', enabled: b === true }, function (res) {";
const TO = "        // 検体: 応答を待たずに表示を反映する（楽観更新）\n"
         + "        settings.boostAllowed = b === true;\n"
         + "        notify({ volume: 0, muted: false, boost: b === true, available: true });\n"
         + "        send({ type: 'setBoost', enabled: b === true }, function (res) {";

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/popup.js の setBoost の送信が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

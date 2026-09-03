'use strict';
/*
 * わざとバグを戻した検体（継ぎ目9・content 側。SPEC 11-b）。
 *
 * 戻す状態: 左コントロールへ差し込めたのに nativeAlign を渡さない。
 * SPEC 11-b は「overlay は値を CSS クラスに写すだけで左右の判断はしない」と決めてある。
 * だから content が渡さなければ overlay は既定＝右寄せのままになる。**これは overlay の
 * バグではない**（契約どおり）。どちらの単体テストにも入らないのはそのためで、
 * 両者を配線した継ぎ目でしか見えない。
 *
 * 見た目の壊れ方は静かで危険:
 *   * ボタンは正しく音量の隣に入る（位置だけを見る検査は全部通る）
 *   * パネルも開くし操作も効く
 *   * 例外も出ず、DOM の個数も権限も通信も変わらない
 *   * 実機でだけ「左端で開いたパネルが右寄せのままプレイヤーの外へはみ出す」
 *
 * 落ちるべきは寄せ方向を見ているアサーション（seam9-left-align-class）だけ。
 * 位置を見る seam9-left-after-volume や右フォールバックは素通りするのが正しい。
 *
 * 本物の src/content.js を書き換える方式（写しを置くと src の変更で腐るため）。
 * 当たらなくなったら例外を投げて赤くする。
 */
function replaceOnce(source, from, to, what) {
  const n = source.split(from).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/content.js の ' + what + ' が ' + n + ' 箇所（1 のはず）: ' + from);
  }
  return source.split(from).join(to);
}

const FROM = "          return { anchor: left, before: before, align: 'left' };";
const TO = '          return { anchor: left, before: before, align: null };   // 検体: 寄せ方向を渡さない';

module.exports = function patch(source) {
  return replaceOnce(source, FROM, TO, '左へ差し込めたときの nativeAlign');
};

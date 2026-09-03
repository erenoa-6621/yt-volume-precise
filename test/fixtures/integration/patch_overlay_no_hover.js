'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・v0.6 の開閉）。
 *
 * 入れるバグ: bindHover が1つもリスナを張らない ＝ ホバーの導線が丸ごと消える。
 * クリックでの開閉は残るので、**v0.5 とまったく同じ挙動**になる。例外も出ず、
 * DOM も権限も通信も変わらない。パネルは開くし操作も効くので、
 * 継ぎ目7 までのどの検査にも掛からない。
 *
 * 落ちるのは3本。いずれも「ホバーで開く」が前提の保証なので、
 * ホバーを消せば同時に失われるのが正しい:
 *   seam8-hover-open-close          （狙い。乗せても開かない）
 *   seam8-hover-no-focus            （乗せて開く状態自体が作れない）
 *   seam8-no-close-while-typing     （同上。固定でない開き方が無くなる）
 * 逆に seam8-click-pins / seam8-touch-no-hover は素通りするのが正しい
 * （どちらもクリック経路の保証で、ホバーの有無に依らない）。
 */
const FROM = '    function bindHover(target, which) {\n      if (!target) { return; }';
const TO = '    function bindHover(target, which) {\n'
         + '      if (target || !target) { return; }   // 検体: ホバーを一切張らない';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の bindHover が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

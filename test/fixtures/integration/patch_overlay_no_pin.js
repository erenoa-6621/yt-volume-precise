'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・v0.6 の「クリックで固定」）。
 *
 * 入れるバグ: クリックしても pinned を立てない。
 * クリックすればパネルは開くので「クリックで開く」だけを見る検査は素通りする。
 * だが固定が効かないので、**手を離した瞬間に閉じる**。
 * 数値を打とうとして手を伸ばした先でパネルが消える、という形で現れる。
 *
 * 落ちるべきは seam8-click-pins だけ。
 */
const FROM = '      pinned = true;\n      setOpen(true);';
const TO = '      pinned = false;   // 検体: クリックしても固定しない\n      setOpen(true);';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の onTriggerClick の固定が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

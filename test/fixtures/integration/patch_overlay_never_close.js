'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・v0.6 の開閉の「閉じる」側）。
 *
 * 入れるバグ: ポインタが離れても自動クローズを予約しない。
 * 開くほうは正しく動くので、「乗せたら開いた」で満足する検査は素通りする。
 * 実機では一度でもボタンに触れるとパネルが出っぱなしになり、動画を覆い続ける。
 *
 * patch_overlay_no_hover.js が「開く」側を、この検体が「閉じる」側を担当する。
 * 1つの検体で片側しか壊せないので、seam8-hover-open-close の2つの主張
 * （開く／離れたら閉じる）を別々に実測するために両方置いてある。
 *
 * 落ちるべきは seam8-hover-open-close だけ。
 * seam8-click-pins と seam8-no-close-while-typing は「閉じないこと」を
 * 主張する検査なので、この検体では素通りするのが正しい。
 */
const FROM = '        if (!anyHover()) { scheduleClose(); }';
const TO = '        if (!anyHover()) { /* 検体: 離れても閉じない */ }';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の leaveFn の閉じ予約が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

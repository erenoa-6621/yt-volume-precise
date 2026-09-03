'use strict';
/*
 * わざと継ぎ目を壊した検体（継ぎ目1）。
 * popup が setSettings を「settings キー無しの平置き」で投げるようにする。
 * content 側は payload.settings がオブジェクトでなければ invalid-settings を返すので、
 * 本当なら結合テストが赤くならなければならない。それを実測するためだけの検体。
 *
 * 検体にソースの写しを置くと src の変更で腐るので、本物の src/popup.js を受け取って
 * 1箇所だけ書き換える方式にしてある。当たらなくなったら例外で赤くする。
 *
 * v0.7 でアンカーを張り替えた。ポップアップが自前の UI を捨てたことで、
 * 旧アンカー（編集フォームの中で `{ presets: list }` を組み立てていた行）は
 * src から消えていた。当たらない検体も例外で赤くはなるが、その赤は
 * 「継ぎ目が壊れている」ではなく「検体が腐っている」なので、回帰としては空振りである。
 */
const FROM = "send({ type: 'setSettings', settings: patch }";
const TO = "send({ type: 'setSettings', presets: patch.presets }";

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/popup.js に想定の呼び出しが ' + n + ' 箇所（1 のはず）: ' + FROM);
  }
  return source.split(FROM).join(TO);
};

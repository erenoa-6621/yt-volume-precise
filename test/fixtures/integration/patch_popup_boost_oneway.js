'use strict';
/*
 * わざとバグを戻した検体（継ぎ目4・popup 側）。SPEC 3-d が禁じた一方通行そのもの。
 *
 * 戻すバグ: ポップアップが「今 boostAllowed が false だから」という理由で、
 * ブーストの要求そのものを送らずに黙って戻る。
 * 自分自身の値で自分を押せなくすると、OFF にした瞬間に許可ごと消えて
 * 二度と ON へ戻せない。
 *
 * ★v0.7 で書き換えた（旧名 patch_popup_boost_disabled.js）。
 * 旧検体は popup.js の render() へ `el.boost.disabled = ...` を差し込んでいたが、
 * v0.7 でポップアップは自前の UI を捨て、描くのは src/overlay.js だけになった。
 * popup.js に render() も el.boost も無いので、旧アンカーは1箇所も当たらない。
 * 「見た目を塞ぐ」ほうの一方通行は overlay 側の担当なので
 * test/fixtures/integration/patch_overlay_boost_conditional.js が持つ（継ぎ目5）。
 * こちら（継ぎ目4・popup 側）に残るのは **要求を出さない**形の一方通行である。
 *
 * seam4-popup-not-oneway は「disabled でないだけでは足りない。押して本当に ON へ
 * 戻せることまで見る（早期 return で黙って何もしない実装も一方通行である）」と
 * 書いてある。この検体はまさにその早期 return を作って、その一文が空文句でないことを
 * 実測する。赤くならないなら、あの検査は表示しか見ていない。
 */
const FROM = "    setBoost: function (b) {\n      return new Promise(function (resolve) {";
const TO = "    setBoost: function (b) {\n      return new Promise(function (resolve) {\n"
         + "        // 検体: 自分の値で自分を押せなくする（要求を出さない一方通行）\n"
         + "        if (settings.boostAllowed !== true) { resolve(null); return; }";

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/popup.js の bridge.setBoost が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

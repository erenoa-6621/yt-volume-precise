'use strict';
/*
 * わざとバグを戻した検体（継ぎ目6・content 側）。c8c17e9 で塞いだバグそのもの。
 *
 * 戻すバグ: normalizeState が MAIN world の返す boost をそのまま採用する
 * （修正前の該当行は `boost: src.boost === true`）。
 * MAIN world（src/page.js）の注入が content より遅れると、MAIN 側の boostEnabled は
 * false のままなので、storage.boostAllowed=true でも state.boost=false が返る。
 * その状態では volume:150 が MAIN 側で 100 に丸められ、ブーストが効かない。
 *
 * SPEC 3-d: 「state.boost は settings.boostAllowed をそのまま反映する。
 * 両者が食い違う状態は存在しない。」
 *
 * この検体で seam6-mainworld-late が赤くならないなら、あの検査は空振りである。
 *
 * 本物の src/content.js を1点だけ書き換える（写しを置くと src の変更で腐るため）。
 * 当たらなくなったら例外を投げて赤くする。
 * 同じ行が UNAVAILABLE() にもあるので、直前の muted 行込みで一意に当てる。
 */
const FROM = '      muted: src.muted === true,\n'
           + '      boost: settings.boostAllowed === true,';
const TO = '      muted: src.muted === true,\n'
         + '      boost: src.boost === true,   // 検体: MAIN world の値をそのまま採用する';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/content.js の normalizeState の boost 行が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

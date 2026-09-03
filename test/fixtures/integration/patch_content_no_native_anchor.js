'use strict';
/*
 * わざとバグを戻した検体（継ぎ目7・content 側）。c139b05 で足した配線を
 * **無かったこと**にする。
 *
 * 戻す状態: mount の options から nativeAnchor のキーごと落とす（v0.1 の呼び方）。
 * 探索そのもの（findNativeAnchor）は残っているので content 単体では矛盾が無く、
 * overlay 側も「nativeAnchor 未指定なら浮きハンドル」という契約どおりに動く
 * （SPEC 9-c の後方互換）。**どちらも自分の契約を守ったまま、機能だけが消える。**
 * 継ぎ目7 だけがこれを捕まえられる。
 *
 * 「nativeAnchor:null と未指定は DOM が完全一致」と実測で確認されているので、
 * この検体は null を渡す版と同じ状態も同時に押さえている。
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

const FROM = '        boostAllowed: settings.boostAllowed,\n        nativeAnchor: anchor\n';
const TO = '        boostAllowed: settings.boostAllowed\n';

module.exports = function patch(source) {
  return replaceOnce(source, FROM, TO, 'overlay.mount へ渡す nativeAnchor');
};

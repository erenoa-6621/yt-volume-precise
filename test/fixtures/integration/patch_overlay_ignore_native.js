'use strict';
/*
 * わざとバグを戻した検体（継ぎ目7・overlay 側）。541bb09 で足した
 * ネイティブ統合を **丸ごと無かったこと**にする。
 *
 * 戻す状態: mount() が options.nativeAnchor を見ず、常に従来の浮きハンドルで組む。
 * これは v0.1 の overlay.js とまったく同じ振る舞いで、overlay 単体では何も壊れない
 * （contract スキャナも通る。ytvp-root は出るし chrome.* も触らない）。
 * content 側も「探して渡す」までは正しく動いているので、A の検査にも掛からない。
 * **継ぎ目7 だけが、この状態を「YouTube の画面にボタンが出ない」として捕まえられる。**
 *
 * この検体で seam7-* が赤くならないなら、あの検査は何も検査していない。
 *
 * 本物の src/overlay.js を書き換える方式にしてある（写しを置くと src の変更で腐るため）。
 * 当たらなくなったら例外を投げて赤くする。
 */
function replaceOnce(source, from, to, what) {
  const n = source.split(from).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の ' + what + ' が ' + n + ' 箇所（1 のはず）: ' + from);
  }
  return source.split(from).join(to);
}

const FROM = '      var anchor = pickAnchor(opts.nativeAnchor);';
const TO = '      var anchor = null;   // 検体: 渡された差し込み先を無視して常に浮きハンドルにする';

module.exports = function patch(source) {
  return replaceOnce(source, FROM, TO, 'nativeAnchor の採用');
};

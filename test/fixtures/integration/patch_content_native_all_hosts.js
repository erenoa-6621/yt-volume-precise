'use strict';
/*
 * わざとバグを戻した検体（継ぎ目7・SPEC 9-b のホスト除外）。
 *
 * 戻す状態: ネイティブ統合の対象ホストに music.youtube.com を足す。
 * YouTube Music は DOM が別物なので、対象にすると「たまたま同名のクラスがある要素」へ
 * ボタンを差し込むことになる（SPEC 9-b が名指しで禁じている）。
 * 判定を1語広げるだけの変更で、権限も通信も何も変わらないため、
 * 他のどの検査にも掛からない。継ぎ目7 の music 側だけが捕まえられる。
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

const FROM = "  var NATIVE_HOSTS = ['www.youtube.com'];";
const TO = "  var NATIVE_HOSTS = ['www.youtube.com', 'music.youtube.com'];   // 検体: SPEC 9-b の除外を外す";

module.exports = function patch(source) {
  return replaceOnce(source, FROM, TO, 'ネイティブ統合の対象ホスト');
};

'use strict';
/*
 * わざとバグを戻した検体（継ぎ目4・content 側）。
 *
 * 戻すバグ: 一度 setBoost{enabled:false} を受けると、以後 enabled:true を受けても
 * boostAllowed が二度と true に戻らない「一方通行」。
 * これは実測で見つかった本物の製品バグ（SPEC 3-d 新設の原因）そのものである。
 *
 * この検体で test/integration.test.js の seam4-boost-roundtrip が赤くならないなら、
 * あの検査は何も検査していない。
 *
 * 本物の src/content.js を2点だけ書き換える（写しを置くと src の変更で腐るため）。
 * 当たらなくなったら例外を投げて赤くする。
 */
const DECL_FROM = '  var overlayHandle = null;';
const DECL_TO = '  var overlayHandle = null;\n  var ytvpOffLatch = false;  // 検体: 一度 OFF にしたら二度と ON へ戻さない';

const SET_FROM = '    settings.boostAllowed = (enabled === true);';
const SET_TO = '    if (enabled !== true) { ytvpOffLatch = true; }\n'
             + '    settings.boostAllowed = (ytvpOffLatch ? false : (enabled === true));';

function replaceOnce(source, from, to, what) {
  const n = source.split(from).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/content.js の ' + what + ' が ' + n + ' 箇所（1 のはず）: ' + from);
  }
  return source.split(from).join(to);
}

module.exports = function patch(source) {
  let out = replaceOnce(source, DECL_FROM, DECL_TO, 'overlayHandle 宣言');
  out = replaceOnce(out, SET_FROM, SET_TO, 'setBoost の boostAllowed 代入');
  return out;
};

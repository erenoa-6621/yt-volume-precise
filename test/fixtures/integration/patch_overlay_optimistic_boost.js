'use strict';
/*
 * わざとバグを戻した検体（継ぎ目5・overlay 側／楽観更新）。
 *
 * 戻すバグ: ブーストのトグルを押した瞬間に見た目を反転させる。
 * SPEC 3-e(2) は「トグルは楽観更新しない。content が死んでいるのに UI だけ ON に
 * なった状態が放置される害のほうが大きい」と定めている（対象は現存するブーストのトグル）。
 *
 * この検体で seam5-overlay-no-optimistic が赤くならないなら、あの検査は空振りである。
 */
const FROM = '      settle(safeCall(bridge.setBoost, bridge, !state.boost));';
const TO = '      // 検体: 応答を待たずに見た目を反転させる（楽観更新）\n'
         + '      var ytvpWant = !state.boost;\n'
         + '      state.boost = ytvpWant;\n'
         + '      render();\n'
         + '      settle(safeCall(bridge.setBoost, bridge, ytvpWant));';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の setBoost 呼び出しが ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

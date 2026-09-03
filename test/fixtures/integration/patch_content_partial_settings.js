'use strict';
/*
 * わざと継ぎ目を壊した検体（継ぎ目2）。
 * content の settingsReply() が boostAllowed を返さない「部分オブジェクト」にする。
 * popup 側は応答の boostAllowed が無いと false に落とすので、トグル操作のたびに
 * ブースト許可が黙って消える。本当なら結合テストが赤くならなければならない。
 *
 * 本物の src/content.js を受け取り、settingsReply の中の1行だけを消す。
 * 当たらなくなったら例外で赤くする（腐った検体で緑になるのを防ぐ）。
 */
module.exports = function patch(source) {
  const head = source.indexOf('function settingsReply()');
  if (head === -1) {
    throw new Error('検体が腐っている: src/content.js に settingsReply() が無い');
  }
  const tail = source.indexOf('\n  }', head);
  if (tail === -1) {
    throw new Error('検体が腐っている: settingsReply() の終わりを見つけられない');
  }
  const body = source.slice(head, tail);
  const line = body.match(/^[ \t]*boostAllowed:[^\n]*\n/m);
  if (!line) {
    throw new Error('検体が腐っている: settingsReply() の中に boostAllowed の行が無い');
  }
  return source.slice(0, head) + body.replace(line[0], '') + source.slice(tail);
};

'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・初回ヒント）。
 *
 * 入れるバグ: mount のたびに firstRunHint:true を渡す。
 * 初回は正しく出るので「ヒントが出るか」だけを見る検査は素通りする。
 * 壊れるのは **1回きり** のほうで、SPA 遷移・差し込み先の再探索・
 * プリセット編集による作り直しのたびに同じ吹き出しが出続ける。
 * 動画を変えるたびに出る案内は、機能ではなく妨害である。
 *
 * 落ちるべきは seam8-hint-once だけ
 * （seam8-hint-not-repeated は storage の既読を読む側の検査で、
 *   この検体では hintShown が false のまま `wantHint` が true に固定されるため
 *   同時に落ちる。両方この検体の狙いである）。
 */
const FROM = '    var wantHint = (!hintShown && !hintOffered);';
const TO = '    var wantHint = true;   // 検体: mount のたびに出す（1回きりを壊す）';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/content.js の wantHint の判定が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・初回ヒントの既読）。
 *
 * 入れるバグ: storage に残っている既読を読まず、毎回「未読」として起動する。
 * 同じセッションの中では hintOffered が効くので**1回しか出ない**。
 * つまり seam8-hint-once（SPA 遷移で二度出ないこと）は素通りする。
 * 壊れるのは「タブを開き直すたびに毎回1回出る」ほうで、
 * 初回ヒントが恒久的な広告に変わる。
 *
 * 落ちるべきは seam8-hint-not-repeated だけ。
 * patch_content_hint_always.js との2本セットで、
 * 「セッション内の1回きり」と「セッションを越えた1回きり」を別々に実測する。
 */
const FROM = '      hintShown = items[KEY_HINT] === true;';
const TO = '      hintShown = false;   // 検体: 保存された既読を無視する';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/content.js の既読の読み取りが ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

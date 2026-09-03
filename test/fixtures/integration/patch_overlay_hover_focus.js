'use strict';
/*
 * わざとバグを入れた検体（継ぎ目8・SPEC 10-a 追補）。
 *
 * 入れるバグ: ホバーで開いたときにも入力欄へフォーカスし、全選択する。
 * 見た目は何も変わらない（パネルは同じように開く）。壊れるのは
 * **マウスが通り過ぎただけで YouTube のショートカットが死ぬ**ことで、
 * k（停止）・f（全画面）・数字キー（シーク）が効かなくなる。
 * DOM を見るだけの検査には一切映らない種類の劣化である。
 *
 * 実測（2026-09-03）で落ちるのは2本:
 *   seam8-hover-no-focus   … 狙い（乗せただけでフォーカスを奪った）
 *   seam8-hover-open-close … フォーカスを奪うと「編集中は閉じない」規則に引っかかり、
 *                            離れてもパネルが閉じなくなる。ホバーでフォーカスを取ると
 *                            自動クローズまで道連れになるという事実そのものである。
 */
const FROM = '        cancelClose();\n        setOpen(true);\n      };';
const TO = '        cancelClose();\n        setOpen(true);\n'
         + '        focusInput(true);   // 検体: ホバーでもフォーカスを奪って全選択する\n      };';

module.exports = function patch(source) {
  const n = source.split(FROM).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の enterFn が ' + n + ' 箇所（1 のはず）');
  }
  return source.split(FROM).join(TO);
};

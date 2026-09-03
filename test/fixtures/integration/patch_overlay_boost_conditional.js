'use strict';
/*
 * わざとバグを戻した検体（継ぎ目5・overlay 側）。65b4ccf で直したバグそのもの。
 *
 * 戻すバグ: `if (boostAllowed) { boostBtn = ... }`。
 * boostAllowed:false のときブーストボタンを **生成すらしない**。
 * disabled にするより性質が悪く、DOM に存在しないので押しようがない。
 * 一度 OFF にするとオーバーレイから ON へ戻す道が完全に消える（一方通行）。
 * SPEC 5 は「ブーストボタンは常に生成する」と明文で禁じている。
 *
 * この検体で test/integration.test.js の seam5-overlay-* が赤くならないなら、
 * あの検査は何も検査していない（＝65b4ccf の修正は何にも守られていない）。
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

const CREATE_FROM = "    var boostBtn = el(doc, 'button', 'ytvp-boost');";
const CREATE_TO = "    var boostBtn = null;\n"
                + "    if (boostAllowed) {   // 検体: 自分の値でボタンの生成そのものを止める\n"
                + "    boostBtn = el(doc, 'button', 'ytvp-boost');";

const APPEND_FROM = "    panel.appendChild(boostBtn);";
const APPEND_TO = "    panel.appendChild(boostBtn);\n    }";

const RENDER_FROM = "      boostBtn.setAttribute('aria-pressed', state.boost ? 'true' : 'false');";
const RENDER_TO = "      if (boostBtn) {\n"
                + "      boostBtn.setAttribute('aria-pressed', state.boost ? 'true' : 'false');";

const RENDER_END_FROM = "      boostBtn.disabled = state.available === false;";
const RENDER_END_TO = "      boostBtn.disabled = state.available === false;\n      }";

module.exports = function patch(source) {
  let out = replaceOnce(source, CREATE_FROM, CREATE_TO, 'ブーストボタンの生成');
  out = replaceOnce(out, APPEND_FROM, APPEND_TO, 'ブーストボタンの appendChild');
  out = replaceOnce(out, RENDER_FROM, RENDER_TO, 'render の aria-pressed 更新');
  out = replaceOnce(out, RENDER_END_FROM, RENDER_END_TO, 'render の disabled 更新');
  return out;
};

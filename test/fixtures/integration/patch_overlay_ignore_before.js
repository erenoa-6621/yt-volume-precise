'use strict';
/*
 * わざとバグを戻した検体（継ぎ目9・overlay 側。SPEC 11-b）。
 *
 * 戻す状態: pickBefore が常に null を返す＝ options.nativeBefore を読まない。
 * overlay は「null/未指定なら従来どおり先頭へ」という後方互換の経路をそのまま通るので、
 *   * 例外は出ない
 *   * ボタンは1個だけ生成され、左コントロールの中に居る
 *   * 押せばパネルも開き、プリセットも音量に効く
 *   * 権限も通信も DOM の個数も変わらない
 * つまり **v0.2 の overlay とまったく同じ振る舞い**で、位置以外は何も壊れない。
 * 実機では「ボタンが再生ボタンの左端に出る」＝要望（音量の隣に寄せてほしい）が
 * 何も解決していない状態に戻る。
 *
 * 落ちるべきは「音量領域の**直前**に居ること」を添字で見ているアサーションだけ。
 * 実測（2026-09-03・直前挿入へ変えた後）で落ちるのは次の4本:
 *   seam9-left-before-volume / seam9-left-volume-last / seam9-left-mute-button
 *   / seam9-left-rebind-single
 * 素通りするのが正しいもの:
 *   seam9-left-volume-first … 音量領域が先頭の台では「直前」と「先頭挿入」が同じ並びになる
 *   seam9-left-align-class / seam9-left-panel-preset … 位置ではなく寄せと操作系を見ている
 *   右フォールバック（seam7 / seam9-right-fallback / seam9-left-no-volume-right）
 *   / seam9-no-controls-float / seam9-music-float … そもそも左へ差し込まない経路
 *
 * v0.3 まではここに「seam9-left-volume-last は素通りする」と書いてあった。直後（右隣）に
 * 入れていた頃はその台だけ before=null で、検体と本物の区別が付かなかったため。
 * 直前挿入では before が常に音量領域そのものなので、末尾の台も検体を捕まえる。
 *
 * 本物の src/overlay.js を書き換える方式（写しを置くと src の変更で腐るため）。
 * 当たらなくなったら例外を投げて赤くする。
 */
function replaceOnce(source, from, to, what) {
  const n = source.split(from).length - 1;
  if (n !== 1) {
    throw new Error('検体が腐っている: src/overlay.js の ' + what + ' が ' + n + ' 箇所（1 のはず）: ' + from);
  }
  return source.split(from).join(to);
}

const FROM = '      var b = opts ? opts.nativeBefore : null;';
const TO = '      var b = null;   // 検体: nativeBefore を読まない（常に先頭挿入へ落とす）';

module.exports = function patch(source) {
  return replaceOnce(source, FROM, TO, 'nativeBefore の読み取り');
};

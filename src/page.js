/*
 * YT Volume Precise — MAIN world ブリッジ
 *
 * ISOLATED world（content.js）とは document 上の CustomEvent だけでやり取りする。
 * 受信: "ytvp:cmd"  detail = { id, action, payload }
 * 送信: "ytvp:res"  detail = { id, ok, data, error }
 *
 * このファイルは MAIN world で動くので YTVP（content script 側のグローバル）は見えない。
 * よって最小限のクランプ処理をここにも持つ。DOM と Web Audio に触れるのはこのファイルだけ。
 */
;(function () {
  'use strict';

  if (window.__YTVP_PAGE__) { return; }
  window.__YTVP_PAGE__ = true;

  var MIN_VOL = 0;
  var MAX_VOL_PLAIN = 100;
  var MAX_VOL_BOOST = 300;

  var boostEnabled = false;          // 既定 OFF。ON のときだけ Web Audio を組む
  var graphs = new WeakMap();        // video 要素 -> { ctx, source, gain, comp }
  var audioCtx = null;               // AudioContext は1つを使い回す

  function clamp(value, max) {
    var n = Number(value);
    if (!isFinite(n)) { return 0; }
    n = Math.round(n);
    if (n < MIN_VOL) { return MIN_VOL; }
    if (n > max) { return max; }
    return n;
  }

  function getPlayer() {
    var el = document.getElementById('movie_player');
    if (!el) { return null; }
    if (typeof el.setVolume !== 'function' || typeof el.getVolume !== 'function') { return null; }
    return el;
  }

  function getVideo() {
    var el = document.getElementById('movie_player');
    var v = el ? el.querySelector('video') : null;
    return v || document.querySelector('video');
  }

  function getAudioContext() {
    if (audioCtx) { return audioCtx; }
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { return null; }
    audioCtx = new Ctor();
    return audioCtx;
  }

  /*
   * ブースト用のグラフを用意する。
   * createMediaElementSource は 1 要素につき 1 回しか呼べないので WeakMap で保持して使い回す。
   * ブーストが OFF のあいだは一切構築しない（一度挿すと元の経路に戻せないため）。
   */
  function ensureGraph(video) {
    if (!video) { return null; }
    var existing = graphs.get(video);
    if (existing) { return existing; }
    var ctx = getAudioContext();
    if (!ctx || typeof ctx.createMediaElementSource !== 'function') { return null; }
    var source = ctx.createMediaElementSource(video);
    var gain = ctx.createGain();
    var comp = ctx.createDynamicsCompressor();
    gain.gain.value = 1;
    try {
      comp.threshold.value = -6;
      comp.knee.value = 12;
      comp.ratio.value = 12;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
    } catch (e) { /* 読み取り専用の実装では既定値のまま使う */ }
    source.connect(gain);
    gain.connect(comp);
    comp.connect(ctx.destination);
    var graph = { ctx: ctx, source: source, gain: gain, comp: comp };
    graphs.set(video, graph);
    return graph;
  }

  function currentGraph() {
    var video = getVideo();
    return video ? (graphs.get(video) || null) : null;
  }

  function currentGain() {
    var g = currentGraph();
    return g ? g.gain.gain.value : 1;
  }

  function setGain(value) {
    var video = getVideo();
    if (!video) { return; }
    var graph = graphs.get(video);
    if (!graph) {
      if (!boostEnabled || value <= 1) { return; }   // OFF のときは組まない
      graph = ensureGraph(video);
      if (!graph) { return; }
    }
    graph.gain.gain.value = value;
    if (graph.ctx && graph.ctx.state === 'suspended' && typeof graph.ctx.resume === 'function') {
      try { graph.ctx.resume(); } catch (e) { /* 自動再生方針で拒否されることがある */ }
    }
  }

  function applyVolume(requested) {
    var player = getPlayer();
    if (!player) { return { available: false }; }
    var max = boostEnabled ? MAX_VOL_BOOST : MAX_VOL_PLAIN;
    var volume = clamp(requested, max);
    var playerPart = volume > MAX_VOL_PLAIN ? MAX_VOL_PLAIN : volume;
    player.setVolume(playerPart);
    if (volume > MAX_VOL_PLAIN && boostEnabled) {
      setGain(volume / 100);
    } else {
      setGain(1);   // 100 以下では gain は 1.0 に保つ（グラフ未構築なら何もしない）
    }
    return { available: true, volume: volume };
  }

  function readState() {
    var player = getPlayer();
    if (!player) {
      return { volume: 0, muted: false, boost: boostEnabled, available: false };
    }
    var base = Number(player.getVolume());
    if (!isFinite(base)) { base = 0; }
    var gain = currentGain();
    var volume = Math.round(base * (gain > 1 ? gain : 1));
    var muted = false;
    try {
      muted = typeof player.isMuted === 'function' ? !!player.isMuted() : false;
    } catch (e) { muted = false; }
    return {
      volume: clamp(volume, MAX_VOL_BOOST),
      muted: muted,
      boost: boostEnabled,
      available: true
    };
  }

  function setBoost(enabled) {
    boostEnabled = !!enabled;
    if (!boostEnabled) {
      // すでにグラフがある場合は外せないので gain を 1.0 に戻して素通しにする
      var graph = currentGraph();
      if (graph) { graph.gain.gain.value = 1; }
      var player = getPlayer();
      if (player) {
        var v = Number(player.getVolume());
        if (isFinite(v) && v > MAX_VOL_PLAIN) { player.setVolume(MAX_VOL_PLAIN); }
      }
    }
    return readState();
  }

  function respond(id, ok, data, error) {
    var detail = { id: id, ok: ok };
    if (data !== undefined) { detail.data = data; }
    if (error !== undefined) { detail.error = error; }
    document.dispatchEvent(new CustomEvent('ytvp:res', { detail: detail }));
  }

  function handle(detail) {
    var id = detail && detail.id;
    var action = detail && detail.action;
    var payload = (detail && detail.payload) || {};
    try {
      if (action === 'get') {
        respond(id, true, readState());
        return;
      }
      if (action === 'set') {
        var result = applyVolume(payload.volume);
        if (!result.available) {
          respond(id, true, { volume: 0, muted: false, boost: boostEnabled, available: false });
          return;
        }
        respond(id, true, readState());
        return;
      }
      if (action === 'boost') {
        respond(id, true, setBoost(payload.enabled));
        return;
      }
      respond(id, false, undefined, 'unknown-action:' + String(action));
    } catch (e) {
      respond(id, false, undefined, String((e && e.message) || e));
    }
  }

  document.addEventListener('ytvp:cmd', function (event) {
    handle(event && event.detail);
  });

  // ISOLATED 側が先に読み込まれていた場合に備え、準備完了を1度だけ知らせる
  document.dispatchEvent(new CustomEvent('ytvp:ready', { detail: { ok: true } }));
})();

(function () {
  'use strict';

  /*
   * ポップアップは「プレイヤー内パネルと同じ部品を、別の文書に載せるための薄い層」。
   *
   * これまでポップアップとパネルは別々のコードで同じものを2回作っていた。
   * それが「片方にしか無い機能」（スライダー・⚙ の設定）を生む原因だったので、
   * UI は overlay.js（window.YTVPOverlay.mount）に一本化する。
   *
   * ここに残るのは次の3つだけ。
   *   1. chrome.tabs でアクティブタブを見つけ、YouTube かを判定する
   *   2. bridge（getState / setVolume / setBoost / setSettings / subscribe）を
   *      {type:'get'|'set'|'setBoost'|'setSettings'|'getSettings'} のメッセージへ翻訳する
   *   3. 話す相手が居ないときの案内文を出す（UI が無いので overlay は載せない）
   *
   * overlay.js は chrome.* を一切呼ばない契約（verify.sh 項目7が機械検査している）。
   * その契約のおかげで、同じ mount をポップアップからも呼べる。
   */

  var FALLBACK_PRESETS = [15, 30, 50, 70, 100];
  var TIMEOUT_MS = 1500;

  var MSG_CONNECTING = '接続中…';
  var MSG_NO_YT = 'YouTube を開いてください';
  var MSG_NO_UI = 'パネルを読み込めませんでした';

  // host_permissions が youtube のみなので、tab.url は YouTube タブに限り返る。
  // 「url が取れない or youtube でない」＝ 話す相手が居ない、として扱う。
  //
  // 判定の範囲は host_permissions の範囲と完全一致させる（SPEC 3-c）。
  // 許すのは下の2ホストの完全一致だけ。サブドメイン無しの youtube.com も
  // m.youtube.com も通さない。判定が権限より広いのは、権限を売りにする拡張として矛盾する。
  var YT_HOSTS = ['www.youtube.com', 'music.youtube.com'];
  var YT_SCHEME = 'https:';

  function isYouTubeTabUrl(raw) {
    if (typeof raw !== 'string' || raw === '') { return false; }
    var u;
    // 文字列の前方一致で見ると www.youtube.com.attacker.test のような検体を通す。
    // 必ず URL としてパースし、ホスト名だけを取り出して突き合わせる。
    try { u = new URL(raw); } catch (e) { return false; }
    if (u.protocol !== YT_SCHEME) { return false; }
    var host = String(u.hostname || '').toLowerCase();
    for (var i = 0; i < YT_HOSTS.length; i++) {
      if (host === YT_HOSTS[i]) { return true; }
    }
    return false;
  }

  // ── content script との会話（SPEC 3-b） ──
  // 拡張ページから runtime 経由で投げたメッセージは content script に配送されない
  // （旧 SPEC の穴。2026-09-02 に 3-b で是正）。
  // よって必ず chrome.tabs.query でアクティブタブを取り、chrome.tabs.sendMessage で
  // そのタブへ直接投げる。tabs 権限は不要（query は id を、youtube の host_permissions が
  // url と sendMessage の到達を与える）。
  var tabId = null;

  function hasTabsApi() {
    try {
      return typeof chrome !== 'undefined' && !!chrome && !!chrome.tabs &&
        typeof chrome.tabs.query === 'function' &&
        typeof chrome.tabs.sendMessage === 'function';
    } catch (e) { return false; }
  }

  function lastError() {
    // 読むこと自体が「エラーを検査した」印になる。読まないと未処理警告が出る。
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.runtime) {
        return chrome.runtime.lastError || null;
      }
    } catch (e) {}
    return null;
  }

  // コールバック形と Promise 形のどちらで実装されていても一度だけ決着させる
  function adopt(ret, ok, ng) {
    try {
      if (ret && typeof ret.then === 'function') { ret.then(ok, ng); }
    } catch (e) {}
  }

  function once(cb) {
    var done = false;
    var timer = null;
    function finish(v) {
      if (done) { return; }
      done = true;
      if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
      try { cb(v); } catch (e) {}
    }
    // content script 未注入のタブで固まらないための保険
    try { timer = setTimeout(function () { finish(null); }, TIMEOUT_MS); } catch (e) {}
    return finish;
  }

  function queryActiveTab(cb) {
    var finish = once(cb);
    if (!hasTabsApi()) { finish(null); return; }
    try {
      var ret = chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (lastError()) { finish(null); return; }
        finish(tabs && tabs.length ? tabs[0] : null);
      });
      adopt(ret, function (tabs) {
        finish(tabs && tabs.length ? tabs[0] : null);
      }, function () { finish(null); });
    } catch (e) {
      finish(null);
    }
  }

  function send(msg, cb) {
    var finish = once(cb);
    if (tabId === null || !hasTabsApi()) { finish(null); return; }
    try {
      var ret = chrome.tabs.sendMessage(tabId, msg, function (res) {
        if (lastError()) { finish(null); return; }
        finish(res === undefined ? null : res);
      });
      adopt(ret, function (res) {
        finish(res === undefined ? null : res);
      }, function () { finish(null); });
    } catch (e) {
      finish(null);
    }
  }

  // 応答の形（SPEC 3-b）: {ok:true, state:{...}} / {ok:true, settings:{...}}
  function unwrapState(res) {
    if (!res || typeof res !== 'object') { return null; }
    if (res.ok === false) { return null; }
    if (res.state && typeof res.state === 'object') { return res.state; }
    if ('volume' in res || 'muted' in res || 'available' in res) { return res; }
    return null;
  }

  function unwrapSettings(res) {
    if (!res || typeof res !== 'object') { return null; }
    if (res.ok === false) { return null; }
    if (res.settings && typeof res.settings === 'object') { return res.settings; }
    if ('presets' in res || 'boostAllowed' in res) { return res; }
    return null;
  }

  // ── 案内文（ポップアップに残る唯一の自前 UI） ──
  var msgEl = null;

  function showMsg(text) {
    if (!msgEl) { return; }
    msgEl.textContent = text;
    msgEl.hidden = false;
  }

  function hideMsg() {
    if (!msgEl) { return; }
    msgEl.hidden = true;
  }

  // ── overlay に渡す状態 ──
  // boostAllowed の既定は false（SPEC 3-c）。設定が届くまでの間はブースト OFF として扱う。
  var settings = { presets: FALLBACK_PRESETS.slice(), boostAllowed: false };
  var handle = null;        // overlay の {destroy, update}
  var subscribers = [];
  var offline = false;

  function readSettings(s) {
    if (!s || typeof s !== 'object') { return false; }
    var before = settings.presets.join(',');
    // 既定は false。未定義・非真は OFF 扱い（SPEC 3-c）。
    settings.boostAllowed = s.boostAllowed === true;
    if (s.presets && s.presets.length) { settings.presets = s.presets.slice(); }
    return settings.presets.join(',') !== before;
  }

  function notify(state) {
    if (!state) { return; }
    for (var i = 0; i < subscribers.length; i++) {
      try { subscribers[i](state); } catch (e) {}
    }
  }

  /*
   * 話す相手が居なくなったら、パネルごと畳んで案内文だけにする。
   * 既存の「オフライン時は操作不能」を維持するため、disabled ではなく destroy を選ぶ。
   * disabled で塞げるのは overlay が塞ぐ部品（数値・スライダー・ブースト）だけで、
   * プリセット pill は塞げない＝押せてしまう。押せるのに何も起きないボタンは残さない。
   */
  function goOffline() {
    if (offline) { return; }
    offline = true;
    tabId = null;              // 以後 send() は何も投げない
    subscribers = [];
    if (handle && typeof handle.destroy === 'function') {
      try { handle.destroy(); } catch (e) {}
    }
    handle = null;
    try { document.body.classList.add('is-offline'); } catch (e) {}
    showMsg(MSG_NO_YT);
  }

  // 状態の応答を1箇所で捌く。取れなければオフラインへ倒す（楽観更新をしない）。
  function settleState(res) {
    var data = unwrapState(res);
    if (!data) { goOffline(); return null; }
    notify(data);
    return data;
  }

  /*
   * bridge。overlay.js が期待する形に、chrome.tabs のメッセージを翻訳するだけの層。
   * ここに UI の判断（クランプ・正規化・描画）を持たない。持つとまた二重実装になる。
   */
  var bridge = {
    getState: function () {
      return new Promise(function (resolve) {
        send({ type: 'get' }, function (res) {
          resolve(settleState(res));
        });
      });
    },
    setVolume: function (v) {
      // 不正値は {ok:false, error:'invalid-volume'} が返る。その場合は現在値を取り直して
      // 真の状態へ戻す（SPEC 3-c(3)）。楽観更新の後始末は overlay の update がやる。
      return new Promise(function (resolve) {
        send({ type: 'set', volume: v }, function (res) {
          var data = unwrapState(res);
          if (data) { notify(data); resolve(data); return; }
          send({ type: 'get' }, function (r2) { resolve(settleState(r2)); });
        });
      });
    },
    setBoost: function (b) {
      return new Promise(function (resolve) {
        send({ type: 'setBoost', enabled: b === true }, function (res) {
          var data = settleState(res);
          // ブーストは settings.boostAllowed と同一概念（SPEC 3-d）。写しを揃える。
          if (data && 'boost' in data) { settings.boostAllowed = data.boost === true; }
          resolve(data);
        });
      });
    },
    setSettings: function (patch) {
      return new Promise(function (resolve) {
        if (!patch || typeof patch !== 'object' || Object.prototype.toString.call(patch) === '[object Array]') {
          resolve(null);
          return;
        }
        send({ type: 'setSettings', settings: patch }, function (res) {
          var got = unwrapSettings(res);
          if (!got) { goOffline(); resolve(null); return; }
          // pill は mount 時の options で決まるので、変わったら作り直す以外に反映手段が無い
          // （content.js の remountOverlay と同じ理由・同じ結論）。
          if (readSettings(got)) { remount(); }
          resolve(got);
        });
      });
    },
    subscribe: function (cb) {
      if (typeof cb === 'function') { subscribers.push(cb); }
    }
  };

  function overlayApi() {
    try {
      var ov = window.YTVPOverlay;
      if (ov && typeof ov.mount === 'function') { return ov; }
    } catch (e) {}
    return null;
  }

  /*
   * mount。options に nativeAnchor は渡さない（＝浮きモード。ポップアップに
   * YouTube のコントロールバーは無い）。firstRunHint も渡さない（既読フラグを
   * 保存する口をポップアップは持たない。出しっぱなしになる）。
   */
  function mountPanel() {
    var ov = overlayApi();
    if (!ov) { showMsg(MSG_NO_UI); return false; }
    subscribers = [];
    try {
      handle = ov.mount(bridge, {
        presets: settings.presets.slice(),
        boostAllowed: settings.boostAllowed
      });
    } catch (e) {
      handle = null;
    }
    if (!handle) { showMsg(MSG_NO_UI); return false; }
    return true;
  }

  function remount() {
    if (offline || !handle) { return; }
    try { handle.destroy(); } catch (e) {}
    handle = null;
    mountPanel();
  }

  function connect() {
    queryActiveTab(function (tab) {
      var url = (tab && typeof tab.url === 'string') ? tab.url : '';
      if (!tab || typeof tab.id !== 'number' || !isYouTubeTabUrl(url)) {
        goOffline();
        return;
      }
      tabId = tab.id;
      // 疎通できるかを先に確かめる。応答が無いタブには mount しない
      // （空のパネルを出すと、効かない操作を並べることになる）。
      send({ type: 'get' }, function (res) {
        var state = unwrapState(res);
        if (!state) { goOffline(); return; }
        // presets / boostAllowed は mount 時の options なので、mount より前に取る。
        send({ type: 'getSettings' }, function (r2) {
          readSettings(unwrapSettings(r2));
          try { document.body.classList.remove('is-offline'); } catch (e) {}
          hideMsg();
          if (!mountPanel()) { return; }
          // mount 直後の refresh（getState）を待たずに、既に知っている状態を流す。
          notify(state);
        });
      });
    });
  }

  function init() {
    msgEl = document.getElementById('ytvp-msg');
    try { document.body.classList.add('is-offline'); } catch (e) {}
    showMsg(MSG_CONNECTING);
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

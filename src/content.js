/*
 * YT Volume Precise — ISOLATED world 本体
 *
 * 役割:
 *  - MAIN world 用の page.js を <script> で注入する
 *  - page.js とは document 上の CustomEvent（ytvp:cmd / ytvp:res）でやり取りする
 *  - chrome.storage.local の読み書き（プリセット / ブースト可否）
 *    ブースト可否（boostAllowed）は未保存なら false（SPEC 3-c(1)・第4章「ブースト既定 OFF」）
 *  - popup からの chrome.runtime メッセージに応答する
 *  - オーバーレイ（overlay.js）が存在すれば mount する。無ければ黙って諦める
 *  - ネイティブ統合の差し込み先（.ytp-right-controls）を探して mount の options で渡す（SPEC 9-c）
 *  - yt-navigate-finish で再バインドする
 *
 * このファイルはホイール操作を購読しない（SPEC 第7章。所有者は src/overlay.js ただ一人）。
 * 刻みの計算は overlay 側が window.YTVP.stepFromWheel を使い、結果を bridge.setVolume へ流す。
 */
;(function () {
  'use strict';

  var GLOBAL = (typeof globalThis !== 'undefined') ? globalThis : window;
  var V = GLOBAL.YTVP;
  if (!V) {
    console.warn('[YTVP] volume.js が読み込まれていません。中止します。');
    return;
  }

  var KEY_PRESETS = 'presets';
  var KEY_BOOST = 'boostAllowed';
  // 初回ヒントの既読フラグ。overlay は chrome API を持たない（SPEC 第5章）ので、
  // 「出してよいか」を決めるのも「出したことを覚える」のも content 側の責務。
  var KEY_HINT = 'hintShown';
  var CMD_TIMEOUT_MS = 2000;

  var settings = {
    presets: V.DEFAULT_PRESETS.slice(),
    boostAllowed: false      // 既定 OFF
  };

  var lastState = { volume: 0, muted: false, boost: false, available: false };
  var subscribers = [];
  var overlayHandle = null;
  var overlayAnchor = null;      // 今の mount に渡した nativeAnchor（null なら浮きハンドル）
  var anchorRetryTimer = null;   // 差し込み先の再探索タイマ（1バインドにつき最大1本）
  var anchorRetryPending = true; // 再探索をまだ1度も使っていないか

  // 初回ヒントは「1回きり」。2つの状態で守る。
  //   hintShown   … storage に残った既読（次のセッション以降も効く）
  //   hintOffered … このセッションで既に firstRunHint:true を渡したか
  // 保存は非同期なので hintShown だけだと、書き込みが返る前の作り直し
  // （SPA 遷移・差し込み先の再探索・プリセット編集）で2度目が出る。
  var hintShown = false;
  var hintOffered = false;

  /* ---------- MAIN world との橋 ---------- */

  var pending = Object.create(null);
  var seq = 0;

  document.addEventListener('ytvp:res', function (event) {
    var detail = event && event.detail;
    if (!detail || !detail.id) { return; }
    var entry = pending[detail.id];
    if (!entry) { return; }
    delete pending[detail.id];
    clearTimeout(entry.timer);
    if (detail.ok) { entry.resolve(detail.data); }
    else { entry.reject(new Error(detail.error || 'ytvp-error')); }
  });

  function sendCmd(action, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'ytvp-' + (++seq) + '-' + Date.now();
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('timeout:' + action));
      }, CMD_TIMEOUT_MS);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      document.dispatchEvent(new CustomEvent('ytvp:cmd', {
        detail: { id: id, action: action, payload: payload || {} }
      }));
    });
  }

  /*
   * SPEC 3-d: settings.boostAllowed が「ブーストが有効か」の唯一の真実。
   * MAIN world が返す boost は参考値にすぎない（注入が遅れると false のまま返る）ので、
   * ISOLATED 側で必ず上書きし、state.boost と settings.boostAllowed が食い違う状態を作らない。
   */
  function normalizeState(raw) {
    var src = raw || {};
    return {
      volume: V.clampVolume(src.volume, { boost: settings.boostAllowed, fallback: 0 }),
      muted: src.muted === true,
      boost: settings.boostAllowed === true,
      available: src.available === true
    };
  }

  var UNAVAILABLE = function () {
    return {
      volume: lastState.volume,
      muted: lastState.muted,
      boost: settings.boostAllowed === true,
      available: false
    };
  };

  function getState() {
    return sendCmd('get').then(function (state) {
      lastState = state ? normalizeState(state) : UNAVAILABLE();
      return lastState;
    }, function () {
      lastState = UNAVAILABLE();
      return lastState;
    });
  }

  function notify(state) {
    lastState = state;
    for (var i = 0; i < subscribers.length; i++) {
      try { subscribers[i](state); } catch (e) { console.warn('[YTVP] subscriber error', e); }
    }
    if (overlayHandle && typeof overlayHandle.update === 'function') {
      try { overlayHandle.update(state); } catch (e) { console.warn('[YTVP] overlay update error', e); }
    }
  }

  function setVolume(value) {
    var volume = V.clampVolume(value, { boost: settings.boostAllowed, fallback: lastState.volume });
    return sendCmd('set', { volume: volume }).then(function (state) {
      var next = state ? normalizeState(state) : UNAVAILABLE();
      notify(next);
      return next;
    }, function () {
      var next = UNAVAILABLE();
      notify(next);
      return next;
    });
  }

  /*
   * SPEC 3-d: この1つの関数が boostAllowed を ON にも OFF にもする（往復できる）。
   * 保存 → MAIN world へ反映 の順で、storage・settings・MAIN の3者を必ず同じ値に揃える。
   * OFF のとき MAIN 側は gain を 1.0 に戻す（SPEC 第4章。グラフ自体は外せないので素通しにする）。
   */
  function setBoost(enabled) {
    settings.boostAllowed = (enabled === true);
    return storageSet(KEY_BOOST, settings.boostAllowed).then(function () {
      return sendCmd('boost', { enabled: settings.boostAllowed });
    }).then(function (state) {
      var next = state ? normalizeState(state) : UNAVAILABLE();
      notify(next);
      return next;
    }, function () {
      var next = UNAVAILABLE();
      notify(next);
      return next;
    });
  }

  /* ---------- storage ---------- */

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(keys, function (items) {
          if (chrome.runtime.lastError) { resolve({}); return; }
          resolve(items || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  function storageSet(key, value) {
    return new Promise(function (resolve) {
      var obj = {};
      obj[key] = value;
      try {
        chrome.storage.local.set(obj, function () {
          if (chrome.runtime.lastError) { /* 保存できなくても操作自体は続ける */ }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  function loadSettings() {
    return storageGet([KEY_PRESETS, KEY_BOOST, KEY_HINT]).then(function (items) {
      settings.presets = V.normalizePresets(items[KEY_PRESETS], { boost: items[KEY_BOOST] === true });
      settings.boostAllowed = items[KEY_BOOST] === true;
      // 読めなかった（storage が壊れている・未保存）ときは false ＝ 未読に倒す。
      // 出し過ぎより出ないほうが害が大きい（気付かれない機能は無いのと同じ）。
      hintShown = items[KEY_HINT] === true;
      return settings;
    });
  }

  /*
   * overlay がヒントを「実際に DOM へ入れた」ときだけ呼ばれる（overlay.js の差し込み成功後）。
   * ここで既読を立てるので、mount しようとして失敗した回は消費されない。
   * 保存に失敗しても例外は外へ出さない（ヒント如きで本体の起動を落とさない）。
   */
  function markHintShown() {
    hintShown = true;
    hintOffered = true;
    return storageSet(KEY_HINT, true);
  }

  /*
   * SPEC 12-a: presets が「正規化後に実際に変わったか」だけを見る。
   * 打った生の値ではなく正規化後の配列同士を比べる（順序違い・重複・範囲外を打ち直しただけの
   * ときに作り直さないため）。normalizePresets は昇順・重複除去済みなので添字比較で足りる。
   */
  function presetsChanged(before, after) {
    var changed = (before.length !== after.length);
    for (var i = 0; !changed && i < after.length; i++) {
      changed = (before[i] !== after[i]);
    }
    return changed;
  }

  /*
   * SPEC 12-a: パネルの pill は mount 時の options で決まるので、作り直す以外に反映手段が無い。
   * プリセットの編集は稀な操作なので作り直しのコストは許容する（頻繁な操作＝音量・ブーストでは
   * 絶対に呼ばない。呼ぶとそのたびにパネルが閉じる）。
   * destroy を必ず先に通すので二重 mount にはならない。例外は外へ出さない。
   */
  function remountOverlay() {
    if (!overlayHandle) { return; }   // まだ載っていないなら作り直す対象が無い
    try {
      unmountOverlay();
      mountOverlay();
    } catch (e) {
      console.warn('[YTVP] オーバーレイの作り直しに失敗しました', e);
    }
  }

  function applySettings(patch) {
    patch = patch || {};
    var chain = Promise.resolve();
    var needsRemount = false;   // presets が正規化後に変わったときだけ true
    if (patch.presets !== undefined) {
      var nextPresets = V.normalizePresets(patch.presets, { boost: settings.boostAllowed });
      needsRemount = presetsChanged(settings.presets, nextPresets);
      settings.presets = nextPresets;
      chain = chain.then(function () { return storageSet(KEY_PRESETS, settings.presets); });
    }
    // SPEC 3-d: setSettings でも setBoost と同一の経路を通す。
    // 値が同じでも黙って捨てない（MAIN world がずれている場合にここで揃え直せる）。
    // ここでは作り直さない（ブーストの切り替えは頻繁な操作。既存挙動を変えない）。
    if (patch.boostAllowed !== undefined) {
      chain = chain.then(function () { return setBoost(patch.boostAllowed === true); });
    }
    if (needsRemount) {
      chain = chain.then(function () { remountOverlay(); });
    }
    return chain.then(function () { return settings; });
  }

  /* ---------- ネイティブ統合の差し込み先（SPEC 9-c。探すのは content.js だけ） ---------- */

  // SPEC 9-b: ネイティブ統合の対象は www.youtube.com だけ。music.youtube.com は DOM が別物なので除外する。
  // 判定は src/popup.js の isYouTubeTabUrl と同じ考え方（ホスト名の完全一致。前方一致で見ない）。
  // 新しい URL 判定は発明しない。location が読めない環境では「対象と確認できない」＝ 対象外に倒す
  // （判定が権限や確証の範囲より広くならないようにする。SPEC 3-c(2) の原則）。
  var NATIVE_HOSTS = ['www.youtube.com'];
  var PLAYER_ID = 'movie_player';
  var RIGHT_CONTROLS_SELECTOR = '.ytp-right-controls';
  // 差し込み先が見つからなかったときの再試行は1回だけ（SPEC 9-b: 見つからなければ黙って浮きハンドルへ戻る）。
  // 常時監視は張らない。MutationObserver も使わない（外し忘れがリークになる）。
  var ANCHOR_RETRY_MS = 1000;

  function isNativeHost() {
    var host = '';
    try {
      var loc = GLOBAL.location;
      if (loc && typeof loc.hostname === 'string') { host = loc.hostname.toLowerCase(); }
    } catch (e) { host = ''; }
    return NATIVE_HOSTS.indexOf(host) >= 0;
  }

  /*
   * 差し込み先を1回だけ探す。見つからなければ null（＝従来どおりの浮きハンドル）。
   * 必ずプレイヤー（#movie_player）配下から探す。document 全体の querySelector で拾うと、
   * ホーム画面のインラインプレビューなど別プレイヤーの右コントロールに当たりうる。
   */
  function findNativeAnchor() {
    if (!isNativeHost()) { return null; }
    try {
      var player = document.getElementById(PLAYER_ID);
      if (!player || typeof player.querySelector !== 'function') { return null; }
      var el = player.querySelector(RIGHT_CONTROLS_SELECTOR);
      // 要素でない・子を足せないものは渡さない（overlay 側で不正値を掴ませない）
      if (!el || typeof el.appendChild !== 'function') { return null; }
      return el;
    } catch (e) {
      return null;
    }
  }

  /* ---------- オーバーレイ（overlay.js。無くても落ちない） ---------- */

  /*
   * SPEC 12-a: パネル内の ⚙ は bridge.setSettings が**関数として在る**ときだけ overlay が生成する。
   * popup と同じ経路（applySettings）を通すので、正規化・保存・作り直しの意味論が
   * 「パネルから編集したとき」と「ポップアップから編集したとき」で一致する。
   * ここで別経路を書くと、片方でしか効かない正規化が生まれる。
   * 例外も拒否も外へ出さない（overlay は UI であって、保存の失敗を扱う場所ではない）。
   */
  var bridge = {
    getState: getState,
    setVolume: function (v) { return setVolume(v).then(function () { }); },
    setBoost: function (b) { return setBoost(b).then(function () { }); },
    setSettings: function (patch) {
      return applySettings(patch || {}).then(function () { }, function () { });
    },
    markHintShown: function () { return markHintShown(); },
    subscribe: function (cb) { if (typeof cb === 'function') { subscribers.push(cb); } }
  };

  function mountOverlay() {
    if (overlayHandle) { return; }
    var overlay = GLOBAL.YTVPOverlay;
    if (!overlay || typeof overlay.mount !== 'function') {
      console.info('[YTVP] オーバーレイ未実装のためスキップします（本体機能は動きます）。');
      return;
    }
    // 見つからなければ null を渡す。overlay の mount は nativeAnchor 無し／null でも
    // 従来どおり浮きハンドルで動く（SPEC 9-c の後方互換）。
    var anchor = findNativeAnchor();
    // 初回だけ true。作り直し（プリセット編集・差し込み先の再探索）と SPA 遷移では
    // hintOffered が立っているので false になる ＝ 1回きりが mount の数に依らず守られる。
    var wantHint = (!hintShown && !hintOffered);
    try {
      overlayHandle = overlay.mount(bridge, {
        presets: settings.presets.slice(),
        boostAllowed: settings.boostAllowed,
        nativeAnchor: anchor,
        firstRunHint: wantHint
      });
      overlayAnchor = overlayHandle ? anchor : null;
      // mount できた回だけ「渡した」を消費する。失敗した回で消費すると、
      // 一度も見せないまま初回ヒントが終わる。
      if (wantHint && overlayHandle) { hintOffered = true; }
    } catch (e) {
      overlayHandle = null;
      overlayAnchor = null;
      console.warn('[YTVP] オーバーレイの mount に失敗しました', e);
    }
    if (overlayHandle && !overlayAnchor) { scheduleAnchorRetry(); }
  }

  /*
   * mount の時点でプレイヤーの DOM がまだ無いことがある（document_idle でも間に合わない場合）。
   * その取りこぼしだけを拾うために、1バインドにつき1回だけ再探索する。
   * 見つからなければそれで終わり。ポーリングも常時監視もしない（SPEC 9-b）。
   */
  function scheduleAnchorRetry() {
    if (!anchorRetryPending) { return; }
    anchorRetryPending = false;
    cancelAnchorRetry();
    anchorRetryTimer = setTimeout(function () {
      anchorRetryTimer = null;
      if (!overlayHandle || overlayAnchor) { return; }
      var anchor = findNativeAnchor();
      if (!anchor) { return; }   // 諦める。浮きハンドルのまま
      unmountOverlay();          // anchorRetryPending は false のまま＝再試行は増えない
      mountOverlay();
    }, ANCHOR_RETRY_MS);
  }

  function cancelAnchorRetry() {
    if (anchorRetryTimer !== null) {
      clearTimeout(anchorRetryTimer);
      anchorRetryTimer = null;
    }
  }

  function unmountOverlay() {
    if (overlayHandle && typeof overlayHandle.destroy === 'function') {
      try { overlayHandle.destroy(); } catch (e) { /* 破棄失敗は無視 */ }
    }
    overlayHandle = null;
    overlayAnchor = null;
  }

  /* ---------- popup とのメッセージ ---------- */

  // SPEC 3-b: state は必ず {volume, muted, boost, available} の4キーを持つ。
  // boost は SPEC 3-d に従い settings.boostAllowed をそのまま反映する（normalizeState が担保）。
  // 平置きの重複キーは旧実装との互換のために残す（追加キーは契約上許される）。
  function stateReply(state) {
    var norm = normalizeState(state);
    return {
      ok: true,
      state: norm,
      volume: norm.volume,
      muted: norm.muted,
      boost: norm.boost,
      available: norm.available
    };
  }

  function settingsReply() {
    return {
      ok: true,
      settings: {
        presets: settings.presets.slice(),
        boostAllowed: settings.boostAllowed
      }
    };
  }

  // 受け取りは寛容に、応答は SPEC 3-b の表に厳密に合わせる。
  // 非同期に応答する枝があるため、リスナは全ての枝で必ず true を返す。
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    var type = message && (message.type || message.action);
    var payload = (message && message.payload) || message || {};
    if (type === 'get') {
      getState().then(function (s) { sendResponse(stateReply(s)); },
                      function () { sendResponse(stateReply(UNAVAILABLE())); });
      return true;
    }
    if (type === 'set') {
      var raw = (payload.volume !== undefined) ? payload.volume : payload.value;
      var parsed = (typeof raw === 'string') ? V.parseVolumeInput(raw) : raw;
      if (typeof parsed !== 'number' || !isFinite(parsed)) {
        sendResponse({ ok: false, error: 'invalid-volume' });
        return true;
      }
      setVolume(parsed).then(function (s) { sendResponse(stateReply(s)); },
                             function () { sendResponse(stateReply(UNAVAILABLE())); });
      return true;
    }
    if (type === 'setBoost') {
      var enabled = (payload.enabled !== undefined) ? payload.enabled : payload.boost;
      setBoost(enabled === true).then(function (s) { sendResponse(stateReply(s)); },
                                      function () { sendResponse(stateReply(UNAVAILABLE())); });
      return true;
    }
    if (type === 'getSettings') {
      sendResponse(settingsReply());
      return true;
    }
    if (type === 'setSettings') {
      // SPEC 3-c(4): settings 自体が不正なとき（未指定 / null / 配列 / 文字列など）だけ弾く。
      // 部分的に不正な値（presets が配列でない等）はエラーにせず applySettings 側で正規化して受け入れる。
      var patch = payload.settings;
      var patchIsObject = (patch !== null && typeof patch === 'object' && !Array.isArray(patch));
      if (!patchIsObject) {
        sendResponse({ ok: false, error: 'invalid-settings' });
        return true;
      }
      applySettings(patch).then(function () { sendResponse(settingsReply()); },
                                function () { sendResponse(settingsReply()); });
      return true;
    }
    sendResponse({ ok: false, error: 'unknown-type' });
    return true;
  });

  /* ---------- 起動と SPA 遷移 ---------- */

  function injectPageScript() {
    if (document.getElementById('ytvp-page-script')) { return; }
    var script = document.createElement('script');
    script.id = 'ytvp-page-script';
    script.src = chrome.runtime.getURL('src/page.js');
    script.async = false;
    script.addEventListener('load', function () {
      // 注入痕を残さない。読み込み済みのコードはそのまま動く
      if (script.parentNode) { script.parentNode.removeChild(script); }
    });
    (document.head || document.documentElement).appendChild(script);
  }

  // MAIN world へ「今の唯一の真実」を押し込む。注入前に呼ばれたら timeout するが、
  // その場合は page.js の ytvp:ready を受けて改めて押し込むので最終的に必ず揃う。
  function syncBoostToPage() {
    return sendCmd('boost', { enabled: settings.boostAllowed }).catch(function () { return null; });
  }

  // page.js は読み込み完了時に ytvp:ready を1度だけ流す。
  // content の起動が先行して boost の反映が届いていない場合、ここで取り戻す。
  document.addEventListener('ytvp:ready', function () {
    syncBoostToPage()
      .then(getState)
      .then(notify)
      .catch(function (e) { console.warn('[YTVP] ready 同期に失敗', e); });
  });

  function bind() {
    // 再探索の権利はバインドごとに1回だけ戻す（SPA 遷移でプレイヤーが作り直されるため）
    cancelAnchorRetry();
    anchorRetryPending = true;
    return syncBoostToPage()
      .then(function () { return getState().then(notify); })
      .then(function () { mountOverlay(); })
      .catch(function (e) { console.warn('[YTVP] bind 失敗', e); });
  }

  function start() {
    injectPageScript();
    window.addEventListener('yt-navigate-finish', function () {
      // 遷移で差し込み先は消える。残ったタイマを必ず止めてから、探し直して mount し直す。
      cancelAnchorRetry();
      unmountOverlay();
      bind();
    });
    loadSettings().then(bind);
  }

  start();
})();

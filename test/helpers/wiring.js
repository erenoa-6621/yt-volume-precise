'use strict';
/*
 * popup ⇄ content を「実物同士」で配線する試験台。
 *
 * なぜ要るか:
 *   src/content.js と src/popup.js は、契約だけを頼りに互いのコードを読まずに書かれている。
 *   両者の継ぎ目（setSettings の payload 形状 / 応答の全キー / manifest のホスト集合）は
 *   どちらの単体テストにも入らず、噛み合わなくなっても黙って壊れる。
 *   ここでは vm で2つのコンテキスト（拡張ページ側 / ページ側）を分け、
 *   偽 chrome.tabs.sendMessage を content の chrome.runtime.onMessage リスナへ
 *   そのまま転送することで、実物同士を往復させる。
 *
 * 差し替えの口（回帰専用。verify.sh は ytvp_unset_env_hooks で必ず殺す）:
 *   YTVP_CONTENT_PATCH / YTVP_POPUP_PATCH / YTVP_OVERLAY_PATCH
 *     … src の本物のソースを受け取り、1点だけ壊して返す CommonJS モジュールへのパス。
 *       検体にソースの写しを置くと src の変更で腐るので、必ず本物を patch する方式にする。
 *       patch が何も書き換えなかったら（＝src が変わって当たらなくなったら）例外で赤くする。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument, FakeEvent } = require('./dom.js');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// フック名はリテラルで書くこと（tools/scan_hooks.sh は文字列として発見する）。
const CONTENT_PATCH = process.env.YTVP_CONTENT_PATCH || '';
const POPUP_PATCH = process.env.YTVP_POPUP_PATCH || '';
const OVERLAY_PATCH = process.env.YTVP_OVERLAY_PATCH || '';

const TAB_ID = 4242;
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function readSource(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function applyPatch(source, patchPath, label) {
  if (!patchPath) { return source; }
  const mod = require(path.resolve(patchPath));
  const fn = (typeof mod === 'function') ? mod : (mod && mod.patch);
  if (typeof fn !== 'function') {
    throw new Error(label + ': 検体が関数を export していない: ' + patchPath);
  }
  const out = fn(source);
  if (typeof out !== 'string') {
    throw new Error(label + ': 検体が文字列を返していない: ' + patchPath);
  }
  if (out === source) {
    throw new Error(label + ': 検体が本物を1文字も書き換えていない（腐った検体）: ' + patchPath);
  }
  return out;
}

/*
 * scale は「検査対象の時計を早回しする」倍率（既定 1 = 実時間）。
 * src/content.js の CMD_TIMEOUT_MS は 2000ms 固定で、テストから変えられない（src 側の定数）。
 * MAIN world が居ない経路を検査すると、その 2 秒を実時間で待つことになり、
 * 回帰は integration.test.js を 70 回近く起動するので数分に膨らむ。
 * 縮めるのは待ち時間だけで、判定に使う値や順序は一切変えない。
 * scale を使う検査（seam6）の要となる観測は timeout の前に済ませてあるので、
 * この倍率をどう変えても赤緑は反転しない。
 */
function makeTimers(scale) {
  const k = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const live = new Set();
  return {
    setTimeout(fn, ms) {
      const wait = Math.max(0, Math.round(Number(ms) * k) || 0);
      const h = setTimeout(() => { live.delete(h); fn(); }, wait);
      live.add(h);
      return h;
    },
    clearTimeout(h) { live.delete(h); clearTimeout(h); },
    clearAll() { for (const h of live) { clearTimeout(h); } live.clear(); }
  };
}

function quietConsole(sink) {
  const push = (level) => function () {
    sink.push(level + ': ' + Array.prototype.map.call(arguments, String).join(' '));
  };
  return { log: push('log'), info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

function jsonClone(v) {
  if (v === undefined) { return undefined; }
  return JSON.parse(JSON.stringify(v));
}

function clampInt(value, max) {
  const n = Number(value);
  if (!isFinite(n)) { return 0; }
  const r = Math.round(n);
  if (r < 0) { return 0; }
  return r > max ? max : r;
}

/*
 * MAIN world（src/page.js）の代役。SPEC 第3章の ytvp:cmd / ytvp:res 契約だけを満たす。
 * 実物の page.js は movie_player と Web Audio に触るので Node では動かせない。
 * ここで検査したいのは popup ⇄ content の継ぎ目なので、その先は契約どおりの stub で足りる。
 */
function attachFakePlayer(doc, initial) {
  const st = Object.assign({ volume: 40, muted: false, boost: false, available: true }, initial || {});
  const log = [];
  const snap = () => ({ volume: st.volume, muted: st.muted, boost: st.boost, available: st.available });
  doc.addEventListener('ytvp:cmd', (ev) => {
    const d = ev && ev.detail;
    if (!d || !d.id) { return; }
    log.push({ action: d.action, payload: jsonClone(d.payload) });
    let ok = true, data = null, error;
    if (d.action === 'get') {
      data = snap();
    } else if (d.action === 'set') {
      st.volume = clampInt(d.payload && d.payload.volume, st.boost ? 300 : 100);
      data = snap();
    } else if (d.action === 'boost') {
      st.boost = (d.payload && d.payload.enabled) === true;
      data = snap();
    } else {
      ok = false;
      error = 'unknown-action';
    }
    doc.dispatchEvent(new FakeEvent('ytvp:res', { detail: { id: d.id, ok: ok, data: data, error: error } }));
  });
  return { state: st, log: log };
}

/* =====================================================================
 * ネイティブ統合UI（SPEC 第9章）の試験台
 *
 * 継ぎ目7 は content.js（差し込み先を探す側）と overlay.js（描く側）の間にある。
 * 片方だけを動かしても見えないので、createHarness に overlay:true を渡すと
 * 実物の src/overlay.js を content と同じコンテキストへ、manifest の
 * content_scripts.js と同じ順序（volume.js → overlay.js → content.js）で読み込む。
 *
 * ここに説明を置いてファイル冒頭に置かないのは、INSTALL.md が
 * test/helpers/wiring.js:99-103（attachFakePlayer）を3箇所から引いているため。
 * 上に行を足すと、他人の文書の引用を黙って腐らせる（tools/scan_doc_cites.sh の
 * アンカーが無い引用は範囲しか見ないので、赤にすらならず嘘だけが残る）。
 * ===================================================================== */

/*
 * YouTube のプレイヤー DOM の最小再現（SPEC 9-a / 9-c）。
 * content.js が探すのは #movie_player 配下の .ytp-right-controls だけなので、
 * 作るのもそこだけにする。既存ボタンを2つ置いてあるのは「先頭に入ったか」を
 * 末尾との差で判定するため（既存の子が1つも無いと先頭と末尾が区別できない）。
 */
function buildYouTubePlayer(doc, spec) {
  const s = spec || {};
  const player = doc.addElement('movie_player', 'div');
  player.className = 'html5-video-player';
  let controls = null;
  if (s.rightControls !== false) {
    controls = doc.createElement('div');
    controls.className = 'ytp-right-controls';
    player.appendChild(controls);
    const names = s.buttons || ['ytp-settings-button', 'ytp-fullscreen-button'];
    for (const n of names) {
      const b = doc.createElement('button');
      b.className = 'ytp-button ' + n;
      controls.appendChild(b);
    }
  }
  return { player: player, controls: controls };
}

function createContentWorld(opts) {
  const doc = makeDocument();
  const timers = makeTimers(opts.clockScale);
  const logs = [];
  const store = jsonClone(opts.storage || {}) || {};
  const messageListeners = [];
  const windowEvents = Object.create(null);

  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => 'chrome-extension://ytvp-test/' + String(p),
      onMessage: {
        addListener(fn) { if (typeof fn === 'function') { messageListeners.push(fn); } }
      }
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys
            : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
          const out = {};
          for (const k of list) {
            if (Object.prototype.hasOwnProperty.call(store, k)) { out[k] = jsonClone(store[k]); }
          }
          setImmediate(() => cb(out));
        },
        set(obj, cb) {
          for (const k of Object.keys(obj || {})) { store[k] = jsonClone(obj[k]); }
          setImmediate(() => { if (typeof cb === 'function') { cb(); } });
        }
      }
    }
  };

  /*
   * 実物の content script には必ず location がある。以前この試験台には無く、
   * src/content.js のホスト判定（SPEC 9-b: ネイティブ統合は www.youtube.com だけ）は
   * 「location が読めない＝対象外」に倒してあるので、足さないとネイティブ経路が
   * 一度も通らないまま緑になる。既定は拡張の主戦場である www.youtube.com。
   * hostname:'music.youtube.com' を渡すと除外側を検査できる。
   */
  const hostname = opts.hostname || 'www.youtube.com';
  const sandbox = {
    chrome: chrome,
    document: doc,
    console: quietConsole(logs),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    CustomEvent: FakeEvent,
    Event: FakeEvent,
    URL: URL,
    location: { hostname: hostname, href: 'https://' + hostname + '/watch?v=dQw4w9WgXcQ' },
    addEventListener(type, fn) { (windowEvents[type] || (windowEvents[type] = [])).push(fn); },
    removeEventListener() {}
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', ctx, { filename: 'ytvp-test-bootstrap' });

  // ISOLATED → MAIN へ出た命令の記録。MAIN world が居ない（＝誰も応答しない）
  // 経路でも content が何を投げたかを見られるようにする。
  const cmdLog = [];
  doc.addEventListener('ytvp:cmd', (ev) => {
    const d = ev && ev.detail;
    if (d && d.id) { cmdLog.push({ id: d.id, action: d.action, payload: jsonClone(d.payload) }); }
  });

  // mainWorld:false は「page.js の注入がまだ済んでいない」状態。
  // 実物では ytvp:cmd を誰も拾わず、content 側は CMD_TIMEOUT_MS で諦める。
  const world = {
    doc, ctx: null, logs, store, player: null, timers, messageListeners, windowEvents,
    sandbox, cmdLog, hostname, yt: null
  };
  if (opts.mainWorld !== false) { world.player = attachFakePlayer(doc, opts.player); }

  // プレイヤーの DOM は content.js を走らせる **前** に組む。
  // 実物の run_at は document_idle で、多くの場合プレイヤーは既にある。
  if (opts.playerDom) { world.yt = buildYouTubePlayer(doc, opts.playerDom); }

  // manifest の content_scripts.js と同じ順序（volume.js → overlay.js → content.js）。
  // 既定では overlay を読まない: seam1〜6 は popup ⇄ content の継ぎ目を見る台で、
  // オーバーレイが居ると同じ doc に別の DOM が混ざる。overlay:true のときだけ足す。
  vm.runInContext(readSource('src/lib/volume.js'), ctx, { filename: 'src/lib/volume.js' });
  if (opts.overlay === true) {
    const overlaySrc = applyPatch(readSource('src/overlay.js'), OVERLAY_PATCH, 'YTVP_OVERLAY_PATCH');
    vm.runInContext(overlaySrc, ctx, { filename: 'src/overlay.js' });
  }
  const contentSrc = applyPatch(readSource('src/content.js'), CONTENT_PATCH, 'YTVP_CONTENT_PATCH');
  vm.runInContext(contentSrc, ctx, { filename: 'src/content.js' });

  world.ctx = ctx;
  return world;
}

// src/popup.html の実物から id と要素名を読む。
// popup.js が触る id が popup.html に無ければ init() が黙って戻るので、
// この読み取り自体が popup.html ⇄ popup.js の食い違いを検知する経路になる。
function readPopupIds() {
  const html = readSource('src/popup.html');
  const re = /<([a-zA-Z][\w-]*)\b[^>]*\sid="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) { out.push({ tag: m[1], id: m[2] }); }
  return out;
}

/*
 * ポップアップの UI 部品を「クラス名で DOM を歩いて」拾う。
 *
 * v0.7 でポップアップは自前のマークアップを捨て、プレイヤー内パネルと同じ
 * src/overlay.js が描くようになった（二重実装の解消）。したがって
 * popup.html に残る id は案内文（#ytvp-msg）だけで、以前のように
 * els['ytvp-num'] で引くと **どの検査も undefined を触って落ちる**。
 * ここは id ではなく、overlay が付けるクラス（.ytvp-value / .ytvp-range /
 * .ytvp-preset-input …）で引き直す層。
 *
 * 参照を掴んで持たず、呼ぶたびに歩き直すのが要点。ポップアップは
 * setSettings のあとパネルを作り直す（popup.js の remount）ので、
 * 掴んだ参照を持つと **DOM から外れた古い要素**を見て緑になる。
 */
function popupUi(doc, els) {
  const one = (cls) => findByClass(doc.body, cls)[0] || null;
  return {
    msg: () => els['ytvp-msg'] || null,
    root: () => one('ytvp-root'),
    handleBtn: () => one('ytvp-handle'),
    panel: () => one('ytvp-panel'),
    value: () => one('ytvp-value'),          // 大きな数値（input）
    range: () => one('ytvp-range'),          // スライダー。上限（max）の真実はここ
    boostBtn: () => one('ytvp-boost'),
    boostVal: () => one('ytvp-boost__val'),
    pills: () => findByClass(doc.body, 'ytvp-pill'),
    gear: () => one('ytvp-gear'),
    settings: () => one('ytvp-settings'),
    presetInput: () => one('ytvp-preset-input'),
    presetApply: () => one('ytvp-preset-apply')
  };
}

function createPopupWorld(deliver, opts) {
  const doc = makeDocument();
  const timers = makeTimers();
  const logs = [];
  const ids = readPopupIds();
  const els = {};
  for (const it of ids) { els[it.id] = doc.addElement(it.id, it.tag); }

  const tabs = opts.tabs || [{ id: TAB_ID, url: YT_URL, active: true }];
  const chrome = {
    runtime: { lastError: undefined },
    tabs: {
      query(info, cb) { setImmediate(() => cb(jsonClone(tabs))); },
      sendMessage(tabId, msg, cb) { deliver(tabId, msg, cb); }
    }
  };

  const sandbox = {
    chrome: chrome,
    document: doc,
    console: quietConsole(logs),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    CustomEvent: FakeEvent,
    Event: FakeEvent,
    URL: URL,
    addEventListener() {},
    removeEventListener() {}
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', ctx, { filename: 'ytvp-test-bootstrap' });

  // src/popup.html の <script> と同じ順序で読む: lib/volume.js → overlay.js → popup.js。
  // overlay.js を足したのが v0.7 の変更点。ポップアップの UI は overlay が描くので、
  // ここで読まないと popup.js の mountPanel() が「パネルを読み込めませんでした」に落ちる
  // ＝ 実物とまるで違う台になる。
  vm.runInContext(readSource('src/lib/volume.js'), ctx, { filename: 'src/lib/volume.js' });
  const overlaySrc = applyPatch(readSource('src/overlay.js'), OVERLAY_PATCH, 'YTVP_OVERLAY_PATCH');
  vm.runInContext(overlaySrc, ctx, { filename: 'src/overlay.js' });
  const popupSrc = applyPatch(readSource('src/popup.js'), POPUP_PATCH, 'YTVP_POPUP_PATCH');
  vm.runInContext(popupSrc, ctx, { filename: 'src/popup.js' });

  return { doc, ctx, logs, els, timers, ids, ui: popupUi(doc, els) };
}

function createHarness(options) {
  const opts = options || {};
  const content = createContentWorld(opts);
  const messages = [];
  const popups = [];
  let intercept = (typeof opts.intercept === 'function') ? opts.intercept : null;

  // ここが配線の要。popup が chrome.tabs.sendMessage で投げたものを、
  // content が chrome.runtime.onMessage に登録した「実物のリスナ」へそのまま渡す。
  function deliver(tabId, msg, cb) {
    // 実物の chrome はワールドをまたぐときに構造化複製する。ここでも境界で必ず複製する。
    //   1) content が popup のオブジェクトを直接掴む「テストでだけ動く」配線を防ぐ
    //   2) 応答が構造化複製できない値（関数・循環）なら、その場で壊れる
    const sent = jsonClone(msg);
    const rec = { tabId: tabId, msg: sent, returns: [], reply: undefined, delivered: false };
    messages.push(rec);
    let done = false;
    const sendResponse = (res) => {
      if (done) { return; }
      done = true;
      rec.reply = jsonClone(res);
      setImmediate(() => {
        try { if (typeof cb === 'function') { cb(rec.reply); } } finally { rec.delivered = true; }
      });
    };
    if (tabId !== TAB_ID) {
      // content script の居ないタブ。実物の chrome は応答せず lastError を立てる。
      setImmediate(() => { rec.delivered = true; if (typeof cb === 'function') { cb(undefined); } });
      return rec;
    }
    if (intercept) {
      const verdict = intercept(sent, rec);
      if (verdict && verdict.drop === true) { rec.dropped = true; return rec; }
      if (verdict && Object.prototype.hasOwnProperty.call(verdict, 'reply')) {
        rec.intercepted = true;
        sendResponse(verdict.reply);
        return rec;
      }
    }
    for (const fn of content.messageListeners) {
      rec.returns.push(fn(sent, { tab: { id: tabId } }, sendResponse));
    }
    return rec;
  }

  const harness = {
    content: content,
    player: content.player,      // mainWorld:false のときは null（startMainWorld で入る）
    store: content.store,
    messages: messages,
    cmdLog: content.cmdLog,
    popup: null,
    TAB_ID: TAB_ID,

    /*
     * MAIN world（src/page.js 相当）を「あとから」立ち上げる。
     * 実物では page.js は <script> で注入されるので、content より遅れて動き出すことがある。
     * fireReady:false は「cmd には答えられるが ytvp:ready をまだ流していない」瞬間で、
     * このとき MAIN 側の boost は content の settings と食い違っている（SPEC 3-d が禁じた状態）。
     */
    startMainWorld(mainOpts) {
      const o = mainOpts || {};
      if (content.player) { throw new Error('MAIN world は既に立ち上がっている'); }
      content.player = attachFakePlayer(content.doc, o.initial || opts.player);
      harness.player = content.player;
      if (o.fireReady !== false) { harness.fireMainWorldReady(); }
      return content.player;
    },
    // src/page.js の最終行そのもの（読み込み完了を1度だけ知らせる）
    fireMainWorldReady() {
      content.doc.dispatchEvent(new FakeEvent('ytvp:ready', { detail: { ok: true } }));
    },

    // popup を通さず、同じ配線で1往復する（SPEC 3-b の表の直接検査用）
    request(msg, timeoutMs) {
      return new Promise((resolve, reject) => {
        const limit = setTimeout(() => {
          reject(new Error('応答が返らない（' + JSON.stringify(msg) + '）'));
        }, timeoutMs || 2000);
        deliver(TAB_ID, msg, (res) => { clearTimeout(limit); resolve(res); });
      });
    },
    lastMessage(type) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].msg && messages[i].msg.type === type) { return messages[i]; }
      }
      return null;
    },
    loadPopup(popupOpts) {
      // ポップアップは何度でも開き直せる（実物と同じ。開くたびに新しいインスタンス）。
      // 過去に開いた分も dispose で確実に片付ける（タイマーが残るとテストが終わらない）。
      harness.popup = createPopupWorld(deliver, popupOpts || {});
      popups.push(harness.popup);
      return harness.popup;
    },
    // 継ぎ目に「壊れた応答 / 無応答」を差し込む口（回帰専用。src には触れない）。
    //   戻り値 {drop:true}        … 応答も配送もしない（content にも届かない）
    //   戻り値 {reply: <値>}      … content を通さずこの値で応答する（undefined = 応答なし）
    //   falsy                     … 素通し（実物の content へ配送）
    setIntercept(fn) { intercept = (typeof fn === 'function') ? fn : null; },
    /*
     * 要素を押す（ページ側・ポップアップ側の両方で使う）。
     * v0.7 まであった click(id) は消した。ポップアップの部品は overlay が描くので
     * id を持たず、id で引く口を残すと「存在しない id を掴んで落ちる」だけの罠になる。
     * 要素は popup.ui.* / h.find(cls) で取り、その参照をここへ渡す。
     * ev を渡せるのは pointerType（タッチ判定）を差し込む検査があるため。
     */
    clickEl(el, type, ev) {
      if (!el) { throw new Error('存在しない要素をクリックしようとした'); }
      el.dispatchEvent(ev || new FakeEvent(type || 'click'));
    },
    // #movie_player 配下の .ytp-right-controls（playerDom を渡したときだけ非 null）
    controls() { return content.yt ? content.yt.controls : null; },
    player_el() { return content.yt ? content.yt.player : null; },
    // ページ内の class 検索（オーバーレイが実際に DOM に居るかを歩いて確かめる）
    find(cls) { return findByClass(content.doc.body, cls); },
    /*
     * SPA 遷移（yt-navigate-finish）。content.js が window に張った実物のリスナを呼ぶ。
     * 購読していなければ throw する。黙って 0 件回すと「遷移させたつもり」で
     * 何も起きていない状態が緑になる。
     */
    navigate() {
      const list = content.windowEvents['yt-navigate-finish'] || [];
      if (list.length === 0) {
        throw new Error('content が yt-navigate-finish を購読していない（SPA 遷移の再バインドが無い）');
      }
      for (const fn of list.slice()) { fn(new FakeEvent('yt-navigate-finish')); }
      return list.length;
    },
    async settle(times) {
      const n = times || 5;
      for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); }
    },
    async waitFor(fn, label, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 2000);
      while (Date.now() < deadline) {
        let hit = false;
        try { hit = !!fn(); } catch (e) { hit = false; }
        if (hit) { return true; }
        await new Promise((r) => setImmediate(r));
      }
      throw new Error('待ち時間内に条件を満たさなかった: ' + label);
    },
    // content の起動（loadSettings → bind → boost → get）が終わるまで待つ
    async ready() {
      if (!content.player) {
        throw new Error('MAIN world が居ないので ready() は使えない（cmdLog を待つこと）');
      }
      await harness.waitFor(
        () => content.player.log.some((e) => e.action === 'get'),
        'content の起動（ytvp:cmd get が届く）');
      await harness.settle(2);
    },
    // MAIN world が居ない経路用。content が命令を投げたところまでを待つ。
    async sent(action) {
      await harness.waitFor(
        () => content.cmdLog.some((e) => e.action === action),
        'content が ytvp:cmd ' + action + ' を投げる');
      return content.cmdLog.filter((e) => e.action === action);
    },
    dispose() {
      content.timers.clearAll();
      for (const p of popups) { p.timers.clearAll(); }
    }
  };
  return harness;
}

/* =====================================================================
 * オーバーレイ（src/overlay.js）の試験台
 *
 * なぜ別の台になるか:
 *   overlay.js は chrome.* を一切呼ばない（SPEC 第5章）。要るのは偽 document と
 *   bridge だけで、popup ⇄ content の配線とは前提が違う。
 *   上の createHarness はオーバーレイを mount しないので、オーバーレイ側の
 *   一方通行（boostAllowed:false のときブーストボタンを生成すらしない）は
 *   どのテストにも掛からなかった。ここがその穴を塞ぐ経路。
 *
 * bridge は content.js が渡すものと同じ形（SPEC 第5章）の偽物にする。
 * 実物の content を噛ませないのは、ここで見たいのが
 * 「オーバーレイが自分の boostAllowed で自分を押せなくしていないか」だからで、
 * content 側の往復は seam4 が実物同士で見ている。
 * ===================================================================== */

function createOverlayWorld() {
  const doc = makeDocument();
  const timers = makeTimers();
  const logs = [];
  const sandbox = {
    document: doc,
    console: quietConsole(logs),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    CustomEvent: FakeEvent,
    Event: FakeEvent
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', ctx, { filename: 'ytvp-test-bootstrap' });
  // 実物のページと同じ順序（manifest の content_scripts.js は lib/volume.js が先）
  vm.runInContext(readSource('src/lib/volume.js'), ctx, { filename: 'src/lib/volume.js' });
  const overlaySrc = applyPatch(readSource('src/overlay.js'), OVERLAY_PATCH, 'YTVP_OVERLAY_PATCH');
  vm.runInContext(overlaySrc, ctx, { filename: 'src/overlay.js' });
  return { doc, ctx, logs, sandbox, timers };
}

function classTokens(el) {
  return String((el && el.className) || '').split(/\s+/).filter((t) => t.length > 0);
}

// 生成されているか否かを見たいので、実際に DOM を歩いて探す。
// 参照を掴んで持っておくと「生成をやめた」実装を検知できない。
function walk(node, out) {
  if (!node) { return out; }
  const kids = node.childNodes || [];
  for (const k of kids) { out.push(k); walk(k, out); }
  return out;
}

function findByClass(root, cls) {
  return walk(root, []).filter((el) => classTokens(el).indexOf(cls) >= 0);
}

// 偽 DOM の textContent は自分の分しか返さないので、子孫を連結する
function deepText(el) {
  if (!el) { return null; }
  let out = String(el._text || '');
  for (const k of (el.childNodes || [])) { out += deepText(k); }
  return out;
}

function createOverlayHarness(options) {
  const opts = options || {};
  const world = createOverlayWorld();
  const doc = world.doc;

  const truth = Object.assign(
    { volume: 40, muted: false, boost: false, available: true }, opts.state || {});
  const calls = [];
  const subscribers = [];
  // 'ok' … content が受理して真実が変わる / 'reject' … 例外で失敗 / 'silent' … 応答は返るが真実は変わらない
  let boostMode = 'ok';

  function snapshot() {
    return { volume: truth.volume, muted: truth.muted, boost: truth.boost, available: truth.available };
  }
  function notify() {
    for (const cb of subscribers.slice()) { try { cb(snapshot()); } catch (e) { /* 購読側の例外は無視 */ } }
  }

  const bridge = {
    getState() { calls.push({ m: 'getState' }); return Promise.resolve(snapshot()); },
    setVolume(v) {
      calls.push({ m: 'setVolume', arg: v });
      truth.volume = v;
      notify();
      return Promise.resolve();
    },
    setBoost(b) {
      calls.push({ m: 'setBoost', arg: b });
      if (boostMode === 'reject') { return Promise.reject(new Error('offline')); }
      if (boostMode === 'silent') { return Promise.resolve(); }
      truth.boost = (b === true);
      notify();
      return Promise.resolve();
    },
    subscribe(cb) {
      calls.push({ m: 'subscribe' });
      if (typeof cb === 'function') { subscribers.push(cb); }
    }
  };

  /*
   * 設定（⚙）と初回ヒントの既読は **content 側にしか置けない口**（overlay は
   * chrome API を持たない。SPEC 第5章）。overlay はこの口が bridge に
   * **関数として在るか**だけで振る舞いを変える（SPEC 12-a）。
   *   * setSettings が無い相手 … ⚙ を出さない（押しても保存先が無いボタンを作らない）
   *   * markHintShown が無い相手 … 既読を知らせない（ヒント自体は出す）
   * 既定で持たせないのは、配線前の旧 content.js を再現する台を残すため。
   * opts.settings / opts.hint を立てたときだけ生やす。
   */
  if (opts.settings === true) {
    bridge.setSettings = function (patch) {
      calls.push({ m: 'setSettings', arg: jsonClone(patch) });
      return Promise.resolve();
    };
  }
  if (opts.hint === true) {
    bridge.markHintShown = function () {
      calls.push({ m: 'markHintShown' });
      return Promise.resolve();
    };
  }

  let handle = null;

  const ov = {
    doc, logs: world.logs, bridge, calls, truth, subscribers,
    setBoostMode(mode) { boostMode = mode; },
    lastCall(name) {
      for (let i = calls.length - 1; i >= 0; i--) { if (calls[i].m === name) { return calls[i]; } }
      return null;
    },
    countCalls(name) { return calls.filter((c) => c.m === name).length; },

    mount(mountOptions) {
      const o = Object.assign({ presets: [15, 30, 50, 70, 100] }, mountOptions || {});
      handle = world.ctx.YTVPOverlay.mount(bridge, o);
      return handle;
    },
    destroy() {
      if (handle && typeof handle.destroy === 'function') { handle.destroy(); }
      handle = null;
    },
    handle() { return handle; },

    root() { return findByClass(doc.body, 'ytvp-root')[0] || null; },
    handleBtn() { return findByClass(doc.body, 'ytvp-handle')[0] || null; },
    panel() { return findByClass(doc.body, 'ytvp-panel')[0] || null; },
    range() { return findByClass(doc.body, 'ytvp-range')[0] || null; },
    boostBtn() { return findByClass(doc.body, 'ytvp-boost')[0] || null; },
    pills() { return findByClass(doc.body, 'ytvp-pill'); },
    // v0.6 で足した部品（⚙ の設定・初回ヒント・数値入力欄）。
    valueEl() { return findByClass(doc.body, 'ytvp-value')[0] || null; },
    gear() { return findByClass(doc.body, 'ytvp-gear')[0] || null; },
    settings() { return findByClass(doc.body, 'ytvp-settings')[0] || null; },
    presetInput() { return findByClass(doc.body, 'ytvp-preset-input')[0] || null; },
    presetApply() { return findByClass(doc.body, 'ytvp-preset-apply')[0] || null; },
    hint() { return findByClass(doc.body, 'ytvp-hint')[0] || null; },
    // パネルが開いているか。hidden だけを見る（class は render の付け方に依存するため）
    isOpen() { const p = ov.panel(); return !!p && p.hidden === false; },
    activeElement() { return doc.activeElement; },

    click(el) {
      if (!el) { throw new Error('存在しない要素をクリックしようとした'); }
      el.dispatchEvent(new FakeEvent('click'));
    },
    /*
     * ホバー（SPEC なし・v0.6 の導線）。実物の overlay は mouse 系と pointer 系の
     * **両方**を購読しているので、どちらか一方だけを飛ばしても成立する。
     * ここは実機で確実に来るほうに寄せて mouseenter / mouseleave を使う。
     * pointerType を渡すとタッチ判定（isTouchPointer）の経路を検査できる。
     */
    hover(el, kind, pointerType) {
      if (!el) { throw new Error('存在しない要素にホバーしようとした'); }
      const ev = new FakeEvent(kind);
      if (pointerType) { ev.pointerType = pointerType; }
      el.dispatchEvent(ev);
    },
    enter(el, pointerType) { ov.hover(el, 'mouseenter', pointerType); },
    leave(el, pointerType) { ov.hover(el, 'mouseleave', pointerType); },

    // SPEC 6: オーバーレイは既定で折りたたみ。観測の前にハンドルで開く。
    open() {
      const hb = ov.handleBtn();
      if (!hb) { throw new Error('ハンドル（.ytvp-handle）が無い'); }
      ov.click(hb);
    },

    // ブーストの「表示」だけを切り出す。楽観更新の検知はこの差分で行う。
    boostView() {
      const b = ov.boostBtn();
      const r = ov.range();
      return {
        exists: !!b,
        disabled: b ? b.disabled === true : null,
        pressed: b ? b.getAttribute('aria-pressed') : null,
        text: b ? deepText(b) : null,
        rangeMax: r ? String(r.max) : null
      };
    },

    async settle(times) {
      const n = times || 5;
      for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); }
    },
    /*
     * 条件が満たされるまで待つ。ホバーの自動クローズは CLOSE_GRACE_MS（200ms）の
     * 実時間タイマなので、setImmediate を回すだけでは絶対に届かない。
     * 「起きるはず」の待ちはここで、「起きないはず」の確認は下の stayFor で行う。
     */
    async waitFor(fn, label, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 2000);
      while (Date.now() < deadline) {
        let hit = false;
        try { hit = !!fn(); } catch (e) { hit = false; }
        if (hit) { return true; }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('待ち時間内に条件を満たさなかった: ' + label);
    },
    // 指定時間ずっと条件が成り立ち続けることを見る（＝「閉じないこと」の検査）。
    // 猶予(200ms)より確実に長く待たないと、単に「まだ閉じていない」を見ただけになる。
    async stayFor(fn, label, ms) {
      const deadline = Date.now() + (ms || 500);
      while (Date.now() < deadline) {
        if (!fn()) { throw new Error('途中で条件が崩れた: ' + label); }
        await new Promise((r) => setTimeout(r, 5));
      }
      return true;
    },
    dispose() {
      ov.destroy();
      world.timers.clearAll();
    }
  };
  return ov;
}

module.exports = {
  createHarness, createOverlayHarness, TAB_ID, YT_URL, readPopupIds,
  findByClass, deepText, buildYouTubePlayer
};

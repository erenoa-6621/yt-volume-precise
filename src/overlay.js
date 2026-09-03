;(function (root) {
  'use strict';

  var MAX_PLAIN = 100;
  var MAX_BOOST = 300;
  var FALLBACK_PRESETS = [15, 30, 50, 70, 100];

  // ホバーが外れてから閉じるまでの猶予。ボタンとパネルの間をポインタが渡るとき、
  // 0 にすると渡っている途中で消える（YouTube 純正の 🔊 も同じ理由で猶予を持つ）。
  var CLOSE_GRACE_MS = 200;
  // 初回ヒントを出しておく時間。読める長さで、邪魔にならないうちに消す。
  var HINT_MS = 4500;
  // プリセット編集欄の区切り。数字（半角・全角）と半角 % 以外はすべて区切りとみなす
  // （SPEC 12-a「空白・カンマ・読点・スラッシュ等の非数字で区切られた数の列」）。
  var PRESET_SEP = /[^0-9０-９%]+/;

  function noop() {}

  // 期待どおりでない入力（bridge が無い・DOM が無い）でも例外を投げず、
  // 何もしない同じ形のハンドルを返す。
  function noopHandle() {
    return { destroy: noop, update: noop };
  }

  function isFn(f) { return typeof f === 'function'; }

  function getDoc() {
    try {
      if (typeof document !== 'undefined' && document &&
          isFn(document.createElement)) { return document; }
    } catch (e) { /* document 自体が未定義の環境 */ }
    return null;
  }

  // 共有ロジック（src/lib/volume.js）が居れば使う。居なければ自前の最小版。
  function lib() {
    try {
      var y = root && root.YTVP;
      if (y && typeof y === 'object') { return y; }
    } catch (e) {}
    return null;
  }

  function clampVolume(value, boost) {
    var y = lib();
    if (y && isFn(y.clampVolume)) {
      try { return y.clampVolume(value, { boost: !!boost, fallback: 0 }); } catch (e) {}
    }
    var n = Number(value);
    if (!isFinite(n)) { return 0; }
    n = Math.round(n);
    var max = boost ? MAX_BOOST : MAX_PLAIN;
    if (n < 0) { return 0; }
    if (n > max) { return max; }
    return n;
  }

  function normalizePresets(list, boost) {
    var y = lib();
    if (y && isFn(y.normalizePresets)) {
      try {
        var got = y.normalizePresets(list, { boost: !!boost });
        if (got && got.length) { return got; }
      } catch (e) {}
    }
    var out = [];
    var src = (list && list.length) ? list : FALLBACK_PRESETS;
    for (var i = 0; i < src.length && out.length < 8; i++) {
      var v = Number(src[i]);
      if (!isFinite(v)) { continue; }
      v = clampVolume(v, boost);
      if (out.indexOf(v) === -1) { out.push(v); }
    }
    out.sort(function (a, b) { return a - b; });
    return out.length ? out : FALLBACK_PRESETS.slice();
  }

  function stepFromWheel(current, deltaY, shift, boost) {
    var y = lib();
    if (y && isFn(y.stepFromWheel)) {
      try { return y.stepFromWheel(current, deltaY, { shift: !!shift, boost: !!boost }); } catch (e) {}
    }
    return null; // 共有ロジックが無ければホイールは諦める（例外にしない）
  }

  // 解釈は共有ロジック（src/lib/volume.js）に一本化する。ここに独自の数値解釈を
  // 書くと、ポップアップと意味論がずれる（全角・"87%"・前後空白の扱い）。
  // 居ないときは null（＝解釈できなかった）を返し、何も適用しない。
  // stepFromWheel と同じ方針：共有ロジック不在で勝手な代替解釈をしない。
  function parseVolumeInput(raw) {
    var y = lib();
    if (y && isFn(y.parseVolumeInput)) {
      try {
        var got = y.parseVolumeInput(raw);
        return (typeof got === 'number' && isFinite(got)) ? got : null;
      } catch (e) { return null; }
    }
    return null;
  }

  function validBridge(b) {
    return !!b && typeof b === 'object' &&
      isFn(b.getState) && isFn(b.setVolume) && isFn(b.setBoost);
  }

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }

  function settle(p) {
    // Promise でも同期戻り値でも例外でも、呼び出し側を落とさない
    try {
      if (p && isFn(p.then)) { p.then(noop, noop); }
    } catch (e) {}
  }

  // SPEC 9-c: YouTube の DOM を探すのは content.js の責務。
  // ここは渡された要素が「描ける器か」を検分するだけで、セレクタは一切持たない。
  function pickAnchor(a) {
    try {
      if (!a || typeof a !== 'object') { return null; }
      // Element なら nodeType===1。持っていない相手（試験用の偽 DOM 等）は口で判断する。
      if ('nodeType' in a && a.nodeType !== 1) { return null; }
      if (!isFn(a.appendChild)) { return null; }
      return a;
    } catch (e) { return null; } // getter が投げる相手でも落ちない
  }

  // 先頭に差し込む。prepend が無い相手には insertBefore、それも無ければ末尾。
  // 例外は握り潰さず呼び出し元へ返す（呼び出し元が浮きハンドルへ戻す）。
  function insertFirst(parent, node) {
    if (isFn(parent.prepend)) { parent.prepend(node); return true; }
    var first = null;
    try {
      first = parent.firstChild ||
        ((parent.childNodes && parent.childNodes.length) ? parent.childNodes[0] : null) || null;
    } catch (e) {}
    if (isFn(parent.insertBefore)) { parent.insertBefore(node, first); return true; }
    if (isFn(parent.appendChild)) { parent.appendChild(node); return true; }
    return false;
  }

  function mount(bridge, options) {
    var doc = getDoc();
    if (!doc || !validBridge(bridge)) { return noopHandle(); }
    var opts = options || {};
    try {
      // SPEC 9-c: nativeAnchor が使える器なら、そこへネイティブボタンを差し込む。
      // 失敗（不正・差し込み不能・例外）は黙って従来の浮きハンドルへ戻す（SPEC 9-b）。
      var anchor = pickAnchor(opts.nativeAnchor);
      if (anchor) {
        var nativeHandle = null;
        try { nativeHandle = build(doc, bridge, opts, anchor); } catch (e) { nativeHandle = null; }
        if (nativeHandle) { return nativeHandle; }
      }
      return build(doc, bridge, opts, null) || noopHandle();
    } catch (e) {
      return noopHandle();
    }
  }

  // anchor が非 null ならネイティブモード。差し込みに失敗したときだけ null を返す
  // （呼び出し元が浮きハンドルで組み直す）。それ以外は必ずハンドルを返す。
  function build(doc, bridge, options, anchor) {
    var native = !!anchor;
    var host = anchor;
    if (!native) {
      try { host = doc.getElementById && doc.getElementById('movie_player'); } catch (e) {}
      if (!host) { host = doc.body; }
      if (!host || !isFn(host.appendChild)) { return noopHandle(); }
    }
    // プレーヤーに入れられなかった場合だけ画面固定にする
    var posCls = native ? ' ytvp-native' : ((host === doc.body) ? ' ytvp-fixed' : '');

    var boostAllowed = !!options.boostAllowed;
    var presets = normalizePresets(options.presets, boostAllowed);

    // SPEC 5: boostAllowed は「ボタンを出すか」ではなく、初期表示（ON/OFF）と
    // 上限（100 / 300）にだけ使う。state.boost はブーストの唯一の真実 boostAllowed の写し。
    var state = { volume: 0, muted: false, boost: boostAllowed, available: true };
    var open = false;
    var destroyed = false;
    var listeners = [];

    // ── ホストの作法（ホバーで開く／クリックで固定）に使う状態 ──
    // YouTube の音量は「🔊 にホバーでスライダーが伸び、外れれば畳まれる」。
    // 同じ作法にすると、利用者が新しく覚えることが無くなる。
    var pinned = false;     // クリックで固定した状態。ホバーが外れても閉じない
    var hoverBtn = false;   // 開閉ボタンの上にポインタが居る
    var hoverPanel = false; // パネルの上にポインタが居る
    var closeTimer = null;  // 猶予つきの自動クローズ
    var hintTimer = null;
    var settingsOpen = false;

    function on(target, type, fn, opts) {
      try {
        target.addEventListener(type, fn, opts);
        listeners.push([target, type, fn, opts]);
      } catch (e) {}
    }

    // 時計は root（＝window）から借りる。無い環境（document だけの試験台等）でも
    // 例外にせず「猶予つきの閉じ」だけを諦める（無いものは使わない）。
    function later(fn, ms) {
      try {
        if (root && isFn(root.setTimeout)) { return root.setTimeout(fn, ms); }
      } catch (e) {}
      return null;
    }
    function cancelLater(h) {
      try {
        if (h !== null && h !== undefined && root && isFn(root.clearTimeout)) { root.clearTimeout(h); }
      } catch (e) {}
    }

    // --- DOM ---
    var rootEl = el(doc, 'div', 'ytvp-root' + posCls + ' ytvp-is-collapsed');
    rootEl.setAttribute('data-ytvp', '1');

    // ネイティブモードでは浮きハンドルを出さない（SPEC 9-a）。開閉の役はネイティブ
    // ボタンが担う。パネルの中身は両モードで完全に同じものを使い回す（新しい操作体系を作らない）。
    var handle = null;
    var handleVal = null;
    var nativeBtn = null;
    var nativeVal = null;

    if (native) {
      // ytp-button から借りるのは位置と余白だけ。中身は数値なので、文字の寸法は
      // CSS で自前に持つ（YouTube 側はアイコン前提で、借りたままだと潰れる）。
      nativeBtn = el(doc, 'button', 'ytp-button ytvp-native-btn');
      nativeBtn.type = 'button';
      nativeBtn.setAttribute('data-ytvp', '1');
      nativeBtn.setAttribute('aria-expanded', 'false');
      nativeBtn.setAttribute('aria-haspopup', 'true');
      nativeBtn.setAttribute('aria-label', '音量');
      nativeBtn.title = '音量パネル';
      nativeVal = el(doc, 'span', 'ytvp-native-btn__value', '0');
      nativeBtn.appendChild(nativeVal);
    } else {
      handle = el(doc, 'button', 'ytvp-handle');
      handle.type = 'button';
      handle.setAttribute('aria-expanded', 'false');
      handle.title = '音量パネル';
      handleVal = el(doc, 'span', 'ytvp-handle__value', '0');
      handle.appendChild(handleVal);
      rootEl.appendChild(handle);
    }

    var panel = el(doc, 'div', 'ytvp-panel');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', '音量');
    panel.hidden = true;

    // SPEC 10-a: readout（大きな数値）**それ自体を入力欄にする**。
    // この製品の出発点は「ゲージでは細かく合わせられないから数値で入れたい」であって、
    // 読むだけの数字ではその要求を満たさない。単位（%）は入力欄の外に置く
    // （中に入れると打った文字と単位が混ざり、parseVolumeInput の仕事が増える）。
    var readout = el(doc, 'div', 'ytvp-readout');
    var valueEl = el(doc, 'input', 'ytvp-value');
    valueEl.type = 'text';
    valueEl.value = '0';
    valueEl.setAttribute('inputmode', 'numeric');
    valueEl.setAttribute('autocomplete', 'off');
    valueEl.setAttribute('spellcheck', 'false');
    valueEl.setAttribute('aria-label', '音量（数値を入力して Enter で確定）');
    valueEl.title = '数値を入力して Enter';
    readout.appendChild(valueEl);
    readout.appendChild(el(doc, 'span', 'ytvp-unit', '%'));
    var stateEl = el(doc, 'span', 'ytvp-state', '');
    readout.appendChild(stateEl);
    panel.appendChild(readout);

    var range = el(doc, 'input', 'ytvp-range');
    range.type = 'range';
    range.min = '0';
    range.max = String(MAX_PLAIN);
    range.step = '1';
    range.value = '0';
    range.setAttribute('aria-label', '音量');
    panel.appendChild(range);

    var pillWrap = el(doc, 'div', 'ytvp-presets');
    pillWrap.setAttribute('role', 'group');
    pillWrap.setAttribute('aria-label', 'プリセット');
    var pills = [];
    for (var i = 0; i < presets.length; i++) {
      (function (v) {
        var b = el(doc, 'button', 'ytvp-pill', String(v));
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        on(b, 'click', function () { apply(v); });
        pillWrap.appendChild(b);
        pills.push({ value: v, node: b });
      })(presets[i]);
    }
    panel.appendChild(pillWrap);

    // SPEC 3-d: ブーストを切り替えるコントロールを boostAllowed で
    // disabled にも非表示にも「生成しない」にもしてはならない。
    // 自分自身の値で自分を押せなくすると、OFF から ON へ戻る道が消える（一方通行）。
    // よってボタンは常に生成する。塞いでよいのはオフライン（available:false）のときだけ。
    var boostBtn = el(doc, 'button', 'ytvp-boost');
    boostBtn.type = 'button';
    boostBtn.setAttribute('aria-pressed', boostAllowed ? 'true' : 'false');
    var boostLabel = el(doc, 'span', 'ytvp-boost__label', 'ブースト');
    var boostVal = el(doc, 'span', 'ytvp-boost__val', boostAllowed ? 'ON' : 'OFF');
    // v0.8: 行の形を「ラベル左・トグル右」にする（YouTube の設定メニューと同じ記号）。
    // ON/OFF は目にはつまみの位置で見える。boostVal の文字は消さずに画面外へ置く
    // （overlay.css）。読み上げに状態が届く経路を aria-pressed だけにしないため。
    var boostSwitch = el(doc, 'span', 'ytvp-boost__switch');
    boostSwitch.appendChild(el(doc, 'span', 'ytvp-boost__thumb'));
    boostBtn.appendChild(boostLabel);
    boostBtn.appendChild(boostVal);
    boostBtn.appendChild(boostSwitch);
    on(boostBtn, 'click', function () {
      if (state.available === false) { return; }
      // 楽観更新をしない。state.boost はここで触らず、真実は content が
      // subscribe / update で返してくるものだけを採る。
      // 先に反転させると、content が死んでいるのに見た目だけ ON になる。
      settle(safeCall(bridge.setBoost, bridge, !state.boost));
    });
    panel.appendChild(boostBtn);

    // ── ⚙ 設定（段階的開示）──
    // 拡張のアイコンは Chrome の既定でツールバーに出ない（パズルピースの中に隠れる）。
    // 「ポップアップにしか無い設定」は多くの人に届かないので、**プレイヤー内パネルを
    // 唯一の家**にする。ただし常時見せると主役（数値入力）が埋もれるので ⚙ で開く。
    // 後方互換: bridge.setSettings を持たない相手（旧 content.js）には ⚙ を出さない。
    // 出しても保存先が無く、押せるのに何も起きないボタンになる。
    var canSettings = isFn(bridge.setSettings);
    var gearBtn = null;
    var settingsEl = null;
    var presetInput = null;
    var presetApply = null;
    var presetEditing = false;

    if (canSettings) {
      gearBtn = el(doc, 'button', 'ytvp-gear');
      gearBtn.type = 'button';
      gearBtn.setAttribute('aria-expanded', 'false');
      gearBtn.setAttribute('aria-label', '設定');
      gearBtn.title = '設定（プリセットの編集）';
      gearBtn.appendChild(el(doc, 'span', 'ytvp-gear__icon', '⚙'));
      // ★置き場所は readout（数値の行）の右端。パネルの末尾ではない。
      // このパネルは**上へ開く**（overlay.css の bottom: calc(100% + ...)）ので、
      // パネルの末尾に置いた要素が YouTube のシークバーに最も近くなる。しかも
      // YouTube はホバー時にシークバーの当たり判定を広げるので、押し合いになる
      // （実機報告「歯車ボタンがシークバーと被って押しにくい」）。
      // 最上段の右端はシークバーから最も遠く、かつ「設定は右上」という一般的な作法にも合う。
      readout.appendChild(gearBtn);

      settingsEl = el(doc, 'div', 'ytvp-settings');
      settingsEl.hidden = true;
      var settingsLabel = el(doc, 'label', 'ytvp-settings__label',
        'プリセット（空白区切り・空欄で既定に戻す）');
      settingsEl.appendChild(settingsLabel);
      var settingsRow = el(doc, 'div', 'ytvp-settings__row');
      presetInput = el(doc, 'input', 'ytvp-preset-input');
      presetInput.type = 'text';
      presetInput.value = presets.join(' ');
      presetInput.setAttribute('inputmode', 'numeric');
      presetInput.setAttribute('autocomplete', 'off');
      presetInput.setAttribute('spellcheck', 'false');
      presetInput.setAttribute('aria-label', 'プリセット（空白区切り）');
      presetApply = el(doc, 'button', 'ytvp-preset-apply', '適用');
      presetApply.type = 'button';
      settingsRow.appendChild(presetInput);
      settingsRow.appendChild(presetApply);
      settingsEl.appendChild(settingsRow);
      panel.appendChild(settingsEl);

      on(gearBtn, 'click', function () { setSettingsOpen(!settingsOpen); });
      on(presetApply, 'click', function () { applyPresets(); });
      on(presetInput, 'focus', function () { presetEditing = true; });
      on(presetInput, 'blur', function () { presetEditing = false; });
      on(presetInput, 'keydown', function (ev) {
        if (!ev) { return; }
        if (ev.key === 'Enter') {
          try { ev.preventDefault(); } catch (e) {}
          applyPresets();
        }
      });
      // 数値入力と同じ3層（実機の「打てない」対策）。YouTube のコントロールバーは
      // mousedown で preventDefault するので、明示の focus() が要る。
      on(presetInput, 'pointerdown', pointerFocus);
      on(presetInput, 'mousedown', pointerFocus);
    }

    var note = el(doc, 'p', 'ytvp-note', 'プレーヤーが見つかりません');
    note.hidden = true;
    panel.appendChild(note);

    rootEl.appendChild(panel);

    // ── 初回に一度だけ、触るきっかけを置く ──
    // 出すか出さないかは content 側が決める（overlay は拡張 API を持たないので
    // 既読フラグを自分で保存できない）。渡された値に従うだけ。
    var hintEl = null;
    if (options.firstRunHint === true) {
      hintEl = el(doc, 'div', 'ytvp-hint', '音量を数値で。クリックで開く');
      hintEl.setAttribute('role', 'status');
      rootEl.appendChild(hintEl);
    }

    function pointerFocus(ev) {
      if (state.available === false) { return; }
      try { if (ev && isFn(ev.stopPropagation)) { ev.stopPropagation(); } } catch (e) {}
      try { if (presetInput && isFn(presetInput.focus)) { presetInput.focus(); } } catch (e) {}
    }

    function setSettingsOpen(next) {
      settingsOpen = !!next && !!settingsEl;
      if (settingsEl) { settingsEl.hidden = !settingsOpen; }
      if (gearBtn) {
        gearBtn.setAttribute('aria-expanded', settingsOpen ? 'true' : 'false');
        gearBtn.className = settingsOpen ? 'ytvp-gear ytvp-gear--on' : 'ytvp-gear';
      }
      // ⚙ は最上段、開く先の編集欄は最下段にある。離れた2つが対応していることを
      // 目で追えるよう、開いている間は編集欄に ⚙ の ON と同じ地色を敷く
      // （色だけに頼らないよう、⚙ 側は枠線も併せて変わる）。
      // panel の className は render() が触らないので、ここで持って構わない。
      panel.className = settingsOpen ? 'ytvp-panel ytvp-panel--settings' : 'ytvp-panel';
      // 開くたびに「今保存されている値」を出し直す。正規化された結果（重複除去・
      // 昇順・最大8件）が入っているので、打った値と違っていればそれが答えになる。
      if (settingsOpen && presetInput) {
        try { presetInput.value = presets.join(' '); } catch (e) {}
      }
    }

    // 解析は共有ロジック（YTVP.parseVolumeInput）に一本化し、**正規化は自前で書かない**。
    // 重複除去・昇順・最大8件・boost に応じた丸めは content 側の normalizePresets が
    // 唯一の正規化器（SPEC 12-a）。ここで先に整えると二重実装になり、popup と意味論がずれる。
    function readPresetInput() {
      var raw = '';
      try { raw = String(presetInput.value == null ? '' : presetInput.value); } catch (e) {}
      var parts = raw.split(PRESET_SEP);
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) { continue; }
        var n = parseVolumeInput(parts[i]);
        if (n === null) { continue; } // 解釈できない断片は黙って捨てる
        out.push(n);
      }
      return out;
    }

    function applyPresets() {
      if (!canSettings || !presetInput) { return; }
      // 空欄 → [] を渡す。既定へ戻すのは content 側の normalizePresets の既存挙動。
      settle(safeCall(bridge.setSettings, bridge, { presets: readPresetInput() }));
    }

    function safeCall(fn, self, arg) {
      try { return fn.call(self, arg); } catch (e) { return null; }
    }

    function apply(v) {
      var next = clampVolume(v, state.boost);
      settle(safeCall(bridge.setVolume, bridge, next));
      // 応答を待たず即座に描き変える（体感の遅れを作らない）。
      // 正しい値は subscribe / update で上書きされる。
      state.volume = next;
      render();
    }

    // --- SPEC 10-a: 入力欄の編集状態 ---
    // 編集中は update(state) が入力欄の中身を上書きしない。守らないと、打っている
    // 最中に subscribe の更新が来て数字が消える（＝数値入力が実質使えない）。
    // フラグと activeElement の両方で判定するのは、activeElement を持たない環境でも
    // 成り立たせるため。
    var editing = false;

    function isEditing() {
      if (editing) { return true; }
      try { if (doc.activeElement === valueEl) { return true; } } catch (e) {}
      return false;
    }

    // 現在の状態が示す値。表示を「現在値へ戻す」ときの唯一の出どころ。
    function currentText() {
      return String(clampVolume(state.volume, true));
    }

    function revertInput() {
      try { valueEl.value = currentText(); } catch (e) {}
    }

    // Enter の確定。解釈できなければ **適用せず** 現在値へ戻す（SPEC 10-a）。
    function commitInput() {
      var parsed = parseVolumeInput(valueEl.value);
      if (parsed === null) { revertInput(); return false; }
      // クランプの本体は content 側にある（popup と同じ）。ここでの clamp は
      // 表示とスライダーの整合のためで、上限の真実ではない。
      apply(parsed);
      // 打った文字（"087"・"87%"・全角）を確定後の正規形に揃える。
      // これは利用者の操作に対する応答であって、update による上書きではない。
      revertInput();
      return true;
    }

    // focus / blur を持たない相手（試験用の偽 DOM・古い実装）でも例外にしない。
    // select は focus の後（フォーカスが無い要素の選択は環境により消えるため）。
    // 以後の update は isEditing() 保護で value を上書きしないので、全選択は壊れない。
    //
    // selectAll を引数にしたのは、**クリックで入り直したときに全選択してはいけない**
    // から（クリックはカーソル位置を指定する操作。全選択すると打ち直しになる）。
    // 全選択するのは「パネルを開いた瞬間の自動フォーカス」だけ（SPEC 10-a 追補）。
    function focusInput(selectAll) {
      try { if (isFn(valueEl.focus)) { valueEl.focus(); } } catch (e) {}
      if (selectAll !== true) { return; }
      try { if (isFn(valueEl.select)) { valueEl.select(); } } catch (e) {}
    }

    // 閉じるときはフォーカスを外す。blur の意味論は既存どおり
    // 「適用せず現在値へ戻す」（下の blur ハンドラがやる。ここでは呼ぶだけ）。
    function blurInput() {
      try { if (isFn(valueEl.blur)) { valueEl.blur(); } } catch (e) {}
    }

    on(valueEl, 'focus', function () { editing = true; });
    on(valueEl, 'blur', function () {
      // blur は適用しない（SPEC 10-a）。打ちかけの文字は捨てて現在値へ戻す。
      editing = false;
      revertInput();
    });

    // ★実機の不具合「数値が触れない」への層その2。
    // YouTube のコントロールバーは、ドラッグでのシークやテキスト選択を防ぐために
    // **mousedown で preventDefault()** する。**mousedown の既定動作はフォーカス移動
    // そのもの**なので、preventDefault されると入力欄をクリックしてもカーソルが入らない。
    // click / keydown を止めるだけでは届かない層である。
    // ここで明示的に focus() を呼ぶ。祖先が**キャプチャ段**で止めてくる場合は
    // 伝播を止める手（下の rootEl 側）が間に合わないが、明示の focus() は
    // 既定動作ではないので preventDefault では潰れない。
    // **自分では preventDefault しない**（すると自分でフォーカスとキャレット配置を殺す）。
    // select() は呼ばない。クリックはカーソル位置を決める操作で、全選択すると打ち直しになる。
    function focusOnPointer(ev) {
      if (state.available === false) { return; }
      try { if (ev && isFn(ev.stopPropagation)) { ev.stopPropagation(); } } catch (e) {}
      focusInput(false);
    }
    on(valueEl, 'pointerdown', focusOnPointer);
    on(valueEl, 'mousedown', focusOnPointer);

    on(valueEl, 'keydown', function (ev) {
      if (!ev) { return; }
      var k = ev.key;
      if (k === 'Enter') {
        try { ev.preventDefault(); } catch (e) {}
        commitInput();
      } else if (k === 'Escape' || k === 'Esc') {
        // Esc は下の rootEl の stopPropagation より先に、ここで自前に処理する
        // （target のリスナは祖先より先に走る）。
        try { ev.preventDefault(); } catch (e) {}
        revertInput();
      }
    });

    function setOpen(next) {
      next = !!next;
      if (next === open) { return; }
      open = next;
      panel.hidden = !open;
      // ⚙ の開閉はパネルを閉じたらリセットする（次に開いたときは操作の顔で始まる）。
      if (!open) { setSettingsOpen(false); }
      render(); // aria-expanded は render が両モードまとめて面倒を見る
      if (open) { refresh(); }
      else { blurInput(); }
    }

    // クリック＝固定（ピン留め）。もう一度クリックで解除して閉じる。
    // ホバーの無い環境（タッチ）では、この経路だけで従来どおり開閉できる。
    function onTriggerClick() {
      cancelClose();
      if (pinned) {
        pinned = false;
        setOpen(false);
        render();
        return;
      }
      pinned = true;
      setOpen(true);
      // SPEC 10-a 追補: 開いたら入力欄へ自動フォーカスして全選択する。
      // 「ボタンをクリック→数字を打つ→Enter」の3動作で完結し、かつボタンに
      // フォーカスが残ったままキーが YouTube へ抜ける穴（数字キー=シーク）を塞ぐ。
      // ホバーで開いた直後にクリックした場合（setOpen が何もしない）でも
      // フォーカスを取れるよう、setOpen の中ではなくここで呼ぶ。
      focusInput(true);
      render();
    }

    function anyHover() { return hoverBtn || hoverPanel; }

    // 打っている最中に消えるのは論外。入力欄（音量・プリセット）を編集中は閉じない。
    function isTypingAnywhere() {
      if (isEditing()) { return true; }
      if (presetEditing) { return true; }
      try { if (presetInput && doc.activeElement === presetInput) { return true; } } catch (e) {}
      return false;
    }

    function cancelClose() {
      if (closeTimer !== null) { cancelLater(closeTimer); closeTimer = null; }
    }

    function scheduleClose() {
      cancelClose();
      closeTimer = later(function () {
        closeTimer = null;
        if (destroyed) { return; }
        if (pinned || anyHover()) { return; }
        // 編集中は閉じずに、猶予を取り直す（打ち終えて blur したら次の回で閉じる）。
        if (isTypingAnywhere()) { scheduleClose(); return; }
        setOpen(false);
      }, CLOSE_GRACE_MS);
    }

    // タッチのポインタは「ホバー」ではない。enter/leave 両方で同じ判定をするので、
    // タッチ環境ではホバー経路が丸ごと効かず、クリックだけが残る。
    function isTouchPointer(ev) {
      try { return !!ev && ev.pointerType === 'touch'; } catch (e) { return false; }
    }

    function enterFn(which) {
      return function (ev) {
        if (isTouchPointer(ev)) { return; }
        if (which === 'btn') { hoverBtn = true; } else { hoverPanel = true; }
        cancelClose();
        setOpen(true);
      };
    }

    function leaveFn(which) {
      return function (ev) {
        if (isTouchPointer(ev)) { return; }
        if (which === 'btn') { hoverBtn = false; } else { hoverPanel = false; }
        if (pinned) { return; }
        if (!anyHover()) { scheduleClose(); }
      };
    }

    // ボタンとパネルの両方にホバーを張る。片方だけだと、ボタンからパネルへ
    // ポインタを移す途中で閉じてしまい、中の操作に手が届かない。
    // pointer 系と mouse 系の両方を見るのは、環境によってどちらかしか来ないため
    // （両方来ても hoverBtn/hoverPanel は真偽値なので二重計上にならない）。
    function bindHover(target, which) {
      if (!target) { return; }
      on(target, 'mouseenter', enterFn(which));
      on(target, 'pointerenter', enterFn(which));
      on(target, 'mouseleave', leaveFn(which));
      on(target, 'pointerleave', leaveFn(which));
    }

    bindHover(handle, 'btn');
    bindHover(nativeBtn, 'btn');
    bindHover(panel, 'panel');

    if (handle) { on(handle, 'click', onTriggerClick); }
    if (nativeBtn) {
      on(nativeBtn, 'click', onTriggerClick);
      // ネイティブボタンはプレーヤーの内側なので、クリックを下へ通さない。
      // ボタンは rootEl の外（コントロールバーの直下）に居るため、下の rootEl 側の
      // stopPropagation は掛からない。自分で同じ範囲を持つ。ここでも preventDefault
      // はしない（押した感触＝フォーカスや :active を自分で殺さない）。
      on(nativeBtn, 'pointerdown', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
      on(nativeBtn, 'mousedown', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
      on(nativeBtn, 'click', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
      on(nativeBtn, 'dblclick', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
      on(nativeBtn, 'wheel', function (ev) {
        if (!ev) { return; }
        var next = stepFromWheel(state.volume, ev.deltaY, !!ev.shiftKey, state.boost);
        if (next === null || next === undefined) { return; }
        try { ev.preventDefault(); } catch (e) {}
        try { ev.stopPropagation(); } catch (e) {}
        apply(next);
      }, { passive: false });
    }

    on(range, 'input', function () {
      apply(range.value);
    });

    // SPEC 第7章：ホイールの所有者はこの overlay ただ一人。
    // content.js は wheel リスナを持たないので、二重発火回避は不要。
    // 拾うのはルート要素（.ytvp-root）の上だけ。document では拾わない。
    on(rootEl, 'wheel', function (ev) {
      if (!ev) { return; }
      var next = stepFromWheel(state.volume, ev.deltaY, !!ev.shiftKey, state.boost);
      if (next === null || next === undefined) { return; } // 共有ロジック不在 → 何もしない
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e) {}
      apply(next);
    }, { passive: false });

    // クリックやキー入力をプレーヤーに伝えない（スペースで再生停止しない等）。
    // SPEC 10-a: YouTube は数字キー=シーク・k=停止・f=全画面をページ全体で拾うので、
    // 入力欄に「50」と打つと動画が 50% 位置へ飛ぶ。keydown だけ止めても keypress /
    // keyup を見ているハンドラには届くため、3 種とも止める。
    // 止めるのは **このパネルの中で起きたキーだけ**（document には何も足さない）。
    // Esc は上の valueEl の keydown ハンドラが先に処理してからここで止まる。
    //
    // ★実機の不具合「数値が触れない」への層その1。pointerdown / mousedown も止める。
    //   ① YouTube のコントロールバーは mousedown で preventDefault() するので、
    //      通してしまうと入力欄をクリックしてもフォーカスが入らない（＝数値が打てない）。
    //   ② パネル内でのドラッグ（テキスト選択・スライダー操作）が、コントロールバーの
    //      ドラッグ＝シークに化ける。
    // **preventDefault はしない**。ここで既定動作を潰すと、フォーカス移動もキャレット
    // 配置もスライダーのドラッグも自分で殺すことになる。止めるのは伝播だけ。
    // 範囲はこのパネル（と上のネイティブボタン）の中だけ。document には何も足さない
    // ので、純正の 🔊 スライダーや再生ボタンの操作は素通りする。
    on(rootEl, 'pointerdown', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
    on(rootEl, 'mousedown', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
    on(rootEl, 'click', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
    on(rootEl, 'keydown', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
    on(rootEl, 'keyup', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
    on(rootEl, 'keypress', function (ev) { try { ev.stopPropagation(); } catch (e) {} });
    on(rootEl, 'dblclick', function (ev) { try { ev.stopPropagation(); } catch (e) {} });

    // Esc で固定解除して閉じる。入力欄の中で押した場合は、上の valueEl の keydown が
    // 先に走って「適用せず現在値へ戻す」を済ませてから、ここで閉じる（target が先）。
    on(rootEl, 'keydown', function (ev) {
      if (!ev) { return; }
      if (ev.key === 'Escape' || ev.key === 'Esc') { unpinAndClose(); }
    });

    // パネル外クリックでも固定解除する。document に足す唯一のリスナで、
    // destroy で必ず外す。パネルとネイティブボタンの中のクリックは上の
    // stopPropagation でここまで来ないので、外側の操作だけを拾う。
    on(doc, 'click', function () {
      if (!open && !pinned) { return; }
      unpinAndClose();
    });

    function unpinAndClose() {
      pinned = false;
      hoverBtn = false;
      hoverPanel = false;
      cancelClose();
      setOpen(false);
      render();
    }

    function render() {
      if (destroyed) { return; }
      var v = clampVolume(state.volume, true);
      var boosted = v > MAX_PLAIN;
      // SPEC 10-a: 上書きを禁じるのは入力欄の value だけ。ハンドル・ネイティブ
      // ボタンの数値や pill のアクティブ表示は編集中も従来どおり更新する
      // （画面の他の場所が止まると、今どこに居るのか分からなくなる）。
      if (!isEditing()) {
        var text = String(v);
        if (String(valueEl.value) !== text) { valueEl.value = text; }
      }
      valueEl.disabled = state.available === false;
      if (handleVal) { handleVal.textContent = String(v); }
      if (nativeVal) { nativeVal.textContent = String(v); }
      if (range.value !== String(v)) { range.value = String(v); }
      range.max = String(state.boost ? MAX_BOOST : MAX_PLAIN);
      range.disabled = state.available === false;

      rootEl.className = 'ytvp-root' + posCls + ' ' +
        (open ? 'ytvp-is-open' : 'ytvp-is-collapsed') +
        (pinned ? ' ytvp-is-pinned' : '') +
        (boosted ? ' ytvp-is-boosted' : '') +
        (state.muted ? ' ytvp-is-muted' : '');
      var label = '音量 ' + v + '%' + (open ? '（閉じる）' : '（開く）');
      if (handle) {
        handle.setAttribute('aria-label', label);
        handle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      if (nativeBtn) {
        nativeBtn.setAttribute('aria-label', label);
        nativeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        // 色は装飾ではなく警告（SPEC 6）。100 超で amber に変える。
        nativeBtn.className = 'ytp-button ytvp-native-btn' +
          (boosted ? ' ytvp-native-btn--boost' : '') +
          (state.muted ? ' ytvp-native-btn--muted' : '');
        nativeBtn.title = '音量 ' + v + '%（クリックでパネル）';
      }

      stateEl.textContent = state.muted ? 'ミュート' : (boosted ? 'ブースト中' : '');
      note.hidden = state.available !== false;

      for (var i = 0; i < pills.length; i++) {
        var hit = pills[i].value === v;
        pills[i].node.setAttribute('aria-pressed', hit ? 'true' : 'false');
        pills[i].node.className = hit ? 'ytvp-pill ytvp-pill--on' : 'ytvp-pill';
      }
      // boostAllowed（= state.boost）は見た目と上限にだけ効かせる。押せるかには効かせない。
      boostBtn.setAttribute('aria-pressed', state.boost ? 'true' : 'false');
      boostBtn.className = state.boost ? 'ytvp-boost ytvp-boost--on' : 'ytvp-boost';
      boostVal.textContent = state.boost ? 'ON' : 'OFF';
      boostBtn.title = state.boost ? '上限 300%（押すと 100% に戻す）'
                                   : '上限 100%（押すと 300% まで許可）';
      boostBtn.disabled = state.available === false;
    }

    function update(next) {
      if (destroyed || !next || typeof next !== 'object') { return; }
      if ('volume' in next) { state.volume = clampVolume(next.volume, true); }
      if ('muted' in next) { state.muted = !!next.muted; }
      if ('boost' in next) { state.boost = !!next.boost; }
      if ('available' in next) { state.available = next.available !== false; }
      try { render(); } catch (e) {}
    }

    function refresh() {
      try {
        var p = bridge.getState();
        if (p && isFn(p.then)) { p.then(update, noop); }
        else if (p && typeof p === 'object') { update(p); }
      } catch (e) {}
    }

    function unlisten() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]); } catch (e) {}
      }
      listeners = [];
    }

    // 入れたものは全部取り除く。SPA 遷移で destroy → mount を繰り返しても増えない。
    function detach() {
      try { if (nativeBtn && nativeBtn.parentNode) { nativeBtn.parentNode.removeChild(nativeBtn); } } catch (e) {}
      try { if (rootEl.parentNode) { rootEl.parentNode.removeChild(rootEl); } } catch (e) {}
    }

    // 差し込みは subscribe より先に行う。順序を逆にすると、差し込みに失敗した
    // 実体が購読に残り、DOM に居ないまま描き続ける（SPEC 9-b の「黙って戻る」が守れない）。
    try {
      if (native) {
        // 先に位置決めの箱、次にボタン。結果は [ボタン, 箱, ...YouTube の既存ボタン]
        if (!insertFirst(host, rootEl)) { throw new Error('ytvp: insert root'); }
        if (!insertFirst(host, nativeBtn)) { throw new Error('ytvp: insert button'); }
      } else {
        host.appendChild(rootEl);
      }
    } catch (e) {
      destroyed = true;
      detach();
      unlisten();
      return null; // 呼び出し元が浮きハンドルで組み直す
    }

    // 差し込みが成功した後にだけヒントを「出した」ことにする。既読を立てるのは
    // content 側（保存は content.js の責務）。無ければ呼ばない。
    if (hintEl) {
      if (isFn(bridge.markHintShown)) { settle(safeCall(bridge.markHintShown, bridge, undefined)); }
      hintTimer = later(function () {
        hintTimer = null;
        hideHint();
      }, HINT_MS);
    }

    function hideHint() {
      if (!hintEl) { return; }
      try { hintEl.hidden = true; } catch (e) {}
      try { if (hintEl.parentNode) { hintEl.parentNode.removeChild(hintEl); } } catch (e) {}
      hintEl = null;
    }

    try {
      if (isFn(bridge.subscribe)) { bridge.subscribe(update); }
    } catch (e) {}

    render();
    refresh();

    function destroy() {
      if (destroyed) { return; }
      destroyed = true;
      // 走っている時計を止める。止めないと、取り外した後の DOM を触りに来る。
      cancelClose();
      cancelLater(hintTimer);
      hintTimer = null;
      // 取り外す要素にフォーカスを残さない（SPEC 10-a 追補）。unlisten の前に
      // 呼ぶので blur ハンドラも普通に走る（editing 解除・現在値へ戻す）。
      blurInput();
      unlisten();
      detach();
    }

    return { destroy: destroy, update: update };
  }

  root.YTVPOverlay = { mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);

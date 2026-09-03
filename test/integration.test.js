'use strict';
/*
 * popup ⇄ content の結合テスト（verify.sh 項目11）
 *
 * 実装は src/content.js と src/popup.js。このファイルは検査のみで、
 * 赤くても src / manifest.json をテストに合わせて直さない（直すのは実装のほう）。
 *
 * 検査するのは「誰の単体テストにも入らない継ぎ目」:
 *   seam1 … popup が投げる setSettings の payload 形状を content が受理するか
 *   seam2 … setSettings の応答が設定の全キーを返し、boostAllowed を落とさないか
 *   seam3 … manifest の判定側（content_scripts.matches）と注入側（host_permissions /
 *           web_accessible_resources.matches）が同じホスト集合か
 *   seam7 … ネイティブ統合（SPEC 第9章）。content.js が探した差し込み先を
 *           overlay.js が実際に使い、失敗時は黙って浮きハンドルへ戻るか
 * 加えて SPEC 3-b の表の全行を実物同士で往復させる。
 *
 * この検査が空振りでないことは tools/tests/run_scanner_regress.sh が
 * 「継ぎ目を壊した検体では赤くなる」ことで実測している。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, createOverlayHarness, deepText, findByClass } = require('./helpers/wiring.js');

// 既定はリポジトリ直下の manifest.json。YTVP_MANIFEST_PATH は回帰専用の差し替え口。
const MANIFEST_PATH = process.env.YTVP_MANIFEST_PATH
  ? path.resolve(process.env.YTVP_MANIFEST_PATH)
  : path.join(__dirname, '..', 'manifest.json');

const STATE_KEYS = ['volume', 'muted', 'boost', 'available'];
const SETTING_KEYS = ['presets', 'boostAllowed'];

/*
 * popup から setSettings を投げさせる唯一の経路（⚙ の中のプリセット編集欄）。
 *
 * v0.7 でポップアップは自前のフォームを捨て、プレイヤー内パネルと同じ overlay が
 * 描く欄（.ytvp-preset-input ＋ .ytvp-preset-apply）を使うようになった。
 * 「値を入れて適用を押す」という利用者の操作そのものをなぞる。
 */
function submitPresets(h, text) {
  const field = h.popup.ui.presetInput();
  const apply = h.popup.ui.presetApply();
  assert.ok(field, 'popup に .ytvp-preset-input が無い（⚙ の編集欄が描かれていない）');
  assert.ok(apply, 'popup に .ytvp-preset-apply が無い（「適用」が描かれていない）');
  field.value = text;
  h.clickEl(apply);
}

function assertStateShape(res, label) {
  assert.ok(res && typeof res === 'object', label + ': 応答がオブジェクトでない: ' + JSON.stringify(res));
  assert.strictEqual(res.ok, true, label + ': ok が true でない: ' + JSON.stringify(res));
  assert.ok(res.state && typeof res.state === 'object', label + ': state が無い: ' + JSON.stringify(res));
  for (const k of STATE_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(res.state, k),
      label + ': state.' + k + ' が無い: ' + JSON.stringify(res.state));
  }
  assert.strictEqual(typeof res.state.volume, 'number', label + ': state.volume が数値でない');
  assert.strictEqual(typeof res.state.muted, 'boolean', label + ': state.muted が真偽値でない');
  assert.strictEqual(typeof res.state.boost, 'boolean', label + ': state.boost が真偽値でない');
  assert.strictEqual(typeof res.state.available, 'boolean', label + ': state.available が真偽値でない');
}

/* ------------------------------------------------------------------ 起動 */

test('seam0-boot: content が起動し、実物の popup が online になる', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    h.loadPopup();
    await h.waitFor(() => h.popup.doc.body.classList.contains('is-offline') === false,
      'popup が online になる');
    assert.strictEqual(h.popup.ui.msg().hidden, true, 'online なのにメッセージが出ている');
    // v0.7: 大きな数値は「読むだけの div」ではなく入力欄（SPEC 10-a）。値は value に出る。
    assert.ok(h.popup.ui.panel(), 'popup にパネル（.ytvp-panel）が載っていない');
    assert.strictEqual(String(h.popup.ui.value().value), '40', '現在値が描かれていない');
    // popup が最初に投げるのは get（SPEC 3-b）
    assert.ok(h.messages.length > 0, 'popup が1通も投げていない');
    assert.strictEqual(h.messages[0].msg.type, 'get');
  } finally { h.dispose(); }
});

/* --------------------------------------------- SPEC 3-b の表の全行を往復 */

test('roundtrip-get: {type:get} が {ok:true,state:{volume,muted,boost,available}}', async () => {
  const h = createHarness({ storage: {}, player: { volume: 33, muted: true } });
  try {
    await h.ready();
    const res = await h.request({ type: 'get' });
    assertStateShape(res, 'get');
    assert.strictEqual(res.state.volume, 33);
    assert.strictEqual(res.state.muted, true);
  } finally { h.dispose(); }
});

test('roundtrip-set: {type:set,volume:87} が state.volume===87 を返す', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    const res = await h.request({ type: 'set', volume: 87 });
    assertStateShape(res, 'set');
    assert.strictEqual(res.state.volume, 87);
    assert.strictEqual(h.player.state.volume, 87, 'MAIN world 側に反映されていない');
  } finally { h.dispose(); }
});

test('roundtrip-set-invalid: {type:set,volume:"abc"} が {ok:false,error:invalid-volume}', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    const res = await h.request({ type: 'set', volume: 'abc' });
    assert.deepStrictEqual(res, { ok: false, error: 'invalid-volume' });
  } finally { h.dispose(); }
});

test('roundtrip-setboost: {type:setBoost,enabled:true} が {ok:true,state:{...}}', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    const res = await h.request({ type: 'setBoost', enabled: true });
    assertStateShape(res, 'setBoost');
    assert.strictEqual(res.state.boost, true);
    assert.strictEqual(h.player.state.boost, true, 'MAIN world 側がブーストになっていない');
  } finally { h.dispose(); }
});

test('roundtrip-getsettings: storage 空なら boostAllowed===false（SPEC 3-c(1)）', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    const res = await h.request({ type: 'getSettings' });
    assert.strictEqual(res.ok, true, 'getSettings の ok が true でない: ' + JSON.stringify(res));
    assert.ok(res.settings && typeof res.settings === 'object', 'settings が無い: ' + JSON.stringify(res));
    for (const k of SETTING_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(res.settings, k),
        'getSettings の応答に ' + k + ' が無い（部分オブジェクトを返している）: ' + JSON.stringify(res.settings));
    }
    assert.strictEqual(res.settings.boostAllowed, false, 'ブースト既定 OFF が守られていない');
    assert.ok(Array.isArray(res.settings.presets), 'presets が配列でない');
  } finally { h.dispose(); }
});

test('roundtrip-set-over: storage 空で {type:set,volume:150} は 100 に収まる（ブースト既定 OFF）', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    const res = await h.request({ type: 'set', volume: 150 });
    assertStateShape(res, 'set 150');
    assert.strictEqual(res.state.volume, 100, 'ブースト未許可なのに 100 を超えた');
  } finally { h.dispose(); }
});

test('roundtrip-unknown: 未知の type にも応答を返す（popup を待たせない）', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    const res = await h.request({ type: 'no-such-type' });
    assert.ok(res && res.ok === false, '未知の type に応答がない: ' + JSON.stringify(res));
  } finally { h.dispose(); }
});

test('roundtrip-returns-true: 全要求でリスナの戻り値が true（MV3 のポートを閉じない）', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    const msgs = [
      { type: 'get' },
      { type: 'set', volume: 50 },
      { type: 'set', volume: 'abc' },
      { type: 'setBoost', enabled: true },
      { type: 'getSettings' },
      { type: 'setSettings', settings: { presets: [10, 20] } },
      { type: 'no-such-type' }
    ];
    for (const m of msgs) { await h.request(m); }
    assert.strictEqual(h.messages.length, msgs.length);
    for (const rec of h.messages) {
      assert.ok(rec.returns.length > 0,
        'リスナが1つも登録されていない: ' + JSON.stringify(rec.msg));
      for (const r of rec.returns) {
        assert.strictEqual(r, true,
          'リスナの戻り値が true でない（非同期応答の前にポートが閉じる）: '
          + JSON.stringify(rec.msg) + ' -> ' + String(r));
      }
    }
  } finally { h.dispose(); }
});

/* ------------------------------------------------------------ 継ぎ目 1 */

test('seam1: popup が投げる setSettings を content が受理する（invalid-settings を返さない）', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();
    h.loadPopup();
    await h.waitFor(() => h.popup.doc.body.classList.contains('is-offline') === false, 'popup が online');
    await h.waitFor(() => h.lastMessage('getSettings') !== null, 'popup が getSettings を投げる');

    submitPresets(h, '10 20');   // プリセットの編集 = popup が setSettings を投げる唯一の経路
    const rec = await h.waitFor(() => h.lastMessage('setSettings'), 'popup が setSettings を投げる')
      .then(() => h.lastMessage('setSettings'));
    await h.waitFor(() => rec.delivered, 'setSettings の応答が popup に戻る');

    assert.ok(rec.reply && typeof rec.reply === 'object',
      'setSettings に応答が無い: ' + JSON.stringify(rec.msg));
    assert.notStrictEqual(rec.reply.error, 'invalid-settings',
      'content が popup の setSettings を弾いた（payload 形状の不一致）: 送った物=' + JSON.stringify(rec.msg));
    assert.strictEqual(rec.reply.ok, true, 'setSettings の ok が true でない: ' + JSON.stringify(rec.reply));

    // 形状そのものも押さえる（content 側の受理条件は settings がオブジェクトであること）
    assert.ok(rec.msg.settings && typeof rec.msg.settings === 'object' && !Array.isArray(rec.msg.settings),
      'popup が settings キー無しの平置きで投げている: ' + JSON.stringify(rec.msg));
    assert.deepStrictEqual(rec.msg.settings.presets, [10, 20],
      'popup が presets を settings の中に入れていない: ' + JSON.stringify(rec.msg));
  } finally { h.dispose(); }
});

/* ------------------------------------------------------------ 継ぎ目 2 */

test('seam2: setSettings の応答が設定の全キーを返し、boostAllowed を保つ', async () => {
  const h = createHarness({ storage: { boostAllowed: true, presets: [10, 20] } });
  try {
    await h.ready();
    const before = await h.request({ type: 'getSettings' });
    for (const k of SETTING_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(before.settings, k),
        'getSettings の応答に ' + k + ' が無い（部分オブジェクトを返している）: ' + JSON.stringify(before.settings));
    }
    assert.strictEqual(before.settings.boostAllowed, true, '前提: storage の boostAllowed が読めていない');

    const res = await h.request({ type: 'setSettings', settings: { presets: [30, 40] } });
    assert.strictEqual(res.ok, true, 'setSettings の ok が true でない: ' + JSON.stringify(res));
    assert.ok(res.settings && typeof res.settings === 'object', 'settings が無い: ' + JSON.stringify(res));
    for (const k of SETTING_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(res.settings, k),
        'setSettings の応答に ' + k + ' が無い（部分オブジェクトを返している）: ' + JSON.stringify(res.settings));
    }
    assert.deepStrictEqual(res.settings.presets, [30, 40], 'presets が反映されていない');
    assert.strictEqual(res.settings.boostAllowed, true,
      'presets だけを変えたのに boostAllowed が落ちた: ' + JSON.stringify(res.settings));
  } finally { h.dispose(); }
});

test('seam2e2e: プリセットの適用後もポップアップの上限が 300 のまま', async () => {
  const h = createHarness({ storage: { boostAllowed: true }, player: { volume: 120 } });
  try {
    await h.ready();
    h.loadPopup();
    // v0.7: 上限の真実はスライダーの max（数値欄は自由入力で、丸めは content 側が持つ）。
    const limit = () => String(h.popup.ui.range().max);
    await h.waitFor(() => h.popup.doc.body.classList.contains('is-offline') === false, 'popup が online');
    await h.waitFor(() => limit() === '300', 'ブースト許可が popup に届いて上限が 300 になる');

    submitPresets(h, '10 20');
    const rec = await h.waitFor(() => h.lastMessage('setSettings'), 'popup が setSettings を投げる')
      .then(() => h.lastMessage('setSettings'));
    await h.waitFor(() => rec.delivered, 'setSettings の応答が popup に戻る');
    await h.settle(5);

    assert.strictEqual(limit(), '300',
      '適用の応答でブースト許可が消え、上限が ' + limit() + ' に落ちた（応答が部分オブジェクト）');
    assert.deepStrictEqual(h.popup.ui.pills().map(deepText), ['10', '20'],
      '応答の presets が pill に反映されていない: ' + JSON.stringify(h.popup.ui.pills().map(deepText)));
    assert.strictEqual(String(h.popup.ui.presetInput().value), '10 20',
      '応答の presets が編集欄に反映されていない: ' + h.popup.ui.presetInput().value);
  } finally { h.dispose(); }
});

/* ------------------------------------------------------------ 継ぎ目 3 */

test('seam3: manifest の content_scripts.matches / host_permissions / web_accessible_resources.matches が同一ホスト集合', () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const norm = (list) => Array.from(new Set(list || [])).sort();

  const hosts = norm(m.host_permissions);
  assert.ok(hosts.length > 0, 'host_permissions が空');

  const cs = m.content_scripts || [];
  assert.ok(cs.length > 0, 'content_scripts が無い');
  for (let i = 0; i < cs.length; i++) {
    assert.deepStrictEqual(norm(cs[i].matches), hosts,
      'content_scripts[' + i + '].matches が host_permissions と違う（判定側と権限側のズレ）: '
      + JSON.stringify(norm(cs[i].matches)) + ' vs ' + JSON.stringify(hosts));
  }

  const war = m.web_accessible_resources || [];
  assert.ok(war.length > 0, 'web_accessible_resources が無い（src/page.js を注入できない）');
  for (let i = 0; i < war.length; i++) {
    assert.deepStrictEqual(norm(war[i].matches), hosts,
      'web_accessible_resources[' + i + '].matches が host_permissions と違う（注入側と権限側のズレ）: '
      + JSON.stringify(norm(war[i].matches)) + ' vs ' + JSON.stringify(hosts));
  }
});

test('seam3-popup: popup のホスト判定が manifest の host_permissions と同じ集合', async () => {
  // popup.js は tab.url が YouTube かを自分で判定する（SPEC 3-c(2)）。
  // 判定が権限より広い / 狭いと、片方のホストで無言のタイムアウトになる。
  const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const hosts = (m.host_permissions || []).map((p) => p.replace(/^\*:\/\//, '').replace(/\/\*$/, ''));
  assert.ok(hosts.length > 0, 'host_permissions が空');

  for (const host of hosts) {
    const h = createHarness({ storage: {} });
    try {
      await h.ready();
      h.loadPopup({ tabs: [{ id: h.TAB_ID, url: 'https://' + host + '/watch?v=x', active: true }] });
      await h.waitFor(() => h.popup.doc.body.classList.contains('is-offline') === false,
        host + ' で popup が online にならない（許可ホストなのに話しかけない）');
    } finally { h.dispose(); }
  }

  // 権限の外は必ず offline（判定が権限より広いのは、権限を売りにする拡張として矛盾する）
  for (const url of ['https://m.youtube.com/watch?v=x',
                     'https://youtube.com/watch?v=x',
                     'https://www.youtube.com.attacker.test/watch?v=x',
                     'https://example.com/']) {
    const h = createHarness({ storage: {} });
    try {
      await h.ready();
      h.loadPopup({ tabs: [{ id: h.TAB_ID, url: url, active: true }] });
      await h.settle(10);
      assert.strictEqual(h.popup.doc.body.classList.contains('is-offline'), true,
        '権限外のホストに話しかけている: ' + url);
    } finally { h.dispose(); }
  }
});

/* ------------------------------------------------------------ 継ぎ目 4 */
/*
 * SPEC 3-d（ブーストは1つの概念）。
 *
 * 由来: 実測で見つかった本物の製品バグ。
 *   「ブーストを一度 OFF にすると二度と ON に戻せない」一方通行。
 *   原因は boost（今の状態）と boostAllowed（許可）を別概念として扱い、
 *   ポップアップが boostAllowed の値で自分自身のトグルを disabled にしていたこと。
 *   自分の値で自分を押せなくする作りは、必ず一方通行を生む。
 *
 * ここが赤いあいだは実装が SPEC 3-d に追いついていない。
 * このファイルは検査であって、赤いからといって src を直さない。
 */

// ポップアップを開いて「get → getSettings の応答まで受け取った」状態にする。
// 設定が届く前に見ると、既定値を見て緑になる（何も検査していない）事故が起きる。
async function openPopup(h, popupOpts) {
  const from = h.messages.length;
  const p = h.loadPopup(popupOpts);
  await h.waitFor(() => p.doc.body.classList.contains('is-offline') === false,
    'popup が online になる');
  await h.waitFor(
    () => h.messages.slice(from).some((r) => r.msg && r.msg.type === 'getSettings' && r.delivered),
    'popup が getSettings の応答を受け取る');
  await h.settle(3);
  return p;
}

/*
 * ポップアップが表示している「ブーストの値」。楽観更新の検知はここの差分で行う。
 *
 * 見るのはブーストの表示（ON/OFF・aria-pressed・入力欄の上限）に限る。
 * 疎通に失敗したときにオフライン表示へ落ちること（現在値が '--' になる等）は
 * 楽観更新ではなく、SPEC 3-d が唯一許した無効化（オフライン）なので差分に含めない。
 * ここを広げると「失敗したら黙るのも禁止」という SPEC に無い制約になる。
 * 狭めたぶん空振りしていないことは、楽観更新を仕込んだ検体
 * （test/fixtures/integration/patch_popup_optimistic_boost.js）で実測する。
 */
function boostView(p) {
  const b = p.ui.boostBtn();
  const v = p.ui.boostVal();
  const r = p.ui.range();
  return {
    boostVal: v ? deepText(v) : null,
    boostPressed: b ? b.getAttribute('aria-pressed') : null,
    max: r ? String(r.max) : null
  };
}

// 失敗時の診断用（assert には使わない）
function popupView(p) {
  const val = p.ui.value();
  return Object.assign(boostView(p), {
    value: val ? String(val.value) : null,
    offline: p.doc.body.classList.contains('is-offline')
  });
}

test('seam4-boost-roundtrip: setBoost が true→false→true と往復し、state.boost と boostAllowed が常に一致する', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();

    const first = await h.request({ type: 'getSettings' });
    assert.strictEqual(first.settings.boostAllowed, false,
      '前提が崩れている: boostAllowed の既定は false（SPEC 3-c(1)）');

    const steps = [true, false, true];
    for (let i = 0; i < steps.length; i++) {
      const want = steps[i];
      const label = 'setBoost 第' + (i + 1) + '段（enabled=' + want + '）';

      const res = await h.request({ type: 'setBoost', enabled: want });
      assertStateShape(res, label);
      assert.strictEqual(res.state.boost, want,
        label + ': 応答の state.boost が ' + want + ' でない: ' + JSON.stringify(res.state));

      const st = await h.request({ type: 'getSettings' });
      assert.strictEqual(st.settings.boostAllowed, want,
        label + ': settings.boostAllowed が ' + want + ' でない（setBoost が片道になっている。SPEC 3-d）: '
        + JSON.stringify(st.settings));
      assert.strictEqual(res.state.boost, st.settings.boostAllowed,
        label + ': state.boost と settings.boostAllowed が食い違う（両者は同一の概念。SPEC 3-d）');

      const got = await h.request({ type: 'get' });
      assert.strictEqual(got.state.boost, want,
        label + ': 直後の get が ' + want + ' を返さない: ' + JSON.stringify(got.state));
    }

    // 3回目（false のあとの true）を明示的に押さえる。ここが一方通行バグの現場。
    const back = await h.request({ type: 'setBoost', enabled: true });
    const backSettings = await h.request({ type: 'getSettings' });
    assert.strictEqual(back.state.boost, true,
      'OFF のあと ON に戻せない（一方通行。SPEC 3-d）: ' + JSON.stringify(back.state));
    assert.strictEqual(backSettings.settings.boostAllowed, true,
      'OFF のあと boostAllowed を true に戻せない（一方通行。SPEC 3-d）: ' + JSON.stringify(backSettings.settings));
  } finally { h.dispose(); }
});

test('seam4-popup-not-oneway: boostAllowed:false で開き直してもブーストトグルが disabled にならず、ON に戻せる', async () => {
  const h = createHarness({ storage: {} });
  try {
    await h.ready();

    // 1回目：既定（boostAllowed:false）で開く
    const p1 = await openPopup(h);
    assert.ok(p1.ui.boostBtn(), 'boostAllowed:false でブーストトグルを生成すらしていない（SPEC 5）');
    assert.strictEqual(deepText(p1.ui.boostVal()), 'OFF', '前提: 既定は OFF 表示');
    assert.strictEqual(p1.ui.boostBtn().disabled, false,
      'boostAllowed:false でブーストトグルが disabled（自分の値で自分を押せなくしている。SPEC 3-d）');

    // 2回目：開き直す（新インスタンスが getSettings で boostAllowed:false を受ける流れ）
    const p2 = await openPopup(h);
    assert.notStrictEqual(p2, p1, '前提: ポップアップを開き直せていない');
    assert.strictEqual(p2.doc.body.classList.contains('is-offline'), false, '前提: 2回目が online');
    assert.ok(p2.ui.boostBtn(), '開き直したポップアップにブーストトグルが無い（SPEC 5）');
    assert.strictEqual(p2.ui.boostBtn().disabled, false,
      '開き直したポップアップで boostAllowed:false のトグルが disabled（二度と ON に戻せない。SPEC 3-d）');

    // disabled でないだけでは足りない。押して本当に ON に戻せることまで見る
    // （早期 return で黙って何もしない実装も一方通行である）。
    const from = h.messages.length;
    h.clickEl(p2.ui.boostBtn());
    await h.waitFor(
      () => h.messages.slice(from).some((r) => r.msg && r.msg.type === 'setBoost' && r.delivered),
      'トグルを押しても setBoost が飛ばない（トグルが死んでいる。SPEC 3-d）');
    await h.settle(3);

    const sent = h.messages.slice(from).filter((r) => r.msg && r.msg.type === 'setBoost').pop();
    assert.strictEqual(sent.msg.enabled, true,
      'OFF のトグルを押したのに enabled:true を送っていない: ' + JSON.stringify(sent.msg));
    const after = await h.request({ type: 'getSettings' });
    assert.strictEqual(after.settings.boostAllowed, true,
      'トグルを押しても boostAllowed が true に戻らない（一方通行。SPEC 3-d）: ' + JSON.stringify(after.settings));
    assert.strictEqual(deepText(p2.ui.boostVal()), 'ON',
      'ブーストが ON になったのにポップアップの表示が OFF のまま');
  } finally { h.dispose(); }
});

test('seam4-no-optimistic: setBoost が {ok:false} / 無応答のとき、ポップアップの表示を変えない', async () => {
  // 応答の形だけを差し替える。content には届かないので、真の状態は ON のまま。
  // 1回失敗するとポップアップはオフラインへ落ちる（SPEC 3-d が唯一許した無効化）ので、
  // ケースごとに開き直す。1つのポップアップで続けて押すと2件目が飛ばず、
  // 「押していないから表示も変わらない」という空振りの緑になる。
  //
  // ★観測の位置（v0.7 で変えた。緩めたのではなく、観測点を前へ動かした）
  //   v0.7 のオフラインは「パネルごと畳む」（popup.js の goOffline が destroy を呼ぶ）。
  //   決着後に見ると、正しい実装でも楽観更新の実装でも **どちらもパネルが消えて**
  //   同じ姿になり、差分が取れない＝何も検査していないことになる。
  //   楽観更新とは「応答が返る前に表示を変えること」なので、**クリックの直後・
  //   応答が処理される前**（dispatchEvent から戻った同期の時点）を見るのが本筋である。
  //   この時点では実物は何も変えておらず、楽観更新の実装だけが既に反転している。
  const cases = [
    { label: '{ok:false} が返る', verdict: { reply: { ok: false, error: 'boom' } } },
    { label: '応答が返らない', verdict: { reply: undefined } }
  ];
  for (const c of cases) {
    const h = createHarness({ storage: { boostAllowed: true } });
    try {
      await h.ready();
      const p = await openPopup(h);
      assert.strictEqual(deepText(p.ui.boostVal()), 'ON',
        c.label + ' 前提: boostAllowed:true なら ON 表示（SPEC 3-d: state.boost は boostAllowed を反映する）');
      assert.strictEqual(p.ui.boostBtn().disabled, false, c.label + ' 前提: トグルが押せる');

      const before = boostView(p);
      const beforeFull = popupView(p);
      h.setIntercept((msg) => (msg && msg.type === 'setBoost') ? c.verdict : null);
      const from = h.messages.length;
      h.clickEl(p.ui.boostBtn());

      // 押した直後（＝ content の応答をまだ1つも処理していない時点）の表示。
      const justAfter = boostView(p);
      assert.ok(h.messages.length > from,
        c.label + ' 前提: トグルを押しても要求が1通も出ていない（押せていない）');
      assert.deepStrictEqual(justAfter, before,
        c.label + ': content が確認していない値をポップアップが表示した（楽観更新）。before='
        + JSON.stringify(beforeFull) + ' after=' + JSON.stringify(popupView(p)));

      // 決着まで進める。失敗を実際に受け取ったことを、オフラインへ落ちた事実で確かめる
      // （落ちなければ「応答を処理していないから表示も変わらなかった」の空振りである）。
      await h.waitFor(
        () => h.messages.slice(from).some((r) => r.msg && r.msg.type === 'setBoost' && r.delivered),
        c.label + ': setBoost の決着（トグルが押せていない可能性）');
      await h.settle(5);
      h.setIntercept(null);
      assert.strictEqual(p.doc.body.classList.contains('is-offline'), true,
        c.label + ': 疎通に失敗したのにオフラインへ落ちていない（応答を処理していない）');

      // 真の状態も動いていないこと（content には届いていないのだから当然）
      const truth = await h.request({ type: 'getSettings' });
      assert.strictEqual(truth.settings.boostAllowed, true,
        c.label + ': content 側の boostAllowed が動いた: ' + JSON.stringify(truth.settings));
    } finally { h.dispose(); }
  }
});


/* ------------------------------------------------------------ 継ぎ目 5 */
/*
 * SPEC 3-d / SPEC 5（オーバーレイ側のブースト）。
 *
 * 由来: 65b4ccf で直した本物の製品バグ。
 *   src/overlay.js は `if (boostAllowed) { boostBtn = ... }` で、boostAllowed:false の
 *   ときブーストボタンを **生成すらしていなかった**。ポップアップ側（seam4）と同型の
 *   一方通行で、オーバーレイからは一度 OFF にすると ON へ戻す手段が消えていた。
 *
 * 当時の配線台はオーバーレイを mount しないため、この修正を守るものが
 * 1つも無かった。ここがその穴を塞ぐ検査。
 *
 * SPEC 5: 「boostAllowed はボタンを出すか出さないかの判定に使ってはならない。
 *          ブーストボタンは常に生成する。」
 * SPEC 3-d: 無効化してよいのはオフラインのときだけ。
 * SPEC 3-e: オーバーレイのオフライン ＝ state.available === false。
 */

// SPEC 6: オーバーレイは既定で折りたたみ。観測の前にハンドルで開く。
async function openOverlay(ov, mountOptions) {
  ov.mount(mountOptions);
  await ov.settle();
  ov.open();
  await ov.settle();
  return ov.boostBtn();
}

test('seam5-overlay-boost-rendered: boostAllowed:false でも ブーストボタンが存在し disabled でない', async () => {
  const ov = createOverlayHarness({ state: { volume: 40, boost: false } });
  try {
    const btn = await openOverlay(ov, { boostAllowed: false });
    assert.ok(btn,
      'boostAllowed:false でブーストボタンが DOM に無い（生成をやめている。SPEC 5）: '
      + JSON.stringify(ov.boostView()));
    assert.strictEqual(btn.disabled, false,
      'boostAllowed:false でブーストボタンが disabled（自分の値で自分を押せなくしている。SPEC 3-d）');
    assert.strictEqual(btn.hidden !== true, true,
      'boostAllowed:false でブーストボタンが非表示（SPEC 3-d は非表示も禁じている）');
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', '初期表示が OFF になっていない');
    assert.ok(/OFF/.test(ov.boostView().text),
      'ブーストの ON/OFF が文字で出ていない: ' + JSON.stringify(ov.boostView()));
  } finally { ov.dispose(); }
});

/*
 * v0.8（見た目を YouTube に寄せる改修）で、ブーストは「ブースト OFF」という文字ボタンを
 * やめ、YouTube の設定メニューと同じ **ラベル左・トグル右の行**になった。
 *
 * 見た目そのものは機械では検査できない（偽 DOM に CSS は効かない）。ここで固定するのは
 * **構造**だけ:
 *   ① 行の中にラベルとトグル（つまみを持つ器）があり、トグルはラベルより後ろ＝右にある
 *   ② 作り替えても SPEC 3-d の契約は変わらない（boostAllowed:false で disabled にしない）
 * ②を同じ検査で見るのは、見た目を作り替えるときに一番壊れやすいのが「押せるかどうか」
 * だからである（一方通行の再発は、この製品で二度起きている）。
 */
test('seam5-overlay-boost-toggle: ブーストは「ラベル左・トグル右」の行で、boostAllowed:false でも押せる', async () => {
  const ov = createOverlayHarness({ state: { volume: 40, boost: false } });
  try {
    const btn = await openOverlay(ov, { boostAllowed: false });
    assert.ok(btn, '前提: ブーストの行がある');

    const cls = (n) => String(n.className || '').split(/\s+/)[0] || ('<' + n.tagName + '>');
    const kids = (btn.childNodes || []).map(cls);
    const iLabel = kids.indexOf('ytvp-boost__label');
    const iSwitch = kids.indexOf('ytvp-boost__switch');
    assert.ok(iLabel >= 0, 'ブーストの行にラベルが無い: ' + JSON.stringify(kids));
    assert.ok(iSwitch >= 0,
      'ブーストがトグルスイッチになっていない（文字ボタンのまま）: ' + JSON.stringify(kids));
    assert.ok(iSwitch > iLabel,
      'トグルがラベルより前にある（ラベル左・トグル右になっていない）: ' + JSON.stringify(kids));

    const sw = findByClass(ov.doc.body, 'ytvp-boost__switch')[0];
    const inSwitch = ((sw && sw.childNodes) || []).map(cls);
    assert.ok(inSwitch.indexOf('ytvp-boost__thumb') >= 0,
      'トグルにつまみ（白い丸）が無い: ' + JSON.stringify(inSwitch));

    // ここから下は SPEC 3-d。見た目を変えても契約は動かない。
    assert.strictEqual(btn.disabled, false,
      'boostAllowed:false でトグルが disabled（自分の値で自分を押せなくしている。SPEC 3-d）');
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'false',
      'トグルの状態が aria-pressed に出ていない（読み上げでは位置が見えない）');
    assert.ok(/OFF/.test(ov.boostView().text),
      'ON/OFF が文字として残っていない（つまみの位置だけに頼っている）: '
      + JSON.stringify(ov.boostView()));

    ov.click(btn);
    await ov.settle();
    assert.ok(ov.lastCall('setBoost'), 'トグルを押しても bridge.setBoost が飛ばない');
  } finally { ov.dispose(); }
});

test('seam5-overlay-boost-click: boostAllowed:false のボタンを押すと bridge.setBoost(true) が飛ぶ', async () => {
  const ov = createOverlayHarness({ state: { volume: 40, boost: false } });
  try {
    const btn = await openOverlay(ov, { boostAllowed: false });
    assert.ok(btn, '前提: ブーストボタンが存在する');
    assert.strictEqual(ov.countCalls('setBoost'), 0, '前提: まだ setBoost を投げていない');

    ov.click(btn);
    await ov.settle();

    const call = ov.lastCall('setBoost');
    assert.ok(call, 'ボタンを押しても bridge.setBoost が呼ばれない（ボタンが死んでいる。SPEC 3-d）');
    assert.strictEqual(call.arg, true,
      'OFF のボタンを押したのに setBoost(true) を投げていない: ' + JSON.stringify(call));
    assert.strictEqual(ov.truth.boost, true, 'bridge 側の真実が ON になっていない');
    assert.strictEqual(ov.boostView().pressed, 'true',
      'content が ON を返したのに表示が OFF のまま: ' + JSON.stringify(ov.boostView()));
    assert.strictEqual(ov.boostView().rangeMax, '300', 'ON になったのに上限が 300 へ上がっていない');
  } finally { ov.dispose(); }
});

test('seam5-overlay-not-oneway: destroy → mount を往復しても boostAllowed:false のボタンが押せる', async () => {
  // ★ 一方通行の判定点。
  // mount(false) → click → ON → destroy → mount(true) → click → OFF → destroy →
  // mount(false) でボタンが消えていたら、そこから先 ON へ戻る道は無い。
  const ov = createOverlayHarness({ state: { volume: 40, boost: false } });
  try {
    // 1周目: OFF で mount して ON にする
    const b1 = await openOverlay(ov, { boostAllowed: false });
    assert.ok(b1, '1周目: boostAllowed:false でボタンが無い（SPEC 5）');
    ov.click(b1);
    await ov.settle();
    assert.strictEqual(ov.lastCall('setBoost').arg, true, '1周目: setBoost(true) が飛んでいない');
    assert.strictEqual(ov.truth.boost, true, '1周目: ON にできていない');
    ov.destroy();
    await ov.settle();
    assert.strictEqual(ov.boostBtn(), null, '1周目: destroy したのに DOM が残っている');

    // 2周目: 真実（ON）で mount し直して OFF に戻す
    const b2 = await openOverlay(ov, { boostAllowed: true });
    assert.ok(b2, '2周目: boostAllowed:true でボタンが無い');
    assert.strictEqual(b2.disabled, false, '2周目: ボタンが disabled');
    assert.strictEqual(b2.getAttribute('aria-pressed'), 'true', '2周目: ON で開いたのに表示が OFF');
    ov.click(b2);
    await ov.settle();
    assert.strictEqual(ov.lastCall('setBoost').arg, false, '2周目: setBoost(false) が飛んでいない');
    assert.strictEqual(ov.truth.boost, false, '2周目: OFF に戻せていない');
    ov.destroy();
    await ov.settle();

    // 3周目: OFF になった真実で mount し直す。ここでボタンが消えるのが「一方通行」。
    const b3 = await openOverlay(ov, { boostAllowed: false });
    assert.ok(b3,
      'OFF にしたあと開き直すとブーストボタンが消える（二度と ON に戻せない一方通行。SPEC 3-d/5）');
    assert.strictEqual(b3.disabled, false,
      'OFF にしたあと開き直すとブーストボタンが disabled（一方通行。SPEC 3-d）');
    ov.click(b3);
    await ov.settle();
    assert.strictEqual(ov.lastCall('setBoost').arg, true,
      '開き直したボタンを押しても setBoost(true) が飛ばない（押せない＝一方通行。SPEC 3-d）');
    assert.strictEqual(ov.truth.boost, true, '3周目: ON に戻せていない');
    assert.strictEqual(ov.boostView().pressed, 'true', '3周目: ON になったのに表示が OFF のまま');
  } finally { ov.dispose(); }
});

test('seam5-overlay-no-optimistic: bridge.setBoost が失敗したらブーストの表示を変えない', async () => {
  // SPEC 3-e(2): ブーストのトグルは楽観更新しない。
  // content が受理していないのに見た目だけ ON になる状態を作らない。
  const cases = [
    { label: 'setBoost が reject する', mode: 'reject' },
    { label: 'setBoost は返るが真実が変わらない', mode: 'silent' }
  ];
  for (const c of cases) {
    const ov = createOverlayHarness({ state: { volume: 40, boost: false } });
    try {
      const btn = await openOverlay(ov, { boostAllowed: false });
      assert.ok(btn, c.label + ' 前提: ブーストボタンが存在する');
      const before = ov.boostView();

      ov.setBoostMode(c.mode);
      ov.click(btn);
      await ov.settle(8);

      assert.ok(ov.lastCall('setBoost'), c.label + ': setBoost が呼ばれていない（押せていない）');
      assert.deepStrictEqual(ov.boostView(), before,
        c.label + ': content が確認していない値をオーバーレイが表示した（楽観更新。SPEC 3-e(2)）。before='
        + JSON.stringify(before) + ' after=' + JSON.stringify(ov.boostView()));
      assert.strictEqual(ov.truth.boost, false, c.label + ': bridge 側の真実が動いた（前提が崩れている）');
    } finally { ov.dispose(); }
  }
});

test('seam5-overlay-offline-disabled: オフライン（available:false）のときだけ塞いでよい', async () => {
  // 逆側の検査。SPEC 3-d が唯一許した無効化まで禁じてしまう（過検知の）実装も捕まえる。
  const ov = createOverlayHarness({ state: { volume: 40, boost: false, available: false } });
  try {
    const btn = await openOverlay(ov, { boostAllowed: false });
    assert.ok(btn, 'オフラインでもボタン自体は生成されていること（SPEC 5: 常に生成する）');
    assert.strictEqual(btn.disabled, true,
      'available:false（オフライン）なのにブーストボタンが押せる（SPEC 3-d/3-e）');
    ov.click(btn);
    await ov.settle();
    assert.strictEqual(ov.countCalls('setBoost'), 0,
      'オフラインなのに setBoost を投げた: ' + JSON.stringify(ov.calls));
  } finally { ov.dispose(); }
});

/* ------------------------------------------------------------ 継ぎ目 6 */
/*
 * SPEC 3-d（state.boost は settings.boostAllowed をそのまま反映する。
 * 両者が食い違う状態は存在しない）。
 *
 * 由来: c8c17e9 で塞いだ本物の製品バグ。
 *   MAIN world（src/page.js）の注入が content より遅れると、MAIN 側の boostEnabled は
 *   false のままなので readState() が boost:false を返す。content がそれを
 *   そのまま採用すると、storage.boostAllowed=true なのに state.boost=false になり、
 *   その状態では volume:150 が MAIN 側で 100 に丸められる（ブーストが効かない）。
 *   この発見には、当初いっさい回帰テストが無かった。
 *
 * MAIN world は SPEC 第3章の ytvp:cmd / ytvp:res 契約を満たす stub で代替する
 * （実物の page.js は movie_player と Web Audio に触るので Node では動かない）。
 * stub の「立ち上がりの遅さ」は wiring.js の mainWorld:false / startMainWorld で再現する。
 */

test('seam6-mainworld-late: MAIN world が遅れて立ち上がっても state.boost が settings.boostAllowed と食い違わない', async () => {
  const h = createHarness({
    storage: {},
    mainWorld: false,          // page.js の注入がまだ済んでいない
    player: { volume: 40 },
    clockScale: 0.05           // content の CMD_TIMEOUT_MS(2000ms) の待ちだけを縮める
  });
  try {
    // content は起動し、MAIN world へ命令を投げる。誰も応答しない（注入前）。
    const bootCmds = await h.sent('boost');
    assert.ok(bootCmds.length >= 1, 'content が起動時に boost を押し込んでいない');
    assert.strictEqual(h.player, null, '前提: MAIN world はまだ立ち上がっていない');

    // (1) MAIN world が居ないうちに setBoost(true) を受ける
    const setRes = await h.request({ type: 'setBoost', enabled: true }, 6000);
    assert.strictEqual(setRes.ok, true, 'setBoost が ok を返さない: ' + JSON.stringify(setRes));
    assert.strictEqual(setRes.state.boost, true,
      'MAIN world が居ないだけで state.boost が false になった（唯一の真実は settings。SPEC 3-d）: '
      + JSON.stringify(setRes.state));
    const st1 = await h.request({ type: 'getSettings' });
    assert.strictEqual(st1.settings.boostAllowed, true, 'setBoost が settings に効いていない');

    // (2) そのあと MAIN world が立ち上がる（ytvp:cmd に答えられるようになる）。
    //     ytvp:ready はまだ流していない ＝ boost の押し込みが届いていない瞬間。
    const main = h.startMainWorld({ fireReady: false });
    assert.deepStrictEqual(main.log, [],
      '前提: 立ち上がる前の命令は MAIN world に届いていない');
    assert.strictEqual(main.state.boost, false,
      '前提: 遅れて立ち上がった MAIN world 自身の boost は false（押し込みを受け損ねている）');

    const mid = await h.request({ type: 'get' });
    assertStateShape(mid, 'MAIN world 立ち上がり直後の get');
    const midSettings = await h.request({ type: 'getSettings' });
    assert.strictEqual(mid.state.boost, midSettings.settings.boostAllowed,
      'state.boost と settings.boostAllowed が食い違った（MAIN world の値をそのまま採用している。SPEC 3-d）: '
      + JSON.stringify(mid.state) + ' vs ' + JSON.stringify(midSettings.settings));
    assert.strictEqual(mid.state.boost, true,
      'settings.boostAllowed=true なのに state.boost=false（c8c17e9 で塞いだバグ。SPEC 3-d）: '
      + JSON.stringify(mid.state));

    // (3) page.js の最終行（ytvp:ready）。content はここで唯一の真実を押し込み直す。
    h.fireMainWorldReady();
    await h.waitFor(() => main.log.some((e) => e.action === 'boost'),
      'ytvp:ready を受けても content が boost を押し込み直さない（立ち上がりの取りこぼしが残る）');
    await h.settle(5);
    assert.strictEqual(main.state.boost, true,
      'ready のあとも MAIN world 側の boost が false のまま: ' + JSON.stringify(main.state));

    // (4) 立ち上がり完了後の get
    const after = await h.request({ type: 'get' });
    assertStateShape(after, '立ち上がり完了後の get');
    const afterSettings = await h.request({ type: 'getSettings' });
    assert.strictEqual(after.state.boost, true,
      '立ち上がり完了後の get が boost:true を返さない: ' + JSON.stringify(after.state));
    assert.strictEqual(after.state.boost, afterSettings.settings.boostAllowed,
      'state.boost と settings.boostAllowed が食い違う（SPEC 3-d）');

    // (5) その状態で 150 を要求したら 100 に丸められない（報告された症状そのもの）
    const set150 = await h.request({ type: 'set', volume: 150 });
    assertStateShape(set150, 'set 150');
    assert.strictEqual(set150.state.volume, 150,
      'ブースト許可中なのに 150 が ' + set150.state.volume + ' に丸められた（MAIN world にブーストが届いていない）');
    assert.strictEqual(h.player.state.volume, 150, 'MAIN world 側に 150 が反映されていない');
  } finally { h.dispose(); }
});

/* ------------------------------------------------------------ 継ぎ目 7 */
/*
 * ネイティブ統合UI（SPEC 第9章。content 側 c139b05 / overlay 側 541bb09）。
 *
 * この継ぎ目がどこにあるか:
 *   探す側（content.js: #movie_player 配下の .ytp-right-controls・music の除外・
 *   SPA 遷移での再探索）と、描く側（overlay.js: 渡された要素の先頭にボタンを挿す）は
 *   別担当で、契約は mount(bridge, options) の options.nativeAnchor 1点しかない。
 *   片方だけの単体検査では「A が探したものを B が使っている」ことは一切分からない。
 *   実際、A の配線を消しても B の分岐を消しても、それぞれの側は矛盾なく動いてしまう。
 *
 * ここでは実物の content.js と実物の overlay.js を同じコンテキストへ
 * manifest と同じ順序で読み込み、偽 DOM 上で「ボタンがどこに入ったか」を歩いて確かめる。
 *
 * SPEC 9-a: .ytp-right-controls の先頭にボタンを1つ差し込む。数値は音量に追随する。
 * SPEC 9-b: 見つからなければ黙って従来の浮きハンドルへ戻る／music.youtube.com は対象外。
 * SPEC 9-c: YouTube のセレクタを持つのは content.js だけ。overlay は渡された器に描くだけ。
 *
 * この検査が空振りでないことは tools/tests/run_scanner_regress.sh が
 * 「A の配線を消した検体」「B の分岐を消した検体」で赤くなることを実測している。
 */

const NATIVE_BTN = 'ytvp-native-btn';
const FLOAT_HANDLE = 'ytvp-handle';

async function bootNative(over) {
  const h = createHarness(Object.assign({
    storage: {},
    overlay: true,                       // 実物の src/overlay.js を content と同じ世界へ
    hostname: 'www.youtube.com',
    playerDom: { rightControls: true },  // #movie_player > .ytp-right-controls
    player: { volume: 40 }
  }, over || {}));
  await h.ready();
  await h.settle(5);
  return h;
}

// ボタン本体だけを拾う（子の .ytvp-native-btn__value は別クラスなので混ざらない）
function nativeButtons(h) { return h.find(NATIVE_BTN); }

test('seam7-native-btn-in-controls: .ytp-right-controls の先頭にボタンが入り、浮きハンドルが消える', async () => {
  const h = await bootNative();
  try {
    const controls = h.controls();
    assert.ok(controls, '前提: 偽 DOM に .ytp-right-controls がある');

    const btns = nativeButtons(h);
    assert.strictEqual(btns.length, 1,
      'ネイティブボタンが ' + btns.length + ' 個（1 のはず）。0 なら content が差し込み先を渡していないか '
      + 'overlay が nativeAnchor を使っていない（SPEC 9-a/9-c）');
    assert.strictEqual(btns[0].parentNode, controls,
      'ボタンが .ytp-right-controls の中に居ない（差し込み先が違う）');
    assert.strictEqual(controls.childNodes[0], btns[0],
      '先頭に入っていない（SPEC 9-a）。並び: '
      + controls.childNodes.map((n) => String(n.className)).join(' | '));

    // SPEC 9-a: ネイティブモードでは開閉の役はボタンが担う。浮きハンドルは出さない。
    assert.strictEqual(h.find(FLOAT_HANDLE).length, 0,
      'ネイティブ統合が効いているのに浮きハンドルも出ている（UI が二重）');

    // パネルの器（ytvp-root）もプレイヤーの右コントロールの中（ボタン基準で開くため）
    const roots = h.find('ytvp-root');
    assert.strictEqual(roots.length, 1, 'ytvp-root が ' + roots.length + ' 個（1 のはず）');
    assert.strictEqual(roots[0].parentNode, controls,
      'ytvp-root が .ytp-right-controls の外に居る（パネルがボタン基準で開けない）');

    // SPEC 9-a: ボタンの数値は現在音量。MAIN world の初期値は 40。
    await h.waitFor(() => deepText(nativeButtons(h)[0]) === '40',
      'ネイティブボタンが現在の音量(40)を表示する');
    assert.strictEqual(deepText(btns[0]), '40',
      'ボタンの文字が現在音量になっていない: ' + JSON.stringify(deepText(btns[0])));
  } finally { h.dispose(); }
});

test('seam7-fallback-no-controls: .ytp-right-controls が無ければ従来の浮きハンドルへ戻る（SPEC 9-b）', async () => {
  const h = await bootNative({ playerDom: { rightControls: false } });
  try {
    assert.strictEqual(h.controls(), null, '前提: 偽 DOM に .ytp-right-controls が無い');
    assert.strictEqual(nativeButtons(h).length, 0,
      '差し込み先が無いのにネイティブボタンを作った（どこに入れた？ SPEC 9-b）');
    const handles = h.find(FLOAT_HANDLE);
    assert.strictEqual(handles.length, 1,
      '浮きハンドルが ' + handles.length + ' 個（1 のはず）。ネイティブ統合の失敗が機能の停止になっている（SPEC 9-b）');
    const roots = h.find('ytvp-root');
    assert.strictEqual(roots.length, 1, 'ytvp-root が ' + roots.length + ' 個（1 のはず）');
    assert.strictEqual(roots[0].parentNode, h.player_el(),
      '浮きハンドルが #movie_player の中に居ない');
  } finally { h.dispose(); }
});

test('seam7-music-float: music.youtube.com は controls があってもネイティブ統合しない（SPEC 9-b）', async () => {
  const h = await bootNative({ hostname: 'music.youtube.com' });
  try {
    assert.ok(h.controls(), '前提: 偽 DOM には .ytp-right-controls がある（除外はホスト判定によるもの）');
    assert.strictEqual(nativeButtons(h).length, 0,
      'music.youtube.com でネイティブ統合した（DOM が別物なので対象外。SPEC 9-b）');
    assert.strictEqual(h.find(FLOAT_HANDLE).length, 1,
      'music.youtube.com で浮きハンドルが出ていない（機能が死んでいる）');
  } finally { h.dispose(); }
});

test('seam7-native-panel-preset: ボタンでパネルが開き、プリセットが実物 content 経由で音量に効く', async () => {
  const h = await bootNative();
  try {
    const btn = nativeButtons(h)[0];
    assert.ok(btn, '前提: ネイティブボタンがある');
    const panel = h.find('ytvp-panel')[0];
    assert.ok(panel, '前提: パネルがある');
    assert.strictEqual(panel.hidden, true, '前提: パネルは既定で閉じている（SPEC 6）');

    h.clickEl(btn);
    await h.settle(3);
    assert.strictEqual(panel.hidden, false,
      'ボタンを押してもパネルが開かない（開閉の役がボタンに渡っていない。SPEC 9-a）');
    assert.strictEqual(btn.getAttribute('aria-expanded'), 'true',
      'パネルを開いたのに aria-expanded が true でない');

    const pill = h.find('ytvp-pill').filter((p) => deepText(p) === '70')[0];
    assert.ok(pill, 'プリセット 70 の pill が無い: '
      + JSON.stringify(h.find('ytvp-pill').map(deepText)));
    h.clickEl(pill);

    // 実物の content → 偽 MAIN world まで届いて初めて「効いた」と言える
    await h.waitFor(() => h.player.state.volume === 70,
      'プリセットを押しても MAIN world の音量が 70 にならない（overlay → content の配線）');
    assert.strictEqual(h.player.state.volume, 70,
      'MAIN world 側の音量が 70 でない: ' + JSON.stringify(h.player.state));
    await h.waitFor(() => deepText(nativeButtons(h)[0]) === '70',
      'ネイティブボタンの数値が 70 に追随する（SPEC 9-a）');
  } finally { h.dispose(); }
});

test('seam7-rebind-single: yt-navigate-finish で再バインドしてもボタンは1個のまま', async () => {
  const h = await bootNative();
  try {
    assert.strictEqual(nativeButtons(h).length, 1, '前提: 遷移前のボタンは1個');
    const controls = h.controls();
    const before = controls.childNodes.length;

    h.navigate();                       // 実物の yt-navigate-finish リスナを呼ぶ
    await h.settle(3);
    await h.waitFor(() => nativeButtons(h).length === 1,
      '再バインド後にネイティブボタンが1個へ戻る');

    const btns = nativeButtons(h);
    assert.strictEqual(btns.length, 1,
      '再バインドでボタンが ' + btns.length + ' 個に増えた（destroy が入れたものを取り除いていない）');
    assert.strictEqual(controls.childNodes[0], btns[0],
      '再バインド後に先頭でなくなった。並び: '
      + controls.childNodes.map((n) => String(n.className)).join(' | '));
    assert.strictEqual(h.find('ytvp-root').length, 1,
      'ytvp-root が ' + h.find('ytvp-root').length + ' 個に増えた（パネルの二重生成）');
    assert.strictEqual(h.find(FLOAT_HANDLE).length, 0,
      '再バインドで浮きハンドルが増えた（差し込み先を見失っている）');
    assert.strictEqual(controls.childNodes.length, before,
      '再バインドで .ytp-right-controls の子が ' + before + ' → ' + controls.childNodes.length
      + ' に増えた（遷移のたびに残骸が積む）');

    // 2 回目の遷移でも同じであること（1 回だけ偶然消えた、を排除する）
    h.navigate();
    await h.settle(3);
    await h.waitFor(() => nativeButtons(h).length === 1, '2 回目の再バインド後もボタンは1個');
    assert.strictEqual(controls.childNodes.length, before,
      '2 回目の遷移で子が ' + controls.childNodes.length + ' に増えた');
  } finally { h.dispose(); }
});


/* ------------------------------------------------------------ 継ぎ目 8 */
/*
 * v0.6 で入れた3つの導線 ―― ⚙（パネル内のプリセット編集）／ホバーで開き
 * クリックで固定する開閉／初回ヒント ―― を守る検査。
 *
 * なぜ要るか（2026-09-03 の実測）:
 *   この3つが入った時点で、`test/` の中に `mouseenter` / `hover` / `pinned` /
 *   `gear` / `firstRunHint` を含むファイルは **1つも無かった**。
 *   実装だけが先に進み、回帰が1本も無い状態だった。ここがその穴を塞ぐ。
 *
 * 見るのは2層ある。どちらか片方だけでは足りない。
 *   overlay 層 … 描く側の作法（⚙ の有無・ホバー・固定・フォーカス）
 *   content 層 … 配線（bridge に setSettings / markHintShown が在るか、
 *                 firstRunHint が渡るか、既読が storage に残るか）
 *   overlay だけ見ると「部品は正しいのに誰も呼んでいない」状態を、
 *   content だけ見ると「呼んではいるが描けていない」状態を取り逃がす。
 *
 * この検査が空振りでないことは tools/tests/run_scanner_regress.sh が
 * 「導線を壊した検体では赤くなる」ことで実測している。
 */

/* --- 8-a. ⚙（SPEC 12-a） --------------------------------------------- */

test('seam8-gear-only-with-setsettings: ⚙ は bridge.setSettings がある相手にだけ出る', async () => {
  // 保存先を持たない相手（配線前の content.js 相当）
  const off = createOverlayHarness();
  try {
    off.mount();
    await off.settle();
    off.open();
    await off.settle();
    assert.ok(off.panel(), '前提: パネルは出ている');
    assert.strictEqual(off.gear(), null,
      'bridge に setSettings が無いのに ⚙ を出した（押せるのに何も起きないボタンを作っている）');
    assert.strictEqual(off.presetInput(), null,
      '⚙ が無いのに編集欄だけ生えている（開く手段の無い UI）');
  } finally { off.dispose(); }

  // 保存先を持つ相手（現行の content.js）
  const on = createOverlayHarness({ settings: true });
  try {
    on.mount();
    await on.settle();
    on.open();
    await on.settle();
    assert.ok(on.gear(), 'bridge.setSettings があるのに ⚙ が出ていない（SPEC 12-a）');
    assert.ok(on.presetInput(), '⚙ はあるのに編集欄が無い');
  } finally { on.dispose(); }
});

/*
 * ⚙ の置き場所は「見た目の好み」ではなく、押せるかどうかの問題である。
 * このパネルは**上へ開く**（overlay.css の bottom: calc(100% + …)）ので、
 * パネルの子の並びで**後ろにあるものほど YouTube のシークバーに近い**。
 * v0.7 までは ⚙ をパネルの末尾側に置いていて、実機で「シークバーと被って
 * 押しにくい」状態になっていた（実機で確認）。
 * 直したのは並びそのものなので、並びで固定する。CSS の px 値では守れない
 * （偽 DOM はレイアウトを持たないし、値は容易に戻せる）。
 */
test('seam8-gear-at-top: ⚙ は readout（数値の行）の中にあり、パネルの末尾側に無い', async () => {
  const ov = createOverlayHarness({ settings: true });
  try {
    ov.mount();
    await ov.settle();
    ov.open();
    await ov.settle();

    const panel = ov.panel();
    const gear = ov.gear();
    const readout = findByClass(ov.doc.body, 'ytvp-readout')[0] || null;
    assert.ok(panel && gear && readout, '前提: パネル・⚙・readout がある');

    const cls = (n) => String(n.className || '').split(/\s+/)[0] || ('<' + n.tagName + '>');
    const panelKids = (panel.childNodes || []).map(cls);
    const readoutKids = (readout.childNodes || []).map(cls);

    assert.strictEqual(panelKids.indexOf('ytvp-gear'), -1,
      'パネル直下に ⚙ が居る（上に開くパネルでは下ほどシークバーに近い）: ' + JSON.stringify(panelKids));
    assert.strictEqual(panelKids[0], 'ytvp-readout',
      'パネルの先頭が readout でない（⚙ を置く行がシークバーから最も遠い側に無い）: ' + JSON.stringify(panelKids));
    assert.strictEqual(readoutKids[readoutKids.length - 1], 'ytvp-gear',
      '⚙ が readout の行の右端に無い: ' + JSON.stringify(readoutKids));

    // 押した ⚙（最上段）と開く先（最下段）が離れるので、対応が見えるようにしてある。
    ov.click(gear);
    await ov.settle();
    assert.ok(String(panel.className).split(/\s+/).indexOf('ytvp-panel--settings') >= 0,
      '設定を開いてもパネルに ytvp-panel--settings が付かない（⚙ と編集欄の対応が見た目に出ない）: ' + panel.className);
    ov.click(gear);
    await ov.settle();
    assert.strictEqual(String(panel.className).split(/\s+/).indexOf('ytvp-panel--settings'), -1,
      '閉じたのに ytvp-panel--settings が残っている: ' + panel.className);
  } finally { ov.dispose(); }
});

test('seam8-gear-opens-and-applies: ⚙ で編集欄が開き、「適用」が bridge.setSettings へ流れる', async () => {
  const ov = createOverlayHarness({ settings: true });
  try {
    ov.mount({ presets: [15, 30, 50, 70, 100] });
    await ov.settle();
    ov.open();
    await ov.settle();

    const gear = ov.gear();
    assert.ok(gear, '前提: ⚙ がある');
    assert.strictEqual(ov.settings().hidden, true,
      '⚙ を押す前から編集欄が開いている（段階的開示になっていない＝主役の数値入力が埋もれる）');

    ov.click(gear);
    await ov.settle();
    assert.strictEqual(ov.settings().hidden, false, '⚙ を押しても編集欄が開かない');
    assert.strictEqual(gear.getAttribute('aria-expanded'), 'true',
      '編集欄を開いたのに ⚙ の aria-expanded が true でない');
    assert.strictEqual(String(ov.presetInput().value), '15 30 50 70 100',
      '開いた欄に「いま保存されている値」が入っていない: ' + ov.presetInput().value);

    ov.presetInput().value = '10 25 40';
    ov.click(ov.presetApply());
    await ov.settle();

    const call = ov.lastCall('setSettings');
    assert.ok(call, '「適用」を押しても bridge.setSettings が呼ばれない（パネルの編集が保存へ流れていない）');
    assert.deepStrictEqual(call.arg, { presets: [10, 25, 40] },
      '編集欄の中身が setSettings の payload になっていない: ' + JSON.stringify(call.arg));

    ov.click(gear);
    await ov.settle();
    assert.strictEqual(ov.settings().hidden, true, 'もう一度 ⚙ を押しても畳まれない');
  } finally { ov.dispose(); }
});

/* --- 8-b. ホバーで開く／クリックで固定 -------------------------------- */

test('seam8-hover-open-close: 乗せると開き、両方から離れると猶予のあとで閉じる', async () => {
  const ov = createOverlayHarness();
  try {
    ov.mount();
    await ov.settle();
    const hb = ov.handleBtn();
    assert.ok(hb, '前提: ハンドルがある');
    assert.strictEqual(ov.isOpen(), false, '前提: 既定は折りたたみ（SPEC 6）');

    ov.enter(hb);
    await ov.settle();
    assert.strictEqual(ov.isOpen(), true, 'マウスを乗せてもパネルが開かない');

    // ボタン → パネルへポインタが渡る途中で閉じないこと（猶予の目的そのもの）
    ov.enter(ov.panel());
    ov.leave(hb);
    await ov.stayFor(() => ov.isOpen(),
      'ボタンからパネルへ渡っている途中で閉じた（中の操作に手が届かない）', 400);

    ov.leave(ov.panel());
    await ov.waitFor(() => ov.isOpen() === false,
      '両方から離れてもパネルが閉じない（開きっぱなしで動画を覆う）');
  } finally { ov.dispose(); }
});

test('seam8-touch-no-hover: タッチのポインタではホバー経路が働かない（クリックだけが残る）', async () => {
  const ov = createOverlayHarness();
  try {
    ov.mount();
    await ov.settle();
    const hb = ov.handleBtn();
    ov.enter(hb, 'touch');
    await ov.settle();
    assert.strictEqual(ov.isOpen(), false,
      'タッチのポインタでパネルが開いた（タップの直前に必ず開く＝クリックの意味が壊れる）');

    ov.click(hb);
    await ov.settle();
    assert.strictEqual(ov.isOpen(), true, 'タッチ環境でクリックからも開けない（開く手段が消えた）');
  } finally { ov.dispose(); }
});

test('seam8-click-pins: クリックで固定すると離れても閉じない／もう一度押すと閉じる', async () => {
  const ov = createOverlayHarness();
  try {
    ov.mount();
    await ov.settle();
    const hb = ov.handleBtn();

    ov.click(hb);
    await ov.settle();
    assert.strictEqual(ov.isOpen(), true, '前提: クリックで開く');

    // 「編集中は閉じない」規則と混ざらないよう、フォーカスを外してから離れる。
    // 外さないと、固定が効いていなくても入力中扱いで開いたままになり、空振りの緑になる。
    ov.valueEl().blur();
    ov.leave(hb);
    await ov.stayFor(() => ov.isOpen(),
      'クリックで固定したのに、マウスを離したら閉じた（固定が効いていない）', 400);

    ov.click(hb);
    await ov.settle();
    assert.strictEqual(ov.isOpen(), false, 'もう一度クリックしても固定が解除されず閉じない');
  } finally { ov.dispose(); }
});

test('seam8-hover-no-focus: ホバーで開いたときは入力欄を奪わない／クリックのときだけ全選択する', async () => {
  // なぜ分けるか: マウスが通り過ぎただけで入力欄にカーソルが入ると、そこから先の
  // k（停止）・f（全画面）・数字キー（シーク）という YouTube のショートカットが全部死ぬ。
  const ov = createOverlayHarness();
  try {
    ov.mount();
    await ov.settle();
    const hb = ov.handleBtn();

    ov.enter(hb);
    await ov.settle();
    assert.strictEqual(ov.isOpen(), true, '前提: 乗せると開く');
    const v = ov.valueEl();
    assert.ok(v, '前提: 数値の入力欄がある');
    assert.notStrictEqual(ov.activeElement(), v,
      'ホバーで開いただけで入力欄がフォーカスを奪った（通り過ぎただけで YouTube の操作系が死ぬ）');
    assert.strictEqual(v._selectCount, 0, 'ホバーで開いただけで全選択した');

    ov.click(hb);
    await ov.settle();
    assert.strictEqual(ov.activeElement(), v,
      'クリックで開いても入力欄にカーソルが入らない（打つまでに余分な操作が要る）');
    assert.strictEqual(v._selectCount, 1,
      'クリックで開いたのに全選択していない（打ち直しになる）: select 回数=' + v._selectCount);
  } finally { ov.dispose(); }
});

test('seam8-no-close-while-typing: 音量欄を編集している間は、離れてもパネルが閉じない', async () => {
  const ov = createOverlayHarness();
  try {
    ov.mount();
    await ov.settle();
    const hb = ov.handleBtn();
    ov.enter(hb);
    await ov.settle();
    assert.strictEqual(ov.isOpen(), true, '前提: 乗せると開く');

    const v = ov.valueEl();
    v.focus();
    v.value = '12';
    ov.leave(hb);
    await ov.stayFor(() => ov.isOpen(), '打っている最中にパネルが閉じた', 500);
    assert.strictEqual(String(v.value), '12', '打ちかけの文字が消えた: ' + v.value);
  } finally { ov.dispose(); }
});

test('seam8-no-close-while-typing-presets: ⚙ のプリセット欄を編集している間も閉じない', async () => {
  // 音量欄では閉じないのにプリセット欄では閉じる、という壊れ方がありうるので組で見る。
  const ov = createOverlayHarness({ settings: true });
  try {
    ov.mount();
    await ov.settle();
    const hb = ov.handleBtn();
    ov.enter(hb);
    await ov.settle();
    ov.click(ov.gear());
    await ov.settle();

    const pi = ov.presetInput();
    assert.ok(pi, '前提: プリセットの編集欄がある');
    pi.focus();
    pi.value = '10 25';
    ov.leave(hb);
    await ov.stayFor(() => ov.isOpen(), 'プリセット欄を打っている最中にパネルが閉じた', 500);
    assert.strictEqual(String(pi.value), '10 25', '打ちかけの文字が消えた: ' + pi.value);
  } finally { ov.dispose(); }
});

/* --- 8-c. content 側の配線（⚙ が実際に保存へ届くか・初回ヒント） ------ */

test('seam8-panel-preset-e2e: パネルの ⚙ から編集すると content に保存され、pill が作り直される', async () => {
  const h = await bootNative();
  try {
    h.clickEl(nativeButtons(h)[0]);            // パネルを開く
    await h.settle(3);
    const gear = h.find('ytvp-gear')[0];
    assert.ok(gear,
      'content の bridge に setSettings があるのにパネルへ ⚙ が出ていない（配線が overlay まで届いていない）');
    h.clickEl(gear);
    await h.settle(3);

    const input = h.find('ytvp-preset-input')[0];
    assert.ok(input, '⚙ を押しても編集欄が出ない');
    input.value = '10 25 40';
    h.clickEl(h.find('ytvp-preset-apply')[0]);

    await h.waitFor(() => JSON.stringify(h.store.presets) === JSON.stringify([10, 25, 40]),
      'パネルの編集が content の storage に届かない（⚙ が保存へ配線されていない）: '
      + JSON.stringify(h.store.presets));
    await h.waitFor(() => h.find('ytvp-pill').map(deepText).join(',') === '10,25,40',
      'パネルの pill が作り直されていない: ' + JSON.stringify(h.find('ytvp-pill').map(deepText)));
  } finally { h.dispose(); }
});

test('seam8-hint-once: 初回ヒントは1回だけ出る（SPA 遷移では二度と出ない）', async () => {
  const h = await bootNative();
  try {
    const hints = h.find('ytvp-hint');
    assert.strictEqual(hints.length, 1,
      '初回にヒントが出ていない（content が firstRunHint を渡していない可能性）: ' + hints.length + ' 個');
    assert.strictEqual(deepText(hints[0]), '音量を数値で。クリックで開く',
      'ヒントの文言が違う: ' + JSON.stringify(deepText(hints[0])));

    await h.waitFor(() => h.store.hintShown === true,
      '既読が storage に保存されない（次のセッションでも毎回出ることになる）');

    h.navigate();                              // SPA 遷移 → 作り直し
    await h.settle(5);
    assert.strictEqual(h.find('ytvp-hint').length, 0,
      'SPA 遷移でヒントがもう一度出た（1回きりが mount の数に依らず守られていない）');
  } finally { h.dispose(); }
});

test('seam8-hint-not-repeated: storage に既読が残っていれば最初から出ない', async () => {
  const h = await bootNative({ storage: { hintShown: true } });
  try {
    assert.strictEqual(h.find('ytvp-hint').length, 0,
      '既読なのに初回ヒントが出た（storage の既読を読んでいない）');
    // 出ていないだけでなく、パネル自体は正常に載っていること（前提が崩れていないか）
    assert.strictEqual(h.find('ytvp-panel').length, 1, '前提: パネルは載っている');
  } finally { h.dispose(); }
});

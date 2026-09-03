'use strict';
// manifest.json を検査する。README の権限方針（storage のみ・youtube のみ・外部通信なし）を機構で守る。
// 赤くても manifest.json をテストに合わせて直さない（直すのは実装のほう）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 既定はリポジトリ直下の manifest.json。YTVP_MANIFEST_PATH は
// tools/tests/run_scanner_regress.sh が「わざと違反した manifest」を食わせて
// 『このテストが本当に落ちること』を実測するための口。通常運用では使わない。
const MANIFEST_PATH = process.env.YTVP_MANIFEST_PATH
  ? path.resolve(process.env.YTVP_MANIFEST_PATH)
  : path.join(__dirname, '..', 'manifest.json');
const ROOT = path.dirname(MANIFEST_PATH);

const ALLOWED_HOSTS = ['*://www.youtube.com/*', '*://music.youtube.com/*'];
const FORBIDDEN = ['<all_urls>', 'tabs', 'webRequest', 'cookies', 'scripting',
                   'management', 'history', 'downloads', 'proxy', 'debugger'];
// トップレベルキーは「禁止キーの列挙」ではなく **ホワイトリスト**で守る。
// 列挙は必ず追いつかなくなるので、知らないキーが1つでも増えたら落とす。
// これは tools/lib/manifest_scan.js にも別実装で入れてある（片方の穴をもう片方が埋める狙い。
// 従来の方針を維持する）。ここを直すときは向こうも直すこと。
// 空配列でも「載っていないキーの存在」は違反にする（optional_permissions: [] も赤）。
const ALLOWED_TOP_KEYS = [
  'manifest_version', 'name', 'version', 'description', 'permissions',
  'host_permissions', 'content_scripts', 'web_accessible_resources', 'action',
  // content_security_policy: 中身は下の CSP テストが別途検査する
  'content_security_policy',
  // icons: 権限を増やさず、参照先の実在は「参照ファイルが実在する」テストが見る
  'icons'
];

function readManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return { raw: raw, json: JSON.parse(raw) };
}

test('manifest.json が存在し、有効な JSON である', () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), 'manifest.json が無い: ' + MANIFEST_PATH);
  assert.doesNotThrow(readManifest, 'manifest.json が JSON として壊れている');
});

test('manifest_version === 3', () => {
  const m = readManifest().json;
  assert.strictEqual(m.manifest_version, 3);
});

test('manifest のトップレベルキーがホワイトリストに収まる（未知のキーは1つでも赤）', () => {
  const m = readManifest().json;
  const unknown = Object.keys(m).filter(function (k) { return ALLOWED_TOP_KEYS.indexOf(k) === -1; });
  assert.deepStrictEqual(unknown, [],
    '許可外の manifest トップレベルキー: ' + unknown.join(', ')
    + '（ホワイトリスト: ' + ALLOWED_TOP_KEYS.join(', ') + '）');
});

test('permissions は ["storage"] と完全一致', () => {
  const m = readManifest().json;
  assert.deepStrictEqual(m.permissions, ['storage']);
});

test('optional_permissions は無いか空', () => {
  const m = readManifest().json;
  if (m.optional_permissions !== undefined) {
    assert.deepStrictEqual(m.optional_permissions, []);
  }
});

test('host_permissions は youtube 系のみ', () => {
  const m = readManifest().json;
  assert.ok(Array.isArray(m.host_permissions), 'host_permissions が配列でない');
  for (const h of m.host_permissions) {
    assert.ok(ALLOWED_HOSTS.indexOf(h) !== -1, '許可外の host_permission: ' + h);
  }
  if (m.optional_host_permissions !== undefined) {
    assert.deepStrictEqual(m.optional_host_permissions, []);
  }
});

test('禁止権限トークンを一切含まない', () => {
  const m = readManifest().json;
  const pools = []
    .concat(m.permissions || [])
    .concat(m.optional_permissions || [])
    .concat(m.host_permissions || [])
    .concat(m.optional_host_permissions || []);
  for (const cs of (m.content_scripts || [])) {
    for (const mt of (cs.matches || [])) { pools.push(mt); }
  }
  for (const war of (m.web_accessible_resources || [])) {
    for (const mt of (war.matches || [])) { pools.push(mt); }
  }
  for (const token of FORBIDDEN) {
    for (const entry of pools) {
      assert.notStrictEqual(String(entry), token, '禁止トークンを検出: ' + token);
      assert.ok(String(entry).indexOf('<all_urls>') === -1, '<all_urls> を検出: ' + entry);
    }
  }
});

test('content_scripts の matches は youtube のホストのみ', () => {
  const m = readManifest().json;
  const re = /^(\*|https?):\/\/(www|music)\.youtube\.com\//;
  for (const cs of (m.content_scripts || [])) {
    assert.ok(Array.isArray(cs.matches) && cs.matches.length > 0, 'content_scripts.matches が空');
    for (const mt of cs.matches) {
      assert.ok(re.test(mt), '許可外の matches: ' + mt);
    }
  }
});

// ------------------------------------------------- 参照ファイルの実在
function collectReferences(m) {
  const refs = [];
  for (const cs of (m.content_scripts || [])) {
    for (const f of (cs.js || [])) { refs.push(f); }
    for (const f of (cs.css || [])) { refs.push(f); }
  }
  for (const war of (m.web_accessible_resources || [])) {
    for (const f of (war.resources || [])) { refs.push(f); }
  }
  if (m.action && typeof m.action.default_popup === 'string') { refs.push(m.action.default_popup); }
  if (m.action && typeof m.action.default_icon === 'string') { refs.push(m.action.default_icon); }
  if (m.action && m.action.default_icon && typeof m.action.default_icon === 'object') {
    for (const k of Object.keys(m.action.default_icon)) { refs.push(m.action.default_icon[k]); }
  }
  for (const k of Object.keys(m.icons || {})) { refs.push(m.icons[k]); }
  if (m.background && typeof m.background.service_worker === 'string') {
    refs.push(m.background.service_worker);
  }
  return refs;
}

test('content_scripts / web_accessible_resources / action.default_popup の参照ファイルが実在する', () => {
  const m = readManifest().json;
  const refs = collectReferences(m);
  assert.ok(refs.length > 0, 'manifest がファイルを1つも参照していない');
  for (const ref of refs) {
    if (ref.indexOf('*') !== -1) {
      // グロブは1件以上ヒットすれば可
      const dir = path.join(ROOT, path.dirname(ref));
      const pattern = new RegExp('^' + path.basename(ref)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const hit = fs.existsSync(dir) && fs.readdirSync(dir).some(function (f) { return pattern.test(f); });
      assert.ok(hit, '参照グロブに一致するファイルが無い: ' + ref);
    } else {
      assert.ok(fs.existsSync(path.join(ROOT, ref)), '参照ファイルが実在しない: ' + ref);
    }
  }
});

test('SPEC 第1章のファイルが manifest から参照されている（popup / content / overlay）', () => {
  const m = readManifest().json;
  const refs = collectReferences(m).map(function (r) { return r.replace(/^\.\//, ''); });
  assert.ok(refs.indexOf('src/content.js') !== -1, 'src/content.js が manifest から参照されていない');
  assert.strictEqual(m.action && m.action.default_popup, 'src/popup.html');
});

// ------------------------------------------------- CSP
test('content_security_policy に unsafe-eval / 外部オリジンが無い', () => {
  const m = readManifest().json;
  if (m.content_security_policy === undefined) { return; }
  const s = JSON.stringify(m.content_security_policy);
  assert.ok(s.indexOf('unsafe-eval') === -1, 'CSP に unsafe-eval: ' + s);
  assert.ok(s.indexOf('unsafe-inline') === -1, 'CSP に unsafe-inline: ' + s);
  assert.ok(!/https?:\/\//.test(s), 'CSP に外部オリジン: ' + s);
});

test('manifest 全体に外部 URL（youtube 以外）が無い', () => {
  const raw = readManifest().raw;
  const hits = raw.match(/https?:\/\/[A-Za-z0-9._~%-]+/g) || [];
  const bad = hits.filter(function (u) {
    return !/^https?:\/\/(www|music)\.youtube\.com$/.test(u);
  });
  assert.deepStrictEqual(bad, [], '外部 URL を検出: ' + bad.join(', '));
});

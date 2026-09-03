'use strict';
// manifest の権限ホワイトリスト検査本体。tools/scan_permissions.sh から呼ばれる。
// 違反を "path:LINE: message" 形式で stdout に出し、1件でもあれば exit 1。
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_HOSTS = ['*://www.youtube.com/*', '*://music.youtube.com/*'];
// manifest のトップレベルキーは「列挙した禁止キーを追う」のではなく **ホワイトリスト**で守る。
//   なぜ: 禁止キーを列挙する設計は必ず追いつかなくなる（同型の失敗が記録されている。
//   断定語を7リテラル列挙して30語句中23語句を取り逃がした件）。
//   ここに無いキーが1つでも増えたら赤にする。externally_connectable（任意の Web ページから
//   拡張へメッセージを送れる口）・background・declarative_net_request・optional_permissions は
//   これで自動的に捕まる。個別に名前を足していく必要はない。
// 載っているキーの根拠:
//   * 先頭9件 … 実物の manifest.json が現に使っているキー。
//   * content_security_policy … 中身は下の 7. が別途検査する（unsafe-eval / 外部オリジン）。
//   * icons … 権限を1つも増やさず、参照先ファイルの実在は下の 6. が検査する。
//     ウェブストア提出前に必ず足すことが INSTALL.md に書かれており、足した瞬間に
//     偽の赤が出ると「ホワイトリストを気軽に緩める」習慣を育てるので、先に通しておく。
const ALLOWED_TOP_KEYS = [
  'manifest_version', 'name', 'version', 'description', 'permissions',
  'host_permissions', 'content_scripts', 'web_accessible_resources', 'action',
  'content_security_policy', 'icons'
];
const FORBIDDEN_PERMS = ['<all_urls>', 'tabs', 'webRequest', 'webRequestBlocking', 'cookies',
                         'scripting', 'management', 'history', 'downloads', 'proxy', 'debugger',
                         'nativeMessaging', 'declarativeNetRequest', 'clipboardRead'];
const HOST_RE = /^(\*|https?):\/\/(www|music)\.youtube\.com\//;

const target = process.argv[2] || 'manifest.json';
const violations = [];
let raw = '';

function lineOf(token) {
  if (!raw) { return 1; }
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(String(token)) !== -1) { return i + 1; }
  }
  return 1;
}

function add(token, msg) {
  violations.push(target + ':' + lineOf(token) + ': ' + msg);
}

function finish() {
  for (const v of violations) { console.log(v); }
  if (violations.length > 0) {
    console.log('scan_permissions: violations=' + violations.length + ' target=' + target);
    process.exit(1);
  }
  console.log('scan_permissions: violations=0 target=' + target);
  process.exit(0);
}

if (!fs.existsSync(target)) {
  console.log(target + ':0: manifest が存在しない');
  console.log('scan_permissions: violations=1 target=' + target);
  process.exit(1);
}

raw = fs.readFileSync(target, 'utf8');
let m = null;
try {
  m = JSON.parse(raw);
} catch (e) {
  console.log(target + ':1: JSON として解析できない: ' + e.message);
  console.log('scan_permissions: violations=1 target=' + target);
  process.exit(1);
}
if (m === null || typeof m !== 'object' || Array.isArray(m)) {
  add('{', 'manifest がオブジェクトでない');
  finish();
}

const baseDir = path.dirname(path.resolve(target));

// 0. トップレベルキーのホワイトリスト（知らないキーが1つでも増えたら赤）
for (const k of Object.keys(m)) {
  if (ALLOWED_TOP_KEYS.indexOf(k) === -1) {
    add('"' + k + '"', '許可外の manifest トップレベルキー: ' + JSON.stringify(k)
      + '（ホワイトリストは ' + ALLOWED_TOP_KEYS.join(' / ')
      + '。増やすなら、そのキーが何の権限を開くかを説明できること）');
  }
}

// 1. manifest_version
if (m.manifest_version !== 3) {
  add('manifest_version', 'manifest_version が 3 でない: ' + JSON.stringify(m.manifest_version));
}

// 2. permissions は ["storage"] 完全一致
if (!Array.isArray(m.permissions) || m.permissions.length !== 1 || m.permissions[0] !== 'storage') {
  add('permissions', 'permissions が ["storage"] と一致しない: ' + JSON.stringify(m.permissions));
}

// 3. host_permissions は許可リストのみ
if (!Array.isArray(m.host_permissions)) {
  add('host_permissions', 'host_permissions が配列でない: ' + JSON.stringify(m.host_permissions));
} else {
  for (const h of m.host_permissions) {
    if (ALLOWED_HOSTS.indexOf(h) === -1) {
      add(h, '許可外の host_permission: ' + JSON.stringify(h));
    }
  }
}

// 4. 禁止トークン（optional 系・matches も含める）
const pool = [];
function pushAll(arr, label) {
  if (arr === undefined) { return; }
  if (!Array.isArray(arr)) { add(label, label + ' が配列でない'); return; }
  for (const x of arr) { pool.push({ v: String(x), label: label }); }
}
pushAll(m.permissions, 'permissions');
pushAll(m.optional_permissions, 'optional_permissions');
pushAll(m.host_permissions, 'host_permissions');
pushAll(m.optional_host_permissions, 'optional_host_permissions');
for (const cs of (m.content_scripts || [])) { pushAll(cs.matches, 'content_scripts.matches'); }
for (const war of (m.web_accessible_resources || [])) { pushAll(war.matches, 'web_accessible_resources.matches'); }

for (const e of pool) {
  if (FORBIDDEN_PERMS.indexOf(e.v) !== -1 || e.v.indexOf('<all_urls>') !== -1) {
    add(e.v, '禁止トークン: ' + e.label + ' に ' + JSON.stringify(e.v));
  }
}

// 5. content_scripts / web_accessible_resources の matches はホストが youtube のみ
for (const cs of (m.content_scripts || [])) {
  for (const mt of (cs.matches || [])) {
    if (!HOST_RE.test(String(mt))) {
      add(mt, '許可外の content_scripts.matches: ' + JSON.stringify(mt));
    }
  }
}
for (const war of (m.web_accessible_resources || [])) {
  for (const mt of (war.matches || [])) {
    if (!HOST_RE.test(String(mt))) {
      add(mt, '許可外の web_accessible_resources.matches: ' + JSON.stringify(mt));
    }
  }
}

// 6. 参照ファイルの実在
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
for (const ref of refs) {
  const rel = String(ref).replace(/^\.\//, '');
  if (rel.indexOf('*') !== -1) {
    const dir = path.join(baseDir, path.dirname(rel));
    const pattern = new RegExp('^' + path.basename(rel)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    let hit = false;
    if (fs.existsSync(dir)) {
      hit = fs.readdirSync(dir).some(function (f) { return pattern.test(f); });
    }
    if (!hit) { add(ref, '参照グロブに一致するファイルが無い: ' + ref); }
  } else if (!fs.existsSync(path.join(baseDir, rel))) {
    add(ref, '参照ファイルが実在しない: ' + ref);
  }
}

// 7. CSP
if (m.content_security_policy !== undefined) {
  const s = JSON.stringify(m.content_security_policy);
  if (s.indexOf('unsafe-eval') !== -1) { add('unsafe-eval', 'CSP に unsafe-eval'); }
  if (s.indexOf('unsafe-inline') !== -1) { add('unsafe-inline', 'CSP に unsafe-inline'); }
  const ext = s.match(/https?:\/\/[A-Za-z0-9._~%*-]+/g) || [];
  for (const u of ext) { add(u, 'CSP に外部オリジン: ' + u); }
}

// 8. リモートコード経路
if (m.background && typeof m.background.service_worker === 'string'
    && m.background.type === 'module') {
  // ESM 自体は禁止ではない。ここでは何もしない（記録のみ）。
}

finish();

#!/usr/bin/env bash
# ウェブストア提出用の zip を作る。
#
# これは「ビルド」ではない。コードを一切変換せず、リポジトリのファイルを
# そのまま複製するだけである。複製であることを毎回 sha256 で確かめるので、
# 「配布物がソースと違う」という事故が起きたらここで赤くなる。
#
# 同梱しないもの: test/（意図的な違反検体が入っており審査で引っかかる）、
# tools/（検査器）、*.md（文書）、verify.sh。
#
# 同梱するものは manifest.json と popup.html から機械的に導く。
# 手で並べた一覧は必ず腐るので置かない。
set -u
cd "$(dirname "$0")/.." || exit 2
exec python3 - "$@" <<'PACK_PY'
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile

fail = [0]


def ok(msg):
    print('[OK] ' + msg)


def ng(msg):
    print('[NG] ' + msg)
    fail[0] = 1


manifest = json.load(open('manifest.json', encoding='utf-8'))
version = manifest['version']
out = os.path.join('dist', 'yt-volume-precise-%s.zip' % version)


def manifest_refs(m):
    """manifest が参照するファイルを集める。zip の中でも同じ関数を使う。"""
    r = ['manifest.json']
    for c in m.get('content_scripts', []):
        r += c.get('js', []) + c.get('css', [])
    for w in m.get('web_accessible_resources', []):
        r += w.get('resources', [])
    a = m.get('action', {})
    if a.get('default_popup'):
        r.append(a['default_popup'])
    for d in (a.get('default_icon') or {}, m.get('icons') or {}):
        r += list(d.values())
    return sorted(set(r))


files = set(manifest_refs(manifest))

# popup.html が読む相対参照は manifest からは辿れないので、HTML から拾う
html = open('src/popup.html', encoding='utf-8').read()
for ref in re.findall(r'(?:src|href)="([^"]+)"', html):
    if re.match(r'^(?:https?:)?//', ref) or ref.startswith('data:'):
        ng('popup.html が外部リソースを読んでいる: ' + ref)
        continue
    files.add(os.path.normpath(os.path.join('src', ref)).replace(os.sep, '/'))

files = sorted(files)

# 1. 収集規則が壊れていないこと（fail-closed）
if len(files) < 12:
    ng('同梱ファイルが少なすぎる（%d 件）。収集規則が壊れている' % len(files))
    sys.exit(1)

# 2. 実在確認
for f in files:
    if not os.path.isfile(f):
        ng('同梱対象が実在しない: ' + f)
if fail[0]:
    sys.exit(1)
ok('同梱対象 %d 件がすべて実在する' % len(files))

# 3. 禁止物が混ざっていないこと
for f in files:
    if f.startswith('test/') or f.startswith('tools/') or f.endswith('.md') or f == 'verify.sh':
        ng('同梱してはいけないものが対象に入っている: ' + f)
if fail[0]:
    sys.exit(1)
ok('test/ tools/ *.md verify.sh が対象に入っていない')

# 4. zip を作る（変換しない。そのまま入れる）
shutil.rmtree('dist', ignore_errors=True)
os.makedirs('dist')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f)
ok('作成: %s (%d バイト)' % (out, os.path.getsize(out)))

with zipfile.ZipFile(out) as z:
    names = sorted(z.namelist())

    # 5. 過不足ゼロ
    if names != files:
        ng('zip の中身が対象と違う')
        print('   余分: %s' % sorted(set(names) - set(files)))
        print('   不足: %s' % sorted(set(files) - set(names)))
    else:
        ok('zip の中身が対象と過不足なく一致（%d 件）' % len(names))

    # 6. 1 バイトも変わっていないこと
    bad = []
    for f in files:
        a = hashlib.sha256(open(f, 'rb').read()).hexdigest()
        b = hashlib.sha256(z.read(f)).hexdigest()
        if a != b:
            bad.append(f)
    if bad:
        ng('内容が違う: %s' % bad)
    else:
        ok('全 %d 件が sha256 まで一致（変換していない証明）' % len(files))

    # 7. zip 単体で manifest の参照が解決すること
    inner = json.loads(z.read('manifest.json'))
    miss = [x for x in manifest_refs(inner) if x not in set(names)]
    if miss:
        ng('zip 内で解決しない参照がある: %s' % miss)
    else:
        ok('zip 単体で manifest の参照がすべて解決する')

    # 8. 審査で弾かれる典型を先に自分で潰す
    for f in names:
        if f.endswith('.js') or f.endswith('.html'):
            body = z.read(f).decode('utf-8', 'replace')
            for pat in ('fetch(', 'XMLHttpRequest', 'eval(', 'new Function'):
                if pat in body:
                    ng('提出物に %s が入っている: %s' % (pat, f))
    if not fail[0]:
        ok('提出物に fetch / XMLHttpRequest / eval / new Function が無い')

print('----')
print('pack: OK  ' + out if not fail[0] else 'pack: NG')
sys.exit(fail[0])
PACK_PY

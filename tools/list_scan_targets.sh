#!/usr/bin/env bash
# 通信スキャン（tools/scan_network.sh）に食わせるファイル一覧を出す。
#   usage: tools/list_scan_targets.sh [root]
#   出力: root からの相対パス（1行1件・重複除去済み）
#   exit 0 = 1件以上出力した / exit 1 = 0件（＝収集規則が壊れている。fail-closed）
#
# なぜ独立したスクリプトか:
#   検査対象が src/ 固定だと、**src の外にファイルを置くだけで走査を逃れられる**（独立検証の指摘6）。
#   「どのファイルを見るか」は検査の一部なので、検査器と同じように回帰で押さえられる形に切り出す。
#
# 収集規則:
#   (a) manifest.json が参照するファイル … 拡張機能として実際に配られるものの閉じた集合。
#       拡張子に関係なく必ず走査する（拡張子の列挙は必ず追いつかなくなるため、
#       「配られるもの」という別の軸を必ず1本通しておく）。
#   (b) 拡張子が js / mjs / cjs / html / htm / css / json のファイル。
#       manifest から参照されていない置き忘れ・仕込みを拾うための仕掛け線。
#
# 除外（理由を必ず書く。黙って外すと検査が空振りする）:
#   * .git/                  … 版管理の内部データ。コードではない。
#   * test/                  … **意図的に違反コードを入れた検体（test/fixtures/bad_net_*.js 等）が
#                               置いてある**。ここを走査すると検体そのもので必ず赤くなり、
#                               検査が「常に赤」＝使い物にならなくなる。
#   * tools/                 … 検査器自身。禁止 API 名を文字列として持っているので必ず当たる。
#   * manifest.json          … 呼び出し側が scan_network.sh の最後の引数として別途渡すため、
#                               ここで出すと同じ違反を二重に数える。
#   * .md / .sh など上記以外の拡張子 … ドキュメントは配られるコードではない。
#                               （SPEC.md・INSTALL.md は外部 URL を含みうるが担当外で編集もできない）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [ ! -d "$ROOT" ]; then
  # 他の検査器と同じ "file:line: " 形式で出す（回帰が「無言の失敗」を許さないため）
  echo "$ROOT:0: root が無い（走査対象を収集できない）"
  exit 1
fi

cd "$ROOT" || exit 1

MANIFEST="manifest.json"
list="$(mktemp)"
trap 'rm -f "$list"' EXIT

# (a) manifest が参照するファイル
if [ -f "$MANIFEST" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("node:fs");
    let m;
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(0); }
    if (m === null || typeof m !== "object") { process.exit(0); }
    const refs = [];
    for (const cs of (m.content_scripts || [])) {
      for (const f of (cs.js || [])) { refs.push(f); }
      for (const f of (cs.css || [])) { refs.push(f); }
    }
    for (const war of (m.web_accessible_resources || [])) {
      for (const f of (war.resources || [])) { refs.push(f); }
    }
    if (m.action && typeof m.action.default_popup === "string") { refs.push(m.action.default_popup); }
    for (const k of Object.keys(m.icons || {})) { refs.push(m.icons[k]); }
    if (m.background && typeof m.background.service_worker === "string") { refs.push(m.background.service_worker); }
    for (const r of refs) {
      const rel = String(r).replace(/^\.\//, "");
      // グロブ（*）はここでは展開しない。実体は (b) の拡張子収集が拾う。
      if (rel.indexOf("*") !== -1) { continue; }
      if (fs.existsSync(rel)) { console.log(rel); }
    }
  ' "$MANIFEST" >> "$list" 2>/dev/null
fi

# (b) コードの拡張子を持つファイル（test/ tools/ .git/ を除く）
find . \
  -path ./.git -prune -o \
  -path ./test -prune -o \
  -path ./tools -prune -o \
  -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \
             -o -name '*.html' -o -name '*.htm' -o -name '*.css' -o -name '*.json' \) -print \
  2>/dev/null | sed 's|^\./||' >> "$list"

# manifest 自身は出さない（呼び出し側が別途渡す）
sort -u "$list" | grep -vxF "$MANIFEST"
count="$(sort -u "$list" | grep -vxF "$MANIFEST" | wc -l)"

if [ "$count" -eq 0 ]; then
  echo "$ROOT:0: 走査対象が0件（収集規則が壊れている。fail-closed で失敗扱い）"
  exit 1
fi
exit 0

#!/usr/bin/env bash
# 「npm 依存ゼロ・ビルド工程ゼロ」を機械検査する。
#   usage: tools/scan_supply_chain.sh [root]
#     root 省略時 … このスクリプトの1つ上（リポジトリのルート）
# 違反行を "path:0: ..." 形式で出力して exit 1。違反が無ければ exit 0。
# set -e には頼らない（途中で落ちて残りの検査が走らないのを防ぐため）。
#
# なぜ要るか:
#   README の「権限方針」は4項目を並べて「README の約束ではなく verify.sh が機械検査する」と
#   書いていた。ところが4つ目（npm 依存ゼロ・ビルド工程ゼロ）だけ、検査が1行も無かった
#   （実測: `grep -c 'npm\|package.json\|node_modules' verify.sh` → 0）。
#   本拡張が批判しているのは「文章の約束だけがあって機構が無い」構造そのものである。
#   自分がそれをやっていたので、書ける範囲まで機構にする。
#
# 検査するもの（3つ）:
#   (1) 依存の成果物が存在しないこと
#       package.json / package-lock.json / npm-shrinkwrap.json / yarn.lock /
#       pnpm-lock.yaml / bun.lockb / node_modules/
#   (2) 典型的なビルド設定が存在しないこと
#       webpack.config.* / vite.config.* / rollup.config.* / esbuild.* / gulpfile.* /
#       babel.config.* / .babelrc（.babelrc.* 含む）/ tsconfig.json / jsconfig.json /
#       Makefile（makefile / GNUmakefile）
#   (3) src/ の .js に ESM の import / export **文**が無いこと
#       SPEC 第0章「content script は classic script。import は使わない」の裏返し。
#       トランスパイル（＝ビルド工程）を前提にしたコードが混入していないことの傍証になる。
#       動的 import(...) は ESM 文ではないので、ここでは見ない（tools/scan_network.sh の担当）。
#
# ------------------------------------------------------------------------------
# この検査が保証しないこと（塞いだふりをしないために先に書く。README にも同じことを書く）
#
#   * **配布物がこのソースそのものである保証はない。** ここで見ているのは作業ツリーだけで、
#     Chrome ウェブストアに提出する zip や、他人が配る版が同じ中身かは何も言えない。
#     それを言うには再現ビルドと署名の照合が要る。この検査の範囲外である。
#   * **「ビルド工程が無い」を直接証明してはいない。** 証明しているのは「よくあるビルド設定の
#     ファイル名が無い」ことだけである。設定名の列挙は必ず追いつかなくなる（新しいバンドラが
#     出れば漏れる）。CI の YAML 内でワンライナーのバンドルを走らせる形も検出できない。
#     これは仕掛け線であって証明ではない。
#   * **「依存ゼロ」も直接証明してはいない。** 他人のコードを src/ に直接貼り付ける（ベンダリング）
#     と、依存の成果物は1つも残らないまま第三者コードが入る。字面では区別できない。
#   * (3) が見るのは字面であり、`globalThis["imp"+"ort"]` のような再構成は原理的に見えない
#     （tools/scan_network.sh の冒頭に書いてある限界と同じもの）。
#
# 保証の重さは manifest 側のホワイトリスト検査（tools/lib/manifest_scan.js）にある。
# ここは「気づかず増えた依存・ビルド工程」を鳴らすための仕掛け線である。
# ------------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [ ! -d "$ROOT" ]; then
  echo "$ROOT:0: root が無い（検査できないので失敗扱い）"
  echo "scan_supply_chain: violations=1 root=$ROOT"
  exit 1
fi

cd "$ROOT" || exit 1

violations=0
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

# ---------------------------------------------------------------- (1) 依存の成果物
DEP_NAMES=(
  "package.json"
  "package-lock.json"
  "npm-shrinkwrap.json"
  "yarn.lock"
  "pnpm-lock.yaml"
  "bun.lockb"
)
for name in "${DEP_NAMES[@]}"; do
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    echo "${f#./}:0: npm 依存の成果物が存在する（README の権限方針: npm 依存ゼロ）" >> "$out"
    violations=$((violations + 1))
  done < <(find . -path ./.git -prune -o -type f -name "$name" -print 2>/dev/null | sort)
done

while IFS= read -r d; do
  [ -n "$d" ] || continue
  echo "${d#./}:0: node_modules/ が存在する（README の権限方針: npm 依存ゼロ）" >> "$out"
  violations=$((violations + 1))
done < <(find . -path ./.git -prune -o -type d -name 'node_modules' -print 2>/dev/null | sort)

# ---------------------------------------------------------------- (2) ビルド設定
BUILD_GLOBS=(
  "webpack.config.*"
  "vite.config.*"
  "rollup.config.*"
  "esbuild.*"
  "gulpfile.*"
  "babel.config.*"
  ".babelrc"
  ".babelrc.*"
  "tsconfig.json"
  "jsconfig.json"
  "Makefile"
  "makefile"
  "GNUmakefile"
)
for g in "${BUILD_GLOBS[@]}"; do
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    echo "${f#./}:0: ビルド工程の設定ファイルが存在する（README の権限方針: ビルド工程ゼロ）" >> "$out"
    violations=$((violations + 1))
  done < <(find . -path ./.git -prune -o -type f -name "$g" -print 2>/dev/null | sort)
done

# ---------------------------------------------------------------- (3) src/ の ESM 文
# `import x from "y"` / `import {a} from "b"` / `import "side"` / `export ...` を行頭で見る。
# 動的 import( は当てない（括弧は続きの文字集合に入れていない）。
# `imports` `exported` のような識別子にも当たらない（続きに空白か { か * を要求する）。
ESM_RE='^[[:space:]]*(import|export)([[:space:]]|[{*])'
if [ ! -d "src" ]; then
  echo "src:0: src/ が無い（ESM 検査ができないので失敗扱い。fail-closed）" >> "$out"
  violations=$((violations + 1))
else
  js_seen=0
  while IFS= read -r f; do
    js_seen=$((js_seen + 1))
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      echo "${hit}" | sed 's/^\([^:]*:[0-9]*\):/\1: ESM の import\/export 文（SPEC 第0章: classic script。ビルド工程を前提にしたコード）:/' >> "$out"
      violations=$((violations + 1))
    done < <(grep -nE "$ESM_RE" "$f" 2>/dev/null | sed "s|^|${f#./}:|")
  done < <(find src -type f -name '*.js' -print 2>/dev/null | sort)
  if [ "$js_seen" -eq 0 ]; then
    echo "src:0: src/ に .js が1件も無い（検査が空振りしている。fail-closed）" >> "$out"
    violations=$((violations + 1))
  fi
fi

[ -s "$out" ] && cat "$out"

echo "scan_supply_chain: violations=$violations root=$ROOT"
if [ "$violations" -gt 0 ]; then
  exit 1
fi
exit 0

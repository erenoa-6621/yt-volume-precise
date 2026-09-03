#!/usr/bin/env bash
# yt-volume-precise の唯一の完了判定。
# exit 0 が全緑。ブラウザ実機の動作確認は含めない（人間の手が要るため）。
#
# 設計上の注意（守ること）:
#   * set -e に頼らない。途中で落ちると残りの項目が検査されず fail 数が過少に見える。
#     各項目の exit code を変数に集計し、最後にまとめて判定する。
#   * 検査器自身の回帰（項目8）を必ず含める。検査が「何も検査していない」状態で緑になる
#     事故を過去に起こしている（verify_article.sh の字数下限 fail-open）。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1
export LC_ALL=C.UTF-8 2>/dev/null || true

# ------------------------------------------------------ 継承されたシェル関数の消毒
# **この位置より前に関数を定義しないこと。**（自分の res / ng まで消してしまう）
#
# なぜ要るか（独立検証の実測で見つかった穴。2026-09-02）:
#   $ bash() { return 0; }; export -f bash; ./verify.sh
#   → 13 項目中 8 項目がスキャナを1本も起動しないまま [OK] を返した。
#   export -f された関数は環境変数 BASH_FUNC_name%% として子プロセスへ継承され、
#   `bash tools/scan_xxx.sh` の `bash` が実行ファイルではなく関数に解決される。
#   下の環境変数の消毒（YTVP_*）は変数しか見ておらず、関数はその外にあった。
#   脅威モデル（cron・自動実行のジョブ・CI は環境を継承する）は同じなのに、
#   経路だけが未対処だった。
#
# unset -f は関数表からも export 属性からも消す＝子プロセスの環境からも消える
# （実測: 消毒後に BASH_FUNC_ の環境変数は 0 件、子の bash は正常に実行される）。
#
# ここで使う変数名に YTVP_ 接頭辞を付けないこと。tools/scan_hooks.sh は
# 「YTVP_ で始まる環境変数の読み取り」でフックを発見するため誤検知になる
# （tools/lib/env_hooks.sh の注意書きと同じ理由）。
INHERITED_FUNCS=""
while read -r _dcl _flg _fn; do
  [ -n "$_fn" ] || continue
  INHERITED_FUNCS="$INHERITED_FUNCS $_fn"
  unset -f "$_fn" 2>/dev/null || true
done < <(declare -F)
unset _dcl _flg _fn
INHERITED_FUNCS="${INHERITED_FUNCS# }"

# 消毒だけでは足りない。**汚染された環境で得た結果は採用しない**（fail-closed）。
#   理由: 消毒が成功したかどうかを、消毒された側の道具（declare / unset そのもの）で
#   確かめている以上、これは自己申告である。実測でも `declare(){ return 0; }` を
#   一緒に継承させると上の while ループは空回りし、消毒も検知も同時に盲になる
#   （そのときに残る最後の防波堤が、下の「空振り検知」＝署名の要求である）。
# 逃げ道は引数だけにする。環境変数にすると、環境を握った側がそのまま解除できてしまう
# （--no-verify-recursion と同じ流儀）。
TAINTED=0
[ -n "$INHERITED_FUNCS" ] && TAINTED=1
for arg in "$@"; do
  case "$arg" in
    # 正当に export -f された関数がある環境（一部の CI イメージ等）向けの明示的な解除。
    # 消毒そのものは解除しない。解除するのは「不採用にする」判定だけ。
    --allow-inherited-functions) TAINTED=0 ;;
    *) echo "usage: $0 [--allow-inherited-functions]"; exit 2 ;;
  esac
done
unset arg

# ------------------------------------------------------------------ 環境の消毒
# 検査対象を差し替える環境変数フック（YTVP_VOLUME_PATH 等）を、テストやスキャナを
# 起動する前に明示的に殺す。口そのものは回帰（mutation testing）に要るので残すが、
# verify.sh の内側では効かせない。
#   なぜ: cron・自動実行のジョブ・CI は環境を継承する。継承された値を
#   「たまたま設定されていなかったから大丈夫」で通すと、検査対象が黙って
#   すり替わる。同型の事故は実際に起きている（別の検査スクリプトで、字数下限が
#   LC_ALL 未指定のためバイトを数え、1500字下限が実質500字に fail-open した）。
# フック名の一覧は tools/lib/env_hooks.sh に1箇所だけ置く。
# 追加のし忘れは項目10（tools/scan_hooks.sh）が検知する。
# shellcheck source=tools/lib/env_hooks.sh
. "$ROOT/tools/lib/env_hooks.sh" || { echo "[NG] tools/lib/env_hooks.sh を読めない"; exit 1; }
ytvp_unset_env_hooks

PASS=0
FAIL=0

ok()  { echo "[OK] $1"; PASS=$((PASS + 1)); }
ng()  { echo "[NG] $1"; FAIL=$((FAIL + 1)); }
res() { # $1=rc $2=説明
  if [ "$TAINTED" -ne 0 ]; then
    ng "$2 ← 汚染環境のため不採用（起動時に継承された関数:$INHERITED_FUNCS）"
    return
  fi
  if [ "$1" -eq 0 ]; then ok "$2"; else ng "$2"; fi
}

# ------------------------------------------------------------------ 空振り検知
# **「exit code が 0 だから緑」をやめる。** 何も実行しなくても exit 0 は返る。
# 各項目は「検査器が実際に走った証跡（署名行）」を要求し、無ければ赤にする。
# 署名は各スキャナが成功時にも違反時にも必ず出す1行（例 `scan_permissions: violations=0 target=...`）。
#
# 照合に grep を使わない。grep 自体を関数で置き換えられる経路を塞いでいるのに、
# その判定を grep に任せたら意味がない（実測: `grep(){ return 0; }` で項目が緑に化ける）。
# 以下の3関数は bash の組み込みだけで書いてある。
#
# **この署名が保証しないこと（先に書く）**:
#   署名は「検査器が起動して最後まで走った」ことまでしか言わない。
#   「検査器の内部で使う道具（grep 等）が正しく動いた」ことは言わない。
#   実測: 消毒器を盲にした上で grep を殺すと、scan_static は署名を出しつつ violations=0 になる。
#   そこを押さえるのは項目8の回帰（既知の違反検体で赤くなることの実測）であり、
#   同じ実測でも項目8は赤くなる。**署名と回帰は別の層であって、片方では足りない。**
has_sig() { # $1=署名 $2=出力
  case "$2" in *"$1"*) return 0 ;; *) return 1 ;; esac
}
num_after() { # $1=出力 $2=ラベル → ラベル直後の数値を出力（無ければ空で exit 1）
  local rest n
  case "$1" in *"$2"*) rest="${1#*"$2"}" ;; *) return 1 ;; esac
  n="${rest%%[!0-9]*}"
  [ -n "$n" ] || return 1
  printf '%s' "$n"
}
show() { # $1=出力（インデントして出す。外部コマンドを使わない）
  local l
  while IFS= read -r l; do printf '     %s\n' "$l"; done <<< "$1"
}
res_sig() { # $1=rc $2=出力 $3=署名 $4=説明
  if ! has_sig "$3" "$2"; then
    ng "$4 ← 空振り検知: 検査器の署名 \"$3\" が出力に無い（検査器が実行されていない）"
    show "$2"
    return 1
  fi
  res "$1" "$4"
}
res_node_test() { # $1=rc $2=出力 $3=説明
  local n
  n="$(num_after "$2" '# tests ')"
  if [ -z "$n" ] || [ "$n" -lt 1 ]; then
    ng "$3 ← 空振り検知: node --test の集計行（# tests N）が無い、または 0 件"
    show "$2"
    return 1
  fi
  res "$1" "$3"
}

# 項目0は汚染時だけ出す（通常実行の項目数を変えないため）。
if [ "$TAINTED" -ne 0 ]; then
  ng "0. 環境の健全性: 継承された export 済みシェル関数を検出（$INHERITED_FUNCS）。unset -f で消毒したが、この実行は認証しない"
  echo "     消毒済みなので下の各項目は正しく実行される。だが起動時の環境が細工されていた以上、"
  echo "     この実行の結果を完了判定に使わない（fail-closed）。正当な環境なら --allow-inherited-functions を付けて起動すること。"
fi

# ------------------------------------------------------------------ 1. 必須ファイル
REQUIRED_FILES=(
  "manifest.json"
  "src/lib/volume.js"
  "src/page.js"
  "src/content.js"
  "src/overlay.js"
  "src/overlay.css"
  "src/popup.html"
  "src/popup.css"
  "src/popup.js"
  "test/volume.test.js"
  "test/manifest.test.js"
  "test/integration.test.js"
  "test/helpers/wiring.js"
  "tools/scan_permissions.sh"
  "tools/scan_network.sh"
  "tools/list_scan_targets.sh"
  "tools/scan_static.sh"
  "tools/scan_contract.sh"
  "tools/scan_hooks.sh"
  "tools/scan_doc_cites.sh"
  "tools/scan_supply_chain.sh"
  "tools/lib/doc_cite_scan.js"
  "tools/lib/env_hooks.sh"
  "verify.sh"
)
missing=0
checked=0
for f in "${REQUIRED_FILES[@]}"; do
  checked=$((checked + 1))
  if [ ! -f "$f" ]; then
    echo "     missing: $f"
    missing=$((missing + 1))
  fi
done
# 空振り検知: 宣言した件数を実際に見たか（配列が空になる／ループが回らない事故を赤にする）
if [ "$checked" -ne "${#REQUIRED_FILES[@]}" ] || [ "$checked" -lt 20 ]; then
  ng "1. 必須ファイルの実在 ← 空振り検知: 検査したのは $checked 件（宣言 ${#REQUIRED_FILES[@]} 件・下限 20 件）"
else
  res "$missing" "1. 必須ファイルの実在（SPEC 第1章。不足 $missing 件）"
fi

# ------------------------------------------------------------------ 2. node --check
syntax_bad=0
js_count=0
while IFS= read -r f; do
  js_count=$((js_count + 1))
  if ! out="$(node --check "$f" 2>&1)"; then
    echo "     $f: $(echo "$out" | head -3 | tr '\n' ' ')"
    syntax_bad=$((syntax_bad + 1))
  fi
done < <(find . -path ./.git -prune -o -type f -name '*.js' -print | sort)
if [ "$js_count" -eq 0 ]; then
  syntax_bad=1
  echo "     .js が1つも見つからない"
fi
# 空振り検知（陽性対照）: 構文が壊れている検体を node --check が **落とすこと** を毎回確かめる。
# node が関数で置き換えられていると「全部通った」と「node が何もしていない」が
# 区別できない。検体の拡張子を .cjs にしてあるのは、上の走査（*.js 全数）が
# この意図的な壊れ物を拾って自分で赤くならないようにするため。
PROBE_BAD_JS="test/fixtures/probe/syntax_broken.cjs"
if [ ! -f "$PROBE_BAD_JS" ]; then
  ng "2. 全 .js が node --check を通る ← 空振り検知: 陽性対照 $PROBE_BAD_JS が無い"
else
  probe_out="$(node --check "$PROBE_BAD_JS" 2>&1)"
  probe_rc=$?
  if [ "$probe_rc" -eq 0 ] || ! has_sig "SyntaxError" "$probe_out"; then
    ng "2. 全 .js が node --check を通る ← 空振り検知: 壊れた JS を node --check が通した（rc=$probe_rc）＝node が実行されていない"
    show "$probe_out"
  else
    res "$syntax_bad" "2. 全 .js が node --check を通る（$js_count 件、失敗 $syntax_bad 件）"
  fi
fi

# ------------------------------------------------------------------ 3. node --test
# 注: node v22.21.1 では `node --test test/` はディレクトリをテストファイルとして
#     require しようとして失敗する（MODULE_NOT_FOUND）。glob 形式を使う。
#     fixtures を巻き込まないためにも *.test.js に限定する。
test_out="$(node --test 'test/**/*.test.js' 2>&1)"
test_rc=$?
echo "$test_out" | grep -E '^# (tests|pass|fail)' | sed 's/^/     /'
if [ "$test_rc" -ne 0 ]; then
  echo "$test_out" | grep -E '^(not ok|# Subtest)' | head -20 | sed 's/^/     /'
fi
res_node_test "$test_rc" "$test_out" "3. node --test 'test/**/*.test.js' が緑"

# ------------------------------------------------------------------ 4. 権限スキャン
perm_out="$(bash tools/scan_permissions.sh manifest.json 2>&1)"
perm_rc=$?
[ "$perm_rc" -ne 0 ] && echo "$perm_out" | sed 's/^/     /'
res_sig "$perm_rc" "$perm_out" "scan_permissions: violations=" "4. tools/scan_permissions.sh"

# ------------------------------------------------------------------ 5. 通信スキャン
# 走査対象を src/ に固定しない。固定すると **src の外にファイルを1つ置くだけで走査を逃れられる**
# （独立検証の指摘6。旧: bash tools/scan_network.sh src manifest.json）。
# 「どのファイルを見るか」自体が検査の一部なので tools/list_scan_targets.sh に切り出し、
# 収集規則と除外理由（test/ は意図的な違反検体、tools/ は検査器自身）をそこに書いてある。
# 収集が0件なら list_scan_targets.sh 側が exit 1 する（fail-closed）。
net_list="$(bash tools/list_scan_targets.sh 2>&1)"
net_list_rc=$?
net_targets=()
if [ "$net_list_rc" -eq 0 ] && [ -n "$net_list" ]; then
  while IFS= read -r _t; do
    [ -n "$_t" ] && net_targets+=("$_t")
  done <<< "$net_list"
fi
if [ "$net_list_rc" -ne 0 ] || [ "${#net_targets[@]}" -eq 0 ]; then
  echo "$net_list" | sed 's/^/     /'
  ng "5. tools/scan_network.sh（走査対象の収集に失敗。list_scan_targets.sh を見ること）"
elif ! printf '%s\n' "${net_targets[@]}" | grep -qxF 'src/content.js'; then
  # 収集規則が壊れて「当たり前に入るはずのファイル」を落としていないかの空振り検知。
  printf '     %s\n' "${net_targets[@]}"
  ng "5. tools/scan_network.sh（走査対象に src/content.js が入っていない＝収集規則が壊れている）"
else
  net_out="$(bash tools/scan_network.sh "${net_targets[@]}" manifest.json 2>&1)"
  net_rc=$?
  [ "$net_rc" -ne 0 ] && echo "$net_out" | sed 's/^/     /'
  res_sig "$net_rc" "$net_out" "scan_network: violations=" \
    "5. tools/scan_network.sh（走査対象 ${#net_targets[@]} 件 + manifest.json）"
fi

# ------------------------------------------------------------------ 6. popup.html
# 本体は tools/scan_static.sh（検査器自身を回帰テストできるよう切り出してある）
popup_out="$(bash tools/scan_static.sh popup src/popup.html 2>&1)"
popup_rc=$?
[ "$popup_rc" -ne 0 ] && echo "$popup_out" | sed 's/^/     /'
res_sig "$popup_rc" "$popup_out" "scan_static(popup): violations=" \
  "6. src/popup.html にインライン script / on* ハンドラが無い"

# ------------------------------------------------------------------ 7. overlay.js
ov_out="$(bash tools/scan_static.sh overlay src/overlay.js 2>&1)"
ov_rc=$?
[ "$ov_rc" -ne 0 ] && echo "$ov_out" | sed 's/^/     /'
res_sig "$ov_rc" "$ov_out" "scan_static(overlay): violations=" \
  "7. src/overlay.js に chrome. の参照が無い（UI は chrome API を持たない）"

# ------------------------------------------------------------------ 8. 検査器の回帰
# --no-verify-recursion: 回帰の中に「verify.sh を環境変数付きで起動する」ケースがあるため、
# verify.sh から呼ぶときだけそのケースを外す（さもないと無限再帰する）。
# 環境変数ではなく引数で渡すのは、環境から黙って検査を減らせる口を作らないため。
reg_out="$(bash tools/tests/run_scanner_regress.sh --no-verify-recursion 2>&1)"
reg_rc=$?
echo "$reg_out" | tail -1 | sed 's/^/     /'
if [ "$reg_rc" -ne 0 ]; then
  echo "$reg_out" | grep '^\[NG\]' | sed 's/^/     /'
fi
# 空振り検知: 回帰の集計行（scanner_regress: pass=N）が出ていること、かつ N が下限を上回ること。
# exit code だけを見ていると、回帰が1件も走らなくても緑になる（実測で起きた）。
# 下限は「検体が丸ごと消えた／ループが回らなくなった」を捕まえるための粗い網であり、
# 件数の正しさを主張するものではない。件数が増えたときに下限を上げる義務はない。
REG_MIN_PASS=100
reg_pass="$(num_after "$reg_out" 'scanner_regress: pass=')"
if [ -z "$reg_pass" ]; then
  ng "8. 検査器自身の回帰 ← 空振り検知: 集計行 \"scanner_regress: pass=\" が出力に無い（回帰が実行されていない）"
  show "$reg_out"
elif [ "$reg_pass" -lt "$REG_MIN_PASS" ]; then
  ng "8. 検査器自身の回帰 ← 空振り検知: 回帰の pass 数が $reg_pass（下限 $REG_MIN_PASS 未満）"
else
  res "$reg_rc" "8. 検査器自身の回帰（tools/tests/run_scanner_regress.sh・pass=$reg_pass）"
fi

# ------------------------------------------------------------------ 9. SPEC 7章の契約
# 担当をまたぐ契約なので、どちらの担当のテストにも入らない。ここで機構として押さえる。
c1_out="$(bash tools/scan_contract.sh nowheel src/content.js 2>&1)"
c1_rc=$?
c2_out="$(bash tools/scan_contract.sh overlayroot src/overlay.js 2>&1)"
c2_rc=$?
contract_rc=$(( c1_rc + c2_rc ))
[ "$c1_rc" -ne 0 ] && echo "$c1_out" | sed 's/^/     /'
[ "$c2_rc" -ne 0 ] && echo "$c2_out" | sed 's/^/     /'
if ! has_sig "scan_contract(nowheel): violations=" "$c1_out" \
   || ! has_sig "scan_contract(overlayroot): violations=" "$c2_out"; then
  ng "9. SPEC 7章の契約 ← 空振り検知: scan_contract の署名が両方そろっていない（検査器が実行されていない）"
  show "$c1_out"; show "$c2_out"
else
  res "$contract_rc" "9. SPEC 7章の契約（content.js に wheel リスナ無し / overlay.js は class=ytvp-root）"
fi

# ------------------------------------------------------------------ 10. フック定義の一致
# 「検査対象を差し替える環境変数」が後から足され、上の unset から漏れる事故を防ぐ。
hook_out="$(bash tools/scan_hooks.sh 2>&1)"
hook_rc=$?
[ "$hook_rc" -ne 0 ] && echo "$hook_out" | sed 's/^/     /'
# 空振り検知: 署名に加えて declared=N を要求する。宣言が0件だと「照合すべきものが無い」
# 状態でも violations=0 になれるため（フック一覧が空になる事故を赤にする）。
hook_declared="$(num_after "$hook_out" 'declared=')"
if ! has_sig "scan_hooks: violations=" "$hook_out"; then
  ng "10. 環境変数フックの宣言と unset が一致 ← 空振り検知: 署名 \"scan_hooks: violations=\" が出力に無い"
  show "$hook_out"
elif [ -z "$hook_declared" ] || [ "$hook_declared" -lt 1 ]; then
  ng "10. 環境変数フックの宣言と unset が一致 ← 空振り検知: declared=$hook_declared（宣言0件では何も照合していない）"
  show "$hook_out"
else
  res "$hook_rc" "10. 環境変数フックの宣言と unset が一致（tools/scan_hooks.sh・declared=$hook_declared）"
fi

# ------------------------------------------------------------------ 11. 結合部
# content.js と popup.js は互いのコードを読まずに実装する契約で書かれたので、
# 両者の継ぎ目はどちらの単体テストにも入らない。ここで機構として押さえる。
#   継ぎ目1: popup が投げる setSettings の payload 形状を content が受理するか
#   継ぎ目2: setSettings の応答が設定の全キーを返し、boostAllowed を落とさないか
#   継ぎ目3: manifest の判定側と権限側と注入側が同じホスト集合か
#   継ぎ目4: ブーストが往復するか（popup ⇄ content。一方通行にならないか。SPEC 3-d）
#   継ぎ目5: overlay がブーストボタンを常に生成し、押せるか（SPEC 3-d/5・65b4ccf）
#   継ぎ目6: MAIN world の注入が遅れても state.boost が settings.boostAllowed と食い違わないか
#           （SPEC 3-d・c8c17e9）
# この検査が空振りでないことは項目8（回帰）が「壊した検体で赤くなる」ことで実測している。
integ_out="$(node --test test/integration.test.js 2>&1)"
integ_rc=$?
echo "$integ_out" | grep -E '^# (tests|pass|fail)' | sed 's/^/     /'
if [ "$integ_rc" -ne 0 ]; then
  echo "$integ_out" | grep -E '^not ok' | head -20 | sed 's/^/     /'
fi
res_node_test "$integ_rc" "$integ_out" "11. popup ⇄ content の結合（test/integration.test.js）"

# ------------------------------------------------------------------ 12. 文書の引用
# INSTALL.md は「根拠は推測ではなく manifest とコード」と自称している。だがその自称を
# 検査する機構が無いまま書かれていたため、行番号が外れた引用が4件残っていた
# （抜き取りで2件、その後の全数検算でさらに2件）。
# 権限も継ぎ目も「文章の約束」から「機構」へ落としてきたのに、文書だけが例外だった。
# **文書が自分の正しさを主張するなら、その主張を検査するものが要る。**
#
# --min-anchor-checked 10 を付けて呼ぶ理由（空振り検知）:
#   この検査は「アンカー語が適用できる引用だけ」内容まで見て、適用できないものは黙って
#   飛ばす（過検知して文書を歪めないため）。つまり規則が当たらなくなると全件スキップ＝
#   何も検査していない状態でも緑になれる。下限を機構で押さえて、そのときに赤くする。
# 保証すること・しないことは tools/scan_doc_cites.sh の冒頭コメントに書いてある。
cite_out="$(bash tools/scan_doc_cites.sh --min-anchor-checked 10 INSTALL.md 2>&1)"
cite_rc=$?
echo "$cite_out" | grep '^scan_doc_cites:' | sed 's/^/     /'
if [ "$cite_rc" -ne 0 ]; then
  echo "$cite_out" | grep -v '^scan_doc_cites:' | sed 's/^/     /'
fi
res_sig "$cite_rc" "$cite_out" "scan_doc_cites: " \
  "12. INSTALL.md の file:行番号 引用が腐っていない（tools/scan_doc_cites.sh）"

# ------------------------------------------------------------------ 13. 供給経路
# README の「権限方針」は4項目を並べて「README の約束ではなく verify.sh が機械検査する」と
# 書いていたが、4つ目（npm 依存ゼロ・ビルド工程ゼロ）だけ検査が1行も無かった
# （実測: grep -c 'npm|package.json|node_modules' verify.sh → 0）。
# 本拡張が批判しているのは「文章の約束はあるが機構が無い」構造そのものなので、
# 書ける範囲を機構にする。
#
# **この項目が保証しないことを先に書く**（詳細は tools/scan_supply_chain.sh の冒頭）:
#   * 配布物（ストアに出す zip）がこのソースそのものである保証はしない。見ているのは作業ツリーだけ。
#   * 「ビルド工程が無い」ではなく「よくあるビルド設定のファイル名が無い」までしか言えない。
#     設定名の列挙は必ず追いつかなくなる。仕掛け線であって証明ではない。
#   * ベンダリング（他人のコードを src/ に直接貼る）は依存の成果物を残さないので検出できない。
# README 側にも同じ内容を、行ごとに「検査される／されない」の形で書いてある。
sc_out="$(bash tools/scan_supply_chain.sh 2>&1)"
sc_rc=$?
echo "$sc_out" | grep '^scan_supply_chain:' | sed 's/^/     /'
if [ "$sc_rc" -ne 0 ]; then
  echo "$sc_out" | grep -v '^scan_supply_chain:' | sed 's/^/     /'
fi
res_sig "$sc_rc" "$sc_out" "scan_supply_chain: violations=" \
  "13. npm 依存の成果物・ビルド設定が無い / src の .js に ESM 文が無い（tools/scan_supply_chain.sh）"

# ------------------------------------------------------------------ 判定
echo "----"
echo "pass=$PASS fail=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

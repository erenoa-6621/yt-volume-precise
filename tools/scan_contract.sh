#!/usr/bin/env bash
# SPEC 第7章で確定した「担当をまたぐ契約」の静的検査。
#   usage: tools/scan_contract.sh nowheel     [src/content.js]
#          tools/scan_contract.sh overlayroot [src/overlay.js]
#
# nowheel     : content.js が wheel リスナを一切持たないこと。
#               SPEC 7章でホイールの所有者は overlay.js ただ一人に確定した。
#               旧 SPEC は A と B の双方に書かせており、二重発火の原因だった。
# overlayroot : overlay.js のルート要素が class="ytvp-root" を持つこと（SPEC 7章の契約）。
#               overlay.js が付ける class 名を content.js 側が当て推量する穴を塞ぐための契約。
#
# 引数で検体を差し替えられる（回帰にかけられない検査は作らない）。
# 違反行を "file:line: ..." 形式で出力して exit 1。違反が無ければ exit 0。
# set -e には頼らない。

MODE="$1"
TARGET="$2"
violations=0

# 行番号を保ったままコメント行を空にする（コメント中の言及は違反にしない）
strip_comments() { sed -E 's@^[[:space:]]*(//|\*|/\*).*@@' "$1"; }

case "$MODE" in
  nowheel)
    TARGET="${TARGET:-src/content.js}"
    if [ ! -f "$TARGET" ]; then
      echo "$TARGET:0: ファイルが存在しない（検査できないので失敗扱い）"
      echo "scan_contract(nowheel): violations=1 target=$TARGET"
      exit 1
    fi
    WHEEL_RE='addEventListener[[:space:]]*\([[:space:]]*['"'"'"](wheel|mousewheel|DOMMouseScroll)['"'"'"]'
    ONWHEEL_RE='(^|[^A-Za-z0-9_$.])on(wheel|mousewheel)[[:space:]]*='
    clean="$(strip_comments "$TARGET")"
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "$TARGET:${line%%:*}: wheel リスナ（SPEC 7章: 所有者は overlay.js ただ一人。content.js は持たない）: ${line#*:}"
      violations=$((violations + 1))
    done < <(printf '%s\n' "$clean" | grep -nE "$WHEEL_RE|$ONWHEEL_RE")
    echo "scan_contract(nowheel): violations=$violations target=$TARGET"
    ;;
  overlayroot)
    TARGET="${TARGET:-src/overlay.js}"
    if [ ! -f "$TARGET" ]; then
      echo "$TARGET:0: ファイルが存在しない（検査できないので失敗扱い）"
      echo "scan_contract(overlayroot): violations=1 target=$TARGET"
      exit 1
    fi
    # class 名として使われている 'ytvp-root' を探す（コメント中の言及は数えない）。
    # 'ytvp-root' / "ytvp-root ..." / class="ytvp-root" のいずれの書き方でも拾う。
    ROOT_RE='['"'"'"]ytvp-root([[:space:]][^'"'"'"]*)?['"'"'"]'
    clean="$(strip_comments "$TARGET")"
    hits="$(printf '%s\n' "$clean" | grep -nE "$ROOT_RE")"
    if [ -z "$hits" ]; then
      echo "$TARGET:0: ルート要素の class 契約 'ytvp-root' が見つからない（SPEC 7章）"
      violations=$((violations + 1))
    else
      echo "$TARGET: ytvp-root を $(printf '%s\n' "$hits" | grep -c .) 箇所で確認"
    fi
    echo "scan_contract(overlayroot): violations=$violations target=$TARGET"
    ;;
  *)
    echo "usage: tools/scan_contract.sh {nowheel|overlayroot} [path]"
    exit 1
    ;;
esac

if [ "$violations" -gt 0 ]; then
  exit 1
fi
exit 0

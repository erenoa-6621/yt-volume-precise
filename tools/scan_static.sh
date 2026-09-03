#!/usr/bin/env bash
# 静的な作法の検査。verify.sh の項目6・7の本体（回帰テストできるよう切り出してある）。
#   usage: tools/scan_static.sh popup   [src/popup.html]
#          tools/scan_static.sh overlay [src/overlay.js]
# 違反行を出力して exit 1。違反が無ければ exit 0。set -e には頼らない。

MODE="$1"
TARGET="$2"
violations=0

case "$MODE" in
  popup)
    TARGET="${TARGET:-src/popup.html}"
    if [ ! -f "$TARGET" ]; then
      echo "$TARGET:0: ファイルが存在しない（検査できないので失敗扱い）"
      echo "scan_static(popup): violations=1 target=$TARGET"
      exit 1
    fi
    # src= を持たない <script> 開始タグ＝インラインスクリプト
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "$TARGET:${line%%:*}: インライン script: ${line#*:}"
      violations=$((violations + 1))
    done < <(grep -nE '<script([[:space:]][^>]*)?>' "$TARGET" | grep -vE 'src=')
    # インライン on* ハンドラ
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "$TARGET:${line%%:*}: インライン on* ハンドラ: ${line#*:}"
      violations=$((violations + 1))
    done < <(grep -nEi '(^|[[:space:]])on[a-z]+[[:space:]]*=[[:space:]]*["'"'"']' "$TARGET")
    echo "scan_static(popup): violations=$violations target=$TARGET"
    ;;
  overlay)
    TARGET="${TARGET:-src/overlay.js}"
    if [ ! -f "$TARGET" ]; then
      echo "$TARGET:0: ファイルが存在しない（検査できないので失敗扱い）"
      echo "scan_static(overlay): violations=1 target=$TARGET"
      exit 1
    fi
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "$TARGET:${line%%:*}: chrome API 参照（UI は chrome を持たない設計）: ${line#*:}"
      violations=$((violations + 1))
    done < <(grep -nE '(^|[^A-Za-z0-9_$])chrome[[:space:]]*\.' "$TARGET")
    echo "scan_static(overlay): violations=$violations target=$TARGET"
    ;;
  *)
    echo "usage: tools/scan_static.sh {popup|overlay} [path]"
    exit 1
    ;;
esac

if [ "$violations" -gt 0 ]; then
  exit 1
fi
exit 0

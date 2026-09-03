#!/usr/bin/env bash
# manifest の権限ホワイトリスト検査。
#   usage: tools/scan_permissions.sh [manifest.json]
# 違反行を出力して exit 1。違反が無ければ exit 0。
# set -e には頼らない（途中で落ちて検査が飛ぶのを防ぐため）。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${1:-manifest.json}"
SCANNER="$SCRIPT_DIR/lib/manifest_scan.js"

if [ ! -f "$SCANNER" ]; then
  echo "scan_permissions: 検査本体が無い: $SCANNER"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "scan_permissions: node が無い（検査できないので失敗扱い）"
  exit 1
fi

node "$SCANNER" "$MANIFEST"
rc=$?
exit "$rc"

#!/usr/bin/env bash
# 環境変数フック（検査対象を差し替える口）の宣言と、verify.sh の unset 対象が
# 一致していることを検査する。
#
#   usage: tools/scan_hooks.sh [def_file] [verify_sh] [scan_root ...]
#   既定:  tools/scan_hooks.sh tools/lib/env_hooks.sh verify.sh src test tools verify.sh
#
# 検査する3点:
#   1. ソースで読まれている YTVP_* 環境変数が、すべて def_file に宣言されている
#      （宣言し忘れ＝verify.sh が unset しない＝穴の復活）
#   2. def_file の宣言が、すべて実際に読まれている（宣言だけが残って腐るのを防ぐ）
#   3. verify.sh が宣言された全フックを無効化している
#      （ytvp_unset_env_hooks の呼び出し、または各名の明示 unset）
#
# 違反行を "file:line: ..." 形式で出力して exit 1。違反が無ければ exit 0。
# set -e には頼らない（途中で落ちて残りが検査されないのを防ぐため）。

DEF_FILE="tools/lib/env_hooks.sh"
VERIFY_SH="verify.sh"
SCAN_ROOTS=()
if [ "$#" -ge 1 ]; then DEF_FILE="$1"; shift; fi
if [ "$#" -ge 1 ]; then VERIFY_SH="$1"; shift; fi
if [ "$#" -ge 1 ]; then SCAN_ROOTS=("$@"); else SCAN_ROOTS=(src test tools verify.sh); fi

violations=0

fail_hard() {
  echo "$1"
  echo "scan_hooks: violations=1 def=$DEF_FILE verify=$VERIFY_SH"
  exit 1
}
[ -f "$DEF_FILE" ]  || fail_hard "$DEF_FILE:0: フック定義ファイルが存在しない（検査できないので失敗扱い）"
[ -f "$VERIFY_SH" ] || fail_hard "$VERIFY_SH:0: 検査スクリプトが存在しない（検査できないので失敗扱い）"

# ---------------------------------------------------------------- 宣言の読み出し
declared="$(bash -c 'ENV_HOOK_NAMES=(); . "$1" >/dev/null 2>&1;
                     for h in "${ENV_HOOK_NAMES[@]}"; do echo "$h"; done' _ "$DEF_FILE" 2>/dev/null | sort -u)"
if [ -z "$declared" ]; then
  echo "$DEF_FILE:1: ENV_HOOK_NAMES が空、または読み出せない"
  violations=$((violations + 1))
fi

def_line_of() { local n; n="$(grep -nF -- "$1" "$DEF_FILE" | head -1 | cut -d: -f1)"; echo "${n:-1}"; }

# ---------------------------------------------------------------- 実使用の発見
# JS:    process.env.YTVP_X / process.env['YTVP_X']
# Shell: $YTVP_X / ${YTVP_X...}
# 定義ファイル自身は「宣言」なので走査から外す（自己検知を避ける）。
JS_RE='process\.env(\.|\[[[:space:]]*['"'"'"])YTVP_[A-Z0-9_]+'
SH_RE='\$\{?YTVP_[A-Z0-9_]+'

abspath() { printf '%s/%s\n' "$(cd "$(dirname "$1")" 2>/dev/null && pwd)" "$(basename "$1")"; }
DEF_ABS="$(abspath "$DEF_FILE")"

used="$(mktemp)"
trap 'rm -f "$used"' EXIT
: > "$used"

for root in "${SCAN_ROOTS[@]}"; do
  [ -e "$root" ] || continue
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    [ "$(abspath "$f")" = "$DEF_ABS" ] && continue
    # コメント行は行番号を保ったまま空にしてから走査する（説明文の中の YTVP_X を拾わない）
    clean="$(sed -E 's@^[[:space:]]*(#|//|\*|/\*).*@@' "$f")"
    { printf '%s\n' "$clean" | grep -noE "$JS_RE" 2>/dev/null;
      printf '%s\n' "$clean" | grep -noE "$SH_RE" 2>/dev/null; } \
    | while IFS= read -r hit; do
        ln="${hit%%:*}"; m="${hit#*:}"
        nm="$(printf '%s' "$m" | grep -oE 'YTVP_[A-Z0-9_]+' | head -1)"
        [ -n "$nm" ] && printf '%s %s %s\n' "$nm" "$f" "$ln"
      done >> "$used"
  done < <(
    if [ -d "$root" ]; then
      # 検体（fixtures）は「検査される側の作り物」なので既定の走査から外す。
      # ただし root 自体が fixtures 配下を指しているときは外さない
      # （この検査器自身の回帰が検体を走査できなくなるため）。
      case "$root" in
        *fixtures*) find "$root" -type f \( -name '*.js' -o -name '*.sh' \) -print 2>/dev/null ;;
        *)          find "$root" -type f \( -name '*.js' -o -name '*.sh' \) -not -path '*/fixtures/*' -print 2>/dev/null ;;
      esac
    else
      echo "$root"
    fi
  )
done
sort -u "$used" -o "$used"

used_names="$(cut -d' ' -f1 "$used" | sort -u)"

# 1) 未宣言のフック
while read -r name file ln; do
  [ -z "$name" ] && continue
  if ! printf '%s\n' "$declared" | grep -qx -- "$name"; then
    echo "$file:$ln: 未宣言の環境変数フック $name（$DEF_FILE の ENV_HOOK_NAMES に足すこと。verify.sh が unset せず穴になる）"
    violations=$((violations + 1))
  fi
done < "$used"

# 2) 宣言されているが読まれていないフック
while IFS= read -r name; do
  [ -z "$name" ] && continue
  if ! printf '%s\n' "$used_names" | grep -qx -- "$name"; then
    echo "$DEF_FILE:$(def_line_of "$name"): 宣言 $name がどこからも読まれていない（腐った宣言。消すか使う側を直すこと）"
    violations=$((violations + 1))
  fi
done <<< "$declared"

# 3) verify.sh が全宣言フックを無効化しているか
# コメント行は無効化された記述なので数えない（`# ytvp_unset_env_hooks` で通ってしまうと
# 「殺しているように見えて殺していない」状態を検知できなくなる）。
verify_clean="$(sed -E 's@^[[:space:]]*#.*@@' "$VERIFY_SH")"
verify_unsets_all=0
if printf '%s\n' "$verify_clean" | grep -qE '(^|[^A-Za-z0-9_])ytvp_unset_env_hooks([^A-Za-z0-9_]|$)'; then
  verify_unsets_all=1
fi
if [ "$verify_unsets_all" -eq 0 ]; then
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if ! printf '%s\n' "$verify_clean" | grep -qE "unset[^#]*(^|[^A-Za-z0-9_])$name([^A-Za-z0-9_]|\$)"; then
      echo "$VERIFY_SH:0: 宣言フック $name を unset していない（環境変数で検査対象を乗っ取られる）"
      violations=$((violations + 1))
    fi
  done <<< "$declared"
fi

echo "scan_hooks: violations=$violations def=$DEF_FILE verify=$VERIFY_SH declared=$(printf '%s\n' "$declared" | grep -c .)"
[ "$violations" -gt 0 ] && exit 1
exit 0

#!/usr/bin/env bash
# 検査対象を差し替える環境変数フックの唯一の定義箇所。
#
# なぜ1箇所に集めるか:
#   これらの環境変数は「検査が何を測っているか」を黙って変える口である。
#   回帰（mutation testing）には必要なので口自体は残すが、verify.sh の内側では必ず殺す。
#   同型の事故は実際に起きている（別の検査スクリプトで、字数下限が LC_ALL 未指定のため
#   バイトを数え、1500字下限が実質500字に fail-open した）。
#   cron・自動実行のジョブ・CI は環境を継承するので、机上の想定より現実に起きやすい。
#
# 新しいフックを足したら、必ずこの配列にも足すこと。
# 足し忘れは tools/scan_hooks.sh が検知して赤くなる（verify.sh 項目10）。
#
# 注意: ここで使う配列名・関数名に YTVP_ 接頭辞を付けないこと。
#       tools/scan_hooks.sh は「YTVP_ で始まる環境変数の読み取り」でフックを発見するため、
#       接頭辞付きの内部変数を作ると自分自身を誤検知する。

ENV_HOOK_NAMES=(
  YTVP_VOLUME_PATH
  YTVP_MANIFEST_PATH
  YTVP_CONTENT_PATCH
  YTVP_POPUP_PATCH
  YTVP_OVERLAY_PATCH
)

# 継承された値を「たまたま設定されていなかったから大丈夫」で通さない。明示的に消す。
ytvp_unset_env_hooks() {
  local h
  for h in "${ENV_HOOK_NAMES[@]}"; do
    unset "$h"
  done
}

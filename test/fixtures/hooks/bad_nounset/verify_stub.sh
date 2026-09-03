#!/usr/bin/env bash
# 検体: フックを殺さずに検査を始める verify（違反。環境変数に乗っ取られる）
# ここには ytvp_unset_env_hooks の呼び出しを「書いたつもり」でコメントしか無い。
# コメントでの言及を呼び出しと数えると、殺していないのに緑になる。
# ytvp_unset_env_hooks
node --test 'test/**/*.test.js'

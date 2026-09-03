#!/usr/bin/env bash
# 検体: フックを殺してから検査を始める verify（適合）
. "$(dirname "${BASH_SOURCE[0]}")/def.sh"
ytvp_unset_env_hooks
node --test 'test/**/*.test.js'

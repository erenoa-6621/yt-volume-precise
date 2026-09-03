# 検体: 使われていない宣言が腐って残っている（違反）
ENV_HOOK_NAMES=(
  YTVP_FIXTURE_PATH
  YTVP_ORPHAN_PATH
)
ytvp_unset_env_hooks() { local h; for h in "${ENV_HOOK_NAMES[@]}"; do unset "$h"; done; }

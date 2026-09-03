# 検体: 宣言・使用・unset が一致している（適合）
ENV_HOOK_NAMES=(
  YTVP_FIXTURE_PATH
)
ytvp_unset_env_hooks() { local h; for h in "${ENV_HOOK_NAMES[@]}"; do unset "$h"; done; }

#!/bin/sh
# Vibe AStock v2 容器入口（Dockerfile.v2 使用）：
# 幂等初始化 .local 私有层（init 不覆盖已有配置），再以远程模式常驻。
# 页面 5940 对外（访问口令在 .local/access.token），API 8770 只听容器回环。
set -eu

node orchestrator/src/init.ts --python /app/.venv/bin/python >/dev/null

exec scripts/start --prebuilt --no-open --remote \
  --public-url "${VRA_PUBLIC_URL:-https://a.luckybrother.cc}"

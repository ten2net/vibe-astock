#!/usr/bin/env sh
# 重建 v2 容器（含隧道），避免公网 a2.luckybrother.cc 掉线。
#
# 为什么不能只跑 `docker compose up -d vibe-astock-v2`：
#   cloudflared-v2 用 network_mode: service:vibe-astock-v2 共享网络命名空间。
#   单独重建 v2 时旧隧道容器仍指向已被销毁的命名空间，会被 SIGTERM 停掉（退出码 137），
#   公网入口随即 502/断连。两个服务必须一起重建、按 depends_on 顺序起来。
#
# 用法：
#   sh scripts/docker-v2-rebuild.sh              # 重新构建镜像并重建两个容器
#   sh scripts/docker-v2-rebuild.sh --no-build   # 不构建，只重建（镜像已是最新时用）
#   sh scripts/docker-v2-rebuild.sh --no-verify  # 跳过公网探测
#
# 环境变量：
#   V2_PUBLIC_URL  公网地址，默认 https://a2.luckybrother.cc
#   WAIT_SECONDS   启动后等待隧道注册的秒数，默认 20
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD=1
VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

PUBLIC_URL="${V2_PUBLIC_URL:-https://a2.luckybrother.cc}"
WAIT_SECONDS="${WAIT_SECONDS:-20}"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

if [ "$BUILD" = 1 ]; then
  echo "==> 构建镜像 vibe-astock-v2:local"
  compose build vibe-astock-v2
fi

# 关键：两个服务放在同一条命令里，compose 会按 depends_on 先起 v2、健康后再起隧道。
echo "==> 重建并启动 vibe-astock-v2 + cloudflared-v2"
compose up -d --force-recreate vibe-astock-v2 cloudflared-v2

echo "==> 等待健康检查与隧道注册（${WAIT_SECONDS}s）"
i=0
while [ "$i" -lt "$WAIT_SECONDS" ]; do
  sleep 2
  i=$((i + 2))
done

# 隧道是共享网络命名空间模式：v2 一旦被单独重建，隧道就会失联。
# 这里显式核对一次，掉了就把它单独拉起来。
if ! docker ps --format '{{.Names}}' | grep -qx 'vibe-astock-cloudflared-v2-1'; then
  echo "!! 隧道容器没在跑，单独拉起"
  compose up -d cloudflared-v2
  sleep 5
fi

fail=0
docker ps --format '{{.Names}}	{{.Status}}' | grep -E '^vibe-astock-v2\b' | grep -q 'healthy' \
  || { echo "!! vibe-astock-v2 未处于 healthy" >&2; fail=1; }
docker ps --format '{{.Names}}' | grep -qx 'vibe-astock-cloudflared-v2-1' \
  || { echo "!! vibe-astock-cloudflared-v2-1 未运行" >&2; fail=1; }

if [ "$VERIFY" = 1 ] && [ "$fail" = 0 ]; then
  echo "==> 探测公网 ${PUBLIC_URL}"
  # 401 = 远程口令生效（正常）；000 = 连不上（隧道还没就绪或已掉线）。
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL" || true)"
  case "$code" in
    200|301|302|401) echo "    HTTP $code，入口正常" ;;
    000) echo "!! 公网连不上（HTTP 000），看日志：docker logs --tail 50 vibe-astock-cloudflared-v2-1" >&2; fail=1 ;;
    *)   echo "!! 公网返回 HTTP $code，请人工确认" >&2; fail=1 ;;
  esac
fi

if [ "$fail" = 0 ]; then
  echo "==> 完成：v2 已重建，隧道在线"
else
  echo "==> 有问题，见上面提示" >&2
  exit 1
fi

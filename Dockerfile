# Vibe AStock —— 本地网页工作台（FastAPI + React + 受控 AI 引擎）
#
# 两个运行时缺一不可：Python 3.12 跑后端，Node 22+ 跑固定版本的 Codex CLI 引擎
# （runtime/）以及前端构建。所以基础镜像取 python，再把 Node 22 装进去。
#
# 构建：docker compose build   或   docker build -t vibe-astock:local .

# ---------------------------------------------------------------- 构建阶段
FROM node:22-bookworm-slim AS build
WORKDIR /build

# 依赖直接复制宿主机已装好的（含 AI 引擎 @openai/codex），不在容器内 npm ci。
# 实测容器内拉取 codex 引擎会卡二十分钟以上 —— registry 可达但带宽受限；而宿主机
# 已经 npm ci 过，且平台一致（linux-x64）。宿主机没准备过时先跑：
#   npm ci --prefix runtime && npm ci --prefix frontend
COPY runtime/ ./runtime/
# 前端 Layout.tsx 直接引用仓库根的 product.json（产品版本一致性检查），所以构建
# 时不能只给 frontend/ 一个目录，得把这个文件一起带上。
COPY product.json ./product.json
COPY frontend/ ./frontend/
RUN ls runtime/node_modules/@openai || (echo "runtime 依赖缺失，先在宿主机跑 npm ci --prefix runtime" && false)
RUN npm run build --prefix frontend

# ---------------------------------------------------------------- 运行阶段
FROM python:3.12-slim-bookworm

ARG NODE_VERSION=22.23.3
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8

# 运行期仍需要 node：AI 引擎由 runtime/bridge 拉起，不是构建完就不用了
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
 && node --version && npm --version \
 && apt-get purge -y --auto-remove curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
# 这两个目录已被 .dockerignore 排除（避免把宿主机的构建产物带进来），从构建阶段取
COPY --from=build /build/runtime ./runtime
COPY --from=build /build/frontend/dist ./frontend/dist

# 业务数据全部重定向到 /data，由 compose 的命名卷持久化；默认是在 home 下，
# 容器重建会丢。
ENV ASTOCK_AGENT_HOME=/data/agent \
    ASTOCK_DATA_HOME=/data/duanxian \
    VR_DATA_DIR=/data/market
RUN mkdir -p /data/agent /data/duanxian /data/market

EXPOSE 8910
HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8910/api/astock/health', timeout=8).read()"

# 容器里没有浏览器、也不需要体检脚本的启动器逻辑，直接起 uvicorn
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8910", "--no-access-log"]

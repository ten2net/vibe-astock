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

# 构建期出网：本网络对境外源有两种不稳定性——直连被注入 RST、代理带宽被限到几十 KB/s。
# 所以 apt 与 nodejs 下载都做成可配置镜像（compose 传国内镜像，其他部署不传则用官方源）。
ARG APT_MIRROR=""
ARG NODE_MIRROR="https://nodejs.org/dist"
# 构建期出网代理：需要时由 compose build.args 显式传入；不传的部署为空值、等于直连。
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG http_proxy=""
ARG https_proxy=""
ARG NO_PROXY=""
ARG no_proxy=""

# 运行期仍需要 node：AI 引擎由 runtime/bridge 拉起，不是构建完就不用了。
# git 供博客发布（blog_publish 要 clone Pages 仓库再 push）；
# openssh-client：ASTOCK_PAGES_SSH=1 时走 ssh.github.com:443 推送（见 docker-compose.yml），
# git 的 https 助手链 libcurl-gnutls，与本网络代理不兼容，SSH 是唯一稳定通道。
# fonts-noto-cjk：情绪卡片图（emotion_card）指定用 Noto Sans CJK SC（ttc index=2），
# 容器里没有它每日复盘的情绪卡片/公众号封面图会整体跳过。
RUN set -e; \
    if [ -n "$APT_MIRROR" ]; then \
        rm -f /etc/apt/sources.list.d/debian.sources; \
        echo "deb $APT_MIRROR bookworm main" > /etc/apt/sources.list.d/mirror.list \
        && echo "deb $APT_MIRROR bookworm-updates main" >> /etc/apt/sources.list.d/mirror.list \
        && echo "deb $APT_MIRROR-security bookworm-security main" >> /etc/apt/sources.list.d/mirror.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl xz-utils ca-certificates git openssh-client fonts-noto-cjk; \
    curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1; \
    node --version && npm --version; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
# pip 源同样可配置：本网络走清华镜像，其他部署不传则用官方 PyPI。
ARG PIP_INDEX_URL="https://pypi.org/simple"
RUN pip install --no-cache-dir -i "$PIP_INDEX_URL" -r requirements.txt

COPY . .
# 这两个目录已被 .dockerignore 排除（避免把宿主机的构建产物带进来），从构建阶段取
COPY --from=build /build/runtime ./runtime
COPY --from=build /build/frontend/dist ./frontend/dist

# hugo（extended，博客发布用）：优先用构建上下文里宿主机已下载好的 .local/bin/hugo
# （.dockerignore 只放行这一个文件，见该文件）；没有时再按固定版本号从 HUGO_MIRROR
# 下载。不把二进制塞进仓库，也不强依赖某个境外地址的可用性。
# 版本与已发布文章的一致，升级时只改 HUGO_VERSION 这一个 ARG。
ARG HUGO_VERSION=0.169.0
ARG HUGO_MIRROR="https://github.com/gohugoio/hugo/releases/download"
RUN if [ -f .local/bin/hugo ]; then \
        echo "hugo: 使用构建上下文的 .local/bin/hugo"; \
        install -m 755 .local/bin/hugo /usr/local/bin/hugo; \
    else \
        curl -fsSL --retry 3 --connect-timeout 20 \
            --speed-limit 20000 --speed-time 30 \
            "${HUGO_MIRROR}/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-amd64.tar.gz" \
        | tar -xz -C /usr/local/bin hugo && chmod +x /usr/local/bin/hugo; \
    fi; \
    hugo version

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

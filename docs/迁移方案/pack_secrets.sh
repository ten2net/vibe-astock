#!/usr/bin/env bash
# 打包本项目「未提交到 GitHub、但迁移到另一台机器必须带走」的文件。
# 用法（在本机仓库根目录执行）：
#   bash "docs/迁移方案/pack_secrets.sh"
# 产物：
#   docs/迁移方案/vibe-astock-secrets-YYYYMMDD.zip
#
# 目录约定（zip 内）：
#   repo/  → 解压后覆盖到新机器的仓库根目录（<REPO>/）
#   home/  → 解压后覆盖到新机器的 $HOME（~）
#   MANIFEST.md → 清单与落位说明
#
# 注意：本包含真实凭据（API token、小程序私钥、SSH 私钥、隧道密钥等），
#       请通过 scp/加密U盘等可信通道传输，勿上传网盘/聊天工具/GitHub。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="${HOME:?HOME 未设置}"
OUT_DIR="$REPO/docs/迁移方案"
STAMP="$(date +%Y%m%d)"
ZIP="$OUT_DIR/vibe-astock-secrets-$STAMP.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "仓库: $REPO"
echo "HOME: $HOME_DIR"
echo "暂存: $STAGE"

mkdir -p "$STAGE/repo" "$STAGE/home"

copy_repo() { # <相对仓库根的路径>
  local src="$REPO/$1" dst="$STAGE/repo/$1"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    echo "  [repo] $1"
  else
    echo "  [跳过] 仓库内不存在: $1" >&2
  fi
}

copy_home() { # <相对 $HOME 的路径>
  local src="$HOME_DIR/$1" dst="$STAGE/home/$1"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    echo "  [home] ~/$1"
  else
    echo "  [跳过] HOME 内不存在: ~/$1" >&2
  fi
}

echo "== 仓库内的私有文件 =="
# 环境变量（真实 token / cookie / 微信 / Bark / Host 白名单）
copy_repo ".env"
# 微信小程序上传私钥
copy_repo "miniprogram/ci/private.wxc02c3bcfcdd5bada.key"
# 本地运行态：API token、setup 指纹
copy_repo ".local/api.token"
copy_repo ".local/setup.json"
# 若存在产品访问令牌（compose 的 VRA_ACCESS_TOKENS_FILE 引用）
copy_repo ".local/access.tokens.json"

echo "== $HOME 下的用户数据与凭据 =="
# Agent 会话 / 任务 / 证据账本 / 计费库 / codex 登录态 / 盯盘缓存
copy_home ".vibe-astock-agent"
# codex-home 下的 tmp/ 与 shell_snapshots/ 是可再生缓存：
# tmp/arg0 里的 codex-linux-sandbox 等是指向 runtime/node_modules 二进制的符号链接，
# 若随包带走，zip 会跟随软链把 258MB 的引擎二进制打进来（且新机器上路径已失效）。
# sqlite 的 -wal/-shm 为运行时临时文件，也不必带走。
rm -rf "$STAGE/home/.vibe-astock-agent/codex-home/tmp" \
       "$STAGE/home/.vibe-astock-agent/codex-home/shell_snapshots"
find "$STAGE/home/.vibe-astock-agent" -type f \( -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) -delete 2>/dev/null || true
# 复盘 reviews / 交易日志 / 原始归档 / 微信 token / 缩略图 / 缓存
copy_home ".duanxian-agents"
# Cloudflare Tunnel 凭据（cert.pem + 各 tunnel 的 TunnelSecret JSON）
copy_home ".cloudflared"
# SSH 私钥与 known_hosts（wechat-proxy 固定出口、云主机登录用）
copy_home ".ssh"

# 生成清单
cat > "$STAGE/MANIFEST.md" <<'EOF'
# vibe-astock 私有文件迁移包

本包收集了「代码在 GitHub、但未提交、迁移到新机器必须带走」的文件。
配套迁移步骤见同目录的 `迁移方案.md`。

## ⚠️ 安全提示
- 含真实凭据：Tushare token、东财 Cookie、微信公众号 AppSecret、Bark key、
  小程序上传私钥、SSH 私钥、Cloudflare TunnelSecret、GitHub Pages token 等。
- 仅通过可信通道（scp / 加密介质）传输，传输后及时删除中转副本。
- **不要**把本 zip 或解压内容提交到任何 Git 仓库 / 网盘 / 聊天工具。

## 目录结构与落位
| zip 内路径 | 解压到新机器的位置 | 说明 |
|---|---|---|
| `repo/.env` | `<REPO>/.env` | 环境变量主文件，含所有真实凭据 |
| `repo/miniprogram/ci/private.*.key` | 同路径 | 微信小程序上传私钥 |
| `repo/.local/api.token` | 同路径 | 本地 API 访问 token |
| `repo/.local/setup.json` | 同路径 | setup 指纹（可留可删，非必需） |
| `repo/.local/access.tokens.json` | 同路径 | 产品访问令牌（若存在） |
| `home/.vibe-astock-agent/` | `~/.vibe-astock-agent/` | Agent 会话/任务/证据账本、计费库、codex 登录态、盯盘缓存 |
| `home/.duanxian-agents/` | `~/.duanxian-agents/` | 复盘报告、交易日志、原始归档、微信 token、缓存 |
| `home/.cloudflared/` | `~/.cloudflared/` | Cloudflare Tunnel 凭据（cert.pem + 各 tunnel JSON） |
| `home/.ssh/` | `~/.ssh/` | SSH 私钥与 known_hosts（wechat-proxy 用） |

## 迁移后必改项（详见迁移方案.md）
1. `.env` 的 `VIBE_ALLOW_HOSTS` 加入新机器的 IP / 域名。
2. `docker-compose.yml` 中硬编码的代理 `192.168.200.24:7890` 改为新环境的代理地址。
3. `.env` 的云主机 / 代理 / 隧道相关 IP、域名按新环境核对。
4. SSH 私钥权限：`chmod 600 ~/.ssh/id_rsa`，`~/.ssh` 目录 `700`。
5. 浏览器 localStorage（自选股/研究记录/界面状态/API 配置）不会随文件迁移，需单独导出或重新配置。

## 未打包（可再生，无需带走）
- 仓库内：`.venv/`、`node_modules/`、`frontend/dist/`、`desktop/dist/`、`blog/public/`、
  `__pycache__/`、`*.pyc`、`*.log`、`.local/snapshots/`、`.local/mcp/`、
  `.local/runs/`、`.local/bin/`（hugo，setup 会重装）、`.pytest_cache/`、`.mypy_cache/`。
- HOME 内：`~/.claude/` 缓存、`~/.vibe-astock-agent/codex-home/tmp/`（codex 沙箱软链，
  指向仓库内引擎二进制，路径随机器而变）、`codex-home/shell_snapshots/`、
  各 `*.sqlite-wal` / `*.sqlite-shm`（运行时临时文件）。
这些由新机器 `sh scripts/setup` / `npm ci` / 启动服务后自动重建。
EOF

# 打包（相对路径，不带绝对路径；-y 保留符号链接本身而非跟随其目标）
( cd "$STAGE" && zip -q -r -y "$ZIP" MANIFEST.md repo home )

echo ""
echo "完成: $ZIP"
echo "体积: $(du -h "$ZIP" | cut -f1)"
echo "校验: sha256sum"
sha256sum "$ZIP"

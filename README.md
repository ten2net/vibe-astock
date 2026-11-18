<p align="center"><b>简体中文</b> | <a href="README_en.md">English</a></p>

<h1 align="center">揽宝投研</h1>

<p align="center">
  <b>A 股短线复盘与跟踪工作台</b><br>
  盯盘 · 情绪复盘 · AI 复盘 · 明日验证 · 交易日志 · 个股深挖 · 回测 · 185 个数据端点
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="CHANGELOG.md"><img alt="源码版本 v2.1.2" src="https://img.shields.io/badge/source-v2.1.2-F35D2B"></a>
  <img alt="A 股短线" src="https://img.shields.io/badge/market-A%20%E8%82%A1-c92a2a">
  <img alt="185 个数据端点" src="https://img.shields.io/badge/data-185%20endpoints-2f9e44">
  <img alt="AI：Claude Code、Codex、WorkBuddy 或模型 API" src="https://img.shields.io/badge/AI-Claude%20Code%20%7C%20Codex%20%7C%20WorkBuddy%20%7C%20API-black">
</p>

---

## 线上体验与相关站点

| 站点 | 地址 | 说明 |
|---|---|---|
| **V2 线上体验** | [a2.luckybrother.cc](https://a2.luckybrother.cc) | 网页版工作台，打开即可用（公网口令向公众号获取） |
| **博客** | [ten2net.github.io](https://ten2net.github.io) | 「揽宝.复盘」：每日复盘、研究与使用文章 |
| **微信公众号** | [扫码关注「揽宝投研」](https://ten2net.github.io/img/lanbao.png) | 发私信「访问码」获取线上体验口令，也发布更新与复盘 |
| **ETF 热力图** | [etf.luckybrother.cc](https://etf.luckybrother.cc/) | ETF 全市场热力图 |
| **A 股市场热力图** | [www.luckybrother.cc](https://www.luckybrother.cc/) | A 股市场涨跌热力图 |
| **LGBM 量化** | [q.luckybrother.cc](https://q.luckybrother.cc/) | 量化研究相关站点 |

> 线上体验站为公开入口，访问口令请通过公众号获取；页面里填写的 API key 只在本地浏览器保存并随请求发往本机后端，公共入口请勿填写敏感密钥。

---

## 这是做什么的

揽宝投研是一个本地网页工作台，用于 A 股短线复盘、盯盘、个股研究与历史回测。行情、统计和回测由程序确定性计算，AI 只负责解读材料、对照观点、整理待验证条件；产品**不输出投资决策、买卖建议或仓位指令**。

核心能力一览（详细逐个功能的说明见 [博客](https://ten2net.github.io) 与产品内页面）：

- **盯盘**：持仓、自选、昨日梯队的实时读数和盘中异动，竞价强弱与全天情绪路径。
- **情绪复盘**：赚钱效应、晋级率、连板天梯、题材轮动、首板名单；AI 分五段写复盘，明日验证次日收盘自动对账。
- **交易日志**：每笔交易自动对上入场那天的情绪和板位，只存在本机、不发给 AI。
- **每日复盘**：市场状态、短线情绪、中长线位置、资金流向，可发布到博客。
- **个股研究**：A 股、港股、美股六阶段研究（画像 → 财务 → 预期 → 估值 → 风险 → 报告），数字带证据、可回查；另有我的研报、多空辩论、回测、候选池、事件日历、定时提醒等栏目。
- **数据**：185 个数据端点、35 层，其中 14 个短线专用；A 股数据同步到 [a-stock-data](https://github.com/simonlin1212/a-stock-data)，港美股同步到 [global-stock-data](https://github.com/simonlin1212/global-stock-data)，端点目录见 [datasources/CATALOG.md](datasources/CATALOG.md)。

v2.0.0 起与 [Vibe Research](https://github.com/simonlin1212/Vibe-Research) 共用同一套底座：接入 AI、个股深挖、回测、产业资讯、研报库、远程访问和免安装包一致。旧版（v1.x）数据可通过页面「接入 AI → 从旧版导入」迁移，步骤见下文。

---

## 如何使用

### 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 11、macOS 或 Linux；Windows 原生运行，不要求 WSL |
| Node.js | ≥ 22.18，推荐 24 LTS（必须是启用 TypeScript 的官方构建，`node -p process.features.typescript` 输出 `strip` 或 `transform`） |
| Python | ≥ 3.11，推荐并已验证 3.12 |
| Git | 用于克隆和更新代码 |
| AI | 可选：Claude Code、Codex、WorkBuddy 订阅，或任意兼容 Chat Completions 的模型 API；setup 不会安装这些 |

### 方式一：源码安装（Windows / macOS / Linux）

Windows（PowerShell / CMD）：

```bat
git clone https://github.com/ten2net/vibe-astock.git vibe-astock
cd vibe-astock
scripts\setup-windows.cmd
scripts\start.cmd
```

macOS / Linux：

```bash
git clone https://github.com/ten2net/vibe-astock.git vibe-astock
cd vibe-astock
scripts/setup
scripts/start
```

- `setup` 会创建 `.venv`、安装 Node / Python 依赖、初始化数据目录并运行体检。
- `start` 会检查安装和端口，同时启动本机 API 与页面，两边就绪后打开 **http://127.0.0.1:5940**；按 Ctrl+C 同时关闭，无需两个终端。
- 默认端口：页面 5940、本机 API 8770；被占用时自动换空闲端口并在终端说明，以浏览器实际打开的地址为准。
- 固定端口：`scripts/start --port 6940 --api-port 9770`（Windows：`scripts\start.cmd -Port 6940 -ApiPort 9770`），或设 `VRA_UI_PORT` / `VRA_API_PORT`；指定端口不可用会直接报错。
- 换端口后，「接入 AI」的模型 API 设置和对话记录要在新地址重新设置（存在浏览器里，按地址分开）。
- macOS / Linux 不想自动打开浏览器：`scripts/start --no-open`。
- 盯盘自动刷新、收盘取数和盘中快照都要程序开着；电脑关机或程序没开时不会运行。
- 部署、接口与维护说明见 [AGENTS.md](AGENTS.md)；`desktop/` 是浏览器前端目录，不是桌面客户端。

### 方式二：免安装包（Windows / macOS）

不想装 Node、Python 和 Git，可到 [Releases](https://github.com/simonlin1212/vibe-astock/releases) 下载带好运行时的压缩包：

| 电脑 | 系统要求 | 压缩包 |
|---|---|---|
| Windows（x64） | 64 位 Windows 10 及以上 | `VibeAStock-<版本>-win-x64.zip` |
| Apple 芯片 Mac | macOS 14 及以上 | `VibeAStock-<版本>-mac-arm64.zip` |
| Intel Mac | macOS 14 及以上 | `VibeAStock-<版本>-mac-x64.zip` |

1. 解压到任意文件夹，双击 `Start-VibeAStock.cmd`（Windows）或 `Start-VibeAStock.command`（macOS），浏览器自动打开 http://127.0.0.1:5940（端口被占用时以窗口显示的地址为准）；关掉窗口即退出。
2. 包没有代码签名：Windows 弹「Windows 已保护你的电脑」时点「更多信息」→「仍要运行」；macOS 提示无法验证开发者时，终端运行 `xattr -dr com.apple.quarantine <解压文件夹>` 再双击。
3. 交易记录、复盘、研究记录存在解压文件夹的 `.local` 里（macOS 按 Command+Shift+. 显示隐藏文件夹）。升级时解压新文件夹，把旧 `.local` 整个复制过去，确认无误再删旧文件夹。
4. 接入 AI 与源码版一样：沿用本机已登录的 Claude Code / Codex / WorkBuddy，或在「接入 AI」填模型 API。

压缩包旁有同名 `.sha256` 可核对完整性。免安装包只在本机打开，不开放局域网。

### 方式三：远程访问（云端电脑）

在一台 macOS / Linux 云端电脑上：

```bash
scripts/setup
scripts/start --remote --no-open --public-url https://<平台分配给页面端口 5940 的公网地址>
```

启动后终端会打印一条带访问口令的链接（`https://…/?access=…`），打开即可用，之后 30 天内直接打开公网地址即可。完整步骤（后台运行、更换口令）见 [AGENTS.md](AGENTS.md) §3。

- 每个请求都要先过访问口令；本机 API 仍只监听回环地址。
- **只用 https 公网地址**，否则页面里填的 API key 会明文传输；页面只能挂在根地址，不支持子路径。
- 拿到链接的人能用这台电脑上的全部功能，链接只给自己用，启动日志里也有访问口令，别外传。
- 云端电脑通常没有你的订阅登录，在页面里用模型 API 接入即可。
- 远程模式端口不会自动换：5940 被占用时先停掉占用程序，或用 `--port` 换成平台开放的端口。
- 程序一直开着的云端电脑适合跑收盘取数和盘中快照，不会因本机关机漏存。

### 接入 AI（可选）

第一次打开首页会弹出「请接入 AI」：已登录的订阅点一下即可测试并保存；「其他接入方式」进入设置页填 API。不接 AI 也能用盯盘、情绪读数、明日验证对账、涨停样本和交易日志；AI 复盘、AI 周报、对话、个股研究、多空辩论和回测需先接入。

| AI | 需要准备 |
|---|---|
| Claude Code 订阅 | 本机安装 Claude Code，并用 claude.ai 订阅登录 |
| Codex 订阅 | 本机安装 OpenAI 官方 Codex CLI（≥ 0.160.0），用 ChatGPT 账号 `codex login` |
| WorkBuddy / CodeBuddy | 本机已登录的 WorkBuddy 桌面版，或官方 CLI `@tencent-ai/codebuddy-code` |
| 模型 API | 任意兼容 Chat Completions 与工具调用的服务：DeepSeek、通义千问、智谱 GLM、Kimi、MiMo、OpenAI 等 |

- **Codex**：`npm install -g @openai/codex` → `codex login` → 页面点「重新检测」→「测试并保存」。用 API key 登录的 Codex 不可用。
- **Claude Code**：claude.ai 订阅登录后设置页自动检测；API key / Bedrock / Vertex 登录不算订阅。
- **WorkBuddy / CodeBuddy**：装好并登录桌面版即可识别；没有桌面版时 `npm install -g @tencent-ai/codebuddy-code` 再 `codebuddy` 登录；找不到时设 `CODEBUDDY_BIN`。
- **模型 API**：「接入 AI」→「API 接入」，选供应商，填地址、模型名和 key，点「测试并保存」。key 只存在当前浏览器 `localStorage`。
- 本机状态不明确时运行 `scripts/doctor`（Windows：`scripts\doctor.ps1`）。详细说明见 [docs/model-access.md](docs/model-access.md)。

### 从旧版（v1.x）升级

旧版 v1.x 是 Python 程序（数据 `~/.duanxian-agents`、页面 8910），不能原地升级：

- 重新克隆仓库或下载免安装包；旧版文件夹和数据不用删，新版不会改动。
- 页面地址从 `http://127.0.0.1:8910` 换成 `http://127.0.0.1:5940`（本机 API 8770）。
- 在「接入 AI」页最下方「从旧版导入」先预览、再导入：可导交易记录、设置、模式卡、AI 复盘、明日验证、盘中快照和个股深挖；导入前自动备份到 `ledger/旧版导入备份-日期/`，可重复导。
- AI 要重新接一次：订阅直接用本机已登录的官方 CLI；旧版专用 Codex 登录不再使用。

### 在 Claude Code / Codex / Cursor 里调用

揽宝投研提供 MCP 接口：先跑完 setup，再按所用工具注册（Windows PowerShell 把 `"$(pwd)/orchestrator/src/mcp.ts"` 换成 `"$PWD\orchestrator\src\mcp.ts"`）：

```bash
# Claude Code（加 -s user 可在所有目录用）
claude mcp add vibe-astock -- node "$(pwd)/orchestrator/src/mcp.ts"
# Codex
codex mcp add vibe-astock -- node "$(pwd)/orchestrator/src/mcp.ts"
```

Cursor：在 `~/.cursor/mcp.json` 加入：

```json
{
  "mcpServers": {
    "vibe-astock": {
      "command": "node",
      "args": ["/你的路径/vibe-astock/orchestrator/src/mcp.ts"]
    }
  }
}
```

接好后可以问：「用 vibe-astock 取 2026-10-09 的短线情绪读数和首板名单」「查 600519 最近的券商研报和一致预期」「给 300308 跑一次研究，列出估值数字和出处」。共 8 个工具（7 个只读、1 个发起研究），发起研究用后台默认 AI 来源（`.local/config.json` 的 `provider.profile` 或 `VRA_PROVIDER`），不读交易日志和持仓。

---

## Docker 部署（自建服务器）

仓库根目录的 `docker-compose.yml` 有两组互不影响的服务：

- **旧版应用** `vibe-astock`：页面 8910，经 Cloudflare Tunnel 发布到 `a.luckybrother.cc`。
- **v2 研究编排器** `vibe-astock-v2`：页面 5940，用 `Dockerfile.v2` 构建，经另一条隧道发布到 `a2.luckybrother.cc`（即线上体验地址）。

两组各配一条 Cloudflare Tunnel，各自独立，重启一个不影响另一个。

### 一键重建 v2（含隧道）

v2 重建**必须连带隧道一起做**，不能只重建应用容器：隧道容器用 `network_mode: service:vibe-astock-v2` 共享 v2 的网络命名空间，单独重建 v2 时旧隧道仍指向已销毁的命名空间，会被停掉（退出码 137），公网入口随即断连。用自带脚本把两个服务放进同一条 `docker compose up -d --force-recreate`，由 `depends_on: service_healthy` 保证先起应用、健康后再起隧道：

```bash
# 构建镜像 + 重建 vibe-astock-v2 和 cloudflared-v2 + 核对健康与公网入口
sh scripts/docker-v2-rebuild.sh

# 镜像已是最新（只改了数据或配置）时，跳过构建
sh scripts/docker-v2-rebuild.sh --no-build

# 不探测公网入口
sh scripts/docker-v2-rebuild.sh --no-verify
```

- 脚本结束前核对：v2 处于 `healthy`、隧道容器在运行、公网地址可访问（远程口令生效时返回 401 属正常）；任一项不符会打印排查提示并返回非零。
- 可用环境变量：`V2_PUBLIC_URL`（默认 `https://a2.luckybrother.cc`）、`WAIT_SECONDS`（等隧道注册的秒数，默认 20）。
- 隧道掉线时看日志：`docker logs --tail 50 vibe-astock-cloudflared-v2-1`。
- 旧版应用单独部署/重建：用 `docker compose up -d` 对应服务；自身隧道配置见 `cloudflared/config.yml`。

### 首次配置要点

- 把对外域名写进 `.env` 的 `VIBE_ALLOW_HOSTS`（逗号分隔），否则对应服务全部接口返回 403。公网地址必须 HTTPS。
- Cloudflare Tunnel 首次搭建：创建 tunnel、`cloudflared tunnel route dns <tunnel名> <域名>` 建 CNAME，配置见 `cloudflared/config.yml` 与 `cloudflared/config-v2.yml`。
- 复盘/研究任务需要 AI 接入，容器内登录方式见下节；微信文章自动发布走 `wechat-proxy` 固定出口，凭据用 `WECHAT_APPID` / `WECHAT_SECRET` 环境变量注入，未配置则跳过。

### 容器内登录 CodeBuddy（AI 接入）

Docker 环境里**不要用 `codebuddy login` 走 OAuth**：登录要回调 `127.0.0.1`，与宿主机浏览器不互通；容器内 SSO 请求还会被边缘拦掉（卡在 `Generating login URL...` 或报 `Socket is closed`）。订阅登录态也无法从宿主机复制进容器（token 用机器级密钥加密，换容器解不开）。

改用 API Key，写进仓库根目录 `.env`（已被 gitignore），由 `docker-compose.yml` 在容器启动时注入：

```bash
# .env（不要提交）
CODEBUDDY_API_KEY=你的key
CODEBUDDY_INTERNET_ENVIRONMENT=internal
CODEBUDDY_MODEL=hy4flash-free
```

- 中国版 key **必须**带 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`，否则认证链路不完整。
- `CODEBUDDY_MODEL` 设默认模型，优先级高于容器内 `settings.json`；换模型只改 `.env`。
- **不要设 `CODEBUDDY_BASE_URL`**——个人 key 走平台默认端点，设了会把登录网关带偏、请求返回 405；它只用于 OpenRouter 这类第三方服务。
- CLI 由 `Dockerfile` / `Dockerfile.v2` 在构建期以固定版本（`CODEBUDDY_VERSION`）装进镜像 `/usr/local/bin`，**两个容器都不挂登录态/CLI 卷、都不设 `CODEBUDDY_BIN`**；换 key/模型只改 `.env` 再 `docker compose up -d`，不用重建镜像，升级 CLI 才改 `CODEBUDDY_VERSION` 重建。
- Hy4 系列模型带 `enterprise:selfhost` 标签，API Key 模式拉不到云配置时，用 `.local/codebuddy/cloud-product-cache.json` 预生成缓存（含完整模型列表）由 compose 只读挂入**两个容器**实现 `disk cache hit`；两边共用同一份 `.env` 的 key、anonymous id 相同，缓存可共享。**换 API Key 后 `anonymous_<id>` 会变，缓存需按新 id 重新生成**（文件已 gitignore）。
- Web「接入 AI」的 CodeBuddy 订阅卡默认禁止 API Key，容器里显式设 `CODEBUDDY_ALLOW_API_KEY_SUBSCRIPTION=1`（`.env` + compose 两处）让订阅探针与复盘/研究保留 API Key；这意味着容器内按 API Key 计费，不是订阅额度。

验证（两个容器内，交互与非交互都应成功）：

```bash
docker compose exec vibe-astock codebuddy -p "reply OK" --output-format json | grep '"subtype"'
docker compose exec vibe-astock-v2 codebuddy -p "reply OK" --output-format json | grep '"subtype"'
# 期望 "subtype": "success"
```

---

## 安全与隐私

- 交易日志、持仓和自选只存在本机。成交、持仓、成本和盈亏**不发给 AI**；自选、笔记、论点和判据可以发给 AI。例外是你主动选的「从截图或表格识别」（会把选中文件发给当前 AI）。
- 原始研报文件只保存在本机，模型只接收服务端检索命中的正文片段；AI 读取公开网页可能经第三方 Jina Reader 转发，不要提交含私密令牌的网址。
- API key：后端默认 provider 的 key 只走环境变量；浏览器里填写的 API key 只保存在当前浏览器 `localStorage`，仅在调用时经本机后端转给所选模型服务商。
- 研究阶段没有网络、只能用 5 个受控工具；取数由编排器用受控脚本完成，原始响应落盘并记录哈希；资料引用 `[资料:<id> p.<页码>]` 由机器校验漏引/错引。
- 本机 API 默认只绑定 `127.0.0.1`，写请求必须鉴权并用 JSON。
- 隐私模式（右上角眼睛图标）：录屏截图前打开，金额、股数、成本价和自写价位显示成 ••••；只遮屏幕显示，不影响计算。
- 防篡改核对：研究结果与台账指纹登记在数据目录 `audit/chain.jsonl`（只在本机），能发现绕开软件的改动；要防同时改写登记簿的人，把页面给的「链头」另存别处。
- 新版提示每天访问一次 GitHub 接口查版本（只带当前版本号），可在「接入 AI」页关闭或设 `VRA_UPDATE_CHECK=0`。
- 输出只包含数据、分析框架、情景概率、待验证条件和裁决点，不提供建仓、加减仓、目标价或止损位。

更多细节见 [docs/model-access.md](docs/model-access.md#5-自托管模型局域网与远程访问)。

---

## 开发与测试

代码结构：`desktop/`（React + Vite 浏览器 UI）、`orchestrator/`（编排、validator、API、MCP、对话、报告归档）、`orchestrator/src/finance/shortline/`（短线读数、盯盘、AI 复盘与周报、明日验证）、`orchestrator/src/finance/journal/`（交易日志）、`backtest/`（回测引擎）、`calc/`（确定性计算）、`datasources/`（数据端点注册表）、`methodology/`（研究宪法）、`scripts/`（安装启动体检）、`.local/`（私有数据与运行产物，已 gitignore）。产品名、仓库地址和端口集中在 `orchestrator/src/brand.ts`。

AI 接入分两层：**Local Agent Runtime**（本机订阅 CLI：Claude Code / Codex / WorkBuddy-CodeBuddy）与 **Model Provider**（模型 API：DeepSeek / 通义千问 / 智谱 / Kimi / OpenAI 兼容接口）。按使用者所选来源路由，不是串联运行，也不互相回落；v2.0.0 起不再内置 Codex Harness（已移除）。

常用检查：

```bash
npm run typecheck --prefix orchestrator && npm test --prefix orchestrator
npm run typecheck --prefix desktop && npm test --prefix desktop && npm run build --prefix desktop
.venv/bin/python -m pytest calc/tests backtest/tests .agents/skills/data-access/scripts/tests -q
```

命令行跑一次研究：

```bash
node orchestrator/src/run.ts --symbol 300308 --market SZ --provider cli-claude \
  --python "$(pwd)/.venv/bin/python" < /dev/null
```

`--provider` 可用 `cli-claude` / `cli-codex` / `cli-codebuddy`（本机订阅）或模型 API 模板 id（key 从对应环境变量读）；不传用后台默认，没有会直接报错。退出码：`0` 完成、`2` 不完整/过期、`3` 失败。产物写入 `.local/runs/<run-id>/`：`report.md`、`evidence.json`、`calculations.json`、`conflicts.json`、`manifest.json`、`viewer.html`。

项目约定：每个环节完成后先测试；重要改动做一次独立审查，逐条核实、修复后复验受影响范围；审查完成前不把该环节称为「建成」，也不提交或推送。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。v2.0.0 换到 Vibe Research 底座，底座历史见 [Vibe Research 的 CHANGELOG](https://github.com/simonlin1212/Vibe-Research/blob/main/CHANGELOG.md)。

## 支持本项目

如果这套工具帮你省了点时间，可以请作者喝杯咖啡（纯自愿，不影响任何功能）：

<table>
<tr>
<td align="center" width="50%" valign="top">
<img src="assets/bmc-qr.png" alt="支付宝赞赏码" width="240"><br><b>支付宝</b><br><span>扫码赞赏</span>
</td>
<td align="center" width="50%" valign="top">
<img src="assets/wx-bmc-qr.png" alt="微信赞赏码" width="240"><br><b>微信</b><br><span>扫码赞赏</span>
</td>
</tr>
</table>

> 赞赏只是对已公开成果的鼓励，不构成任何服务承诺、技术支持约定或投资相关往来。

## 免责声明

本工具用于数据整理、研究和历史复核，只产出研究数据、分析框架、待验证条件与裁决点，**不提供投资决策、买卖建议或仓位指令**。情绪分档和周期是分析框架，不是客观事实；涨停样本是市场现象统计，不是策略回测。公开数据、程序计算、个人记录与 AI 解读都可能出错，引用存在不代表推论正确，历史结果不代表未来表现。投资有风险，使用者应自行核实并承担决策责任，同时遵守各数据源的使用条款。

## License

Apache-2.0，详见 [LICENSE](LICENSE)。v2.0.0 起的底座来自同一作者的 [Vibe Research](https://github.com/simonlin1212/Vibe-Research)（MIT），原许可声明见 [NOTICE](NOTICE)。

**贡献者：** Ten2net(https://ten2net.github.io/) · 邮箱：[tennet@gmail.com](mailto:tennet@gmail.com)
**特别感谢原作者：** Simon 林 · X [@linsizhen](https://x.com/linsizhen) · 邮箱：[simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)

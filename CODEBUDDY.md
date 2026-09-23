# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目定位

Vibe AStock 是一个**本地网页**工作台，用于 A 股短线复盘、盯盘、个股研究和历史回测。它不是纯前端或纯后端项目，而是一个「FastAPI 后端 + React 前端 + 受控 AI 引擎」的组合体：

- 行情、统计、回测**由程序确定性计算**，不依赖 AI 生成。
- AI（受控）只负责解释材料、对照观点、整理待验证条件。
- 产品**不输出投资决策、买卖建议或仓位指令**——这是贯穿全代码库的硬性约束（`review_agent/product_policy.py` 的 `has_trade_recommendation` 会在保存前拦截含交易动作/点位的报告）。

## 技术栈

- **后端**：Python 3.12（`.venv` 虚拟环境，依赖见 `requirements.txt`），FastAPI + Uvicorn。
- **前端**：React 19（Vite），构建产物落在 `frontend/dist/`，由后端单端口直接托管。
- **AI 引擎**：固定版本的官方 OpenAI Codex CLI（`runtime/node_modules/@openai/codex/`），由 `review_agent/` 以"隔离引擎"方式驱动；Claude / WorkBuddy / CodeBuddy 通过各自本机 CLI 适配接入。
- **编排**：LangGraph（`duanxian/review_graph.py`）把五位分析师串成复盘图。
- **回测引擎**：自研确定性引擎（`backtest/engines/`），取数来自 `research_data/`。

## 常用命令

环境准备只需 Python 3.10+（推荐 3.12）与 Node.js 22+（含 npm）。所有命令建议在仓库根目录执行，统一用受管虚拟环境的解释器 `.venv/bin/python`（Windows 为 `.venv/Scripts/python.exe`）。

```bash
# 1) 准备环境：建 .venv、装 Python 依赖、npm ci 并构建前端（首次或源码更新后必跑）
sh scripts/setup
# 等价： python scripts/manage.py setup

# 2) 离线体检：检查 Python/Node 依赖、引擎、前端构建、安装一致性（不请求模型）
sh scripts/doctor
# 机器可读： python scripts/manage.py doctor --json

# 3) 启动本地服务（默认 127.0.0.1:8910，只监听回环）
sh scripts/start
# 换端口： sh scripts/start --port 8911
# 不自动开浏览器： sh scripts/start --no-browser
# Windows： .venv\Scripts\python.exe -X utf8 scripts/manage.py start

# 后端本质是： uvicorn server:app --host 127.0.0.1 --port 8910
# 调试前端（改 UI 时才需要，vite 把 /api 代理到 8910）： npm --prefix frontend run dev -- --port 5910 --strictPort
```

### 测试

```bash
# 全量 Python 测试（含回归）：
.venv/bin/python -m pytest tests backtest/tests research_data/tests -q

# 跑单个测试文件：
.venv/bin/python -m pytest tests/test_core_logic.py -q

# 跑单个测试/类（pytest 标准语法）：
.venv/bin/python -m pytest tests/test_core_logic.py::TestVersionIsConsistentEverywhere -q

# 标记： unit（纯逻辑、不打网络）/ integration（需真实数据源）。可加 -m unit 过滤。
# 前端测试（Node 原生 test runner）：
node --test frontend/test/*.test.ts

# 前端生产构建（验证改动）：
npm --prefix frontend run build
```

注意：`.venv/bin/python -m pytest`（而非裸 `pytest`）能确保用受管依赖。CI 参见 `.github/workflows/windows-runtime.yml`（Windows 原生验收：setup → doctor → 捆绑引擎版本 → pytest 若干合约/回归 → `tests/windows_web_smoke.py`）。

## 代码架构（大图）

数据流核心原则（来自 README「架构与开发」）：

```
公开数据 → 原始归档与口径整理 → 确定性统计 / 历史模拟
                             ↓
                    受控 AI 解读与证据工具
                             ↓
                    引用校验 → 报告版本与追问
人工交易日志与研究记录 → 本地台账和自查视图
```

### 目录职责

| 目录 | 职责 |
|---|---|
| `frontend/` | React 19 网页、七模块导航（首页/盯盘/复盘/资讯雷达/个股研究/回测/我的股票）、主题与交互。dev 用 5910，产物 `dist/` 由后端托管。 |
| `server.py` | 本地 HTTP 服务入口（FastAPI）。包住复盘图、缓存、静态前端；并合并 `vr/` 的 7 个分栏路由。 |
| `vr/` | 盘面数据、首板、盯盘、持仓/自选、个股、资讯雷达等后端（改编自 Vibe-Research）。**同步必须逐文件合并并回归，不能整目录覆盖**（见 `server.py` 中 `_merge_vr_routes` 的注释）。 |
| `review_agent/` | 统一模型接入、隔离引擎、任务管理、受控证据工具、引用校验、产品政策约束（核心见下）。 |
| `duanxian/` | 短线核心：五位分析师、复盘图、核验、归档、交易日志、多空辩论、盯盘、情绪指标等。 |
| `backtest/` `research_data/` | 历史模拟引擎（china_a / global_equity）与配套取数（baostock、yahoo、事件概率）。 |
| `runtime/` | 固定版本的 Codex CLI 引擎（`node_modules/@openai/codex/`）与 TypeScript 桥接（`bridge/`）。 |
| `scripts/` | `manage.py`（setup/doctor/start/auto 的实现）、`setup`/`doctor`/`start` 包装壳、评测脚本。 |
| `tests/` `backtest/tests/` `research_data/tests/` `frontend/test/` | 回归与契约测试。 |

### 受控 AI 设计（关键不变量）

`review_agent/runtime.py` 用固定版本的 Codex CLI 作为"隔离引擎"。理解这一层对改动 AI 相关代码至关重要：

- **模型默认没有工具**：普通聊天不启用工具或联网。复盘/辩论/回测需用户明确发起。
- **有界的 MCP 证据工具**：只开放 `list_evidence / read_evidence / compare_metric / submit_answer / fetch_stock_prices / compare_stock_prices` 及若干 MCP 资源工具；`runtime.py` 中 `DISABLED` 列表显式禁用 `shell_tool`、`unified_exec`、联网搜索等。
- **冻结输入（FrozenInputs）**：复盘前由 host 冻结日期与取数范围，模型不能越界取数。确定性数值比较由 host 拥有（`compare_metric` 等），模型只写定性解释。
- **引用校验**：AI 回答走 schema（`ANSWER_SCHEMA`）约束，引用/数字核对不依赖模型自觉。
- **产品政策**：`review_agent/product_policy.py` 中的 `has_trade_recommendation` 在保存前拦截含交易建议的文本（见 `review_agent/daily.py:check_report_text`）。
- 模型接入来源在 `review_agent/access.py` 统一管理（Codex 订阅 / Claude CLI / WorkBuddy-CodeBuddy CLI / OpenAI API / DeepSeek-MiMo / 自托管网关 CC Switch 等）。

### 数据落盘位置（环境变量）

这些位置**不是统一开关迁移**的——改一个不会搬走其它：

- `~/.vibe-astock-agent/`（Agent 会话、任务、证据账本、产品登录；可用 `ASTOCK_AGENT_HOME` 改根）
- `~/.duanxian-agents/`（复盘 `reviews/`、交易日志 `journal/`、原始归档 `archive/`；可用 `ASTOCK_DATA_HOME` 指定绝对路径）
- `~/.vibe-astock-agent/market-data/`（市场资料与盯盘缓存；`VR_DATA_DIR`）
- 研报资料默认在 `VR_DATA_DIR/myreports/`，可用 `VR_REPORTS_DIR` 单独指定
- 自选/研究记录/界面状态/API 配置在**浏览器本地存储**，换浏览器或端口会读不到
- 开发日志与诊断在仓库 `.local/`（默认不进版本控制，含 `startup.log`）

## 改动时的重要坑

- **`mini-racer` vs `py_mini_racer` 冲突**：板块资金接口需要改名后的 `mini-racer`，**绝不能同时装旧的 `py_mini_racer`**（两包装进同一 `py_mini_racer/` 目录互覆盖，导致「板块资金/资金轮动」静默空着）。见 `requirements.txt` 注释。
- **`VIBE_ALLOW_HOSTS`**：默认只认 `127.0.0.1 / localhost / ::1`。挂到局域网或反代后访问，必须把 Host 写进该环境变量（逗号分隔），否则**全部接口返回 403**（`server.py` 的 `_ALLOWED_HOSTS`）。公网地址仍强制 HTTPS。
- **版本一致性**：产品版本（`vr/product_version.py`、README、CHANGELOG、`product.json`）有回归测试 `tests/test_core_logic.py::TestVersionIsConsistentEverywhere` 校验，改版本号要同步多处。
- **`vr/` 是改编 vendored 模块**：合并上游更新必须逐文件合并并回归，不能整目录覆盖 `vr/`。
- **`main.py` 是旧 CLI 兼容入口**，网页主流程在 `review_agent/daily.py`；不要把旧 CLI 的成功当作网页验收。
- 后端换端口需同时改 `launch.json` 与 `frontend/vite.config.ts` 的代理目标（见 `.claude/launch.json` 注释）。

## 其他参考

- 完整产品说明、七模块细节、数据/隐私与验证范围见 `README.md`（英文 `README_en.md`）。
- 回测与取数的上游来源/许可见 `backtest/NOTICE.md`、`research_data/NOTICE.md`。
- 更新日志：`CHANGELOG.md`。
- 评测用例：`evals/review_agent.json`、`evals/review_agent_daily.json`，以及 `scripts/evaluate_review_agent.py`。

# 分时资金榜自动持仓记账代理 — 设计文档

日期：2026-10-27
状态：已定稿（用户确认）

## 1. 背景与目标

依据 v2 实时动态页的「分时资金 · 横盘后拉升(前 20)」榜（`orchestrator/src/finance/shortline/fflow_pattern.ts`），实现一个**自动模拟盘记账代理**：盘中识别买入/卖出信号，自动向 `trade` 台账写入成交记录，持仓、成本、盈亏全部由现有重放引擎算出，用户在「我的持仓」页面直接可见。

这是模拟盘（paper trading），不接券商、不执行真实交易。

## 2. 关键现状（设计依据）

- 榜单字段（`FflowCandidate`，fflow_pattern.ts:23-30）：`code/name/price/pct/main_net/flat_minutes/rise_minutes/rise_bp/up_ratio/series_bp`（曲线尾部 ≤60 点）。无 DDX/DDY，「DDX」为文档俗称。
- 分钟曲线两通道自动切换：腾讯 5 分钟估算（`tx_minute_today`）/ 东财真实大单口径（`em_fund_flow_minute`）。东财 mapper 已透传 super_net/large_net，本设计暂不启用（YAGNI，后续可叠加资金结构过滤）。
- 现有基础设施全部复用：
  - 台账：`orchestrator/src/finance/ledger_kinds.ts:136` `trade`（opening/buy/sell，hiddenFromAssistant，成交不进 AI 上下文，天然满足合规红线）；
  - 持仓重放：`orchestrator/src/finance/holdings.ts`（FIFO / 移动加权），视图 `/view/holdings`、`/view/holdings_perf`；
  - 调度：`orchestrator/src/finance/schedule.ts:300` `FINANCE_SCHEDULE` + `orchestrator/src/notify.ts` 进程内调度器（北京时间、交易日门判定、安静时段、收件箱 InboxItem、webhook）；
  - 信号：fflow_pattern 进程内缓存 45s（fflow_pattern.ts:48）。
- 价格均为近似：现价 ± 0.1% 滑点，无撮合。

## 3. 总体架构

新增一个模块 + 一个调度任务，无前端改动：

```
orchestrator/src/finance/auto_trade.ts      规则引擎（纯函数，可单测）
orchestrator/src/finance/schedule.ts        FINANCE_SCHEDULE 新增盘中任务 auto_fflow_trade
```

数据流：调度 tick → 读 fflow_pattern 榜单（复用缓存）→ 读当前持仓（holdings 重放）→ 规则引擎输出买卖指令 → 写 `trade` 台账（带 `source=auto_fflow` 标记）→ 收件箱记录决策快照（可选 webhook 推送）→ 持仓页自动反映。

规则引擎是纯函数：`decide(state, clock) → Order[]`，输入 = 榜单 + 持仓 + 时钟，输出 = 指令列表（buy/sell + 价格 + 理由），不直接碰 IO，便于单测。

## 4. 资金与仓位规则

- 初始资金 100 万由执行器状态文件记账（台账 replay 无现金概念，`opening` 只会生成伪持仓污染持仓页）；成交仍全部写 `trade`，盈亏由重放算出。目标总仓位恒定 **50%**（50 万额度，半仓滚动）。
- 最多同时持有 **5 只**，单笔固定 **10 万**等权。卖出一只释放 10 万额度，新信号补位。
- 不做再平衡：个股涨超额度不强制减（让利润奔跑），新买永远按 10 万一笔。
- 初始：信号多于额度时按 score 排序逐个买满 5 只为止。

## 5. 买入规则（盘中信号即买）

每 **5 分钟**扫描一次（09:35–14:50，**14:50 后不开新仓**）。信号票须全部满足：

| 条件 | 阈值 |
|---|---|
| 持仓/冷却 | 未持有、有空闲额度、近 3 个交易日内未买过该票 |
| 涨幅 `pct` | 3% ≤ pct ≤ 6%（≥7% 追高跳过；主板 ≥9.5%、创业板/科创板 ≥19% 视为涨停买不进，跳过） |
| 稳步度 `up_ratio` | ≥ 0.6 |
| 拉升幅度 `rise_bp` | 达到 fflow_pattern 横盘→拉升默认判定线 |
| 主力净额 | 当日 `main_net` 占流通市值 ≥ 5bp（无流通市值时用当日成交额近似） |
| 排除 | 非 ST、非停牌、非一字板（无上市日期数据源，v1 不做新股过滤） |

成交价 = 信号时刻现价 × (1 + 0.1% 滑点)。

## 6. 卖出规则（四条，先到先执行）

1. **止损**：现价 ≤ 买入成本 × 0.95 → 现价卖出；
2. **止盈**：现价 ≥ 买入成本 × 1.08 → 现价卖出；
3. **形态破坏**：该票当日资金曲线由正转负且持续 ≥30 分钟（分钟序列取 fflow_pattern 同款通道）→ 现价卖出；
4. **到期强平**：持有满 **3 个交易日** → 当日收盘前现价卖出，释放额度。

- 成交价 = 现价 × (1 − 0.1% 滑点)。
- **T+1**：当日买入最早次日可卖，止损/止盈/形态破坏当日对新仓不生效；到期强平按交易日计数，最早 T+3 日。
- 卖出后该票冷却 1 个交易日。

## 7. 可观测性

- 每次自动成交写一条收件箱记录：信号字段快照（pct/main_net/rise_bp/up_ratio）、触发的规则编号、成交近似价；复用现有 webhook 可推企业微信/飞书。
- `trade` 记录带 `source=auto_fflow` 标记，与手工记账区分（持仓页展示/筛选）。

## 8. 错误与边界处理

- 取数失败（榜单/分钟曲线/交易日历拿不到）：本轮跳过，不写任何记录，记一条 warn 日志（与 finance 现有任务的降级行为一致）。
- 现价缺失或为 0：跳过该票。
- 台账写入失败：不静默吞掉，记错误日志并保留指令待下一轮重试（防重复成交靠幂等：写入前校验该信号当轮未执行过）。
- 重复触发防护：同一信号轮内每条指令有确定性 key（如 `buy-<code>-<bar_ts>`），重复 tick 不产生重复成交。

## 9. 测试

- 规则引擎纯函数单测覆盖：冷却期、T+1、涨停过滤、额度滚动（买满 5 只→卖 1 只→补 1 只）、四条卖出规则各自触发与优先级、14:50 后不开仓、非交易日不跑。
- 集成验证：挂起代理，观察「我的持仓」页与收件箱若干交易日；核对 holdings 重放数字与预期一致。

## 10. 明确不做（YAGNI）

- 真实交易接入、东财 super/large 资金结构过滤（方案 C，预留）、A 组对照盘、自动再平衡、多策略并行。

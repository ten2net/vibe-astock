# 界面截图 / UI screenshots

拍摄日期 / Captured: 2026-10-10 至 10-11（周末，休市 / weekend, market closed）。

开发版前端，由本地开发服务和产品自带的本地服务运行，数据目录是单独新建的演示目录；无头 Chrome 用单独的临时配置，视口 1440 × 1020，未接入 AI。除首次接入弹窗那张外，每张拍摄前都点了弹窗里的「暂不接入，先浏览」把它关掉（10-11 补拍时弹窗已不再出现）；拍「从旧版导入」前清空了输入框里自动填好的本机路径。没有注入假回复、修改页面文字或合成界面，拍摄时没有调用模型，也没有读取私人持仓、研报或账号凭据。图片不带任何元数据。

- **示例数据**：自选 5 只；持仓 3 笔期初流水；交易日志里 7 买 7 卖的示例成交、7 条标注、1 张模式卡；1 条论点、2 条判据。都是拍摄前通过产品自己的台账接口录入的，每条备注都写着「示例数据」或「示例」，价格取在当天真实的最高价和最低价之间，不是真实交易。交易日志的「按情绪环境」分组用的是这几天真实的情绪读数。
- **AI 复盘 / AI 周报**：2026-10-10 在开发验证时用 Claude Code 订阅给 2026-10-09 实际写的版本（复盘 4 版、周报 3 版），原样复制进演示目录，没有改动。「明日验证」里 2026-10-09 写下的 4 条条件，是从其中一版 AI 复盘建议的条件一键加进去的；下一个交易日（10-12）还没收盘，所以没有对账结果。
- **竞价与盘中**：旧版（v1.x）在 2026-09-23 交易时段存下的盘中快照，用「从旧版导入」导进演示目录；旧快照没有「1进2」这一项，所以那一列显示「—」。
- **研究报告**：2026-10-08 开发验证时用 Claude Code 订阅跑完的一份中际旭创六阶段报告，原样复制进演示目录，没有改动。
- **其余内容**（指数、情绪读数、连板天梯、题材轮动、涨停样本、复盘、K 线、资讯、GPU 租金、事件日历、候选池）都是拍摄时页面自己取到的公开数据快照。今日情绪、连板天梯、题材轮动三张是 10-11 新功能做完后重拍 / 补拍的；题材轮动那张只裁出了这一块。
- 候选池的条件（沪深300、市盈率 0–15 倍、市净率不超过 1.5 倍）只是为了演示核对过程，不是选股建议。

Development-build frontend, served by the local dev server and the product's own local server with a separate, newly created demo data directory. Headless Chrome with a separate temporary profile, viewport 1440 × 1020, no AI connected. Except for the first-connection dialog shot itself, the first-run dialog was closed with "暂不接入，先浏览" (browse without connecting) before each shot (it no longer appeared during the October 11 retakes); before the "Import from the old version" shot, the local path prefilled in its input was cleared. No fabricated replies, DOM text replacements, or composited UI; no model calls during capture and no access to private holdings, reports, or credentials. The images carry no metadata.

- **Demo data**: 5 watchlist entries; 3 opening-position transactions; 7 buys and 7 sells of demo trades in the trade journal, 7 trade labels, and 1 playbook card; 1 thesis and 2 criteria. All were entered through the product's own ledger API before capture; every note says "示例数据" or "示例" (demo data / example), prices fall between that day's real high and low, and none of it is a real trade. The journal's "by sentiment" split uses the real sentiment readings for those days.
- **AI review / AI weekly review**: versions actually written on October 10, 2026 with a Claude Code subscription for October 9 during development testing (4 review versions, 3 weekly versions), copied into the demo directory unchanged. The 4 next-day conditions written on October 9 were added in one click from the conditions one of those AI reviews suggested; the next trading day (October 12) had not closed yet, so they have no result.
- **Auction & intraday**: snapshots the old version (v1.x) saved during the September 23, 2026 session, brought into the demo directory with "Import from the old version"; the old snapshots have no first-to-second-board field, so that column shows "—".
- **Research report**: a complete six-stage report on Zhongji Innolight (300308) produced on October 8, 2026 during development testing with a Claude Code subscription, copied into the demo directory unchanged.
- **Everything else** (indices, sentiment readings, board ladder, theme rotation, limit-up samples, daily review, candlestick chart, news, GPU rental rates, event calendar, candidate pool) is the public data the pages fetched at capture time. The Today, board ladder, and theme rotation shots were retaken or added on October 11 after those features were built; the theme rotation shot is cropped to that block.
- The candidate-pool conditions (CSI 300, P/E 0–15, P/B at most 1.5) only demonstrate the checking process; they are not a stock pick.

<table>
<thead>
<tr><th nowrap>文件 / File</th><th>场景 / View</th></tr>
</thead>
<tbody>
<tr><td nowrap><a href="shortline-today.png">shortline-today.png</a></td><td>情绪复盘 · 今日情绪 / Sentiment review · Today</td></tr>
<tr><td nowrap><a href="shortline-ladder.png">shortline-ladder.png</a></td><td>情绪复盘 · 连板天梯 / Sentiment review · Board ladder</td></tr>
<tr><td nowrap><a href="shortline-rotation.png">shortline-rotation.png</a></td><td>情绪复盘 · 近 5 天 · 题材轮动（只裁出这一块）/ Sentiment review · Last 5 days · Theme rotation (cropped to this block)</td></tr>
<tr><td nowrap><a href="watch-live.png">watch-live.png</a></td><td>盯盘 · 实时动态 / Watch · Live moves</td></tr>
<tr><td nowrap><a href="watch-intraday.png">watch-intraday.png</a></td><td>盯盘 · 竞价与盘中 / Watch · Auction &amp; intraday</td></tr>
<tr><td nowrap><a href="shortline-review.png">shortline-review.png</a></td><td>AI 复盘 / AI review</td></tr>
<tr><td nowrap><a href="shortline-weekly.png">shortline-weekly.png</a></td><td>AI 周报 / AI weekly review</td></tr>
<tr><td nowrap><a href="shortline-verify.png">shortline-verify.png</a></td><td>明日验证 / Next-day checks</td></tr>
<tr><td nowrap><a href="shortline-samples.png">shortline-samples.png</a></td><td>涨停样本 / Limit-up samples</td></tr>
<tr><td nowrap><a href="journal-records.png">journal-records.png</a></td><td>交易日志 · 交易记录（示例数据）/ Trade journal · Trades (demo data)</td></tr>
<tr><td nowrap><a href="journal-review.png">journal-review.png</a></td><td>交易日志 · 复查（示例数据）/ Trade journal · Review (demo data)</td></tr>
<tr><td nowrap><a href="home-dark.png">home-dark.png</a></td><td>深色首页 / Dark home</td></tr>
<tr><td nowrap><a href="home-light.png">home-light.png</a></td><td>浅色首页 / Light home</td></tr>
<tr><td nowrap><a href="daily-review.png">daily-review.png</a></td><td>每日复盘 / Daily review</td></tr>
<tr><td nowrap><a href="stock-overview.png">stock-overview.png</a></td><td>个股深挖 · 概览 / Company deep dive · Overview</td></tr>
<tr><td nowrap><a href="research-report.png">research-report.png</a></td><td>六阶段研究报告 / Six-stage research report</td></tr>
<tr><td nowrap><a href="sectors.png">sectors.png</a></td><td>产业研究 / Industry research</td></tr>
<tr><td nowrap><a href="intel.png">intel.png</a></td><td>资讯雷达 / Intelligence radar</td></tr>
<tr><td nowrap><a href="signals.png">signals.png</a></td><td>产业信号 / Industry signals</td></tr>
<tr><td nowrap><a href="holdings.png">holdings.png</a></td><td>我的持仓（示例数据）/ Holdings (demo data)</td></tr>
<tr><td nowrap><a href="calendar.png">calendar.png</a></td><td>事件日历 / Event calendar</td></tr>
<tr><td nowrap><a href="candidates.png">candidates.png</a></td><td>候选池 / Candidate pool</td></tr>
<tr><td nowrap><a href="connect-ai.png">connect-ai.png</a></td><td>首次接入弹窗 / First connection dialog</td></tr>
<tr><td nowrap><a href="settings-import.png">settings-import.png</a></td><td>接入 AI 页 · 从旧版导入 / Connect AI page · Import from the old version</td></tr>
</tbody>
</table>

接入弹窗只展示选项，不代表任何账号已经通过连接测试。英文 README 沿用同一套中文产品界面截图，不暗示已提供英文 UI。截图只展示界面，不构成投资建议。

The connection dialog only displays choices; it is not evidence that any account passed a connection test. The English README uses the same Chinese product UI screenshots and does not imply an English UI is available. The screenshots only show the interface and are not investment advice.

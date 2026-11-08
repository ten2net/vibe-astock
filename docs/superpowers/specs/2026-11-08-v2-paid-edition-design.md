# Vibe AStock v2 付费版设计

日期：2026-11-08
状态：已定稿（用户确认）
参考材料：公众号《不用注册公司，个人身份就能收海外款：我怎么接的 Waffo》（小路呀，Waffo Pancake MoR 收款接入实录，作为**收款/支付实现参考**，非产品分层参考）

## 1. 背景与目标

当前源码主线已是 **v2.1.2**（`README.md` badge、CHANGELOG 顶部），v1.1.3 为 Python 旧版归档（`README-v1.md`）。本设计不是「从零起一个 v2」，而是**在 v2.1.x 本地网页工作台基线上叠加一层付费能力**：

- 保留 Apache-2.0 开源、本地优先、数据存本机、自带 AI Key 的现有形态为「社区版」；
- 新增「Pro 付费版」：卖**由服务端承担成本的资源与效率工具**，用 Waffo（MoR）收海外款；
- 付费判定与额度扣减**全部在后端**，不靠前端开关或浏览器本地存储。

产品硬约束（CODEBUDDY.md、`review_agent/product_policy.py`）不因付费化改变：**不输出投资决策、买卖建议、仓位指令**；行情与统计仍由程序确定性计算，不依赖 AI 生成；付费不触及这两条红线。

### 设计对象确认

- 对象＝**本仓库 Vibe AStock**（非文章作者的 AI 视频站）。
- Waffo 文章只提供收款通道与支付后端实现要点，不提供版本分级结论。
- 复用现有自动持仓记账（`2026-10-27-auto-fflow-ledger-design.md`）作为 Pro 进阶能力之一，不重复造规则引擎。

## 2. 关键现状（设计依据）

- `server.py`：FastAPI 单端口托管 `frontend/dist/`；已有 `_merge_vr_routes()`（逐文件合并 `vr/` 路由，禁止整目录覆盖）、`app.include_router(...)`、HTTP 中间件 `_vr_guard`（`_ALLOWED_HOSTS` 默认仅回环，改公网/反代需 `VIBE_ALLOW_HOSTS`）、`_guard_vr_userdata()`（用户数据本地隔离）。新 billing 路由应作为独立 router 挂入，不改 vr/ 原有文件。
- `review_agent/runtime.py`：隔离引擎、FrozenInputs、有界 MCP 证据工具、`DISABLED` 显式禁用 shell/联网——托管 AI 额度必须走这一层，不能另开一条「付费直连大模型」的旁路。
- 数据落盘分散（CODEBUDDY.md）：`~/.vibe-astock-agent/`、`~/.duanxian-agents/`、`VR_DATA_DIR`、以及**浏览器本地存储**（自选/界面/API 配置）。付费账号与授权不得存浏览器本地存储。
- 合规定位：README 明确「行情和统计由程序算，AI 只负责解读，数据记录存自己电脑」。Waffo 入驻业务介绍（文章第 10 步）要求「专业、可验证、别写『我做软件』」；本产品是金融复盘工具、非 AIGC 媒体生成，审核按数字产品/服务申报，AI 生成图片/视频那层检测不适用，但「不输出投资建议」的合规定位要如实写进业务介绍。
- Waffo 关键事实（文章）：MoR 代管税务/合规，个人身份 + 身份证实名 + 支付宝提款；手续费 **3.9% + $0.50**/成功交易，无月费；**只支持数字产品与服务**；一个站点一个店铺（隔离单位）；商品支持一次性 + 订阅混排；买家侧微信支付已支持（大陆/香港，USD/CNY），支付宝买家侧未开放；测试/生产 Key 与 Webhook 公钥各一套。

## 3. 版本分级与定价

### 3.1 三层定位

| | v1 归档（Python 旧版） | v2 社区版（免费/开源） | v2 Pro（付费） |
|---|---|---|---|
| 形态 | 历史归档，仅数据可导入 | 本地网页、自带 AI Key、自己跑 | 同底座 + 服务端托管资源 |
| 行情/复盘/回测/台账/情绪读数 | — | 全量保留（核心确定性能力**不阉割**） | 全量 + 增强 |
| AI 解读/辩论/复盘 | — | 用户自配 Key（Codex/Claude/WorkBuddy/API） | 内置**托管 AI 额度**，免配 Key，按积分消耗 |
| 自动持仓记账代理（fflow） | — | 不含 | 含（复用已定稿设计） |
| 分时资金形态榜进阶过滤 | — | 基础 | 增强（资金结构过滤等后续项） |
| 资讯雷达/事件概率 | — | 基础 | 增强覆盖 + 历史回看 |
| 数据与同步 | — | 纯本机（浏览器本地存储 + 本地目录） | 多端同步、云备份 |
| 更新与支持 | — | 社区 | 优先更新 + 专属支持 |

### 3.2 定价形态（贴合 Waffo 一次性 + 订阅混排）

- **订阅商品**：Pro 月付 / 年付，含每月托管 AI 额度 → Waffo「订阅」。
- **积分包**：一次性购买额外 AI 额度 → Waffo「一次性」；对应文章作者 AI 视频站的积分包逻辑。
- **不卖**：信号、荐股、买卖建议、仓位指令、任何「付费解锁确定性行情数字」。只卖算力额度 + 效率工具 + 同步服务。
- 毛利需计入 3.9% + $0.50/笔手续费；小额积分包定价过低会被固定 $0.50 吃掉，定价时设最低客单价。

### 3.3 为什么付费点放在服务端资源而非「本地功能开关」

本地网页前端可被复制，`localStorage` 标记等于没有付费墙。托管 AI 额度本身就是天然的服务端 gate（额度在服务端扣、调用走隔离引擎），比「解锁本地按钮」更防绕过，也更符合收款逻辑。本地确定性计算继续免费开源，保住社区信任。

## 4. 总体架构

新增一个后端模块 `billing/` + 在 `server.py` 挂一个 router；前端只增加「账号/订阅/额度」视图，不承载任何授权判定。

```
浏览器(React)  →  FastAPI(server.py)
   ├─ /api/auth/*              账号登录 / 授权签发(JWT)，服务端持权
   ├─ /api/billing/products    服务端商品表(订阅/积分包)：价格/币种/额度由服务端定
   ├─ /api/billing/checkout    建内部订单 → 创建 Waffo 会话，回传内部订单号
   ├─ /api/billing/webhook     验签 → 幂等 → 事务内「订单已付 + 发额度/开权益」
   ├─ /api/billing/entitlement 查询当前授权与剩余额度
   └─ /api/ai/*（Pro 托管）    先查授权 + 扣额度 → 再走 review_agent 隔离引擎
                              （FrozenInputs / DISABLED / 引用校验 / 产品政策不变）
```

新增文件：

```
billing/
   products.py      服务端商品配置(订阅/积分包 → 价格/币种/额度映射)，唯一真源
   orders.py        内部订单：待处理/已付/已退，带内部订单号与用户关联
   waffo.py         Waffo API 封装：建会话、验签、金额字段解析
   webhook.py       验签 + 幂等 + 订单与权益原子处理
   entitlement.py   授权(JWT)与额度账本：查询/扣减/发放
   router.py        APIRouter，由 server.py include_router 挂入
```

数据落盘：授权与额度账本放 `~/.vibe-astock-agent/`（沿用 `ASTOCK_AGENT_HOME` 根），**不进浏览器本地存储**，不与 `~/.duanxian-agents/` 的复盘/台账混放。

`server.py` 改动仅限：`app.include_router(billing_router)` 一行 + 必要的配置读取；vr/ 与 review_agent 现有逻辑零改动（遵循 `_merge_vr_routes` 的逐文件合并纪律）。

## 5. 支付流程（Waffo 官方契约，2026-11-08 按官方文档重写）

> 权威来源（本章以官方文档为准，覆盖那篇公众号文章的表述）：
> - `https://docs.waffo.ai/api-reference/webhooks.md`（验签、payload、事件类型、响应/重试）
> - `https://docs.waffo.ai/api-reference/endpoints/orders/create-checkout-session.md`（建会话）
> - `https://docs.waffo.ai/api-reference/authentication.md`（API Key 请求签名）
> - `https://docs.waffo.ai/integrate/ai-integration.md`（环境变量、SDK 概览）
>
> 技术栈决策：后端是 Python/FastAPI 单进程，官方 SDK 是 TypeScript，故用官方文档给出的
> **Python 手动 REST 接入**（`requests` + `cryptography`），不引入 Node 子进程。

### 5.1 建单与建会话

1. 服务端先创建**带内部订单号**的待处理订单，再 `POST /v1/actions/checkout/create-session`。
2. **商品映射由服务端说了算**：前端只传 `product_id`；价格/币种/额度由 `products.py` 定。
   真实 Waffo Product ID 走运行时环境变量 `WAFFO_PRODUCT_<大写站内ID>`（`PROD_xxx`），
   不硬编码。价格以 Waffo 后台商品定价为准（官方推荐「Path B：复用控制台商品」），
   `products.py` 的 price_cents 用于展示与发放积分，**必须与后台商品价一致**。
3. **API Key 认证**（不能用 Store Slug，否则 `metadata` / `orderMerchantExternalId` 被静默忽略）：
   - `canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + SHA256_BASE64(BODY)`
   - `X-Signature = Base64(RSA-SHA256(canonical, privateKey, PKCS1v15))`
   - 头：`X-Merchant-Id` / `X-Timestamp` / `X-Signature`；**不需要** `X-Environment`（每个 Key 绑定环境）
   - 出站时间戳窗口：落后 ≤5 分钟、超前 ≤1 分钟（与 webhook 的 45 分钟不同！）
4. **内部订单号回传**：`orderMerchantExternalId`（≤128 字符）+ `metadata.orderId`，
   分别透传到 webhook `data.orderMerchantExternalId` / `data.orderMetadata`，用于找回站内订单。
   `user_id` 从 JWT 取，不再信任请求体（§12-3）。
5. 响应 `{data:{sessionId, checkoutUrl, expiresAt}}`；回填订单后把 `checkoutUrl` 返给前端跳转。
6. 一个 Vibe AStock 站点 = 一个 Waffo Store；订阅与积分包都在这一个店铺内。

### 5.2 支付成功判定

- 用户从收银台跳回网站**只代表浏览器回来了**，不能凭跳转参数认定付款成功、开始发额度。
  （官方：无 `cancelUrl`，放弃支付不触发任何 webhook；`successUrl` 也不会自动跳转。）
- 唯一可信来源是**验签通过的 Webhook**；前端回调页只展示「处理中/去账户中心查看」。

### 5.3 Webhook：验签、幂等、原子（发额度前必做）

1. **验签**（官方「Signature Verification」）：
   - 头 `X-Waffo-Signature: t=<毫秒时间戳>,v1=<base64签名>`；另有 `X-Waffo-Event` 事件类型。
   - 签名输入 **`${t}.${rawRequestBody}`**——必须 `request.body()` 取**原始字节**，
     先 JSON 解析再序列化会改变空白字符导致验签失败（官方「常见陷阱」第一条）。
   - **RSA-SHA256 + PKCS1v15 + SHA256**，用 Dashboard → Settings → Webhooks 的**平台级公钥 PEM**
     （test / prod 各一把，所有店铺共用）。按 payload 的 `mode` 选对应公钥，选错会验签失败。
   - 时间容差 **45 分钟（不是 5 分钟）**：重试复用原始签名头（`t` 永不重签），最后一次重试
     在首次投递 31+ 分钟后；5 分钟窗口会把合法重试误判为 401。
   - **真正的防重放靠 `eventType + eventId` 去重**，不靠收紧时间窗。
   - 验签通过后额外校验 `mode` / `storeId` 与配置一致（`WAFFO_EXPECTED_MODE` / `WAFFO_STORE_ID`），
     错误店铺、错误环境一律拒绝（§5.3 原约束保留）。
2. **幂等**：官方 `processed_webhooks` 用 `(event_type, event_id)` 联合主键 + `INSERT OR IGNORE`。
   额度发放另有 `credit_ledger.idempotency_key`：一次性订单用 `grant-<order_id>`，
   订阅按 `grant-<eventId>`（每次扣款各发一期、重试不重复），退款用 `refund-<order_id>-<eventId>`。
3. **订单与额度原子处理**：事件去重标记、订单置 `paid`、发放/扣回额度**全部在单个事务**内
   （`db.transaction` + `*_in_tx` 变体，避免嵌套事务提前提交）。任一环节失败整事务回滚，
   连事件标记一起回滚 → Waffo 重试可安全重放。满足 §5.3「订单与额度一起处理」。

### 5.4 金额字段语义（易错点，已写进代码注释）

官方「Deprecated amount fields」确认了文章所述并补充了层级与类型：金额都在 `data` 下、
是 **display 格式字符串**（如 `"98.00"`），`amount` 已被标记 **Deprecated**（在支付/退款/订阅
三类事件里指三种不同的东西）。**禁止**再断言 `amount == total`。

| 事件主体 | 实扣 | 标价 / 原价 | 弃用字段对应 |
|---|---|---|---|
| `order.completed` / `subscription.payment_succeeded` | `data.chargedAmount` | `data.listPrice.total` | `amount`→chargedAmount；`total`→listPrice.total |
| `refund.succeeded` / `refund.failed` | `data.refundedAmount` | `data.originalPayment.total` | `amount`→refundedAmount；`total`→originalPayment.total |
| 订阅状态事件（`subscription.activated` 等） | — | `data.planPrice.total` | `amount`→planPrice.total |

`billing/waffo.py::parse_amount` 按 `eventType` 主体命名解析，绝不复用一个 `amount`。
`listPrice` 与 `chargedAmount` 仅在按比例抵扣或零元卡验证时不同（折扣场景用
`listTotal − discountAmount = total`，不用 `subtotal + taxAmount`）。

### 5.5 退款、边界与响应

- 官方**响应要求**：10 秒内返回 **2xx**（建议 200，body 不限）；推荐「先返回 200 再异步处理」，
  重试由非 2xx / 超时触发（最多 3 次，间隔约 12s / 2m28s / 30m8s）。
  **本实现刻意同步处理**：本地 SQLite 为毫秒级、无外部 IO，远在时限内；同步能让意外失败
  返回 500 触发重试（因幂等而安全），且不必引入后台任务与「标记已处理却没发放」的窗口。
  这是对官方「建议异步」的简化，若将来发放涉及慢 IO 再改异步。
- 回调早于建单 / 关联不上 / 乱序：留 `processed_webhooks` 原始记录（`outcome=ignored`），
  **不假装处理成功**，供人工或下一轮核对（§7）。
- `refund.succeeded` 幂等扣回该订单额度；部分退款按整单额度扣回（细则待定）；
  订阅状态机（canceled / past_due / recovered / renewed）v1 只记录事件、不改额度。
- **部署约束**：`/api/billing/webhook` 需公网可达，而 `server.py` 的 `_vr_guard` 对所有 `/api/`
  校验 Host 白名单 → 生产必须把对外域名写进 `VIBE_ALLOW_HOSTS`，否则 Waffo 回调被 403。
  这是运营配置，不改中间件语义（§6 不放宽白名单）。

## 6. 授权与额度

- 登录后后端签发短期 JWT（含用户 id、授权等级、到期时间）；付费功能在 **FastAPI 依赖/中间件层** gate，而非前端隐藏按钮。
- `/api/ai/*`（Pro 托管）调用链：校验 JWT → 查额度 → 预扣/扣减 → 进入 `review_agent` 隔离引擎（FrozenInputs 冻结日期与取数范围、`DISABLED` 仍禁 shell/联网、ANSWER_SCHEMA 引用校验、`has_trade_recommendation` 保存前拦截）→ 返回结果。托管额度用尽返回明确提示，引导购买积分包，**不降级到用户自配 Key 的旁路**以免绕过计费。
- 社区版路径完全不变：用户自带 Key 直连现有 `review_agent/access.py` 接入源，不经过 billing。
- 远程访问场景：若经反代/公网，`VIBE_ALLOW_HOSTS` 与 HTTPS 约束（server.py `_vr_guard`）依旧生效；付费不放宽 Host 白名单。公网地址仍强制 HTTPS。

## 7. 可观测性与对账

- 每笔订单状态流转、每次额度发放/扣减、每个 Webhook 事件（含被拒绝的）落库，保留 Waffo 交易号与内部订单号映射。
- 提供后台对账视图：订单 × Waffo 交易 × 额度流水三方核对；店铺营收按 Waffo 后台单独统计（一个站点一个店铺，便于定位）。
- 沿用现有收件箱/日志习惯：Webhook 异常、验签失败、幂等命中记结构化日志，不写进 AI 上下文。

## 8. 错误与边界处理

| 场景 | 处理 |
|---|---|
| 前端提交价格/积分数 | 忽略，按服务端商品配置；规格不符拒绝发起 |
| 跳转回参声称成功 | 不采信，等验签 Webhook |
| 验签失败/过期/错误店铺/错误环境 | 直接拒绝，记日志 |
| 重复/乱序/早到回调 | 幂等 key + 可核对记录 + 恢复路径，不假装成功 |
| 额度发放与订单状态不一致 | 事务内原子处理；失败返回非 2xx 触发重发 |
| 取数/账单服务不可用 | 建单失败明确报错，不产生「幽灵订单」 |
| 托管额度耗尽 | 明确提示 + 引导积分包，不静默降级 |
| 退款 | 幂等扣回额度，细则随订阅策略定 |

## 9. 合规与产品政策

- 付费不售卖、不解锁任何投资建议/买卖动作/仓位指令；`has_trade_recommendation` 拦截对 Pro 报告同样生效。
- 行情、情绪读数、回测结果仍由程序确定性计算，付费不强化「AI 给结论」的表述。
- Waffo 业务介绍如实写明：金融复盘工具、数字产品/服务、不售实体商品、不输出投资建议；域名验证、服务条款、隐私政策按文章第 9 步走「网站自检」。
- 个人身份入驻：Profile 法定姓名用证件中文姓名（提款户名，逐字符核对），入驻「全名」字段用拉丁字母拼音（中文姓名连写不加空格）；有提款记录后核心字段不可自助改，先改再提款。提款账户大陆用支付宝绑定注册手机号/邮箱。这些属**运营入驻动作**，不写进代码。

## 10. 测试

- `billing/products.py`：前端篡改价格/币种/积分/user_id 被拒（user_id 从 JWT 取）；无映射、规格不符、缺凭据拒绝建会话。
- **Webhook 验签（官方契约）**：用临时 RSA 密钥对真实签名——正确签名通过；篡改 body、重新序列化 JSON、错公钥、超 45 分钟、缺 mode、错店铺/环境一律拒绝；31 分钟后的合法重试必须通过（5 分钟窗口会误杀）；测试公钥不验生产事件。
- **API Key 出站签名**：canonical request 的签名可被对应公钥验证；建会话请求带 `orderMerchantExternalId` + `metadata.orderId`、不含 `priceSnapshot`（防前端改价）；响应 `{data:{...}}` 与错误 `{errors:[...]}` 解析。
- **幂等**：`eventType + eventId` 重复投递只发一次额度；订阅按 `eventId` 每期各发一次；同一退款只处理一次；乱序/早到回调留原始记录可恢复。
- **原子性**：模拟「发放额度抛错」→ 订单状态、额度、事件标记整事务回滚，不出现半状态。
- **金额字段**：支付用 `chargedAmount`/`listPrice.total`，退款用 `refundedAmount`/`originalPayment.total`，订阅状态用 `planPrice.total`；值为 display 字符串、位于 `data` 下；`subscription.payment_succeeded` 按支付事件解析；**断言不依赖 `amount == total`**（`amount` 已弃用）。
- 授权 gate：无 JWT / 过期 / 额度耗尽均被后端拦截，前端隐藏按钮不构成绕过；社区版自带 Key 路径回归不受影响。
- 回归：`npm --prefix frontend run build`、`.venv/bin/python -m pytest tests backtest/tests research_data/tests -q`；新增 billing 单测以 `-m unit` 可离线跑（不打网络）。
- 合规回归：Pro 报告文本经 `has_trade_recommendation` 仍被拦截（复用现有产品政策测试）。

## 11. 明确不做（YAGNI）

- 真实交易接入、券商对接、荐股/信号付费。
- 阉割社区版核心确定性能力做「付费解锁」。
- 前端 localStorage 存授权或额度、前端做付费判定。
- 另开一条绕过 `review_agent` 隔离引擎的付费直连大模型通道。
- 多站点多店铺矩阵、实体商品销售、支付宝买家侧（Waffo 尚未开放）。
- 自建税务/合规体系（由 MoR 承担）。
- 整目录覆盖 vr/ 或改动 `server.py` 既有中间件语义。

## 12. 落地顺序建议

1. `billing/` 骨架 + 服务端商品表 + 内部订单（不接真钱，纯结构）。
2. ✅ Waffo 测试环境：建会话、Webhook 验签、金额字段解析、幂等与事务（已按官方契约完成，2026-11-08；生产 Key/公钥与入驻仍待运营动作）。
3. 授权(JWT) + 额度账本 + `/api/ai/*` gate 接隔离引擎。
4. 前端「账号/订阅/额度」视图 + 收银台跳转与回调页。
5. 生产 Key/公钥、Waffo 入驻与域名验证、测试支付跑通后再开真实收款；提款账户核对放在有首笔成功提款前完成。
6. 对账视图与退款策略补齐。

## 13. 修订记录

### 2026-11-08（Waffo 官方契约集成，§12-2 完成）

用户提供官方文档 `https://docs.waffo.ai/zh/integrate/ai-integration`，据此按真实契约重写 §5、落地 §12-2。**§5 以官方文档为准，覆盖公众号文章的表述**。技术栈选 Python 手动 REST（不引入官方 TS SDK / Node 子进程）。

- `waffo.py` 全量重写（删掉之前的 Protocol 占位）：
  - `verify_webhook`：`X-Waffo-Signature: t=<ms>,v1=<base64>`，`${t}.${rawBody}` → RSA-SHA256/PKCS1v15/SHA256，**45 分钟**容差，公钥 PEM 按 `mode` 选 test/prod；`select_and_verify` + `check_event_scope`（mode/storeId 校验）。
  - `build_signed_headers` / `create_checkout_session`：API Key canonical request 签名，`POST /v1/actions/checkout/create-session`，body 带 `orderMerchantExternalId` + `metadata.orderId`，解析 `{data:{sessionId,checkoutUrl,expiresAt}}`；`poster` 可注入做离线单测。
  - `parse_amount`：按 `eventType`（非旧的 `type`）解析，字段在 `data` 下、值为字符串；`amount` 视为 Deprecated；新增 `PAYMENT_EVENTS` / `REFUND_EVENTS`。
  - `WaffoConfig.from_env`：`WAFFO_MERCHANT_ID` / `WAFFO_PRIVATE_KEY(_BASE64)` / `WAFFO_WEBHOOK_PUBLIC_KEY_TEST` / `_PROD` / `WAFFO_API_BASE`；`resolve_waffo_product_id` 用 `WAFFO_PRODUCT_<ID>`。缺配置 fail closed。
- `db.py`：增 `processed_webhooks`（`PRIMARY KEY(event_type,event_id)`，含 raw_payload/outcome，§7 对账）；`orders` 经 `_add_columns_if_missing` 补 `checkout_url` / `checkout_expires_at` / `waffo_order_id` / `buyer_email` / `waffo_event_id`，老库平滑升级。
- `entitlement.py` / `orders.py`：拆出 `_apply_unlocked` / `_set_status_unlocked` + `grant_in_tx` / `refund_clawback_in_tx` / `set_status_in_tx`，让 Webhook 在**单个事务**内完成「去重标记 + 置 paid + 发额度」，避免嵌套事务提前提交。
- `webhooks.py`（新）：验签后事件分发。`order.completed` / `subscription.payment_succeeded` → 置 paid + 发放订单快照额度；`refund.succeeded` → 幂等扣回；其余订阅/store 事件只记录（`outcome=ignored`）；关联不上订单留原始记录不假装成功。内部订单号经 `orderMerchantExternalId` / `orderMetadata.orderId` 找回。
- `router.py`：新增 `POST /api/billing/checkout`（需 JWT，服务端建单→Waffo 建会话→回填→返 `checkout_url`）与 `POST /api/billing/webhook`（原始 body 验签、不需 JWT）；`POST /api/billing/orders` 的 `user_id` 改为从 JWT 取。
- `requirements.txt` 显式加 `cryptography>=42`（RSA 签名/验签）。
- **与公众号文章/旧设计的差异（重要）**：① 验签算法、45 分钟容差（**非 5 分钟**）、毫秒时间戳、靠 `eventType+eventId` 去重（非订单号、非时间窗）；② 官方推荐「先返回 200 再异步处理」，本实现因本地 SQLite 毫秒级而**同步处理完再返回**（偏差已在 §5.5 说明理由）；③ 事件是 `eventType`+`data` 嵌套、`amount` 弃用、金额是字符串；④ 建会话要 API Key RSA 签名，Store Slug 会忽略 metadata；⑤ `orderMerchantExternalId` 是官方的业务订单号回传字段。
- **部署约束**：`/api/billing/webhook` 需公网可达，`_vr_guard` 的 Host 白名单要求把对外域名写进 `VIBE_ALLOW_HOSTS`，否则 Waffo 回调 403（§5.5）。不改中间件语义。
- 待补（§12-3 之后）：真实账号/登录、`/api/ai/*` 接隔离引擎、订阅状态机、前端视图、对账视图、退款细则。
- 离线单测 `tests/test_waffo_integration.py` 新增 28 例（`-m unit`，用临时 RSA 密钥对真实签名/验签，不写死假验签）：验签通过/篡改/错公钥/45 分钟容差(含 31 分钟重试)/重解析 body 失败/缺 mode、API Key canonical 签名、配置 fail closed、事件分发/幂等/原子回滚、checkout+webhook 端到端。既有两份 billing 测试按新契约同步调整。三个 billing 测试文件合计 **64 passed**。
- 回归：全量 **1774 passed / 5 pre-existing failed**（5 例在 `main` 基线同样失败，与本次改动无关）/ 5 skipped / 2 xfailed；`py_compile` 全通过；真实 `server.app` 开启开关冒烟：products 200、未配 Waffo 时 checkout **503 fail closed**、非法 Host 的 webhook **403**（印证 §5.5 的 `VIBE_ALLOW_HOSTS` 约束）。

### 2026-11-08（协议无关授权额度内核，§12-3 部分）

用户提供 Waffo 官方文档前，先落地不依赖支付协议的部分；**验签/建会话不写假实现**。

- `db.py`：`init_schema` 增 `entitlements`（余额/等级/到期）与 `credit_ledger`（追加式流水，`idempotency_key UNIQUE`），全部 `CREATE IF NOT EXISTS` 老库可直接升级。
- `entitlement.py`：`grant`（`grant-<order_id>` 幂等，§12-2 发额度落点）、`consume`（`consume-<ref_id>` 幂等，余额不足**整事务回滚**且不落流水、不烧幂等键，§12-3 扣额度落点）、`balance`/`entitlement`、`refund_clawback`。均走 `db.transaction` 原子。
- `auth.py`：stdlib HS256 JWT（`hmac.compare_digest` 常量时间、`exp` 过期、`alg` 混淆拒绝），密钥取 `ASTOCK_BILLING_JWT_SECRET`，**缺失即报错不硬编码**，不引 PyJWT 等新依赖。仅签发/校验令牌，账号/登录体系仍未设计。
- `waffo.py`：`parse_amount` 按 §5.4 已知字段名（`chargedAmount`/`listPrice.total`/`refundedAmount`/`originalPayment`/`planPrice`）纯函数解析，**禁止 `amount == total` 断言**；`WebhookVerifier`/`CheckoutClient` 用 `typing.Protocol` 只声明契约，具体实现 pending 官方文档。
- `router.py`：改单 router 全路径（保持 `/api/billing/*` 不变，可挂 `/api/ai/*`）。新增 `GET /api/billing/entitlement`（需 Bearer JWT）与 `POST /api/ai/echo` **gate 占位**：验 JWT → 原子扣 `AI_CALL_COST` → 返回 stub，额度耗尽 402 引导积分包、**不降级自配 Key 旁路**（§6）；**不调用任何真实大模型**，真实 handler 接 `review_agent` 隔离引擎后替换。
- 单测 `tests/test_billing_entitlement.py` 21 例（`-m unit`）：JWT 签发/篡改/过期/算法混淆/缺密钥、发放与扣减幂等、余额不足回滚、三类事件金额解析、gate 401/402/幂等/不产建议。`test_billing_skeleton.py` 同步调整为 15 例。
- 当时待补的 §12-2（签名算法、事件结构、建会话、幂等表、checkout/webhook 端点）已于同日按官方文档补齐，见上方修订记录。
- 行为备注（历史）：当时 `POST /api/billing/checkout` 尚未实现，真实 `server.app` 的 GET-only SPA fallback（`server.py:1677`）使其返回 405；现已实现，该备注不再适用。
- 回归：全量 1746 passed / 5 pre-existing failed（同 `main` 基线）/ 5 skipped / 2 xfailed；真实 app 开启开关后冒烟通过（JWT→扣 10 额度→entitlement 余额 90）。

### 2026-11-08（骨架落地，§12-1）

- 新增 `billing/`：`db.py`（SQLite 连接/建表/事务，库落 `ASTOCK_AGENT_HOME/billing/billing.db`）、`products.py`（服务端商品表唯一真源，`resolve` 只收 product_id、不接受前端金额）、`orders.py`（内部订单：下单瞬间快照价格/币种/积分、状态机 pending→paid→refunded、`waffo_txn_id` UNIQUE 作幂等种子）、`router.py`（仅 products / 建待处理订单 / 查订单三个不碰钱端点）。
- `server.py` 仅加一段 env 开关：`ASTOCK_BILLING_ENABLED=1` 才 `include_router`，**默认关闭**，骨架阶段不改变线上 API 行为；开启后仍受 `_vr_guard` 的 Host 白名单约束（§6 不放宽）。
- 刻意未做（留 §12-2/3）：Waffo 建会话、Webhook 验签/幂等/发额度、JWT 授权与 `/api/ai/*` gate、前端视图。router 对 `/checkout`、`/webhook` 返回 404。
- 离线单测 `tests/test_billing_skeleton.py` 14 例（`-m unit`）：商品表唯一真源、**前端篡改 price/credits 被忽略**、未知商品拒绝、状态机非法跳转拒绝、事务回滚、幂等种子、router 端点与「无金钱端点」。
- 环境说明：本机 FastAPI 0.141 起 `include_router` 以 `_IncludedRouter` 包装挂载，`app.router.routes` 不再平铺计费路由，验证端点须用 `TestClient`；本机 pytest 需 `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`（ROS `launch_testing` 插件缺 `lark`）。
- 全量回归：1729 passed / 5 pre-existing failed（5 例在 `main` 基线同样失败，与本次改动无关）/ 5 skipped / 2 xfailed。

### 2026-11-08（初稿并定稿）

初稿并定稿（用户确认，分支 `feat/v2-paid-edition`）。确认设计对象为当前 v2.1.x 源码基线（非文章作者的 AI 视频站），Waffo 文章定位为收款/支付实现参考。分级、授权、支付流程、金额字段语义、合规约束均按本仓库现状与文章要点落地。

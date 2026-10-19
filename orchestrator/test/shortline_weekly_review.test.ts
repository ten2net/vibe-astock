import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { FINANCE_LEDGER_KINDS } from "../src/finance/ledger_kinds.ts";
import { cancelReview, resetReviews, reviewFinished, type TurnFn } from "../src/finance/shortline/review.ts";
import type { ItemResult } from "../src/finance/shortline/verification.ts";
import {
  shortlineWeeklyReview, shortlineWeeklyReviewAct, splitWeeks, startWeeklyReview, verifyEvidence, weekStart, weekTally, type DayCheck,
} from "../src/finance/shortline/weekly_review.ts";
import { detectPython } from "../src/init.ts";
import { ServiceError, ledgerInsertMany, ledgerList, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
// 2026-10-10 是周六;这一周(10-05 起)国庆休到 10-07,交易日只有 10-08、10-09
const NOW = new Date("2026-10-10T08:00:00Z");
const sig = () => new AbortController().signal;
const id = (name: string) => `ev-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`;

afterEach(() => resetReviews());

// ── 纯计算 ──
test("周的划分:周一起算;周末那天不算交易日;上周是前一周的交易日", () => {
  assert.equal(weekStart("2026-10-10"), "2026-10-05");
  assert.equal(weekStart("2026-10-05"), "2026-10-05");
  assert.equal(weekStart("2026-10-11"), "2026-10-05", "周日归前面那个周一");
  assert.equal(weekStart("2026-01-01"), "2025-12-29", "跨年");
  const K = ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"];
  assert.deepEqual(splitWeeks([...K, "2026-10-10"], "2026-10-10"), { thisWeek: ["2026-10-08", "2026-10-09"], lastWeek: ["2026-09-28", "2026-09-29", "2026-09-30"] });
  assert.deepEqual(splitWeeks([...K.slice(0, 5), "2026-10-08"], "2026-10-08"), { thisWeek: ["2026-10-08"], lastWeek: ["2026-09-28", "2026-09-29", "2026-09-30"] });
  // 交易日历没取到时只有 end 本身
  assert.deepEqual(splitWeeks(["2026-10-11"], "2026-10-11"), { thisWeek: [], lastWeek: [] });
  assert.deepEqual(splitWeeks(["2026-10-09"], "2026-10-09"), { thisWeek: ["2026-10-09"], lastWeek: [] });
  // 两头的周一:本周一算本周、不算上周;上周一算上周
  const M = ["2026-09-21", "2026-09-28", "2026-10-02", "2026-10-05", "2026-10-06"];
  assert.deepEqual(splitWeeks(M, "2026-10-06"), { thisWeek: ["2026-10-05", "2026-10-06"], lastWeek: ["2026-09-28", "2026-10-02"] });
});

const item = (over: Partial<ItemResult>): ItemResult => ({
  id: "x", metric: "limit_up_count", label: "涨停家数", unit: "家", kind: "count", higher_is_hotter: true, eps: 5,
  direction: "up", direction_label: "上升", reason: "", prev_value: 50, cur_value: 80, actual: "up", actual_label: "上升",
  verified: true, late: false, baseline: null, baseline_samples: null, baseline_reason: null, baseline_note: "", edge: null, written_at: "", ...over,
});

test("对账写成证据:读数照搬、比例标小数、取不到的不写;合计只数算战绩的", () => {
  const c: DayCheck = { set_date: "2026-10-08", date: "2026-10-09", provisional: false, results: [
    item({ reason: "延续\u0007" }),
    item({ metric: "broken_rate", label: "炸板率", unit: "", kind: "rate", direction: "down", direction_label: "下降", prev_value: 0.3, cur_value: 0.4, actual_label: "上升", verified: false, baseline_note: "这个方向近 60 天出现过 20%" }),
    item({ metric: "highest_board", label: "最高连板高度", unit: "板", direction: "flat", direction_label: "持平", late: true }),
    item({ metric: "deep_loss_count", label: "跌超5%家数", cur_value: null, actual_label: null, verified: null }),
    item({ metric: "market_amount_total", label: "两市成交额", unit: "元", prev_value: null, actual_label: null, verified: null }),
  ] };
  const ev = verifyEvidence(c);
  const of = (label: string) => ev.filter((e) => e.record_key === `2026-10-08 晚写·${label}`);
  assert.deepEqual(of("涨停家数").map((e) => [e.field, e.value, e.unit, e.period]), [
    ["判断方向", "上升", "text", "2026-10-08"], ["前一晚读数", 50, "家", "2026-10-08"], ["当天读数", 80, "家", "2026-10-09"],
    ["实际方向", "上升", "text", "2026-10-09"], ["对账结果", "成立", "text", "2026-10-09"]]);
  assert.equal(of("涨停家数")[0]!.note, "理由:延续", "理由剥掉控制字符");
  assert.deepEqual(of("炸板率").map((e) => [e.field, e.value, e.unit]).slice(1, 3), [["前一晚读数", 0.3, "小数"], ["当天读数", 0.4, "小数"]]);
  assert.equal(of("炸板率").at(-1)!.value, "不成立");
  assert.match(of("炸板率").at(-1)!.note!, /近 60 天出现过 20%/);
  assert.match(of("最高连板高度").at(-1)!.note!, /开盘竞价后才写或改,不计入战绩/);
  assert.deepEqual(of("跌超5%家数").map((e) => e.field), ["判断方向", "前一晚读数", "对账结果"], "当天读数没取到:不写空值");
  assert.equal(of("跌超5%家数").at(-1)!.value, "判不了");
  assert.deepEqual(of("两市成交额").map((e) => e.field), ["判断方向", "当天读数", "对账结果"], "前一晚读数没取到:也不写空值");
  assert.equal(new Set(ev.map((e) => e.id)).size, ev.length, "编号不重复");
  assert.ok(ev.every((e) => /^ev-[0-9a-f]{12}$/.test(e.id)));
  assert.deepEqual(verifyEvidence(c).map((e) => e.id), ev.map((e) => e.id), "同样的对账编号不变");

  // 5 条:事后 1 条不计;能判 2 条(判不了的两条不算判错),成立 1 条
  assert.deepEqual(weekTally([c]), { total: 5, excluded: 1, decided: 2, hit: 1 });
  // 暂定的一天整天不计入
  assert.deepEqual(weekTally([c, { ...c, date: "2026-10-10", provisional: true, results: [item({})] }]), { total: 6, excluded: 2, decided: 2, hit: 1 });
});

// ── 整条链路:假取数器 + 假 AI ──
const FAKE = String.raw`import json,sys,os,hashlib
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
def evid(*p): return 'ev-'+hashlib.sha1('|'.join(p).encode()).hexdigest()[:12]
d=args.get('date','')
if ep=='tx_kline':
  rows=cfg.get('klines',[])
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_k_%d.json'%os.getpid()
  json.dump({'rows':[{'date':x,'open':1,'high':1,'low':1,'close':1000,'volume':1} for x in rows]},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep=='cn_shortline_daily':
  v=cfg.get('daily',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  units={'broken_rate':'小数','promotion_rate':'小数','money_effect_median_ret':'%','ladder_highest':'板'}
  evs=[{'id':evid(d,k),'field':k,'value':x,'unit':units.get(k,'只'),'period':d,'raw_ref':'raw/x.json',**({'record_key':'1进2'} if k=='promotion_rate' else {})} for k,x in v.items()]
  if d in cfg.get('unsettled',[]): done({'status':'partial','extra':{'degraded':'这一天还没收盘：本次结果不缓存','settled':False},'evidence':evs},2)
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
if ep=='cn_shortline_facts': done({'status':'failed','reason':'没有','evidence':[]},3)
if ep=='cn_shortline_themes':
  n=cfg.get('themes',{}).get(d)
  if n is None: done({'status':'failed','reason':'同花顺没取到','evidence':[]},3)
  evs=[{'id':evid(d,'topic_concentration'),'field':'topic_concentration','value':0.12,'unit':'小数','period':d,'note':'第一题材涨停 ÷ 全部涨停'}]
  for i in range(n):
    t='题材%d'%i
    for k,x in (('topic_state','延续'),('topic_limit_up',n-i),('topic_highest',2),('topic_first_boards',1),('topic_members','某某（600000）2板')):
      evs.append({'id':evid(d,t,k),'field':k,'value':x,'unit':'text' if isinstance(x,str) else '只','period':d,'record_key':t})
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
if ep=='cn_shortline_structure':
  evs=[{'id':evid(d,'ladder_highest'),'field':'ladder_highest','value':4,'unit':'板','period':d},
       {'id':evid(d,'leader_name'),'field':'leader_name','value':'龙头'+d[-2:],'unit':'text','period':d,'record_key':'600001'},
       {'id':evid(d,'leader_boards'),'field':'leader_boards','value':4,'unit':'板','period':d,'record_key':'600001'},
       {'id':evid(d,'raw_fields'),'field':'raw_fields','value':'a,b,c','unit':'text','period':d,'record_key':'zt'}]
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
done({'status':'failed','reason':'unknown','evidence':[]},3)
`;
interface Cfg { klines?: string[]; daily?: Record<string, Record<string, number>>; themes?: Record<string, number>; unsettled?: string[] }
type Call = { ep: string; args: { date?: string } };
function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): Call[]; writeItems(rs: Record<string, unknown>[]): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-weekly-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
    writeItems: (rs) => fs.writeFileSync(path.join(dataRoot, "ledger", "verification.json"), JSON.stringify({ schema_version: 1, kind: "verification",
      records: rs.map((r, i) => ({ id: `v${i}`, kind: "verification", created_at: r.updated_at, ...r })) })),
  };
}
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });

const K = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"];
const day = (lu: number, br: number) => ({ limit_up_count: lu, ladder_highest: 4, broken_rate: br, money_effect_median_ret: 1.5, loss_deep5_count: 6, promotion_rate: 0.25 });
// 涨停:09-29 30 → 09-30 70 → 10-08 50 → 10-09 80;炸板率 10-08 0.3 → 10-09 0.4
const DAILY: Record<string, Record<string, number>> = Object.fromEntries(K.map((d) => [d, day(40, 0.2)]));
Object.assign(DAILY, { "2026-09-29": day(30, 0.2), "2026-09-30": day(70, 0.2), "2026-10-08": day(50, 0.3), "2026-10-09": day(80, 0.4) });
const CFG: Cfg = { klines: K, daily: DAILY, themes: { "2026-10-08": 9, "2026-10-09": 3 } };
const at = (d: string, hm: string) => `${d}T${hm}:00.000+08:00`;
const ITEMS = [
  { date: "2026-10-08", metric: "limit_up_count", direction: "up", reason: "延续", updated_at: at("2026-10-08", "21:00") },
  { date: "2026-10-08", metric: "broken_rate", direction: "down", updated_at: at("2026-10-08", "21:00") },
  { date: "2026-10-08", metric: "highest_board", direction: "flat", updated_at: at("2026-10-09", "10:00") },
  { date: "2026-09-30", metric: "limit_up_count", direction: "down", updated_at: at("2026-09-30", "20:00") },
  // 上周的对账(09-29 晚写、09-30 对账)不进本周
  { date: "2026-09-29", metric: "deep_loss_count", direction: "down", updated_at: at("2026-09-29", "20:00") },
];

function fakeTurn(texts: Partial<Record<string, string>>): TurnFn & { seen: { session: string; message: string }[] } {
  const seen: { session: string; message: string }[] = [];
  const fn = (async (message: string, session: string) => {
    seen.push({ session, message });
    const sec = Object.keys(texts).find((k) => new RegExp(`-${k}(-format-retry)?$`).test(session));
    if (!sec) throw new Error(`没给 ${session} 准备正文`);
    return texts[sec]!;
  }) as TurnFn & { seen: typeof seen };
  fn.seen = seen;
  return fn;
}
const LU = (d: string) => id(`${d}|limit_up_count`);
const TALLY = (field: string) => id(JSON.stringify(["tally", "2026-10-05", "2026-10-09", field]));
const TEXTS = {
  trend: `涨停从 2026-09-30 的 70 只[${LU("2026-09-30")}]到 2026-10-09 的 80 只[${LU("2026-10-09")}],本周两天合计 50+80=130 只次。`,
  themes: `2026-10-08 题材0 涨停 9 只[${id("2026-10-08|题材0|topic_limit_up")}],最高标是龙头08[${id("2026-10-08|leader_name")}],两天题材数 9+3=13。另见[ev-deadbeef0000]。`,
  verify: `本周条件 4 条[${TALLY("本周条件条数")}],能判 3 条[${TALLY("计入战绩且能判的条数")}],成立 2 条[${TALLY("其中成立的条数")}]。`,
  summary: `本周涨停回升到 80 只[${LU("2026-10-09")}]。如果下周涨停继续在 60 只以上,说明情绪延续。`,
};

test("视图和台账种类已登记;日期不对、还没到不取数", async () => {
  assert.ok(listViews().some((v) => v.id === "shortline_weekly_review" && v.label === "AI 周报"));
  assert.equal(FINANCE_LEDGER_KINDS.shortline_weekly_review?.label, "AI 周报");
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    await assert.rejects(shortlineWeeklyReview(ctx, { date: "2026-02-31" }, sig()), (e: unknown) => e instanceof ServiceError && e.code === "bad_query");
    for (const date of ["2026-02-31", "2026-10-11", ""]) {
      await assert.rejects(startWeeklyReview(ctx, { date }, sig(), NOW, fakeTurn({})), (e: unknown) => e instanceof ServiceError && e.code === "bad_request", date);
    }
    await assert.rejects(shortlineWeeklyReviewAct(ctx, { action: "rerun" }, sig()), (e: unknown) => e instanceof ServiceError && e.code === "bad_request");
    await assert.rejects(shortlineWeeklyReviewAct(ctx, { action: "start", date: "2026-10-09", executionMode: "direct" }, sig()),
      (e: unknown) => e instanceof ServiceError && e.code === "agent_required");
    const v = await shortlineWeeklyReview(ctx, { date: "2026-10-10" }, sig());
    assert.equal(v.week_start, "2026-10-05");
    assert.deepEqual(v.sections.map((s) => s.label), ["情绪走势", "题材轮动", "验证回看", "本周汇总"]);
    assert.deepEqual([v.versions, v.weeks, v.runs], [[], [], []]);
    assert.deepEqual(ctx.calls(), []);
  } finally { cleanup(ctx); }
});

test("链路:本周两天 + 上周三天;各段只看自己的证据;题材只放前 6 后 2、只留四项;验证回看只算本周对账;存一版、同周归在一起", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    ctx.writeItems(ITEMS);
    const turn = fakeTurn(TEXTS);
    const started = await startWeeklyReview(ctx, { date: "2026-10-10", ai: "Claude 订阅" }, sig(), NOW, turn);
    assert.equal(started.date, "2026-10-09", "周六写的:算到这周最后一个交易日");
    await assert.rejects(startWeeklyReview(ctx, { date: "2026-10-08" }, sig(), NOW, turn), (e: unknown) => e instanceof ServiceError && e.code === "review_busy" && /2026-10-05 起这一周的周报/.test(e.message));
    assert.throws(() => cancelReview(started.id), (e: unknown) => e instanceof ServiceError && e.code === "not_found", "日复盘那边停不掉周报");
    const r = await reviewFinished(started.id);
    assert.equal(r.outcome, "completed");
    assert.deepEqual(r.stages.map((s) => `${s.id}:${s.status}`), ["trend:done", "themes:done", "verify:done", "summary:done"]);

    const msg = (sec: string) => turn.seen.find((x) => x.session.endsWith(`-${sec}`))!.message;
    assert.match(msg("trend"), /周报范围:2026-10-05 起的这一周,算进来的交易日 2026-10-08、2026-10-09\(2026-10-05、2026-10-06、2026-10-07 休市\);上周对照 2026-09-28、2026-09-29、2026-09-30。/);
    for (const d of ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"]) assert.ok(msg("trend").includes(LU(d)), d);
    assert.ok(!msg("trend").includes(LU("2026-09-25")), "上上周的不进");
    assert.ok(msg("trend").includes(`limit_up_count = 80只 (2026-10-09) [${LU("2026-10-09")}]`), "每条都写日期");
    assert.ok(!msg("trend").includes(id("2026-10-08|题材0|topic_limit_up")), "情绪段看不到题材");
    assert.match(msg("themes"), /算进来的交易日 2026-10-08、2026-10-09\(2026-10-05、2026-10-06、2026-10-07 休市\);这一段只看本周,不跟上周比。/, "只有情绪走势那段带上周");
    assert.doesNotMatch(msg("summary"), /上周对照|这一段只看本周/, "汇总看各段,不说只看本周");
    assert.match(msg("summary"), /只有情绪走势那段跟上周比过/);

    const th = msg("themes");
    for (const i of [0, 1, 2, 3, 4, 5, 7, 8]) assert.ok(th.includes(id(`2026-10-08|题材${i}|topic_limit_up`)), `题材${i}`);
    assert.ok(!th.includes(id("2026-10-08|题材6|topic_limit_up")), "第 7 个题材没放进来");
    assert.ok(!th.includes("topic_members") && !th.includes("topic_first_boards") && !th.includes("raw_fields"), "只留几项");
    assert.ok(th.includes(id("2026-10-09|题材2|topic_state")) && th.includes(id("2026-10-08|leader_name")) && th.includes(id("2026-10-09|ladder_highest")));
    assert.ok(r.gaps.some((g) => /题材 2026-10-08:共 9 条记录,资料包只放了前 6 条和后 2 条,其余 1 条没放进来/.test(g)));
    assert.ok(!th.includes(LU("2026-10-09")));

    // 验证回看:10-09 对 10-08 晚的三条(事后一条),10-08 对 09-30 晚的一条;09-30 那次对账是上周的
    const vf = msg("verify");
    assert.ok(vf.includes(`本周条件条数 = 4条 (2026-10-05..2026-10-09) [${TALLY("本周条件条数")}]`));
    assert.ok(vf.includes("不计入战绩的条数 = 1条") && vf.includes("计入战绩且能判的条数 = 3条") && vf.includes("其中成立的条数 = 2条"));
    assert.ok(vf.includes("### 2026-09-30 晚写的条件,2026-10-08 对账") && vf.includes("### 2026-10-08 晚写的条件,2026-10-09 对账"));
    assert.match(vf, /2026-09-30 晚写·涨停家数 对账结果 = 成立/);
    assert.match(vf, /2026-10-08 晚写·炸板率 当天读数 = 0\.4\(小数\) \(2026-10-09\)/);
    assert.match(vf, /2026-10-08 晚写·炸板率 对账结果 = 不成立/);
    assert.match(vf, /2026-10-08 晚写·最高连板高度 对账结果 = 成立 \(2026-10-09\) \[ev-[0-9a-f]{12}\] — 下一场开盘竞价后才写或改,不计入战绩/);
    assert.ok(!vf.includes("跌超5%家数"), "上周的对账不进");
    assert.ok(!vf.includes(LU("2026-10-09")), "验证段看不到情绪证据");

    const sm = msg("summary");
    assert.ok(sm.includes("## 情绪走势") && sm.includes(TEXTS.verify) && !sm.includes("【资料包"));
    assert.match(sm, /500 字以内/);
    assert.ok(!/```json/.test(sm), "周报不要 json 建议");

    // 核对:算式 50+80=130 重算通过、9+3=13 标红;编出来的编号单列;汇总段对照三段的资料包
    const st = Object.fromEntries(r.stages.map((s) => [s.id, s]));
    assert.equal(st.trend!.audit!.bad_math.length, 0);
    assert.ok(st.trend!.audit!.derived >= 1);
    assert.deepEqual(st.themes!.audit!.bad_math.map((b) => b.recomputed), [12]);
    assert.deepEqual(st.themes!.unknown_cites, ["ev-deadbeef0000"]);
    assert.deepEqual(st.verify!.cited!.map((c) => c.id), [TALLY("本周条件条数"), TALLY("计入战绩且能判的条数"), TALLY("其中成立的条数")]);
    assert.deepEqual(st.summary!.cited!.map((c) => c.id), [LU("2026-10-09")]);
    assert.equal(st.summary!.text, TEXTS.summary, "周报汇总不拆 json");

    const saved = ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review!;
    assert.equal(saved.length, 1);
    assert.deepEqual([saved[0]!.date, saved[0]!.week_start, saved[0]!.days, saved[0]!.settled, saved[0]!.ai], ["2026-10-09", "2026-10-05", ["2026-10-08", "2026-10-09"], true, "Claude 订阅"]);
    assert.ok(!("conditions" in saved[0]!), "周报不存明日验证建议");
    assert.equal(r.saved_id, saved[0]!.id);
    assert.deepEqual(ledgerList(ctx, "shortline_review").shortline_review ?? [], [], "不写进日复盘");

    // 同一周的任何一天都看得到这一版;下一周看不到
    const v = await shortlineWeeklyReview(ctx, { date: "2026-10-07" }, sig());
    assert.deepEqual(v.versions.map((x) => [x.id, x.week_start, x.days]), [[saved[0]!.id, "2026-10-05", ["2026-10-08", "2026-10-09"]]]);
    assert.deepEqual(v.versions[0]!.sections.map((s) => [s.label, s.desc.length > 0]), [["情绪走势", true], ["题材轮动", true], ["验证回看", true], ["本周汇总", true]]);
    assert.deepEqual(v.weeks, [{ week_start: "2026-10-05", count: 1 }]);
    assert.deepEqual(v.runs.map((x) => x.id), [started.id]);
    const next = await shortlineWeeklyReview(ctx, { date: "2026-10-12" }, sig());
    assert.deepEqual([next.week_start, next.versions, next.runs], ["2026-10-12", [], []]);
  } finally { cleanup(ctx); }
});

test("没写过条件:验证回看跳过;最后一天没数据(节假日)不算进本周;还没收盘的一天提示 AI", async () => {
  const ctx = fakeCtx();
  try {
    // 10-09 当天没收盘:写的时候要说明
    ctx.setCfg({ ...CFG, unsettled: ["2026-10-09"] });
    const turn = fakeTurn(TEXTS);
    const s1 = await startWeeklyReview(ctx, { date: "2026-10-09" }, sig(), new Date("2026-10-09T05:00:00Z"), turn);
    const r1 = await reviewFinished(s1.id);
    assert.deepEqual(r1.stages.map((s) => `${s.id}:${s.status}`), ["trend:done", "themes:done", "verify:skipped", "summary:done"]);
    assert.match(r1.stages[2]!.error!, /本周没有要对账的明日验证条件/);
    assert.equal(r1.settled, false);
    assert.match(turn.seen.find((x) => x.session.endsWith("-trend"))!.message, /最后一天 2026-10-09 还没收盘/);
    assert.match(turn.seen.find((x) => x.session.endsWith("-summary"))!.message, /这些分项跳过了,原因如下;别当它们不存在,也别说成没写成】\n- 验证回看:本周没有要对账的明日验证条件/);
    assert.equal(ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review![0]!.settled, false);

    // 10-09 一条都没取到:按节假日处理,本周只算 10-08
    const daily = { ...DAILY };
    delete daily["2026-10-09"];
    ctx.setCfg({ ...CFG, daily });
    const turn2 = fakeTurn(TEXTS);
    const s2 = await startWeeklyReview(ctx, { date: "2026-10-09" }, sig(), NOW, turn2);
    assert.equal(s2.date, "2026-10-08");
    await reviewFinished(s2.id);
    assert.match(turn2.seen.find((x) => x.session.endsWith("-trend"))!.message, /算进来的交易日 2026-10-08\(2026-10-05、2026-10-06、2026-10-07、2026-10-09 休市\)/);
    const rec = ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review!.find((x) => x.id === (s2 as { saved_id: string | null }).saved_id || x.date === "2026-10-08")!;
    assert.deepEqual(rec.days, ["2026-10-08"]);
  } finally { cleanup(ctx); }
});

test("本周一天的读数都没有不开工、不调 AI;交易日历没取到只看那一天,不跟上周比", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ ...CFG, daily: {} });
    const turn = fakeTurn(TEXTS);
    await assert.rejects(startWeeklyReview(ctx, { date: "2026-10-09" }, sig(), NOW, turn), (e: unknown) => e instanceof ServiceError && e.code === "no_data" && /一天都没取到/.test(e.message));
    // 周一是节假日、之前没有本周的交易日
    ctx.setCfg(CFG);
    await assert.rejects(startWeeklyReview(ctx, { date: "2026-10-11" }, sig(), NOW, turn), (e: unknown) => e instanceof ServiceError && e.code === "bad_request");
    await assert.rejects(startWeeklyReview(ctx, { date: "2026-10-06" }, sig(), NOW, turn), (e: unknown) => e instanceof ServiceError && e.code === "no_data");
    assert.equal(turn.seen.length, 0);

  } finally { cleanup(ctx); }
  // 日 K 有 5 分钟缓存:换一个数据根
  const ctx2 = fakeCtx();
  try {
    ctx2.setCfg({ ...CFG, klines: [] });
    // 前一晚写过条件,但日 K 没取到、对不了账:不能说成「本周没有条件」
    ledgerInsertMany(ctx2, { kind: "verification", records: [{ date: "2026-10-08", metric: "limit_up_count", direction: "up", reason: "" }] });
    const turn = fakeTurn(TEXTS);
    const s = await startWeeklyReview(ctx2, { date: "2026-10-09" }, sig(), NOW, turn);
    const r = await reviewFinished(s.id);
    assert.ok(r.gaps.some((g) => /上证A股指数日 K 没取到/.test(g)));
    const v = r.stages.find((x) => x.id === "verify")!;
    assert.equal(v.status, "skipped");
    assert.doesNotMatch(v.error!, /本周没有要对账/);
    assert.match(v.error!, /明日验证 2026-10-09:没法对账\(列不出前一个交易日/);
    assert.match(turn.seen.find((x) => x.session.endsWith("-trend"))!.message, /算进来的交易日 2026-10-09;上周的交易日没列出来/);
  } finally { cleanup(ctx2); }
});

test("中途停:只能用周报的停止;日复盘和周报合计最多同时两份", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    // 一直不回的 AI:被停时才结束
    const hang: TurnFn = (_m, _s, signal) => new Promise((_res, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    const a = await startWeeklyReview(ctx, { date: "2026-10-09" }, sig(), NOW, hang);
    const b = await startWeeklyReview(ctx, { date: "2026-09-30" }, sig(), NOW, hang);
    await assert.rejects(startWeeklyReview(ctx, { date: "2026-09-25" }, sig(), NOW, hang), (e: unknown) => e instanceof ServiceError && e.code === "capacity_full" && /合计最多 2 份/.test(e.message));
    await assert.rejects(shortlineWeeklyReviewAct(ctx, { action: "cancel", id: "nope" }, sig()), (e: unknown) => e instanceof ServiceError && e.code === "not_found" && /周报/.test(e.message));
    const c = await shortlineWeeklyReviewAct(ctx, { action: "cancel", id: a.id }, sig());
    assert.equal(c.id, a.id);
    const ra = await reviewFinished(a.id);
    assert.equal(ra.outcome, "cancelled");
    assert.ok(ra.stages.every((s) => s.status === "cancelled" || s.status === "skipped"));
    assert.equal(ra.saved_id, null);
    await shortlineWeeklyReviewAct(ctx, { action: "cancel", id: b.id }, sig());
    await reviewFinished(b.id);
    assert.deepEqual(ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? [], []);
  } finally { cleanup(ctx); }
});

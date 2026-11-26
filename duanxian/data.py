"""短线复盘数据层 —— 在 `fetchers` 的取数函数之上做缓存、降级与文本化。"""

from __future__ import annotations

from duanxian.paths import data_path
from typing import Optional

import json
import os
import socket
from collections import Counter

from . import fetchers as dr
from .util import is_today, safe_join

socket.setdefaulttimeout(45)

_LEADER_DIR = data_path("leaders")

_MACRO_GROUPS = {
    "AI算力": ["算力", "CPO", "共封装", "光模块", "光通信", "光器件", "液冷",
             "PCB", "铜连接", "服务器", "数据中心", "东数西算", "AI", "chiplet", "存储"],
    "人形机器人": ["机器人", "减速器", "丝杠", "灵巧手", "人形", "机器人概念", "空心杯"],
    "商业航天": ["航天", "火箭", "卫星", "卫星导航", "商业航天", "北斗"],
}


def _ymd(date: str) -> str:
    return date.replace("-", "")


def _degrade_msg(label: str, date: str, msg: str) -> str:
    """取数没成功时**唯一**的返回长相。

    这里只有一种约定是要紧的：所有失败都得长成 `[⚠️ …]`。判断"这一路数据能不能用"
    的地方不止一处（体检闸、降级计数、界面提示），它们都认这个前缀；
    谁要是自己发明一种失败措辞（比如「XX取数失败：…」这种裸文本），
    那几处就一起看不见它 —— 非空、没前缀，在它们眼里跟正常数据一模一样。
    """
    return f"[⚠️ {label}｜{date} 数据获取失败已降级：{str(msg)[:120]}]"


def _degrade(label: str, date: str, exc: Exception) -> str:
    return _degrade_msg(label, date, f"{type(exc).__name__}: {exc}")


def _asof_note(date: str) -> str:
    """仅在取数前后均通过参考行情日期校验的分支追加。"""
    return (f"\n（口径提示：取数前后参考行情均对应 {date} 收盘；"
            "资金流/板块来自当前接口，并非独立历史快照，端点本身的时间戳未单独核实。）")


# ============ ① 情绪面 ============
def get_sentiment_data(date: str) -> str:
    try:
        zt = dr.fetch_zt_pool(_ymd(date))
        ztdf = zt.get("zt")
        n_zt = int(len(ztdf)) if ztdf is not None else 0
        n_zb = int(zt.get("zb_count", 0) or 0)
        n_dt = int(zt.get("dt_count", 0) or 0)
        hc = int(zt.get("highest_consec", 0) or 0)
        br = n_zb / (n_zb + n_zt) if (n_zb + n_zt) else 0
        ladder = zt.get("ladder", [])
        highs = [x for x in ladder if x["consec_boards"] >= 2][:8]
        ladder_txt = "、".join(f"{x['name']}({x['consec_boards']}板)" for x in highs) or "无 2 板以上"
        if n_zt == 0 and n_dt == 0:
            return f"[⚠️ {date} 涨停池为空，可能非交易日或数据未更新，情绪面数据不可用]"
        return (
            f"[真实数据 {date}] 涨停 {n_zt} 家，炸板 {n_zb} 家，跌停 {n_dt} 家；"
            f"炸板率 {br:.0%}；最高连板 {hc} 板。连板梯队（2 板以上）：{ladder_txt}"
        )
    except Exception as exc:  # noqa: BLE001
        return _degrade("情绪面", date, exc)


def get_emotion_metrics(date: str) -> tuple[str, dict]:
    """派生情绪指标（赚钱效应 / 晋级率 / 连板溢价）"""
    try:
        from . import emotion_metrics as em

        m = em.build_metrics(date)
        return em.render_metrics(m), m
    except Exception as exc:  # noqa: BLE001
        return _degrade("派生情绪指标", date, exc), {}


def get_market_facts(date: str) -> tuple[str, dict]:
    """客观事实表（封板质量 / 亏钱效应 / 反馈矩阵 / 题材结构 / 事件账本 / 分板块）。

    与 `get_emotion_metrics` 一样返回 **(文本块, 结构化 dict)**：文本喂 prompt，
    结构化那份供 UI 直接渲染。事实层是"今天发生了什么"，指标层是"什么温度"，
    两者互补，别互相替代。

    延迟导入同 emotion_metrics（market_facts 反过来要借 data 注入 sys.path）。
    """
    try:
        from . import market_facts as mf

        from . import stats_context as sctx
        from . import theme_tree as tt

        from . import breadth as bd

        facts = {
            "breadth": bd.market_breadth(date),
            "stats_context": sctx.context_for(date),
            "day_diff": sctx.diff(date),
            "trend": sctx.trend(10, end=date),
            "theme_tree": tt.build(date),
            "seal_quality": mf.seal_quality(date),
            "loss_effect": mf.loss_effect(date),
            "feedback_matrix": mf.feedback_matrix(date),
            "theme_structure": mf.theme_structure(date),
            "event_ledger": mf.event_ledger(date),
            "by_board": mf.by_board(date),
        }
        # 两融叠加图（近20交易日融资净买入柱 + 融资余额线）+ 基于图的观察指引。
        # 图写到 blog/static/cards/margin-<date>.png；失败不影响主复盘（降级为空）。
        try:
            from pathlib import Path as _Path
            from .fetchers import fetch_margin_history
            from review_agent.margin_chart import render_margin_chart, margin_guidance
            _series = fetch_margin_history(date, days=20)
            if _series:
                _cards = _Path(__file__).resolve().parents[1] / "blog" / "static" / "cards"
                _img = render_margin_chart(_series, _cards / f"margin-{date}.png")
                if _img:
                    facts["margin_chart"] = {
                        "image": f"/cards/margin-{date}.png",
                        "file": str(_img),
                        "guidance": margin_guidance(_series),
                        "dates": [s["date"] for s in _series],
                    }
        except Exception:  # noqa: BLE001  增强项：失败不阻断复盘
            pass
        return render_market_facts(facts), facts
    except Exception as exc:  # noqa: BLE001
        return _degrade("市场事实表", date, exc), {}


def _pct(v) -> str:
    return "—" if v is None else f"{v:.0%}"


def render_market_facts(f: dict) -> str:
    """事实表 → 分析师 prompt 直接能吃的文本。不可用的部分如实说明。"""
    lines = ["[今日客观事实表]"]

    bd_ = f.get("breadth") or {}
    if bd_:
        from . import breadth as _bd

        lines.append(_bd.render(bd_))

    sq = f.get("seal_quality") or {}
    if sq.get("available"):
        lines.append(
            f"· 封板质量：涨停 {sq['total']} 家，其中 {sq['never_broken']} 家全天没炸过板"
            f"（{_pct(sq['never_broken_rate'])}）；开盘 5 分钟内封板 {sq['opening_seconds']} 家；"
            f"14:30 后才最终封住 {sq['late_seal']} 家；炸过又回封 {sq['reopened']} 家；"
            f"平均炸板 {sq['avg_broken_times']} 次"
        )
    else:
        lines.append(f"· 封板质量：不可用（{sq.get('reason', '未知')}）")

    le = f.get("loss_effect") or {}
    if le.get("available"):
        rec = le.get("prev_broken_recovery")
        rec_txt = (f"；昨日炸板股今日均 {rec['avg']:+.2f}%、翻红 {_pct(rec['positive_rate'])}"
                   if rec else "")
        lines.append(
            f"· 亏钱效应：{le['prev_date']} 涨停的 {le['sample']} 只里，今日跌超 5% 有 "
            f"{le['deep_loss_5_count']} 只（{_pct(le['deep_loss_5_rate'])}）、跌超 7% 有 "
            f"{le['deep_loss_7_count']} 只、跌停 {le['limit_down_count']} 只，最差 {le['worst']:+.2f}%；"
            + (f"全市场跌停 {le['market_limit_down']} 家" if le.get("market_limit_down") is not None
             else "本统计模块未获取全市场跌停数") + rec_txt
        )
    else:
        lines.append(f"· 亏钱效应：不可用（{le.get('reason', '未知')}）")

    fm = f.get("feedback_matrix") or {}
    if fm.get("available"):
        segs = []
        for tier, cell in fm["matrix"].items():
            segs.append(f"{tier}({cell['合计']}只)：晋级{cell['晋级涨停']}/收红{cell['收红']}"
                        f"/跌超5%{cell['跌超5%']}/跌停{cell['跌停']}")
        lines.append("· 昨日强势股反馈（按昨日板位分组）：" + "；".join(segs))

    # 统计语境放最前 —— 先知道"今天算不算异常"，再看细节
    sc_, dd_ = f.get("stats_context") or {}, f.get("day_diff") or {}
    if sc_ or dd_:
        from . import stats_context as _sctx

        txt = _sctx.render(sc_, dd_)
        if txt:
            lines.append(txt)

    tt_ = f.get("theme_tree") or {}
    if tt_.get("available"):
        from . import theme_tree as _tt

        lines.append(_tt.render(tt_))
    elif tt_:
        lines.append(f"· 题材事件树：不可用（{tt_.get('reason', '未知')}）→ 下面退回行业分类，"
                     "注意行业≠题材")

    ts = f.get("theme_structure") or {}
    if ts.get("available"):
        top = ts["themes"][:5]
        segs = [f"{t['sector']}(涨停{t['limit_up']}/最高{t['highest']}板/炸{t['broken']}"
                f"/首封{(t['first_seal'] or '—')[:4]})" for t in top]
        tl = "、".join(f"{x['slot']} {x['count']}家" for x in ts["timeline"])
        lines.append(f"· 题材结构（共 {ts['theme_count']} 个方向，头部占比 {_pct(ts['concentration'])}）："
                     + "；".join(segs))
        lines.append(f"· 涨停时间分布（按首次封板）：{tl}"
                     "　←　早盘集中=主动发酵，午后才起来=被动轮动")

    bb = f.get("by_board") or {}
    if bb.get("available"):
        segs = [f"{b}：涨停{g['limit_up']}/最高{g['highest']}板/晋级率{_pct(g.get('promotion_rate'))}"
                for b, g in bb["boards"].items() if g.get("limit_up")]
        lines.append("· 分涨跌幅制度（10cm/20cm/ST 生态不同，别混着读）：" + "；".join(segs))

    el = f.get("event_ledger") or {}
    if el.get("available") and el["events"]:
        segs = [f"[{e['tag']}]{e['name']}({e['boards']}板,{e['sector']})" for e in el["events"][:10]]
        lines.append("· 关键事件：" + "、".join(segs))
    return "\n".join(lines)




def _fund_extras_lines(date: str) -> list[str]:
    """资金面附加数据（融资余额/沪深港通/同口径历史资金/时间戳），当日与历史补源共用。"""
    lines: list[str] = []
    # 融资融券余额（Tushare margin，按交易所分列，单位亿；口径不同不加总）
    ymd8 = _ymd(date)
    try:
        margin = dr.fetch_margin_summary(ymd8)
    except Exception:  # noqa: BLE001
        margin = {}
    if margin:
        lines.append("融资融券余额（Tushare，亿；按交易所分列不合计）：")
        for ex, v in margin.items():
            lines.append(f"  {ex}：融资余额{v['rzye']}亿，融资买入{v['rzmre']}亿，"
                         f"融券余额{v['rqye']}亿，两融余额{v['rzrqye']}亿")

    # 沪深港通资金（Tushare moneyflow_hsgt，单位亿；按字段口径折算）
    try:
        hsgt = dr.fetch_hsgt_money(ymd8)
    except Exception:  # noqa: BLE001
        hsgt = {}
    if hsgt and any(v is not None for v in hsgt.values()):
        lines.append("沪深港通（Tushare，亿；按字段原值折算，非独立快照）："
                     f"北向{hsgt.get('north_money')}，南向{hsgt.get('south_money')}，"
                     f"沪股通{hsgt.get('hgt')}，深股通{hsgt.get('sgt')}")

    # 同口径历史行业资金序列（Tushare moneyflow 近 N 日，可跨日对照）
    try:
        hist = dr.fetch_industry_moneyflow_hist(ymd8, days=5)
    except Exception:  # noqa: BLE001
        hist = {}
    if hist:
        from collections import defaultdict
        by_ind: dict[str, list[dict]] = defaultdict(list)
        for h in hist:
            by_ind[h["industry"]].append(h)
        # 列出目标日附近（序列最后一天）净额绝对值最大的几个行业
        last_day = max(h["date"] for h in hist)
        ranked = sorted(
            [(name, sum(x["net_yi"] for x in rows[-3:])) for name, rows in by_ind.items()],
            key=lambda x: abs(x[1]), reverse=True)
        lines.append(f"同口径行业资金近3日累计（Tushare moneyflow，截至{last_day}，亿；"
                     "非主力口径，不与东财主力净额混算）：")
        for name, val in ranked[:6]:
            lines.append(f"  {name}：近3日{val:+.2f}亿")

    # 接口时间戳核验：实际返回交易日 vs 目标日
    try:
        asof = dr.fetch_moneyflow_asof(ymd8)
    except Exception:  # noqa: BLE001
        asof = {}
    if asof:
        flag = ("一致" if asof.get("matched") is True
                else ("不一致" if asof.get("matched") is False else "未核实"))
        lines.append(f"接口时间戳核验（{asof.get('source', 'Tushare')}）："
                     f"目标日{asof.get('target')}，实际返回{asof.get('actual') or '未取得'}，{flag}")
    return lines


# ============ ② 资金面 ============
def get_capital_data(date: str) -> str:
    from .trade_calendar import live_quotes_are_close_of
    matched, reason = live_quotes_are_close_of(date)
    if not matched:
        try:
            from .historical_sources import historical_activity
            return historical_activity(date) + "\n" + "\n".join(_fund_extras_lines(date))
        except Exception as exc:
            return _degrade("资金面历史补源", date, exc)
    try:
        ind = dr.fetch_sector_flow("2")  # 行业
        dr.enrich_trend(ind)

        def _top(lst, n=6, rev=True):
            xs = [s for s in lst if s.get("inflow_today") is not None]
            xs.sort(key=lambda s: s["inflow_today"], reverse=rev)
            return xs[:n]

        # 降级源（Tushare）拿不到 5日/10日累计，直接拼会输出「5日None亿」——如实省略
        def _win(label, v):
            return f"/{label}{v}亿" if v is not None else f"/{label}缺"

        lines = ["行业主力净流入 TOP："]
        for s in _top(ind):
            lines.append(
                f"  {s['name']} 今{s['inflow_today']}亿{_win('5日', s['inflow_5d'])} "
                f"涨{s['change_pct']}% 领涨{s['lead_stock']}"
            )
        lines.append("行业主力净流出 TOP：")
        for s in _top(ind, rev=False):
            lines.append(f"  {s['name']} 今{s['inflow_today']}亿")
        try:
            turn = dr.fetch_turnover_top20(10)
            lines.append("全市场成交额 TOP：")
            for t in turn:
                lines.append(f"  {t['name']} {t['amount']}亿 涨{t['change_pct']}% {t.get('sector') or ''}")
        except Exception as exc:
            lines.append(f"（成交额榜获取失败已跳过：{type(exc).__name__}）")
        lines.extend(_fund_extras_lines(date))

        matched, reason = live_quotes_are_close_of(date)
        if not matched:
            return _degrade_msg("实时资金与板块", date, "取数期间行情日期已变化，本批未使用：" + reason)
        return "\n".join(lines) + _asof_note(date)
    except Exception as exc:  # noqa: BLE001
        return _degrade("资金面", date, exc)


# ============ 大赛道跟踪（概念 / 行业资金流）============
def _dedup_sector(rows: list[dict]) -> list[dict]:
    """按板块名去重（akshare 概念榜存在同名重复行），保留净额最大的一条。"""
    seen: dict[str, dict] = {}
    for r in rows:
        name = str(r.get("name") or "").strip()
        if not name:
            continue
        cur = seen.get(name)
        if cur is None or (r.get("inflow_today") or 0) > (cur.get("inflow_today") or 0):
            seen[name] = r
    return list(seen.values())


def _match_groups(rows: list[dict]) -> dict[str, list[dict]]:
    """按 _MACRO_GROUPS 关键词把板块归入大赛道（概念名/行业名匹配）。"""
    matched: dict[str, list[dict]] = {g: [] for g in _MACRO_GROUPS}
    for r in rows:
        name = str(r.get("name") or "")
        for grp, kws in _MACRO_GROUPS.items():
            if any(k in name for k in kws):
                matched[grp].append(r)
    return matched


def get_macro_sector_data(date: str) -> str:
    from .trade_calendar import live_quotes_are_close_of
    matched, reason = live_quotes_are_close_of(date)
    if not matched:
        # 非当日：用历史补源（历史活动口径）
        try:
            from .historical_sources import historical_activity
            return historical_activity(date, _MACRO_GROUPS)
        except Exception as exc:
            return _degrade("大板块历史补源", date, exc)
    try:
        # 主源：东财概念资金流（akshare datacenter 口径，绕开被掐的 push2 clist）
        concept = _dedup_sector(dr.fetch_concept_flow_ak() or [])
        industry = _dedup_sector(dr.fetch_industry_flow_ak() or [])
        # 新源为空时回退旧 clist 源（部分环境 akshare 可用而 clist 可用，互为补充）
        if not concept:
            legacy = _dedup_sector(dr.fetch_sector_flow("3") or [])
            dr.enrich_trend(legacy)
            concept = legacy

        # 取数后二次核对行情日期：跨场整批作废（产品安全约束，数据空也照样校验）
        matched2, reason2 = live_quotes_are_close_of(date)
        if not matched2:
            return _degrade_msg("实时资金与板块", date, "取数期间行情日期已变化，本批未使用：" + reason2)

        if not concept and not industry:
            # 数据空也保留口径说明（参考行情对应日 + 端点时间戳未核实），
            # 不能让读者误以为这份输出可以不带时间前提地解读。
            return ("大赛道跟踪：当日概念与行业资金流均未取到（东财 clist 被掐且无替代），"
                    "本分项无板块资金数据可用；资料缺失只说明缺口，不代表市场无该现象。\n"
                    + _asof_note(date))

        lines = ["大赛道跟踪（概念/行业资金流即时口径，净额单位亿，非5日累计；"
                 "概念成分有重叠，逐项看不合计）："]
        by_concept = _match_groups(concept)
        by_industry = _match_groups(industry)
        for grp in _MACRO_GROUPS:
            hits = by_concept.get(grp, []) + by_industry.get(grp, [])
            if not hits:
                lines.append(f"  {grp}：当日概念/行业资金流榜未见该方向成分，"
                             "可能因该板块当日净额未进榜或名称不在关键词表；不代表市场无该方向")
                continue
            # 每条标注来源（概念/行业），按净额降序
            tagged = []
            for c in hits:
                c = dict(c)
                c["_kind"] = "概念" if c.get("source", "").endswith("concept") else "行业"
                tagged.append(c)
            tagged.sort(key=lambda x: x.get("inflow_today") or 0, reverse=True)
            lines.append(f"  {grp}（概念成分有重叠，逐项看，不合计）：")
            for c in tagged[:8]:
                chg = f"{c['change_pct']:+.2f}%" if c.get("change_pct") is not None else "未覆盖"
                flow = f"{c['inflow_today']:+.2f}" if c.get("inflow_today") is not None else "未覆盖"
                lead = f"，领涨 {c['lead_stock']}" if c.get("lead_stock") else ""
                lines.append(f"    [{c['_kind']}] {c['name']}：当日涨幅{chg}，净额{flow}亿{lead}")
        return "\n".join(lines) + _asof_note(date)
    except Exception as exc:  # noqa: BLE001
        return _degrade("大板块本周", date, exc)


# ============ ③ 题材热点（涨停原因题材串）============
def get_theme_reasons(date: str) -> str:
    try:
        reasons, err = dr.fetch_zt_reasons(_ymd(date))
        if not reasons:
            return _degrade_msg("题材涨停原因", date, f"涨停原因题材串未取到：{err}")
        tags = Counter()
        for r in reasons.values():
            for t in r.split("+"):
                t = t.strip()
                if t:
                    tags[t] += 1
        hot = tags.most_common(12)
        return f"{date} 涨停题材串热度 TOP：" + "、".join(f"{t}×{c}" for t, c in hot) + (f"\n{err}" if err else "\n来源：问财目标日涨停原因。")
    except Exception as exc:  # noqa: BLE001
        return _degrade("题材涨停原因", date, exc)


# ============ ④ 龙虎榜游资 ============
def get_dragon_tiger_data(date: str) -> str:
    try:
        ymd = _ymd(date)
        rows = dr.fetch_lhb(ymd, top=15)
        if rows and isinstance(rows[0], dict) and rows[0].get("error"):
            return _degrade_msg("龙虎榜", date, rows[0]["error"])
        if not rows:
            return f"{date} 无龙虎榜数据"
        lines = ["龙虎榜净买额榜（亿，负=净卖）："]
        seen: set = set()
        uniq = []
        for r in rows:
            code6 = str(r.get("code", "")).split(".")[0][-6:]
            if code6 and code6 in seen:
                continue  # 同一股票因多条上榜原因重复出现，只保留净买额最高的一条
            if code6:
                seen.add(code6)
            uniq.append(r)
        codes6 = [str(r.get("code", "")).split(".")[0][-6:] for r in uniq]

        # 行业分布（Tushare stock_basic 行业字段）：按上榜个股统计，非题材归属
        try:
            ind = dr.fetch_industry_map()
        except Exception:  # noqa: BLE001
            ind = {}
        # 东财官方解读（买一主买/机构买入/成功率等），借鉴其龙虎榜解读口径
        try:
            explains = dr.fetch_lhb_em_explain(ymd, top=15)
        except Exception:  # noqa: BLE001
            explains = {}
        for r in uniq:
            nb = r.get("net_buy")
            nb_s = f"{nb:+.2f}" if nb is not None else "—"
            c6 = str(r.get("code", "")).split(".")[0][-6:]
            tag = f"（行业：{ind.get(c6)}）" if ind.get(c6) else ""
            ex = explains.get(c6, {}).get("explain", "")
            ex_s = f" 东财解读：{ex}" if ex else ""
            lines.append(f"  {r['name']} 净买{nb_s}亿 [{r.get('reason', '')}]{tag}{ex_s}")
        if ind:
            from collections import Counter
            inds = Counter(ind.get(c, "") for c in codes6 if ind.get(c))
            if inds:
                lines.append("上榜个股行业分布（Tushare 行业字段，非题材归属）："
                             + "、".join(f"{k}×{v}" for k, v in inds.most_common(8)))

        # 机构买卖统计（东财）：买方/卖方机构数 + 机构净买额
        try:
            inst = dr.fetch_lhb_inst_summary(ymd)
        except Exception:  # noqa: BLE001
            inst = {}
        inst_hit = [(r, inst.get(str(r.get("code", "")).split(".")[0][-6:]))
                    for r in uniq]
        inst_hit = [(r, v) for r, v in inst_hit if v and v.get("inst_net_yi") is not None]
        if inst_hit:
            lines.append("机构专用席位参与（东财机构统计，亿；仅名单内样本）：")
            for r, v in inst_hit[:8]:
                ratio = v.get("inst_ratio")
                ratio_s = f"{float(ratio):.2f}%" if isinstance(ratio, (int, float)) else "—"
                lines.append(f"  {r['name']}：买方机构{v['buy_inst']}家/卖方{v['sell_inst']}家，"
                             f"机构净买{v['inst_net_yi']:+.3f}亿，占比{ratio_s}")

        # 席位身份明细（东财）：机构专用/北向/知名游资/一般营业部
        try:
            identity = dr.fetch_lhb_seat_identity(ymd, codes6, top_seats=3)
        except Exception:  # noqa: BLE001
            identity = {}
        if identity:
            lines.append("席位明细与身份线索（名称线索归类，非确证身份；净额亿）：")
            shown = 0
            for r in uniq:
                c6 = str(r.get("code", "")).split(".")[0][-6:]
                v = identity.get(c6)
                if not v or (not v.get("buy") and not v.get("sell")):
                    continue
                shown += 1
                lines.append(f"  {r['name']}：")
                for s in v.get("buy", []):
                    lines.append(f"    买 {s['identity']}·{s['seat']} 净{s['net_yi']:+.3f}")
                for s in v.get("sell", []):
                    lines.append(f"    卖 {s['identity']}·{s['seat']} 净{s['net_yi']:+.3f}")
                if shown >= 6:
                    break
        return "\n".join(lines)
    except Exception as exc:  # noqa: BLE001
        return _degrade("龙虎榜游资", date, exc)


# ============ ⑤ 龙头跟踪（含持久化）============
def get_leader_data(date: str) -> str:
    try:
        d = _ymd(date)
        zt = dr.fetch_zt_pool(d)
        ladder = [x for x in zt.get("ladder", []) if x["consec_boards"] >= 1]
        top = sorted(ladder, key=lambda x: x["consec_boards"], reverse=True)[:12]

        if top:
            os.makedirs(_LEADER_DIR, exist_ok=True)
            try:
                path = safe_join(_LEADER_DIR, f"{d}.json")
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump({"date": date, "ladder": top}, fh, ensure_ascii=False)
                os.replace(tmp, path)  # 原子替换
            except Exception:
                pass

        if not top:
            return f"[⚠️ {date} 无有效连板数据（可能非交易日），龙头跟踪不可用]"

        lines = [f"连板梯队（{date}，共 {len(ladder)} 只；以下仅展示前 {min(8, len(top))} 只）："]
        for x in top[:8]:
            lines.append(f"  {x['name']}({x['consec_boards']}板·{x.get('sector', '')})")

        # 载入最近 5 份已有快照，归档日期不一定连续。
        try:
            files = sorted(f for f in os.listdir(_LEADER_DIR) if f.endswith(".json") and f[:8] < d)
        except FileNotFoundError:
            files = []
        hist = files[-5:]
        if hist:
            lines.append("最近 5 份已有历史归档（日期可能不连续，不代表最近五个交易日）：")
            for hf in hist:
                try:
                    with open(os.path.join(_LEADER_DIR, hf), encoding="utf-8") as fh:
                        h = json.load(fh)
                    hl = h.get("ladder", [])
                    if hl:
                        lead = hl[0]
                        lines.append(
                            f"  {h.get('date', hf[:8])}: 最高{lead['consec_boards']}板 "
                            f"{lead['name']}({lead.get('sector', '')})"
                        )
                except Exception:
                    continue
        else:
            lines.append("（首次运行，近 5 日龙头谱系需逐日快照攒够后才有对比）")
        return "\n".join(lines)
    except Exception as exc:  # noqa: BLE001
        return _degrade("龙头跟踪", date, exc)

# ---------- 前日涨停池（复盘的昨日反馈 / 晋级率 / 多日趋势都要用）----------

_PREV_POOL_DIR = data_path("cache/prev_pool")


def is_limit_up(row: dict) -> "Optional[bool]":
    """这一行今天涨停了吗。优先用「现价 == 涨停价」，缺价格字段时按制度推定。"""
    close, limit = row.get("close"), row.get("limit_price")
    if close is not None and limit is not None and limit > 0:
        return abs(close - limit) < 0.011
    ret = row.get("ret")
    if ret is None:
        return None
    from .market_facts import limit_pct

    return ret >= limit_pct(row.get("code", ""), row.get("name", "")) - 0.3


def fetch_prev_pool(date: str) -> "Optional[list[dict]]":
    """取「前一交易日涨停股在 date 当天的表现」，已定稿的日子落盘缓存。"""
    from . import trade_calendar
    from .cache_policy import fresh as cache_fresh, write as write_cache

    is_past = trade_calendar.is_settled(date)
    os.makedirs(_PREV_POOL_DIR, exist_ok=True)
    path = os.path.join(_PREV_POOL_DIR, f"{date}.json")
    if is_past and os.path.isfile(path) and cache_fresh(path, date):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:  # noqa: BLE001
            pass

    try:
        import akshare as ak

        df = ak.stock_zt_pool_previous_em(date=date.replace("-", ""))
    except Exception:  # noqa: BLE001
        return None
    if df is None or not len(df):
        return None

    rows = []
    for _, r in df.iterrows():
        try:
            rows.append({
                "code": str(r["代码"]).zfill(6),
                "name": str(r["名称"]),
                "ret": float(r["涨跌幅"]),
                "prev_boards": int(r["昨日连板数"]),
                "seal_time": str(r.get("昨日封板时间", "")),
                "sector": str(r.get("所属行业", "")),
                "close": float(r["最新价"]) if r.get("最新价") is not None else None,
                "limit_price": float(r["涨停价"]) if r.get("涨停价") is not None else None,
            })
        except (KeyError, ValueError, TypeError):
            continue
    if not rows:
        return None
    if is_past:
        write_cache(path, rows)
    return rows

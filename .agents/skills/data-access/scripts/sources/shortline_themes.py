"""题材事件树与首板名单:按涨停原因串(真实事件题材)复盘,不按行业分类。

「电网设备」「元件」「IT服务」是东财的行业分类,不是打板选手复盘时说的题材。问财 / 同花顺的涨停原因串才是:

    000417: 间接投资长鑫科技+百货零售+合肥国资
    000533: 数据中心+干式变压器+电网设备+控制权变更预期

题材树对每个题材按复盘顺序摆事实:昨日该题材涨停股今天什么反馈 → 几点首封 → 扩散到几只 → 连板多高 → 炸了几个。
拿不到题材串时整棵树标不可用,**绝不退回行业分类冒充题材**(行业结构在 cn_shortline_facts 的 themes 块)。

移植自 Vibe AStock v2.0.0 的 duanxian/theme_tree.py、historical_sources.public_limit_reasons、vr/firstboard.py,改了几处:
- 涨停原因统一走 `limit_reasons()`:配了 IWENCAI_API_KEY 先问问财(按日期问,用返回列名里的日期核对场次);
  问财出错或没配 key,走同花顺涨停揭秘(逐行核对封板时间属于这一天)。VA 首板页的问财查询原来不核对场次,现在一样核对;
  VA 配了 key 而问财出错时整棵树不可用,现在改走同花顺。
- 问财翻页上限从 3 页(150 只)放到 10 页,翻满还没完就当失败,不交半份名单。
- 题材串清洗只按整个标签截断:VA 先拼好再截到 30 个字,会把末尾标签截成半个词(「控制权变更预」),半个词又会被当成一个新题材。
- 首板名单可指定日期;反包票(东财连板数 1、涨停统计 N 天 M 板)照旧算在首板里,但标出「N天M板」并单独计数。
- 东财池子取数沿用 shortline.py(push2ex),题材串缓存交给取数服务的快照(已收盘的日子长期缓存)。

全部是当天已发生的客观事实汇总,不预测、不给个股倾向;题材「状态」只由已发生的读数推出。
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH  # noqa: E402
from sources import shortline as S  # noqa: E402
from sources._http import http_json  # noqa: E402

_GENERIC = {
    "国企改革", "央企改革", "破净", "低价股", "高送转", "摘帽", "壳资源",
    "小盘股", "微盘股", "次新股", "超跌反弹", "股权激励", "员工持股",
}
# 地方国资类(xx国资 / xx国企)也属于属性词,用后缀判
_GENERIC_SUFFIX = ("国资", "国企", "板块")

_MAX_TAGS = 4
_MAX_LEN = 40
_IWC_PAGE = 50
_IWC_PAGES = 10
_THS_URL = "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool"
_THS_FIELDS = "199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004"
_THS_PAGE = 200
_THS_PAGES = 20
_UA = "Mozilla/5.0"


def _is_generic(tag: str) -> bool:
    return tag in _GENERIC or tag.endswith(_GENERIC_SUFFIX)


def clean_reason(text: Any) -> str:
    """题材串清洗:统一分隔符,最多 4 个标签;超长时整个丢掉后面的标签,不截成半个词。"""
    s = str(text or "").replace("，", "+").replace(",", "+")
    out: list[str] = []
    for t in (p.strip() for p in s.split("+")):
        if not t:
            continue
        if out and len("+".join(out + [t])) > _MAX_LEN:
            break
        out.append(t[:_MAX_LEN])
        if len(out) >= _MAX_TAGS:
            break
    return "+".join(out)


def tags_of(reason: Any) -> list[str]:
    """题材串 → 事件标签。过滤纯属性词(国企改革 / 破净 / xx国资…)。"""
    return [t for t in (p.strip() for p in str(reason or "").split("+")) if t and not _is_generic(t)]


# ---------------------------------------------------------------- 涨停原因
def _iwencai_reasons(d8: str) -> tuple[dict[str, str], str]:
    """问财按日期问「YYYY-MM-DD涨停的股票 涨停原因」。列名形如 涨停原因[YYYYMMDD]:没带日期或日期不对都当失败。"""
    from sources.iwencai import iwencai_query

    query = f"{d8[:4]}-{d8[4:6]}-{d8[6:]}涨停的股票 涨停原因"
    reasons: dict[str, str] = {}
    first_len = 0
    for page in range(1, _IWC_PAGES + 1):
        rows = iwencai_query(query, page=page, limit=_IWC_PAGE)
        if not rows:
            break
        cols = list(rows[0].keys())
        code_cols = [c for c in cols if "代码" in c]
        reason_cols = [c for c in cols if "涨停原因" in c]
        if not code_cols or not reason_cols:
            raise ValueError(f"问财返回没有涨停原因列:{cols[:6]}")
        dated = {m.group(1): c for c in reason_cols if (m := re.search(r"\[(\d{8})\]", c))}
        if not dated:
            raise ValueError(f"问财的涨停原因列没带日期,确认不了是哪一场:{reason_cols[:3]}")
        if d8 not in dated:
            raise ValueError(f"问财返回的是 {sorted(dated)} 的涨停原因,不是 {d8}")
        cc, rc = code_cols[0], dated[d8]
        before = len(reasons)
        for r in rows:
            code = str(r.get(cc) or "")[:6]
            reason = str(r.get(rc) or "").strip()
            if re.fullmatch(r"\d{6}", code) and reason and reason.lower() != "nan" and code not in reasons:
                reasons[code] = clean_reason(reason)
        # 🔴 问财每页实际给几条没核实过(要密钥):不能拿「不满 50 条」当最后一页,否则上限低于 50 时只取到第一页。
        #    只认三种结束:空页、比第一页短、这页没给新票(上游不认 page 参数;第一页就没有能用的原因则改走同花顺)
        if len(reasons) == before:
            break
        first_len = first_len or len(rows)
        if len(rows) < first_len:
            break
    else:
        raise ValueError(f"问财翻到第 {_IWC_PAGES} 页还没完,不交半份名单")
    if not reasons:
        raise ValueError("问财没返回涨停原因")
    return reasons, f"来源：问财 {S.iso(d8)} 涨停原因（列名日期已核对）；原因覆盖 {len(reasons)} 只；源站归因非公司确认。"


def _ths_reasons(d8: str) -> tuple[dict[str, str], str]:
    """同花顺涨停揭秘:翻页拿全,逐行核对首次封板时间属于这一天(请求参数不算日期证据)。不含北交所。"""
    day = datetime.strptime(d8, "%Y%m%d").date()
    reasons: dict[str, str] = {}
    seen: set[str] = set()
    total: Optional[int] = None
    for page in range(1, _THS_PAGES + 1):
        env = http_json(_THS_URL, params={"page": page, "limit": _THS_PAGE, "field": _THS_FIELDS, "filter": "HS,GEM2STAR",
                                          "order_field": "330324", "order_type": "0", "date": d8},
                        headers={"User-Agent": _UA}, timeout=12)
        if env.get("status_code") != 0:
            raise ValueError("同花顺涨停揭秘没有成功返回")
        data = env.get("data") or {}
        rows = data.get("info") or []
        count = int((data.get("page") or {}).get("total") or 0)
        if total is not None and total != count:
            raise ValueError("翻页期间名单变了,请重试")
        total = count
        if not rows and len(seen) < total:
            raise ValueError("同花顺涨停揭秘分页缺失")
        for row in rows:
            code = str(row.get("code", ""))
            if not re.fullmatch(r"\d{6}", code) or code in seen:
                raise ValueError("同花顺涨停揭秘有重复或无效代码,分页不完整")
            seen.add(code)
            try:
                stamp = float(row["first_limit_up_time"])
                when = datetime.fromtimestamp(stamp, TZ_SH).date()
            except (KeyError, TypeError, ValueError, OverflowError, OSError):
                raise ValueError(f"{code} 缺少有效封板时间,核对不了是哪一天") from None
            if when != day:
                raise ValueError("同花顺返回的是别的交易日,未使用")
            reason = row.get("reason_type")
            if isinstance(reason, str) and reason.strip() and reason.strip() not in {"-", "暂无"}:
                reasons[code] = clean_reason(reason)
        if len(seen) >= total:
            if len(seen) != total:
                raise ValueError("同花顺涨停揭秘分页数量对不上")
            break
    else:
        raise ValueError("同花顺涨停揭秘翻页超过上限,不交半份名单")
    if not seen:
        raise ValueError(f"同花顺 {S.iso(d8)} 没返回涨停记录,核对不了是哪一天")
    return reasons, (f"来源：同花顺涨停揭秘 {S.iso(d8)}；原因覆盖 {len(reasons)}/{len(seen)} 只；封板时间逐行核对；"
                     "沪深主板 / 创业板 / 科创板，不含北交所；源站编辑归因非公司确认。")


_REASONS: dict[str, tuple[dict[str, str], str]] = {}


def limit_reasons(date: str) -> tuple[dict[str, str], str]:
    """某个交易日的 代码 → 涨停原因串。取不到返回 ({}, 原因);同一进程按日期记住成功的结果。"""
    d8 = S.compact(date)
    if d8 in _REASONS:
        return _REASONS[d8]
    errs: list[str] = []
    if os.environ.get("IWENCAI_API_KEY"):
        try:
            got = _iwencai_reasons(d8)
            _REASONS[d8] = got
            return got
        except Exception as exc:  # noqa: BLE001  问财不行就换同花顺,原因写进说明
            errs.append(f"问财：{str(exc)[:120]}")
    try:
        reasons, note = _ths_reasons(d8)
    except Exception as exc:  # noqa: BLE001
        errs.append(f"同花顺涨停揭秘：{str(exc)[:120]}")
        return {}, "；".join(errs)
    if errs:
        note = note + f"（问财没取到，已改用同花顺：{errs[0]}）"
    _REASONS[d8] = (reasons, note)
    return reasons, note


# ---------------------------------------------------------------- 题材事件树
def _state_of(grp: dict, has_prev: bool = True, prev_complete: bool = True) -> str:
    """题材状态标签。只由已发生的读数推出,不含对明天的判断。"""
    lu, hi = grp["limit_up"], grp["highest"]
    prev_n = grp["prev_members"]
    cont = grp["continuation_rate"]
    br = grp["broken_rate"] or 0
    if not has_prev:
        return "无昨日题材数据"
    if lu == 0 and prev_n:
        return "昨日题材未再涨停"
    if prev_n == 0:
        return "今日新出现" if prev_complete else "昨日覆盖样本未见"
    if cont is not None and cont <= 0.15 and lu <= 2:
        return "接力断档"
    if br >= 0.5:
        return "分歧加大"
    if lu >= 4 and grp["first_boards"] >= 2:
        return "扩散中"
    if hi >= 3 and lu <= 2:
        return "高标独活"
    if cont is not None and cont >= 0.5:
        return "延续"
    return "维持"


def theme_tree(date: str, prev: Optional[str] = None, top: int = 10) -> dict:
    """某个交易日的题材事件树。"""
    p = S.pools(date)
    if p is None:
        return {"available": False, "reason": f"{date} 涨停池或炸板 / 跌停池没取到(或当天涨停池为空)"}
    reasons, note = limit_reasons(date)
    if not reasons:
        return {"available": False, "reason": f"涨停原因串没取到（{note}）。不用行业分类顶替：行业不是题材"}

    zt, zb, dt = p["zt"], p["zb"], p["dt"]
    zt_by_code = {r["code"]: r for r in zt}
    zb_codes = {r["code"] for r in zb}
    dt_codes = {r["code"] for r in dt}

    # 昨日各票的题材与板位:算「这个题材昨天的涨停股今天怎么样」
    prev_reasons, _ = limit_reasons(prev) if prev else ({}, "没有前一交易日")
    pp = S.pools(prev) if prev else None
    has_prev = bool(prev_reasons) and pp is not None and bool(pp["zt"])
    prev_boards = {r["code"]: int(r.get("boards") or 1) for r in (pp["zt"] if pp else [])}
    prev_covered = sum(bool(tags_of(prev_reasons.get(code, ""))) for code in prev_boards)
    prev_complete = bool(prev_boards) and prev_covered == len(prev_boards)

    groups: dict[str, dict] = {}

    def g(tag: str) -> dict:
        return groups.setdefault(tag, {
            "tag": tag, "limit_up": 0, "first_boards": 0, "consec_boards": 0, "highest": 0, "broken": 0, "limit_down": 0,
            "seal_times": [], "members": [], "prev_members": 0, "prev_still_up": 0, "prev_broken_or_down": 0,
        })

    matched = 0   # 题材串里真正对上当天涨停池的只数(问财 / 同花顺口径和东财涨停池会有出入)
    for code, reason in reasons.items():
        r = zt_by_code.get(code)
        if r is None:
            continue
        tags = tags_of(reason)
        if not tags:
            continue
        matched += 1
        b = int(r.get("boards") or 1)
        stat = r.get("zt_stat")
        t = str(r.get("first_seal") or "")
        for tag in tags:
            grp = g(tag)
            grp["limit_up"] += 1
            grp["highest"] = max(grp["highest"], b)
            grp["first_boards" if b <= 1 else "consec_boards"] += 1
            if t:
                grp["seal_times"].append(t)
            grp["members"].append({
                "code": code, "name": r["name"], "boards": b, "zt_stat": stat, "label": S.board_label(b, stat),
                # 反包票(3天2板)东财连板数只给 1,排序按有效高度,别沉到榜尾
                "_h": max(b, S.stat_boards(stat)), "first_seal": t or None, "broken_times": int(r.get("broken_times") or 0),
            })

    # 昨日题材今天一只没涨停也保留,免得整条失去反馈的题材从表里消失
    for code, reason in prev_reasons.items():
        if code in prev_boards:
            for tag in tags_of(reason):
                g(tag)

    # 炸板 / 跌停的票归到它们的题材(今天没涨停就没有今日串,用昨日串兜底)
    for codes, key in ((zb_codes, "broken"), (dt_codes, "limit_down")):
        for code in codes:
            for tag in tags_of(reasons.get(code) or prev_reasons.get(code) or ""):
                if tag in groups:
                    groups[tag][key] += 1

    # 延续:昨天这个题材里的涨停股,今天还在不在
    for code, reason in prev_reasons.items():
        if code not in prev_boards:
            continue
        for tag in tags_of(reason):
            pg = groups.get(tag)
            if pg is None:
                continue
            pg["prev_members"] += 1
            if code in zt_by_code:
                pg["prev_still_up"] += 1
            elif code in zb_codes or code in dt_codes:
                pg["prev_broken_or_down"] += 1

    if matched == 0 and not any(grp["prev_members"] for grp in groups.values()):
        return {"available": False, "reason": "涨停原因和当天涨停池没匹配出事件题材"}

    themes = []
    for grp in groups.values():
        ts = sorted(grp.pop("seal_times"))
        attempts = grp["limit_up"] + grp["broken"]
        grp["first_seal"] = ts[0] if ts else None    # 该题材第一只涨停的时间
        grp["last_seal"] = ts[-1] if ts else None    # 最后一只:和首封拉开 = 持续发酵
        grp["broken_rate"] = round(grp["broken"] / attempts, 3) if attempts else None
        grp["continuation_rate"] = round(grp["prev_still_up"] / grp["prev_members"], 3) if grp["prev_members"] else None
        grp["state"] = _state_of(grp, has_prev, prev_complete)
        grp["members"] = sorted(grp["members"], key=lambda x: -x["_h"])[:8]
        for m in grp["members"]:
            m.pop("_h", None)
        themes.append(grp)
    themes.sort(key=lambda x: (-x["limit_up"], -x["highest"]))

    total_zt = len(zt)
    shown = themes[:top] + [t for t in themes[top:] if not t["limit_up"] and t["prev_members"]][:6]
    src = (f"昨日有效题材覆盖 {prev_covered}/{len(prev_boards)} 只，只对已覆盖的样本算延续。列出当天前 {top} 个题材，"
           f"另补最多 6 个昨日有、今天没再涨停的题材。{note}")
    if not has_prev:
        src += " 昨日涨停池或昨日题材串没取到，不能判断题材是不是新出现。"
    return {
        "available": True, "source_note": src, "tag_count": len(themes),
        "prev_covered": prev_covered, "prev_total": len(prev_boards), "has_prev": has_prev,
        "themes": shown,
        # 头部集中度:第一题材占全市场涨停的比例
        "concentration": round(themes[0]["limit_up"] / total_zt, 3) if themes and total_zt else None,
        # 覆盖率 = 对上涨停池的只数 / 涨停家数(直接用原因条数会出现「42/40」这种看着像 bug 的数)
        "covered": matched, "total_limit_up": total_zt,
        "coverage_rate": round(matched / total_zt, 3) if total_zt else None,
    }


def build_themes(date: Optional[str] = None, top: int = 10) -> dict:
    d = S.review_day(date)
    top = int(top)
    if not 3 <= top <= 30:
        raise ValueError("top 要在 3–30 之间")
    prev = S.prev_trade_date(d)
    return {"date": d, "prev_date": prev, "settled": S.is_settled(d), "top": top, "tree": theme_tree(d, prev, top)}


def render_themes(r: dict) -> str:
    tree = r.get("tree") or {}
    if not tree.get("available"):
        return f"[题材事件树 {r.get('date')}：不可用（{tree.get('reason', '未知')}）]"
    cr = tree.get("coverage_rate")
    lines = [f"[题材事件树 {r['date']}｜题材串覆盖 {tree['covered']}/{tree['total_limit_up']} 只涨停"
             + (f"（{cr:.0%}）" if cr is not None else "") + "]", tree["source_note"]]
    for t in tree["themes"]:
        seg = f"· {t['tag']}［{t['state']}］涨停{t['limit_up']}（首板{t['first_boards']}/连板{t['consec_boards']}）最高{t['highest']}板"
        if t["first_seal"]:
            seg += f"，首封{t['first_seal'][:2]}:{t['first_seal'][2:4]}"
            if t["last_seal"] and t["last_seal"] != t["first_seal"]:
                seg += f"→末封{t['last_seal'][:2]}:{t['last_seal'][2:4]}"
        if t["broken"]:
            seg += f"，炸{t['broken']}"
        if t["limit_down"]:
            seg += f"，跌停{t['limit_down']}"
        if t["prev_members"]:
            seg += f"；昨日该题材{t['prev_members']}只涨停，今日仍涨停{t['prev_still_up']}只"
            if t["continuation_rate"] is not None:
                seg += f"（延续率{t['continuation_rate']:.0%}）"
        names = "、".join(f"{m['name']}{m['label']}" for m in t["members"][:3])
        if names:
            seg += f"；代表：{names}"
        lines.append(seg)
    if tree.get("concentration") is not None:
        lines.append(f"· 头部题材占全市场涨停 {tree['concentration']:.0%}（共 {tree['tag_count']} 个事件题材）")
    return "\n".join(lines)


# ---------------------------------------------------------------- 首板名单
def build_firstboard(date: Optional[str] = None) -> dict:
    """某个交易日的首板(东财连板数 = 1)名单 + 涨停原因,按首封时间排。原因取不到时其余字段照出。"""
    d = S.review_day(date)
    zt = S.zt_pool(d)
    out: dict = {"date": d, "settled": S.is_settled(d)}
    if zt is None:
        out.update(available=False, reason=f"{d} 涨停池没取到(或当天涨停池为空)")
        return out
    reasons, note = limit_reasons(d)
    stocks = []
    for r in zt:   # 池子按首封时间升序取回,早封在前
        if int(r.get("boards") or 1) != 1:
            continue
        stat = r.get("zt_stat")
        stocks.append({
            "code": r["code"], "name": r["name"], "board": r["board"], "close": r.get("close"), "ret": r.get("ret"),
            "amount": r.get("amount"), "float_cap": r.get("float_cap"), "sector": r.get("sector") or "",
            "first_seal": r.get("first_seal") or None, "broken_times": int(r.get("broken_times") or 0),
            "label": S.board_label(1, stat), "rebound": S.stat_boards(stat) > 1, "reason": reasons.get(r["code"], ""),
        })
    out.update(available=True, total_limit_up=len(zt), first_count=len(stocks),
               rebound_count=sum(1 for s in stocks if s["rebound"]),
               reason_available=bool(reasons), reason_covered=sum(1 for s in stocks if s["reason"]),
               reason_note=note, stocks=stocks)
    return out


def render_firstboard(r: dict) -> str:
    if not r.get("available"):
        return f"[首板 {r.get('date')}：不可用（{r.get('reason', '未知')}）]"
    head = (f"[首板 {r['date']}｜涨停 {r['total_limit_up']} 只，其中首板 {r['first_count']} 只"
            + (f"（含反包 {r['rebound_count']} 只）" if r["rebound_count"] else "")
            + (f"；涨停原因覆盖 {r['reason_covered']}/{r['first_count']}" if r["reason_available"] else "；涨停原因没取到")
            + "]")
    lines = [head, r["reason_note"]]
    for s in r["stocks"][:40]:
        t = s["first_seal"]
        seg = f"· {s['name']}（{s['code']}）首封{t[:2]}:{t[2:4]}" if t else f"· {s['name']}（{s['code']}）"
        if s["rebound"]:
            seg += f"，{s['label']}"
        if s["broken_times"]:
            seg += f"，开板{s['broken_times']}次"
        if s["reason"]:
            seg += f"；{s['reason']}"
        lines.append(seg)
    if len(r["stocks"]) > 40:
        lines.append(f"· 其余 {len(r['stocks']) - 40} 只略")
    return "\n".join(lines)

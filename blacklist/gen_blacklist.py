#!/usr/bin/env python3
"""生成「黑榜论市」公众号文章：三位大V当日观点 + 揽宝怎么看。

数据源：
  1. blacklist/data/<date>.json —— 三位大V的当日采集材料（由采集 skill 或人工提供）。
     每位大V字段：name / handle / platform / source_url / status / points[] / quote。
     status=ok 表示取得原文；status=unavailable 表示未取得，文章会如实标注，绝不编造。
  2. 复盘数据底座 reviews/<date>.json —— 当日真实读数，供「揽宝怎么看」使用。

产出：
  blacklist/output/<date>/article.md   带 frontmatter 的公众号文章
  blacklist/output/<date>/preview.html 手机宽度预览（调用 wxpub render --preview）

合规：沿用产品政策——「揽宝怎么看」用数据对照 + 观察条件表达，不输出买卖/仓位指令。

用法（仓库根目录）：
  .venv/bin/python blacklist/gen_blacklist.py --date 2026-11-24
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from duanxian.paths import data_path  # noqa: E402
from review_agent import blog_publish as bp  # noqa: E402

WXPUB = Path("/root/.codebuddy/skills/wechat-article-workflow/scripts/wxpub.mjs")
DATE_CN = lambda d: f"{int(d[5:7])}月{int(d[8:10])}日"

# 免责声明：与生成器共用同一口径；风险句加橙色大字体前缀
DISCLAIMER = bp.DISCLAIMER
RISK_TAG = bp.RISK_TAG_HTML


def _split(text: str) -> list[str]:
    """按中文句号拆段（与揽宝投研生成器同规则）。"""
    return bp._split_sentences(text)


def _load_experts(date: str) -> dict:
    path = ROOT / "blacklist" / "data" / f"{date}.json"
    if not path.exists():
        # cron 场景：当天材料尚未采集时，落一份「待采集」占位，保证流程不中断、
        # 也绝不编造大V观点。采集 skill 配置好后，覆盖同名文件即可重跑。
        template = {
            "date": date,
            "note": "当日材料待采集；待微信/抖音采集通道可用后填充。未取得原文不作转述。",
            "experts": [
                {"name": n, "handle": h, "platform": p, "source_url": "", "status": "unavailable",
                 "note": "当日原文待采集", "points": []}
                for n, h, p in (
                    ("大红好运哥", "大红好运哥", "微信公众号"),
                    ("格兰投研", "格兰投研", "微信公众号"),
                    ("全能的野人", "全能的野人哥", "抖音"),
                )
            ],
        }
        path.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"当天材料缺失，已创建待采集占位：{path}", file=sys.stderr)
    return json.loads(path.read_text(encoding="utf-8"))


def _review_facts(date: str) -> dict:
    try:
        payload = bp.load_review(data_path("reviews"), date)
    except bp.PublishError:
        # 14:00 触发时当天复盘尚未生成：退回最近一个已落盘交易日，
        # 并明确标注数据日期，避免把旧读数当成当天读数。
        reviews = data_path("reviews")
        dates = bp.iter_dates(reviews, limit=1)
        if not dates:
            raise SystemExit("复盘数据底座为空，无法生成文章")
        payload = bp.load_review(reviews, dates[0])
        payload["_facts_date"] = dates[0]
    focus = payload.get("focus") or {}
    em = payload.get("emotion_metrics") or {}
    breadth = (payload.get("market_facts") or {}).get("breadth") or {}
    money = em.get("money_effect") or {}
    promo = (em.get("promotion") or {}).get("overall") or {}
    up, down = breadth.get("up"), breadth.get("down")
    ratio = bp._pct(up / (up + down)) if isinstance(up, int) and isinstance(down, int) and up + down > 0 else "—"
    return {
        "_facts_date": str(payload.get("_facts_date") or ""),
        "phase": str(focus.get("emotion_phase") or "—"),
        "oneliner": str(focus.get("market_oneliner") or ""),
        "updown": f"{up} / {down}" if up is not None and down is not None else "—",
        "ratio": ratio,
        "money_median": bp._sign(money.get("median"), 2, "%") if money.get("available") else "—",
        "positive_rate": bp._pct(money.get("positive_rate")) if money.get("available") else "—",
        "promotion": bp._pct(promo.get("rate")) if promo.get("rate") is not None else "—",
        "verification": (focus.get("verification_items") or [])[:4],
    }


def _expert_block(expert: dict) -> str:
    """一位大V一个区块：观点、来源、状态；未取得原文时如实说明。"""
    name = expert.get("name", "未命名")
    handle = expert.get("handle", "")
    platform = expert.get("platform", "")
    status = expert.get("status", "unavailable")
    lines = []
    header = f"## {name}（{platform}）"
    if handle:
        header += f" · {handle}"
    lines.append(header)
    if status == "skipped":
        lines.append(f"> {expert.get('note') or '本次暂不处理。'}")
        lines.append("")
        return "\n".join(lines)
    if status != "ok":
        note = str(expert.get("note") or "采集受限，不作转述。").strip()
        prefix = "当日原文未取得"
        lines.append(f"> {note if note.startswith(prefix) else prefix + '：' + note}")
        lines.append("")
        return "\n".join(lines)
    quote = str(expert.get("quote") or "").strip()
    if quote:
        for s in _split(quote):
            lines.append(s)
        lines.append("")
    for p in expert.get("points") or []:
        text = str(p).strip()
        if text:
            lines.append(f"- {text}")
    lines.append("")
    rebuttal = str(expert.get("rebuttal") or "").strip()
    if rebuttal:
        lines.append("### 黑榜对账：观点 vs 真实读数")
        lines.append("")
        for s in _split(rebuttal):
            lines.append(s)
        lines.append("")
    url = str(expert.get("source_url") or "").strip()
    if url:
        lines.append(f"> 原文：{url}")
        lines.append("")
    return "\n".join(lines)


def _column_title(date: str, data: dict) -> str:
    """标题亮明态度：有对账 material 时直接点出哪条说中、哪条打折。"""
    experts = data.get("experts") or []
    if any((e.get("status") == "ok" and e.get("rebuttal")) for e in experts):
        return f"{DATE_CN(date)}黑榜论市：高开低走，谁说中了"
    return f"{DATE_CN(date)}黑榜论市：大V观点对照真实读数"


def build_article(date: str, data: dict, facts: dict) -> str:
    title = _column_title(date, data)
    experts = data.get("experts") or []
    facts_date = facts.get("_facts_date")
    data_note = (f"（读数截至 {DATE_CN(facts_date)}，当日复盘尚未落盘）" if facts_date else "")
    body = [
        f"# {title}",
        "",
        f"{DATE_CN(date)}A股复盘，把三位大V的当日观点摆上桌，再拿真实读数逐条对一遍。",
        "这是揽宝投研的「黑榜论市」：不站队、不吹捧，只看观点有没有被第二天的数据验证。",
        "",
        "## 先说结论",
        "",
        f"当日情绪档位「{facts['phase']}」{data_note}，涨跌家数 {facts['updown']}，上涨占比 {facts['ratio']}；"
        f"昨日涨停样本今日中位 {facts['money_median']}，翻红率 {facts['positive_rate']}，"
        f"整体晋级率 {facts['promotion']}。",
        "",
        f"{facts['oneliner']}" if facts["oneliner"] else "",
        "",
        "下面三位大V，谁说中了、谁没验证，数字自己会说话。",
        "",
    ]
    for e in experts:
        body.append(_expert_block(e))

    body.extend([
        "## 揽宝怎么看",
        "",
        "我们不跟着任何一位大V走，只把当日读数按可证伪的方式摆出来。",
        f"上涨占比 {facts['ratio']}，说明当天个股层面的广度偏弱；"
        f"昨日涨停股中位 {facts['money_median']}，翻红率 {facts['positive_rate']}，"
        "这是昨日强势样本的真实反馈，不是全市场收益。",
        f"晋级率 {facts['promotion']} 衡量接力意愿，低则梯队不稳。",
        "",
    ])
    vi = facts.get("verification") or []
    if vi:
        body.append("接下来盯这几个条件，出现才谈延续，未出现就是反证：")
        body.append("")
        nmap = {"limit_up_count": "涨停家数", "promotion_1to2": "1进2晋级率",
                "money_effect_median": "昨日涨停样本中位表现", "broken_rate": "炸板率",
                "market_limit_down": "跌停家数", "highest_board": "最高连板高度"}
        for it in vi:
            label = nmap.get(str(it.get("metric")), str(it.get("metric")))
            body.append(f"- {label}：看{it.get('direction', '')}——{it.get('reason', '')}")
        body.append("")
    body.extend([
        "以上为观察条件，不是涨跌预测，也不构成操作建议。",
        "",
        "---",
        "",
        "**你更信哪类观点：情绪派、产业派，还是短线派？评论区说说你的判断依据。**",
        "",
        "*#A股复盘 #黑榜论市 #大V观点 #情绪档位 #明日验证*",
        "",
    ])
    for s in _split(DISCLAIMER):
        body.append(f"{RISK_TAG if bp._is_risk_sentence(s) else ''}{s}")
        body.append("")
    return "\n".join(body)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成黑榜论市公众号文章")
    ap.add_argument("--date", required=True, help="复盘日期，如 2026-11-24")
    ap.add_argument("--no-preview", action="store_true", help="不调用 wxpub 生成预览")
    ap.add_argument("--trading-day-only", action="store_true",
                    help="今天非交易日则直接跳过（供宿主 cron 使用）")
    args = ap.parse_args(argv)

    if args.trading_day_only:
        from duanxian import trade_calendar
        from duanxian.util import china_today

        dates = trade_calendar.last_trade_dates(1)
        if dates and dates[-1] != china_today():
            print("今天非交易日，按 --trading-day-only 跳过", file=sys.stderr)
            return 0

    data = _load_experts(args.date)
    facts = _review_facts(args.date)
    article = build_article(args.date, data, facts)

    out_dir = ROOT / "blacklist" / "output" / args.date
    out_dir.mkdir(parents=True, exist_ok=True)
    title = _column_title(args.date, data)
    fm = ("---\n"
          f"title: {title}\n"
          "author: 揽宝投研\n"
          "summary: 三位大V当日观点逐条摆上桌，用真实读数对照，看谁被验证、谁没有。\n"
          "cover: ./cover.png\n"
          "theme: orange\n"
          "collection: 黑榜论市\n"
          "source_url: https://ten2net.github.io/\n"
          "---\n\n")
    md_path = out_dir / "article.md"
    md_path.write_text(fm + article, encoding="utf-8")
    print(f"文章：{md_path}")
    print(f"标题：{title}")

    if not args.no_preview and WXPUB.exists():
        proc = subprocess.run(
            ["node", str(WXPUB), "render", str(out_dir), "--theme", "orange", "--preview",
             "--project", str(ROOT / "wechat-article")],
            capture_output=True, text=True, cwd=str(ROOT))
        if proc.returncode == 0:
            print(f"预览：{out_dir / 'preview.html'}")
        else:
            print(f"预览生成失败（不影响文章）：{proc.stderr[:300]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

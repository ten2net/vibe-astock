#!/usr/bin/env python3
"""公众号「标签校准」发布前检查。

背景：为涨粉关注无关公众号会导致账号兴趣标签错乱、完读率下降。
本脚本检查文章本身的垂直度与结构，确保每篇内容都在帮系统把账号
打回「A股短线投研」标签，而不是稀释它。

纯标准库，无额外依赖。
用法：
    python tag_calibration_check.py <article.md | 目录>
退出码：0 = 通过，1 = 未通过（含 ERROR 或分数 < 80）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- 词表

# 核心领域词：命中即强化「A股投研」标签。
# 覆盖投研全域（短线复盘 + 个股研究 + 估值 + 回测），避免把合法子类误判为不垂直。
CORE_TERMS = [
    # 短线情绪
    "A股", "复盘", "涨停", "情绪", "晋级率", "连板", "跌停",
    "上涨占比", "昨日涨停", "赚钱效应", "亏钱效应", "资金",
    "档位", "首板", "中位表现", "明日验证", "情绪周期", "题材",
    # 个股研究 / 基本面
    "个股", "研究", "估值", "PE", "财报", "财务", "产业链", "公司",
    "盈利", "营收", "净利润", "口径", "报告",
    # 回测 / 量化
    "回测", "策略", "收益率", "净值", "量化", "数据", "因子", "收盘价",
]

# 无关领域词：出现即判 ERROR（标签污染源）。
# 用强信号词组，避免「两种游戏混着玩」这类比喻被误判。
OFF_TOPIC_TERMS = [
    "美食推荐", "宠物", "猫咪", "狗狗", "玩游戏", "游戏攻略", "手游", "网游",
    "美妆", "护肤", "育儿", "星座运势", "带货", "穿搭", "旅游攻略",
    "菜谱", "减肥", "健身教程", "相亲", "情感鸡汤", "萌宠", "追剧",
    "综艺节目", "八卦新闻",
]

# 震惊体/标题党
SENSATIONAL_TERMS = ["震惊", "必看", "不看后悔", "惊人", "吓尿", "速看", "紧急"]

# 诱导结尾词（微信违规风险）
INDUCEMENT_TERMS = ["点在看", "点亮在看", "转发朋友圈", "点赞转发", "求点赞", "求转发"]

WANTED_SOURCE_URL = "https://ten2net.github.io/"

PASS_SCORE = 80

# ---------------------------------------------------------------- 工具


def strip_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """返回 (frontmatter 字典, 正文)。"""
    fm: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
        if m:
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    fm[k.strip()] = v.strip().strip("\"'")
            body = m.group(2)
    return fm, body


def count_terms(text: str, terms: list[str]) -> dict[str, int]:
    return {t: text.count(t) for t in terms if text.count(t) > 0}


def first_n_chars(text: str, n: int) -> str:
    return text[:n]


class Result:
    def __init__(self, path: Path):
        self.path = path
        self.score = 0
        self.notes: list[str] = []
        self.errors: list[str] = []

    def add(self, points: int, note: str) -> None:
        self.score += points
        self.notes.append(f"+{points:2d}  {note}")

    def skip(self, note: str) -> None:
        self.notes.append(f" 0   {note}")

    def error(self, note: str, deduct: int = 0) -> None:
        self.score -= deduct
        msg = f"ERROR {note}" + (f"（-{deduct}）" if deduct else "")
        self.errors.append(msg)
        self.notes.append(msg)

    @property
    def passed(self) -> bool:
        return not self.errors and self.score >= PASS_SCORE


# ---------------------------------------------------------------- 各项检查


def check_core_terms(r: Result, body: str, first300: str) -> None:
    """B1 核心关键词垂直度（30 分）。"""
    hits_first = count_terms(first300, CORE_TERMS)
    hits_all = count_terms(body, CORE_TERMS)
    total = sum(hits_all.values())

    n_first = sum(hits_first.values())
    if n_first >= 3:
        r.add(18, f"前300字核心词 {n_first} 次（{hits_first}）")
    elif n_first >= 1:
        r.add(8, f"前300字核心词仅 {n_first} 次，建议 ≥3")
    else:
        r.error("前300字没有任何核心领域词，系统无法识别账号领域", deduct=18)

    if total >= 8:
        r.add(12, f"全文核心词共 {total} 次")
    elif total >= 4:
        r.add(5, f"全文核心词仅 {total} 次，垂直度偏弱（建议 ≥8）")
    else:
        r.error(f"全文核心词仅 {total} 次，垂直度不足", deduct=12)

    off = count_terms(body, OFF_TOPIC_TERMS)
    if off:
        r.error(f"命中无关领域词，会污染标签：{off}", deduct=10)


def check_data_contrast(r: Result, body: str) -> None:
    """B2 真实数据对照区块（25 分）。"""
    if re.search(r"真实数据对照|两种.{0,4}盘面|同一套信号", body):
        r.add(8, "含「真实数据对照」区块标题")
    else:
        r.error("缺少「真实数据对照」区块", deduct=8)

    numbers = re.findall(r"[+-]?\d+\.\d+%|\d+\.\d+%|\d+%", body)
    if len(numbers) >= 4:
        r.add(8, f"含 {len(numbers)} 处带单位数字读数")
    elif len(numbers) >= 2:
        r.add(4, f"数字读数偏少（{len(numbers)} 处）")
    else:
        r.error("数据对照缺少带单位的数字读数", deduct=8)

    if "揽宝投研当日复盘原文" in body or "程序对公开数据逐项核对" in body:
        r.add(5, "含数据来源标注")
    else:
        r.error("数据对照缺少来源标注", deduct=5)

    if "分析框架，不是客观事实" in body or "不是客观事实" in body:
        r.add(4, "含「档位是分析框架，不是客观事实」口径声明")
    else:
        r.skip("缺少「档位是分析框架，不是客观事实」口径声明")


def check_title(r: Result, fm: dict[str, str]) -> None:
    """B3 标题质量（15 分）。"""
    title = fm.get("title", "")
    if not title:
        r.error("frontmatter 缺少 title", deduct=15)
        return

    if len(title) <= 20:
        r.add(5, f"标题 {len(title)} 字，符合 20 字内")
    else:
        r.add(2, f"标题 {len(title)} 字，超过 20 字")

    head = title[:12]
    if any(t in head for t in CORE_TERMS):
        r.add(6, "标题前12字含核心词（核心词前置）")
    else:
        r.error("标题前12字没有核心词，建议核心词前置", deduct=6)

    sens = [t for t in SENSATIONAL_TERMS if t in title]
    if sens:
        r.error(f"标题含震惊体/标题党：{sens}", deduct=15)
    else:
        r.add(4, "无震惊体/标题党")


def check_footer(r: Result, body: str, fm: dict[str, str]) -> None:
    """B4 文末结构（15 分）。"""
    # 加粗互动提问：形如 **...？** 或 **...吗**
    if re.search(r"\*\*[^*\n]*[？?][^*\n]*\*\*", body):
        r.add(5, "含加粗互动提问")
    else:
        r.error("缺少加粗互动提问", deduct=5)

    tags = re.findall(r"^#(\S+)", body, re.M)
    tag_line = ""
    m = re.search(r"^\*(#[^\n]+)\*$", body, re.M)
    if m:
        tag_line = m.group(1)
        tags = re.findall(r"#(\S+)", tag_line)
    if len(tags) >= 5:
        core_in_tags = sum(1 for t in tags if any(c in t for c in CORE_TERMS))
        if core_in_tags >= 1:
            r.add(5, f"含 {len(tags)} 个话题标签，其中 {core_in_tags} 个含核心词")
        else:
            r.add(2, f"含 {len(tags)} 个标签，但没有核心词标签")
    elif len(tags) >= 1:
        r.add(2, f"话题标签仅 {len(tags)} 个，建议 5 个")
    else:
        r.error("缺少斜体话题标签", deduct=5)

    if "**风险警示：**" in body and "不提供投资决策" in body:
        r.add(5, "含引用块「风险警示：」+ 完整免责")
    elif "风险警示" in body:
        r.add(2, "含风险警示，但免责表述不完整")
    else:
        r.error("缺少「风险警示：」完整免责", deduct=5)


def check_config(r: Result, body: str, fm: dict[str, str], path: Path) -> None:
    """B5 配置一致性（15 分）。"""
    url = fm.get("source_url", "")
    if url == WANTED_SOURCE_URL:
        r.add(4, "source_url 指向博客首页")
    else:
        r.error(f"source_url 异常：{url or '缺失'}，应为 {WANTED_SOURCE_URL}", deduct=4)

    cover = fm.get("cover", "")
    if cover and (path.parent / cover.lstrip("./")).exists():
        r.add(4, "cover 文件存在")
    elif cover:
        r.error(f"cover 文件不存在：{cover}", deduct=4)
    else:
        r.error("frontmatter 缺少 cover", deduct=4)

    if fm.get("collection"):
        r.add(3, f"合集：{fm['collection']}")
    else:
        r.error("缺少 collection", deduct=3)

    inducement = [t for t in INDUCEMENT_TERMS if t in body]
    if inducement:
        r.error(f"含诱导结尾词（微信违规风险）：{inducement}", deduct=10)
    else:
        r.add(4, "无诱导结尾词")


def check_file(path: Path) -> Result:
    r = Result(path)
    text = path.read_text(encoding="utf-8")
    fm, body = strip_frontmatter(text)
    first300 = first_n_chars(body, 300)

    check_core_terms(r, body, first300)
    check_data_contrast(r, body)
    check_title(r, fm)
    check_footer(r, body, fm)
    check_config(r, body, fm, path)
    return r


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    target = Path(sys.argv[1])
    if target.is_dir():
        files = sorted(target.glob("*/article.md")) + sorted(target.glob("article.md"))
    elif target.is_file():
        files = [target]
    else:
        print(f"路径不存在：{target}")
        return 2

    if not files:
        print(f"未找到 article.md：{target}")
        return 2

    all_passed = True
    for f in files:
        r = check_file(f)
        status = "PASS" if r.passed else "FAIL"
        print(f"\n{'='*64}")
        print(f"[{status}] {f}  得分 {r.score}/{PASS_SCORE}门槛")
        print(f"{'='*64}")
        for note in r.notes:
            print(f"  {note}")
        if not r.passed:
            all_passed = False
            if r.errors:
                print("  阻断项：")
                for e in r.errors:
                    print(f"    - {e}")
    print(f"\n{'='*64}")
    print(f"总计 {len(files)} 篇，{'全部通过' if all_passed else '存在未通过'}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())

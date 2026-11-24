"""标签校准共享核心：对纯文本做垂直度检查。

被两处复用：
  - wechat-article/tag_calibration_check.py（CLI，检查 article.md 模板文章）
  - review_agent/wechat_publish.py（复盘自动发布，检查 HTML 正文）

只做"内容是否帮账号打准 A股投研标签"的判断，不依赖 frontmatter 或文件。
纯标准库。
"""

from __future__ import annotations

import re

# 核心领域词：命中即强化「A股投研」标签（覆盖短线 + 基本面 + 量化）。
CORE_TERMS = [
    "A股", "复盘", "涨停", "情绪", "晋级率", "连板", "跌停",
    "上涨占比", "昨日涨停", "赚钱效应", "亏钱效应", "资金",
    "档位", "首板", "中位表现", "明日验证", "情绪周期", "题材",
    "个股", "研究", "估值", "PE", "财报", "财务", "产业链", "公司",
    "盈利", "营收", "净利润", "口径", "报告", "回测", "策略",
    "收益率", "净值", "量化", "数据", "因子", "收盘价",
]

# 无关领域词（强信号词组，避免比喻误判）。
OFF_TOPIC_TERMS = [
    "美食推荐", "宠物", "猫咪", "狗狗", "玩游戏", "游戏攻略", "手游", "网游",
    "美妆", "护肤", "育儿", "星座运势", "带货", "穿搭", "旅游攻略",
    "菜谱", "减肥", "健身教程", "相亲", "情感鸡汤", "萌宠", "追剧",
    "综艺节目", "八卦新闻",
]

# 震惊体 / 标题党
SENSATIONAL_TERMS = ["震惊", "必看", "不看后悔", "惊人", "吓尿", "速看", "紧急"]

# 诱导结尾词（微信违规风险）
INDUCEMENT_TERMS = ["点在看", "点亮在看", "转发朋友圈", "点赞转发", "求点赞", "求转发"]

PASS_SCORE = 80


class GateResult:
    def __init__(self) -> None:
        self.passed = True
        self.errors: list[str] = []
        self.notes: list[str] = []

    def gate(self, ok: bool, msg: str) -> None:
        if ok:
            self.notes.append(f"  OK  {msg}")
        else:
            self.passed = False
            self.errors.append(msg)
            self.notes.append(f"FAIL  {msg}")


def strip_html(html: str) -> str:
    """简单去掉 HTML 标签，供复盘 HTML 正文做文本检查。"""
    text = re.sub(r"<script\b[^>]*>.*?</script>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text)


def check_text(text: str, *, title: str = "") -> GateResult:
    """对纯文本做标签垂直度检查。

    Args:
        text: 文章正文（HTML 会被调用方先 strip，或传纯文本）。
        title: 标题，可选；传入时额外检查核心词前置与震惊体。
    Returns:
        GateResult，.passed 为 False 时应阻止发布。
    """
    r = GateResult()

    # 1) 前 300 字核心词（系统据此识别账号领域）
    first300 = text[:300]
    first_hits = sum(first300.count(t) for t in CORE_TERMS)
    r.gate(first_hits >= 3, f"前300字核心领域词 {first_hits} 次（要求 ≥3）")

    # 2) 全文核心词密度
    total_hits = sum(text.count(t) for t in CORE_TERMS)
    r.gate(total_hits >= 8, f"全文核心词 {total_hits} 次（要求 ≥8）")

    # 3) 无关领域词污染
    off = {t: text.count(t) for t in OFF_TOPIC_TERMS if t in text}
    r.gate(not off, f"无关领域词污染：{off}" if off else "无无关领域词污染")

    # 4) 震惊体标题党
    sens = [t for t in SENSATIONAL_TERMS if t in title]
    r.gate(not sens, f"标题含震惊体：{sens}" if sens else "标题无震惊体")

    # 5) 标题核心词前置
    if title:
        head_hits = sum(title[:12].count(t) for t in CORE_TERMS)
        r.gate(head_hits >= 1, f"标题前12字核心词 {head_hits} 次（要求 ≥1）")

    # 6) 诱导结尾词
    inducement = [t for t in INDUCEMENT_TERMS if t in text]
    r.gate(not inducement, f"含诱导结尾词：{inducement}" if inducement else "无诱导结尾词")

    return r

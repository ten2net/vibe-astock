"""平台适配层：把交易日复盘改写成「导流到公众号揽宝投研」的社媒图文包。

设计约束（母版不动）：
- 不修改 ``social_publish.py`` 的核心分发逻辑，也不改 ``emotion_card.py`` 的卡片契约。
- 本模块只被 ``social_publish.py`` / ``scripts/social_daily.py`` 挂载调用。
- 文案统一走「克制正确版」：不承诺收益、不用违规营销词、不放任何 URL/二维码文字。
- 第三道合规门禁 ``lead_gate()`` 在现有「产品政策 + 公开文本」两道闸之上追加。

平台定位：
- 雪球（xueqiu）：主阵地，文案带数据口径，语气克制专业。
- 东财股吧（dongfang）：流量入口，标题更短更口语。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from . import emotion_card as ec
from .blog_publish import DISCLAIMER
from .product_policy import has_trade_recommendation

if TYPE_CHECKING:  # 仅类型提示，避免运行时循环导入
    pass

# 两个导流平台
LEAD_PLATFORMS = ("xueqiu", "dongfang")

# 克制版导流固定句（不得出现在门禁扫描的「可违规」部分，故 lead_gate 会剔除）
LEAD_SLOGAN = "完整复盘与数据口径见公众号：揽宝投研"

# 违规营销词（用户选「克制正确版」：不承诺收益、不催单、不引导私域交易）
_BAD_MARKETING = re.compile(
    r"稳赚|跟单|内部消息|包赚|收益保证|保证收益|必涨|翻倍|"
    r"限时|名额|加群|私聊|进群|加微信|扫码加|免费领|带你赚",
    re.IGNORECASE,
)
# 文案内禁止出现 URL 与「二维码 / 扫码」字样（二维码只在卡片图上，不在文案里）
_URL_RE = re.compile(r"https?://|www\.|\.com/|\.cn/|/go/|二维码|扫码|扫一扫", re.IGNORECASE)


@dataclass(frozen=True)
class LeadCaption:
    """与 ``social_publish.Caption`` 同形（duck typing），避免循环导入。"""

    platform: str
    text: str
    go_url: str = ""  # 导流文案不放任何 URL，恒为空


def build_lead_caption(platform: str, metrics: ec.CardMetrics) -> LeadCaption:
    """生成导流文案：日期 + 档位 + 三读数 + 口径 + 克制导流句 + 免责 + 话题标签。

    - 雪球：主阵地，带数据口径说明，语气克制专业。
    - 东财股吧：流量入口，开头更短更口语，便于信息流里抓眼球。
    文案**不含任何 URL**（二维码在卡片图上）。
    """
    if platform not in LEAD_PLATFORMS:
        raise ValueError(f"非导流平台：{platform!r}")

    head = f"{metrics.date} A股情绪档位：{metrics.phase}"
    stats = (f"涨停 {metrics.limit_up} 家 · 晋级率 {metrics.promote_rate} · "
             f"炸板率 {metrics.broken_rate}")

    if platform == "xueqiu":
        text = (
            f"{head}\n\n"
            f"当日读数\n{stats}\n\n"
            f"数据来源：公开榜单与程序统计。\n"
            f"情绪档位是分析框架，非客观事实。\n\n"
            f"{LEAD_SLOGAN}。\n\n"
            f"{DISCLAIMER}\n\n"
            f"#A股复盘 #情绪周期 #数据复盘"
        )
    else:  # dongfang（财富号/股吧）—— 按财富号发文规范整改，禁止任何导流
        # 财富号《发文规范（修订版）》2.1：禁止二维码、个人微信/QQ、变种文字、公众号
        # 水印图片、营销推广信息。故东财文案**不含** LEAD_SLOGAN，只做纯数据复盘。
        text = (
            f"{head}\n"
            f"{stats}\n"
            f"（公开数据，仅供复盘参考）\n\n"
            f"{DISCLAIMER}\n\n"
            f"#A股 #复盘 #情绪周期"
        )
    return LeadCaption(platform=platform, text=text, go_url="")


def lead_gate(text: str) -> bool:
    """第三道合规闸：剔除免责声明与固定导流句后，检查荐股与违规营销。

    返回 ``True`` 表示通过；``False`` 表示拦截。
    ``has_trade_recommendation(DISCLAIMER)`` 会命中产品口径词，故先剔除再扫
    （沿用 ``social_publish.compliance_ok`` 的已有技巧）。
    """
    scan = text.replace(DISCLAIMER, "").replace(LEAD_SLOGAN, "")
    scan = re.sub(r"#\S+", "", scan)  # 话题标签不参与违规扫描
    if has_trade_recommendation(scan):
        return False
    if _BAD_MARKETING.search(scan):
        return False
    if _URL_RE.search(scan):
        return False
    return True


# 财富号《发文规范（修订版）》2.1 禁止的导流/推广表达：
# 二维码、个人微信/QQ、变种文字（威信/薇信/微^信`公`众`号）、公众号/头条号、
# 外部网址、营销意图（回复xx获得xx）、APP/网站推广、购物/网盘链接。
_EASTMONEY_BANNED = re.compile(
    r"公众号|微信|薇信|威信|微\s*[\^`·]?\s*信|公众\s*号|头条号|"
    r"二维码|扫码|扫一扫|加群|进群|个人微信|QQ群|电话|"
    r"回复.{0,8}(获得|领取|获取)|外部网址|网址|链接|"
    r"APP下载|下载.{0,6}APP|购物链接|网盘|推广|广告",
    re.IGNORECASE,
)


def eastmoney_gate(text: str) -> bool:
    """财富号合规门禁：按《发文规范（修订版）》2.1 拦截导流/推广表达。

    返回 ``True`` 表示通过；``False`` 表示含违规导流内容。
    在 ``lead_gate`` 之外单独生效，专用于东财平台（财富号禁止任何公众号导流）。
    """
    scan = text.replace(DISCLAIMER, "")
    scan = re.sub(r"#\S+", "", scan)  # 话题标签不参与扫描
    if _EASTMONEY_BANNED.search(scan):
        return False
    if _URL_RE.search(scan):
        return False
    return True


def default_qr_path() -> Path:
    """公众号二维码静态图：复用博客文章引导卡用的 ``blog/static/img/lanbao.png``。"""
    root = Path(__file__).resolve().parents[1]
    return root / "blog" / "static" / "img" / "lanbao.png"


def render_lead_card_horizontal(metrics: ec.CardMetrics, out_path: Path | str) -> Path:
    """画一张 1200×630 横版导流图（雪球长文正文配图）：**无二维码**。

    雪球长文编辑器对带二维码的营销图敏感（可能拒绝上传），且竖版 1080×1350
    在正文里会被截断。故长文配图用横版 OG 比例（1200×630），画面只留品牌、
    档位、三读数与导流文字「完整复盘见公众号：揽宝投研」，不放二维码。
    """
    from PIL import Image, ImageDraw

    font_big = ec._load_font(120, bold=True)
    font_title = ec._load_font(30, bold=True)
    font_label = ec._load_font(24, bold=False)
    font_value = ec._load_font(54, bold=True)
    font_note = ec._load_font(19, bold=False)
    font_disclaimer = ec._load_font(17, bold=False)
    font_cta = ec._load_font(30, bold=True)

    img = ec._gradient((ec.WIDTH, ec.HEIGHT))
    d = ImageDraw.Draw(img)
    pad = 64

    d.text((pad, 40), "揽宝.复盘", font=font_title, fill=ec.ACCENT)
    tw = d.textlength(metrics.date, font=font_label)
    d.text((ec.WIDTH - pad - tw, 46), metrics.date, font=font_label, fill=ec.LABEL_COLOR)
    d.line([(pad, 92), (ec.WIDTH - pad, 92)], fill=ec.ACCENT, width=3)

    d.text((pad, 126), "情绪档位", font=font_label, fill=ec.LABEL_COLOR)
    d.text((pad, 158), metrics.phase, font=font_big, fill=ec.PHASE_COLOR)
    d.text((ec.WIDTH - pad - 210, 250), "分析框架 · 非客观事实",
           font=font_note, fill=ec.NOTE_COLOR)

    cards = [
        ("涨停家数", metrics.limit_up, "当日涨停池样本"),
        ("晋级率", metrics.promote_rate, "昨日涨停 → 今日"),
        ("炸板率", metrics.broken_rate, "封板质量口径"),
    ]
    top, gap = 350, 24
    card_w = (ec.WIDTH - 2 * pad - 2 * gap) // 3
    card_h = 150
    for i, (label, value, sub) in enumerate(cards):
        x0 = pad + i * (card_w + gap)
        d.rounded_rectangle([(x0, top), (x0 + card_w, top + card_h)],
                            radius=16, fill=ec.CARD_BG)
        d.text((x0 + 22, top + 16), label, font=font_label, fill=ec.LABEL_COLOR)
        d.text((x0 + 22, top + 50), value, font=font_value, fill=ec.VALUE_COLOR)
        d.text((x0 + 22, top + 116), sub, font=font_note, fill=ec.NOTE_COLOR)

    # 底部导流文字（无二维码、无 URL）：只给公众号名，读者自行搜索关注
    d.text((pad, 528), "完整复盘见公众号：揽宝投研", font=font_cta, fill=ec.ACCENT)
    d.text((pad, 568), "公开数据整理 · 不构成投资建议", font=font_note, fill=ec.NOTE_COLOR)

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    return out


# 雪球长文封面显示区实测 840×336（约 2.5:1 扁横版），横版 OG 图在这会被上下裁。
COVER_W, COVER_H = 840, 336


def render_lead_cover(metrics: ec.CardMetrics, out_path: Path | str,
                      *, with_qr: bool = False,
                      qr_path: Path | str | None = None) -> Path:
    """画雪球长文封面图 840×336（扁横版，适配长文封面裁切区）。

    ``with_qr=False``：右侧放导流文字（安全版，规避二维码营销图拒传）；
    ``with_qr=True``：右侧放公众号二维码（转化短，但可能被平台拒传）。
    两版都由调用方生成，用户上传时按实际可用情况选。
    """
    from PIL import Image, ImageDraw

    font_title = ec._load_font(22, bold=True)
    font_label = ec._load_font(16, bold=False)
    font_phase = ec._load_font(54, bold=True)
    font_value = ec._load_font(28, bold=True)
    font_note = ec._load_font(14, bold=False)
    font_cta = ec._load_font(20, bold=True)

    img = ec._gradient((COVER_W, COVER_H))
    d = ImageDraw.Draw(img)
    pad = 28

    d.text((pad, 20), "揽宝.复盘", font=font_title, fill=ec.ACCENT)
    tw = d.textlength(metrics.date, font=font_label)
    d.text((COVER_W - pad - tw, 24), metrics.date, font=font_label, fill=ec.LABEL_COLOR)
    d.line([(pad, 58), (COVER_W - pad, 58)], fill=ec.ACCENT, width=2)

    # 左：档位 + 三读数（紧凑横排）
    d.text((pad, 78), "情绪档位", font=font_label, fill=ec.LABEL_COLOR)
    d.text((pad, 104), metrics.phase, font=font_phase, fill=ec.PHASE_COLOR)
    readings = [("涨停", metrics.limit_up), ("晋级率", metrics.promote_rate),
                ("炸板率", metrics.broken_rate)]
    x = pad
    for label, value in readings:
        d.text((x, 200), label, font=font_label, fill=ec.LABEL_COLOR)
        d.text((x, 224), value, font=font_value, fill=ec.VALUE_COLOR)
        x += 150

    # 右：二维码版或纯文字版
    right_x = COVER_W - pad - 150
    if with_qr:
        qr_file = Path(qr_path) if qr_path is not None else default_qr_path()
        if qr_file.is_file():
            with Image.open(qr_file) as raw:
                qr_img = raw.convert("RGB").resize((132, 132))
            img.paste(qr_img, (right_x + 8, 92))
            d = ImageDraw.Draw(img)
            d.text((right_x, 230), "扫码关注", font=font_cta, fill=ec.ACCENT)
            d.text((right_x, 260), "揽宝投研", font=font_note, fill=ec.LABEL_COLOR)
    else:
        d.text((right_x, 120), "完整复盘", font=font_cta, fill=ec.ACCENT)
        d.text((right_x, 152), "见公众号", font=font_cta, fill=ec.ACCENT)
        d.text((right_x, 184), "揽宝投研", font=font_title, fill=ec.VALUE_COLOR)
        d.text((right_x, 224), "公开数据整理", font=font_note, fill=ec.NOTE_COLOR)

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    return out


def render_lead_card(metrics: ec.CardMetrics, out_path: Path | str,
                     *, qr_path: Path | str | None = None) -> Path:
    """画一张 1080×1350 导流竖卡：版式同 ``emotion_card`` 竖版，底部换公众号二维码。

    不修改 ``emotion_card.render_card_vertical`` 的绘图逻辑与产物契约；本函数独立
    复用其私有字体/底色/折行工具，只把底部 CTA 从「扫码看全文（博客短链）」换成
    「扫码关注公众号 · 揽宝投研」。缺字体/Pillow 等增强项失败照常抛 CardError，
    由调用方按现有降级策略记 log 并跳过。
    """
    from PIL import Image, ImageDraw

    qr = Path(qr_path) if qr_path is not None else default_qr_path()

    font_big = ec._load_font(140, bold=True)
    font_title = ec._load_font(38, bold=True)
    font_label = ec._load_font(30, bold=False)
    font_value = ec._load_font(62, bold=True)
    font_note = ec._load_font(24, bold=False)
    font_disclaimer = ec._load_font(20, bold=False)
    font_cta = ec._load_font(34, bold=True)

    img = ec._gradient((ec.V_WIDTH, ec.V_HEIGHT))
    d = ImageDraw.Draw(img)
    pad = 72

    d.text((pad, 56), "揽宝.复盘", font=font_title, fill=ec.ACCENT)
    tw = d.textlength(metrics.date, font=font_label)
    d.text((ec.V_WIDTH - pad - tw, 64), metrics.date, font=font_label, fill=ec.LABEL_COLOR)
    d.line([(pad, 130), (ec.V_WIDTH - pad, 130)], fill=ec.ACCENT, width=4)

    d.text((pad, 176), "情绪档位", font=font_label, fill=ec.LABEL_COLOR)
    d.text((pad, 226), metrics.phase, font=font_big, fill=ec.PHASE_COLOR)
    d.text((pad, 420), "分析框架 · 非客观事实", font=font_note, fill=ec.NOTE_COLOR)

    cards = [
        ("涨停家数", metrics.limit_up, "当日涨停池样本"),
        ("晋级率", metrics.promote_rate, "昨日涨停 → 今日"),
        ("炸板率", metrics.broken_rate, "封板质量口径"),
    ]
    top, card_h, gap = 468, 164, 11
    for i, (label, value, sub) in enumerate(cards):
        y0 = top + i * (card_h + gap)
        d.rounded_rectangle([(pad, y0), (ec.V_WIDTH - pad, y0 + card_h)],
                            radius=20, fill=ec.CARD_BG)
        d.text((pad + 32, y0 + 12), label, font=font_label, fill=ec.LABEL_COLOR)
        d.text((pad + 32, y0 + 50), value, font=font_value, fill=ec.VALUE_COLOR)
        d.text((pad + 32, y0 + 128), sub, font=font_note, fill=ec.NOTE_COLOR)

    # 底部：公众号二维码 + 克制 CTA
    cta_y = 1040
    qr_size = 196
    qr_img = None
    if qr.is_file():
        with Image.open(qr) as raw:
            qr_img = raw.convert("RGB").resize((qr_size, qr_size))
    text_x = pad
    text_w = ec.V_WIDTH - 2 * pad - (qr_size + 24 if qr_img is not None else 0)
    d.text((text_x, cta_y + 8), "扫码关注公众号", font=font_cta, fill=ec.ACCENT)
    d.text((text_x, cta_y + 56), "揽宝投研", font=font_title, fill=ec.VALUE_COLOR)
    d.text((text_x, cta_y + 108), "每日A股情绪复盘 · 完整数据与口径",
           font=font_note, fill=ec.LABEL_COLOR)
    if qr_img is not None:
        img.paste(qr_img, (ec.V_WIDTH - pad - qr_size, cta_y - 4))
        d = ImageDraw.Draw(img)  # paste 后重建 draw

    lines = ec._wrap(d, DISCLAIMER, font_disclaimer, ec.V_WIDTH - 2 * pad)[:2]
    y = ec.V_HEIGHT - 30 - len(lines) * 28
    for ln in lines:
        d.text((pad, y), ln, font=font_disclaimer, fill=ec.DISCLAIMER_COLOR)
        y += 28

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    return out


def render_eastmoney_card(metrics: ec.CardMetrics, out_path: Path | str) -> Path:
    """东财（财富号）合规竖版配图：无二维码、无公众号/微信字样、无外链。

    财富号《发文规范（修订版）》2.1 禁止二维码、公众号水印图片与推广信息，
    故本图只保留品牌、档位、三读数、数据来源与免责声明，不携带任何导流元素。
    """
    from PIL import Image, ImageDraw

    font_big = ec._load_font(140, bold=True)
    font_title = ec._load_font(38, bold=True)
    font_label = ec._load_font(30, bold=False)
    font_value = ec._load_font(62, bold=True)
    font_note = ec._load_font(24, bold=False)
    font_disclaimer = ec._load_font(20, bold=False)

    img = ec._gradient((ec.V_WIDTH, ec.V_HEIGHT))
    d = ImageDraw.Draw(img)
    pad = 72

    d.text((pad, 56), "揽宝.复盘", font=font_title, fill=ec.ACCENT)
    tw = d.textlength(metrics.date, font=font_label)
    d.text((ec.V_WIDTH - pad - tw, 64), metrics.date, font=font_label, fill=ec.LABEL_COLOR)
    d.line([(pad, 130), (ec.V_WIDTH - pad, 130)], fill=ec.ACCENT, width=4)

    d.text((pad, 176), "情绪档位", font=font_label, fill=ec.LABEL_COLOR)
    d.text((pad, 226), metrics.phase, font=font_big, fill=ec.PHASE_COLOR)
    d.text((pad, 420), "分析框架 · 非客观事实", font=font_note, fill=ec.NOTE_COLOR)

    cards = [
        ("涨停家数", metrics.limit_up, "当日涨停池样本"),
        ("晋级率", metrics.promote_rate, "昨日涨停 → 今日"),
        ("炸板率", metrics.broken_rate, "封板质量口径"),
    ]
    top, card_h, gap = 468, 164, 11
    for i, (label, value, sub) in enumerate(cards):
        y0 = top + i * (card_h + gap)
        d.rounded_rectangle([(pad, y0), (ec.V_WIDTH - pad, y0 + card_h)],
                            radius=20, fill=ec.CARD_BG)
        d.text((pad + 32, y0 + 12), label, font=font_label, fill=ec.LABEL_COLOR)
        d.text((pad + 32, y0 + 50), value, font=font_value, fill=ec.VALUE_COLOR)
        d.text((pad + 32, y0 + 128), sub, font=font_note, fill=ec.NOTE_COLOR)

    # 底部：仅品牌落款与数据口径，无二维码/无公众号/无 CTA
    d.line([(pad, 1040), (ec.V_WIDTH - pad, 1040)], fill=ec.ACCENT, width=3)
    d.text((pad, 1070), "揽宝.复盘 · 每日 A 股情绪复盘", font=font_title, fill=ec.ACCENT)
    d.text((pad, 1122), "数据来源：公开榜单与程序统计", font=font_note, fill=ec.LABEL_COLOR)

    lines = ec._wrap(d, DISCLAIMER, font_disclaimer, ec.V_WIDTH - 2 * pad)[:2]
    y = ec.V_HEIGHT - 30 - len(lines) * 28
    for ln in lines:
        d.text((pad, y), ln, font=font_disclaimer, fill=ec.DISCLAIMER_COLOR)
        y += 28

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    return out

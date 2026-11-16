"""「长期拉关注」贴图：一张含蓄的竖版长图 + 同文案的公众号图文正文。

用途：微信公众号订阅号在攒够关注、开通受限功能之前，放一篇**长期**图文，
被转发、置顶或做被关注自动回复都合适。刻意不喊「求关注」、不提关注数门槛——
只讲清楚「这里只是入口，真正的图文版和系统点『阅读原文』能到」，靠价值留人。

两处共用同一份文案（``COPY``），避免 PNG 与文章 HTML 各写一套、日后改出偏差：
- ``render_poster_png``：纯 Pillow 竖版长图，复用 emotion_card 的字体/渐变/折行。
- ``article_html``：公众号图文正文（短引导 + <img> 贴贴图 + 文末阅读原文引导）。

产品政策：``COPY`` 不荐股、不预测、不承诺收益、不写做不到的「回关」功能承诺；
「不一定让你立马赚钱，但一定不会让你稀里糊涂亏钱」是**认知**表述而非收益承诺。
``check_public_text`` 之外，这里再对整段文案跑一次 has_trade_recommendation 自检。
"""
from __future__ import annotations

import html
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .product_policy import has_trade_recommendation

# ---------------------------------------------------------------- 文案（单一来源）
# 主题含蓄：不露骨拉新，用「这里只是个入口」「不稀里糊涂」做文眼。
BRAND = "揽宝.复盘"
READ_ORIGINAL_URL = "https://a2.luckybrother.cc"   # 揽宝系统线上入口（VRA_PUBLIC_URL）


@dataclass(frozen=True)
class Copy:
    title: str            # 公众号文章标题
    digest: str           # 摘要
    kicker: str           # 贴图眉标
    headline: list[str]   # 主标语（分行）
    paragraphs: list[tuple[str, list[str]]]   # (小标题, 若干行)
    punch: list[str]      # 文眼
    closing: list[str]    # 抱团/回关态度（含蓄、做得到）
    signoff: str
    footnote: str


COPY = Copy(
    title="这里只是个入口",
    digest="盘面数据、复盘，还有那套能自己点开核对的系统，都在门后面。慢慢来，一起看得清楚些。",
    kicker=f"{BRAND} · 写给在场上、和还没进场的人",
    headline=["这里地方小，", "装不下所有想说的话。"],
    paragraphs=[
        ("关于这个入口", [
            "公众号能放下的有限，更多时候，它只是个入口。",
            "排版、图表、能逐项展开的数据，都被折进了短短几行里。",
            "想看表现力更友好、能顺着图表对照的图文版本，",
            "点文章末尾左下角的「阅读原文」，门就在那里。",
        ]),
        ("如果你也是股民", [
            "这里的每日复盘、后端的博客，",
            "还有那套能自己点开、逐项核对的揽宝系统，",
            "大概率会是你盘后愿意多留十分钟的地方。",
            "不替你做决定，只把公开的数据和口径摊开。",
        ]),
        ("如果你还不是股民", [
            "也不必急着划走。",
            "若身边有在场上、常常看得一头雾水的亲友，",
            "把这里递给他看看就好。",
        ]),
    ],
    punch=["揽宝不一定会让你立马赚钱，", "但一定不会让你稀里糊涂地亏钱。", "看得清，比走得快更要紧。"],
    closing=[
        "一路走来，每一位愿意留下的人，我都认真记着。",
        "留言我会看，能回的都回；",
        "往后日子长，我们抱团，把盘面一点一点看清楚。",
    ],
    signoff=f"{BRAND} · 数字由程序核对",
    # 与全站 DISCLAIMER 同口径；但不用「不推荐个股」字面——政策正则
    # 「推荐.{0,12}(个股|标的)」不看「不」字会误伤，故用「只客观呈现」表达同义。
    footnote=("只客观呈现公开数据与榜单，不预测涨跌、不构成投资建议。"
              "模型输出可能出错，请沿证据链自行核实并独立决策，风险自担。"),
)


def _all_text() -> str:
    parts = [COPY.title, COPY.digest, COPY.kicker, *COPY.headline]
    for h, lines in COPY.paragraphs:
        parts.append(h)
        parts.extend(lines)
    parts.extend([*COPY.punch, *COPY.closing, COPY.signoff, COPY.footnote])
    return "\n".join(parts)


class PosterError(RuntimeError):
    """文案越过产品政策，或字体/绘图库不可用。"""


def check_copy() -> None:
    """公开前自检：整段文案不得含交易建议/收益承诺类的硬越界。"""
    if has_trade_recommendation(_all_text()):
        raise PosterError("贴图文案命中不荐股规则，请改写后再发布")


# ---------------------------------------------------------------- 竖版 PNG 贴图
# 竖版长图：手机信息流/被关注回复里读得舒服。品牌暗底 + 暖橙，呼应情绪卡片。
P_WIDTH, P_HEIGHT = 1080, 1920
_PAD = 80

# 复用 emotion_card 的暗底渐变与配色（不重复定义一套）
from .emotion_card import (  # noqa: E402  放在文案后，避免模块级循环导入顾虑
    _load_font, _gradient, _wrap,
    ACCENT, PHASE_COLOR, LABEL_COLOR, CARD_BG, NOTE_COLOR, DISCLAIMER_COLOR,
)


def render_poster_png(out_path: Path | str, *,
                      log: Callable[[str], None] = lambda _m: None) -> Path:
    """画一张 1080×1920 竖版贴图，写入 out_path 并返回路径。"""
    from PIL import Image, ImageDraw

    check_copy()

    f_kicker = _load_font(26, bold=False)
    f_head = _load_font(64, bold=True)
    f_h = _load_font(30, bold=True)
    f_body = _load_font(31, bold=False)
    f_punch = _load_font(42, bold=True)
    f_sign = _load_font(24, bold=False)
    f_foot = _load_font(20, bold=False)

    img = _gradient((P_WIDTH, P_HEIGHT))
    d = ImageDraw.Draw(img)
    x = _PAD
    max_w = P_WIDTH - 2 * _PAD

    # 顶部：品牌 + 眉标
    d.text((x, 70), BRAND, font=f_h, fill=ACCENT)
    d.text((x, 122), COPY.kicker, font=f_kicker, fill=LABEL_COLOR)
    d.line([(x, 178), (P_WIDTH - x, 178)], fill=ACCENT, width=3)

    y = 226
    # 主标语
    for ln in COPY.headline:
        d.text((x, y), ln, font=f_head, fill=PHASE_COLOR)
        y += 86

    y += 30
    # 正文分段：小标题 + 折行正文
    for h, lines in COPY.paragraphs:
        d.text((x, y), h, font=f_h, fill=ACCENT)
        y += 56
        for ln in lines:
            wrapped = _wrap(d, ln, f_body, max_w)
            for w in wrapped:
                d.text((x, y), w, font=f_body, fill=PHASE_COLOR)
                y += 48
        y += 34

    # 文眼：暖橙卡片强调（含蓄，不喊关注）。高度留足上下 padding，
    # 别让最后一行贴着卡片下边缘。
    line_h = 70
    punch_h = 40 + 52 + len(COPY.punch) * line_h + 44   # 上留白 + 标题 + 正文 + 下留白
    d.rounded_rectangle([(x - 20, y - 10), (P_WIDTH - x + 20, y - 10 + punch_h)],
                        radius=20, fill=CARD_BG)
    d.text((x + 12, y + 26), "想说的其实只有一句", font=f_h, fill=ACCENT)
    yy = y + 26 + 52
    for ln in COPY.punch:
        for w in _wrap(d, ln, f_punch, max_w - 24):
            d.text((x + 12, yy), w, font=f_punch, fill=PHASE_COLOR)
            yy += line_h
    y = y - 10 + punch_h + 46

    # 抱团/回关态度
    for ln in COPY.closing:
        for w in _wrap(d, ln, f_body, max_w):
            d.text((x, y), w, font=f_body, fill=LABEL_COLOR)
            y += 48
    y += 24

    # 落款 + 脚注
    d.line([(x, y), (P_WIDTH - x, y)], fill=NOTE_COLOR, width=2)
    y += 28
    d.text((x, y), COPY.signoff, font=f_sign, fill=ACCENT)
    y += 44
    for ln in _wrap(d, COPY.footnote, f_foot, max_w)[:2]:
        d.text((x, y), ln, font=f_foot, fill=DISCLAIMER_COLOR)
        y += 30

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    log(f"贴图已生成：{out}（{P_WIDTH}×{P_HEIGHT}）")
    return out


# ---------------------------------------------------------------- 横版头图（草稿封面）
# 微信头条封面按 2.35:1（1080×460）展示。统一用仓库里的专属头图素材
# （assets/头图1.jpg，1800×766 正好 2.35:1），不再用 Pillow 另画一张通用图，
# 避免公众号里同时存在两种风格不一致的头图。
H_WIDTH, H_HEIGHT = 1080, 460
HEADER_ASSET = Path(__file__).resolve().parents[1] / "assets" / "头图1.jpg"


def render_header_png(out_path: Path | str, *,
                      log: Callable[[str], None] = lambda _m: None) -> Path:
    """取统一头图素材，等比缩放到 1080×460 并写成 PNG，返回路径。

    输出契约不变（PNG、1080×460），但内容来自 ``HEADER_ASSET`` 这张专属设计图，
    而不是临时画的通用图。素材缺失时抛 PosterError，不静默回退到旧样式。
    """
    from PIL import Image

    if not HEADER_ASSET.is_file():
        raise PosterError(f"头图素材不存在：{HEADER_ASSET}")
    with Image.open(HEADER_ASSET) as src:
        src.load()
        img = src.convert("RGB").resize((H_WIDTH, H_HEIGHT), Image.LANCZOS)

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    log(f"头图已生成：{out}（{H_WIDTH}×{H_HEIGHT}，源 {HEADER_ASSET.name}）")
    return out


# ---------------------------------------------------------------- 公众号图文正文
def _esc(t: str) -> str:
    return html.escape(t)


def article_html(*, image_url: str = "") -> str:
    """公众号图文正文：短引导 + <img> 贴贴图 + 文末「阅读原文」醒目引导。

    ``image_url`` 由 uploadimg 接口换得（微信正文 <img> 只认自家 URL）。
    贴图已经承载了几乎全部文案，正文只做轻量串联与合规兜底，避免手机端重复阅读。
    """
    check_copy()
    out: list[str] = []

    s_lead = "margin:0 0 18px;padding:14px 16px;background:#10151d;border-radius:8px;"
    s_lead_t = "margin:0;font-size:18px;font-weight:bold;color:#f0d78c;"
    s_p = "margin:0 0 14px;font-size:15px;color:#1d2129;line-height:1.8;"
    s_muted = "margin:0 0 14px;font-size:13px;color:#86909c;line-height:1.7;"
    s_cta = ("margin:22px 0 14px;padding:16px;background:#fff8e6;"
             "border-left:5px solid #f08c00;border-radius:6px;")
    s_cta_t = "margin:0 0 10px;font-size:16px;font-weight:bold;color:#c96a00;line-height:1.5;"
    s_cta_p = "margin:0 0 8px;font-size:14px;color:#5c4300;line-height:1.75;"

    out.append(f'<section style="{s_lead}"><p style="{s_lead_t}">{_esc(COPY.title)}</p></section>')
    out.append(f'<p style="{s_p}">{_esc(COPY.digest)}</p>')

    if image_url:
        # 微信会剥 class，图片用内联样式 + 宽度 100%
        out.append(f'<p style="margin:0 0 18px;text-align:center;">'
                   f'<img src="{_esc(image_url)}" style="max-width:100%;height:auto;'
                   f'display:block;margin:0 auto;" alt="{_esc(BRAND)} 贴图"/></p>')

    # 正文只放最必要的三句，其余都在贴图里
    out.append(f'<p style="{s_p}">公众号能放下的有限，这里更多时候只是个入口。'
               f'排版、图表、能逐项展开的数据，都被折进了短短几行。</p>')

    # 醒目「阅读原文」引导（与每日复盘文末同款卡片，指向揽宝系统）
    out.append(f'<section style="{s_cta}">')
    out.append(f'<p style="{s_cta_t}">点左下角「阅读原文」，看更友好的图文版 →</p>')
    out.append(f'<p style="{s_cta_p}">揽宝系统的交互式复盘工作台：盘中情绪路径、多空对照、'
               f'个股深挖、历史回测与交易日志，条件自己点、数据自己核对。</p>')
    out.append(f'<p style="{s_cta_p}">（看不到入口时，向下滑到文章最底部，点「阅读原文」即可。）</p>')
    out.append("</section>")

    out.append(f'<p style="{s_muted}">{_esc(COPY.signoff)}</p>')
    out.append(f'<p style="{s_muted}">{_esc(COPY.footnote)}</p>')
    return "\n".join(out)

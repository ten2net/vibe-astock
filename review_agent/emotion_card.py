"""情绪卡片图生成器 —— 把每日复盘的情绪档位与三个读数渲染成 1200×630 PNG。

用途：社交平台分享头图（OG image）。每篇复盘一张 ``<date>.png``，另出一张
``latest.png`` 作首页/默认分享图。产物落在 ``blog/static/cards/``（Hugo staticDir，
构建时原样拷到 public/cards/ → 线上 ``/cards/<date>.png``）。

数据来源：本机 ``~/.duanxian-agents/reviews/YYYY-MM-DD.json``（可用 --reviews 覆盖）。
字段（与 review_agent/blog_publish.py 的读数口径一致）：
- 情绪档位：``focus.emotion_phase``（字符串，如「退潮」）
- 涨停家数：``emotion_metrics.promotion.limit_up_count``（int）
- 晋级率  ：``emotion_metrics.promotion.overall.rate``（0~1 小数，×100 显示）
- 炸板率  ：``market_facts.seal_quality.broken_rate``（0~1 小数，×100 显示）

设计约束：
- **纯 Pillow**，不启浏览器、不联网；字体统一用 Noto Sans CJK **SC**（TTC index=2，
  实测 DroidSansFallbackFull.ttf 缺 ASCII 数字与 · → 的字形会画成豆腐块）。
  缺字体/缺 Pillow 时 ``generate()`` 记 log 并跳过（这是增强项，不能让整篇复盘发布失败）。
- 数据缺失写「—」（不写 0、不编造），字段类型异常一律降级为「—」。
- 免责声明照抄 blog_publish.DISCLAIMER 的口径（这里独立定义一份，避免模块级循环导入：
  blog_publish.publish 会在函数内 import 本模块来触发生成）。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

WIDTH, HEIGHT = 1200, 630           # 横版：社交平台 OG 标准尺寸（链接预览用）
V_WIDTH, V_HEIGHT = 1080, 1350      # 竖版：手机信息流发图（X/TG/雪球）

# 免责声明（口径同 blog_publish.DISCLAIMER）
DISCLAIMER = (
    "揽宝投研 只客观呈现公开数据与榜单，不推荐个股、不预测涨跌、不构成投资建议。"
    "模型输出可能出错，请沿证据链自行核实并独立决策，风险自担。"
)

# 系统字体候选：(路径, ttc index)。统一用 Noto Sans CJK **SC（index=2）**：
# 实测 DroidSansFallbackFull.ttf 对 ASCII 数字、"·"、"→" 缺字形，会画成豆腐块
# （日期 2026-11-06 变成 □□□□□□□□□□）。Noto CJK SC 覆盖中文/数字/标点/箭头。
_BOLD_CANDIDATES = [
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc", 2),
]
_REGULAR_CANDIDATES = [
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2),  # 缺 Regular 时用 Bold
]

# 配色（暗底 + 暖橙强调，呼应前端 --primary）
BG_TOP = (18, 20, 28)
BG_BOTTOM = (30, 26, 34)
ACCENT = (245, 124, 43)       # 暖橙
PHASE_COLOR = (255, 255, 255)
LABEL_COLOR = (168, 172, 186)
VALUE_COLOR = (255, 255, 255)
CARD_BG = (42, 44, 56)
NOTE_COLOR = (140, 145, 160)
DISCLAIMER_COLOR = (120, 124, 138)


class CardError(RuntimeError):
    """字体/绘图库不可用等可预期的失败。"""


@dataclass(frozen=True)
class CardMetrics:
    date: str
    phase: str
    limit_up: str       # 已格式化的展示值
    promote_rate: str
    broken_rate: str


# ---------------------------------------------------------------- 数据抽取

def _pct(v, digits: int = 1) -> str:
    """0~1 小数 → 百分数字符串；非数字写「—」。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "—"
    return f"{v * 100:.{digits}f}%"


def _count(v) -> str:
    if isinstance(v, bool) or not isinstance(v, int):
        return "—"
    return str(v)


def extract_metrics(payload: dict, date: str) -> CardMetrics:
    """从复盘 json 抽四个展示值。任何字段缺失/类型异常都降级为「—」，不抛错。"""
    focus = payload.get("focus") or {}
    em = payload.get("emotion_metrics") or {}
    mf = payload.get("market_facts") or {}
    promo = em.get("promotion") or {}
    overall = promo.get("overall") or {}
    seal = mf.get("seal_quality") or {}

    phase = focus.get("emotion_phase")
    # 档位大字：只接受非空字符串，避免把字典/数字画上去
    phase_s = phase.strip() if isinstance(phase, str) and phase.strip() else "—"

    limit = _count(promo.get("limit_up_count"))
    # 有些日期 promotion 里没有 limit_up_count，用 seal_quality.total 兜底
    if limit == "—":
        limit = _count(seal.get("total"))

    return CardMetrics(
        date=date,
        phase=phase_s,
        limit_up=limit,
        promote_rate=_pct(overall.get("rate")),
        broken_rate=_pct(seal.get("broken_rate")),
    )


def iter_review_dates(reviews_dir: Path | str) -> list[str]:
    """库里有正文的复盘日期，新→旧。只认 YYYY-MM-DD.json（跳过 latest.json）。"""
    out = []
    for p in Path(reviews_dir).glob("*.json"):
        if not DATE_RE.fullmatch(p.stem):
            continue
        try:
            payload = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(payload, dict) and payload.get("focus"):
            out.append(p.stem)
    return sorted(out, reverse=True)


# ---------------------------------------------------------------- 字体与绘图

def _load_font(size: int, *, bold: bool) -> "object":
    """按候选顺序加载第一个可用字体；全不可用抛 CardError。"""
    from PIL import ImageFont  # 延迟导入：缺 Pillow 时 generate() 能优雅降级

    candidates = _BOLD_CANDIDATES if bold else _REGULAR_CANDIDATES
    for path, index in candidates:
        if not Path(path).is_file():
            continue
        try:
            return ImageFont.truetype(path, size, index=index) if index is not None \
                else ImageFont.truetype(path, size)
        except (OSError, ValueError):
            continue
    raise CardError("找不到可用的中文字体（Noto Sans CJK / DroidSansFallback）")


def _gradient(size: tuple[int, int]) -> "object":
    """竖向渐变底：按行画（630 次 draw.line），不做 75 万次逐像素循环。"""
    from PIL import Image, ImageDraw

    w, h = size
    img = Image.new("RGB", (w, h), BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        color = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=color)
    return img


def _wrap(draw, text: str, font, max_width: int) -> list[str]:
    """按像素宽度折行（中文逐字，英文按词不苛求）。"""
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) <= max_width:
            cur += ch
        else:
            if cur:
                lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def render_card(metrics: CardMetrics, out_path: Path | str) -> Path:
    """画一张 1200×630 PNG 并写入 out_path，返回路径。"""
    from PIL import Image, ImageDraw

    font_big = _load_font(132, bold=True)
    font_title = _load_font(30, bold=True)
    font_label = _load_font(24, bold=False)
    font_value = _load_font(56, bold=True)
    font_note = _load_font(19, bold=False)
    font_disclaimer = _load_font(17, bold=False)

    img = _gradient((WIDTH, HEIGHT))
    d = ImageDraw.Draw(img)
    pad = 64

    # 顶部：品牌 + 日期
    d.text((pad, 40), "揽宝.复盘", font=font_title, fill=ACCENT)
    date_s = metrics.date
    tw = d.textlength(date_s, font=font_label)
    d.text((WIDTH - pad - tw, 46), date_s, font=font_label, fill=LABEL_COLOR)
    d.line([(pad, 92), (WIDTH - pad, 92)], fill=ACCENT, width=3)

    # 中部：情绪档位大字
    d.text((pad, 126), "情绪档位", font=font_label, fill=LABEL_COLOR)
    d.text((pad, 158), metrics.phase, font=font_big, fill=PHASE_COLOR)
    # 分析框架标注（贴在大字右侧，避免与三读数挤）
    note = "分析框架 · 非客观事实"
    nw = d.textlength(note, font=font_note)
    d.text((WIDTH - pad - nw, 250), note, font=font_note, fill=NOTE_COLOR)

    # 下部：三张读数卡
    cards = [
        ("涨停家数", metrics.limit_up, "当日涨停池样本"),
        ("晋级率", metrics.promote_rate, "昨日涨停 → 今日"),
        ("炸板率", metrics.broken_rate, "封板质量口径"),
    ]
    top, gap = 360, 24
    card_w = (WIDTH - 2 * pad - 2 * gap) // 3
    card_h = 158
    for i, (label, value, sub) in enumerate(cards):
        x0 = pad + i * (card_w + gap)
        d.rounded_rectangle([(x0, top), (x0 + card_w, top + card_h)],
                            radius=16, fill=CARD_BG)
        d.text((x0 + 22, top + 18), label, font=font_label, fill=LABEL_COLOR)
        d.text((x0 + 22, top + 52), value, font=font_value, fill=VALUE_COLOR)
        d.text((x0 + 22, top + 120), sub, font=font_note, fill=NOTE_COLOR)

    # 底部：免责声明（自动折行，最多 2 行）
    lines = _wrap(d, DISCLAIMER, font_disclaimer, WIDTH - 2 * pad)[:2]
    y = HEIGHT - 28 - len(lines) * 24
    for ln in lines:
        d.text((pad, y), ln, font=font_disclaimer, fill=DISCLAIMER_COLOR)
        y += 24

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    return out


def _qr_image(url: str, size: int) -> "object | None":
    """把 URL 编成二维码 PIL 图；缺 qrcode 库返回 None（竖版降级为无码，不报错）。"""
    try:
        import qrcode
        from qrcode.image.pil import PilImage
    except ImportError:
        return None
    qr = qrcode.QRCode(version=None, box_size=8, border=1,
                       error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(url)
    qr.make(fit=True)
    im = qr.make_image(image_factory=PilImage).convert("RGB")
    return im.resize((size, size))


def render_card_vertical(metrics: CardMetrics, out_path: Path | str,
                         *, go_url: str | None = None) -> Path:
    """画一张 1080×1350 竖版社媒图（信息流发图用）。

    与横版区别：档位更大、三读数竖排、底部带短链文字 + 二维码 +「扫码看全文」CTA。
    二维码指向 ``go_url``（缺省用 tg 平台的 /go/ 跳页）；缺 qrcode 库时跳过二维码。
    """
    from PIL import Image, ImageDraw

    if go_url is None:
        from . import social_links  # 局部 import，避免模块级循环
        go_url = social_links.go_url("tg", metrics.date)

    font_big = _load_font(176, bold=True)
    font_title = _load_font(38, bold=True)
    font_label = _load_font(30, bold=False)
    font_value = _load_font(68, bold=True)   # 太大就会压到卡片底部的小注
    font_note = _load_font(24, bold=False)
    font_disclaimer = _load_font(20, bold=False)
    font_cta = _load_font(28, bold=True)

    img = _gradient((V_WIDTH, V_HEIGHT))
    d = ImageDraw.Draw(img)
    pad = 72

    # 顶部：品牌 + 日期
    d.text((pad, 56), "揽宝.复盘", font=font_title, fill=ACCENT)
    tw = d.textlength(metrics.date, font=font_label)
    d.text((V_WIDTH - pad - tw, 64), metrics.date, font=font_label, fill=LABEL_COLOR)
    d.line([(pad, 130), (V_WIDTH - pad, 130)], fill=ACCENT, width=4)

    # 情绪档位大字
    d.text((pad, 176), "情绪档位", font=font_label, fill=LABEL_COLOR)
    d.text((pad, 226), metrics.phase, font=font_big, fill=PHASE_COLOR)
    d.text((pad, 436), "分析框架 · 非客观事实", font=font_note, fill=NOTE_COLOR)

    # 三读数竖排（每张占满宽度）
    cards = [
        ("涨停家数", metrics.limit_up, "当日涨停池样本"),
        ("晋级率", metrics.promote_rate, "昨日涨停 → 今日"),
        ("炸板率", metrics.broken_rate, "封板质量口径"),
    ]
    top, card_h, gap = 510, 176, 11
    for i, (label, value, sub) in enumerate(cards):
        y0 = top + i * (card_h + gap)
        d.rounded_rectangle([(pad, y0), (V_WIDTH - pad, y0 + card_h)],
                            radius=20, fill=CARD_BG)
        d.text((pad + 32, y0 + 14), label, font=font_label, fill=LABEL_COLOR)
        d.text((pad + 32, y0 + 54), value, font=font_value, fill=VALUE_COLOR)
        d.text((pad + 32, y0 + 140), sub, font=font_note, fill=NOTE_COLOR)

    # 底部：二维码 + 短链 + CTA
    qr_size = 180
    qr = _qr_image(go_url, qr_size)
    cta_y = 1090
    if qr is not None:
        img.paste(qr, (V_WIDTH - pad - qr_size, cta_y))
        d = ImageDraw.Draw(img)  # paste 后重建 draw
    text_x = pad
    text_w = V_WIDTH - 2 * pad - (qr_size + 24 if qr is not None else 0)
    d.text((text_x, cta_y + 16), "扫码看全文", font=font_cta, fill=ACCENT)
    short = go_url.replace("https://", "")
    short_lines = _wrap(d, short, font_note, text_w)[:2]
    sy = cta_y + 62
    for ln in short_lines:
        d.text((text_x, sy), ln, font=font_note, fill=LABEL_COLOR)
        sy += 30
    # 免责声明（最多 2 行）
    lines = _wrap(d, DISCLAIMER, font_disclaimer, V_WIDTH - 2 * pad)[:2]
    y = V_HEIGHT - 32 - len(lines) * 28
    for ln in lines:
        d.text((pad, y), ln, font=font_disclaimer, fill=DISCLAIMER_COLOR)
        y += 28

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    return out


# ---------------------------------------------------------------- 批量生成

def generate(reviews_dir: Path | str, out_dir: Path | str,
             *, dates: list[str] | None = None,
             vertical: bool = True,
             log: Callable[[str], None] = lambda _m: None) -> list[Path]:
    """按日期批量生成卡片。

    横版（OG 用，文件名契约不变）：``<date>.png`` + ``latest.png``。
    竖版（社媒发图用）：``<date>-vertical.png`` + ``latest-vertical.png``。

    返回成功写出的路径列表。**任何单篇/单形态失败只记 log 并跳过**，不让整个发布
    失败（缺字体/缺 Pillow/缺 qrcode/坏 json 都属增强项故障）；竖版失败不影响横版。
    """
    try:
        from PIL import Image  # noqa: F401  仅探测可用性
        _load_font(20, bold=True)
    except (ImportError, CardError) as exc:
        log(f"情绪卡片：跳过生成（{exc}）")
        return []

    reviews, out = Path(reviews_dir), Path(out_dir)
    target_dates = dates if dates is not None else iter_review_dates(reviews)
    written: list[Path] = []
    latest_metrics: CardMetrics | None = None
    latest_date = ""

    for date in sorted(target_dates, reverse=True):
        src = reviews / f"{date}.json"
        if not src.is_file():
            log(f"情绪卡片：{date} 无复盘文件，跳过")
            continue
        try:
            payload = json.loads(src.read_text(encoding="utf-8"))
            metrics = extract_metrics(payload, date)
        except (OSError, ValueError) as exc:
            log(f"情绪卡片：{date} 读取失败，跳过（{exc}）")
            continue

        # 横版（OG 契约，不能因竖版失败而缺失）
        try:
            render_card(metrics, out / f"{date}.png")
            written.append(out / f"{date}.png")
        except (OSError, CardError) as exc:
            log(f"情绪卡片：{date} 横版生成失败，跳过（{exc}）")
        # 竖版（社媒发图，独立降级）
        if vertical:
            try:
                render_card_vertical(metrics, out / f"{date}-vertical.png")
                written.append(out / f"{date}-vertical.png")
            except (OSError, CardError, ValueError) as exc:
                log(f"情绪卡片：{date} 竖版生成失败，跳过（{exc}）")
        if date > latest_date:
            latest_date, latest_metrics = date, metrics

    # latest：取最新一天，横竖各一张
    if latest_metrics is not None:
        try:
            render_card(latest_metrics, out / "latest.png")
            written.append(out / "latest.png")
        except (OSError, CardError) as exc:
            log(f"情绪卡片：latest.png 生成失败（{exc}）")
        if vertical:
            try:
                render_card_vertical(latest_metrics, out / "latest-vertical.png")
                written.append(out / "latest-vertical.png")
            except (OSError, CardError, ValueError) as exc:
                log(f"情绪卡片：latest-vertical.png 生成失败（{exc}）")
    log(f"情绪卡片：生成 {len(written)} 张到 {out}")
    return written

"""两融叠加图：近20交易日融资净买入（柱）+ 两融余额（线），PIL 纯本地生成。

仿 assets/两融余额与融资净买入.png 的样式：
- 柱状（左轴）：融资净买入，红=净买入>0（加杠杆）、绿=净买入<0（去杠杆），以0轴为基线
- 折线（右轴）：两融余额（融资余额三所合计）
- 双轴 + 图例 + 日期标签

只用 Pillow（项目已依赖），字体复用 emotion_card 的 Noto Sans CJK SC。
不联网、不新增依赖。
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from .emotion_card import _load_font  # 复用中文字体加载（Noto CJK SC）

WIDTH, HEIGHT = 941, 433
PAD_TITLE = 12
PLOT_L, PLOT_R, PLOT_T, PLOT_B = 66, 70, 78, 40   # 绘图区边距（左轴/右轴/上/下）

# 配色（参考图）
RED = (216, 72, 60)      # 净买入>0 加杠杆
GREEN = (32, 150, 110)   # 净买入<0 去杠杆
BLUE = (38, 96, 168)     # 两融余额线
GRID = (228, 232, 236)
TEXT = (60, 66, 72)
MUTED = (130, 138, 146)
BG = (255, 255, 255)
BORDER = (224, 228, 232)

TITLE = "把它们叠加起来看，这个关系就很直观："
LEGEND = [("净买入 > 0 加杠杆", RED), ("净买入 < 0 去杠杆", GREEN), ("两融余额（右轴）", BLUE)]


def _nice_bounds(values: list[float]) -> tuple[float, float]:
    """取一个包含所有值的整齐对称区间（用于净买入轴）。"""
    if not values:
        return -1.0, 1.0
    m = max(abs(min(values)), abs(max(values)), 1.0)
    top = int(m / 100) * 100 + 100
    return float(-top), float(top)


def render_margin_chart(series: list[dict], out_path: str | Path) -> Path | None:
    """生成叠加图 PNG；series 为 [{date, margin_bal_yi, net_buy_yi}]，按日期升序。

    out_path 为输出文件路径。无有效数据或字体/Pillow 不可用时返回 None（降级，不阻断发布）。
    """
    valid = [s for s in series if isinstance(s, dict)
             and s.get("net_buy_yi") is not None and s.get("margin_bal_yi") is not None]
    if len(valid) < 3:
        return None
    try:
        from PIL import Image, ImageDraw
        f_title = _load_font(16, bold=True)
        f_small = _load_font(12, bold=False)
        f_axis = _load_font(11, bold=False)
    except Exception:  # noqa: BLE001  字体/Pillow 不可用 → 降级
        return None

    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((3, 3, WIDTH - 4, HEIGHT - 4), radius=12, outline=BORDER, width=2)

    # 标题
    d.text((PAD_TITLE + 10, PAD_TITLE), TITLE, font=f_title, fill=TEXT)

    # 图例（标题下方一行）
    lx = PAD_TITLE + 12
    ly = 46
    for label, color in LEGEND:
        d.rectangle((lx, ly + 2, lx + 12, ly + 14), fill=color)
        d.text((lx + 18, ly), label, font=f_small, fill=TEXT)
        lx += 18 + int(d.textlength(label, font=f_small)) + 26

    # 绘图区
    x0, x1 = PLOT_L, WIDTH - PLOT_R
    y0, y1 = PLOT_T, HEIGHT - PLOT_B
    nets = [float(s["net_buy_yi"]) for s in valid]
    bals = [float(s["margin_bal_yi"]) for s in valid]
    net_lo, net_hi = _nice_bounds(nets)
    bal_lo, bal_hi = min(bals) - 100, max(bals) + 100
    bal_lo = max(0.0, bal_lo)

    def y_net(v: float) -> float:
        return y1 - (v - net_lo) / (net_hi - net_lo) * (y1 - y0)

    def y_bal(v: float) -> float:
        return y1 - (v - bal_lo) / max(bal_hi - bal_lo, 1) * (y1 - y0)

    # 水平网格 + 左轴（净买入）刻度
    for i in range(5):
        v = net_lo + (net_hi - net_lo) * i / 4
        yy = y_net(v)
        d.line((x0, yy, x1, yy), fill=GRID, width=1)
        d.text((x0 - 8, yy - 7), f"{v:.0f}", font=f_axis, fill=MUTED, anchor="ra")

    # 右轴（两融余额）刻度
    for i in range(5):
        v = bal_lo + (bal_hi - bal_lo) * i / 4
        yy = y_bal(v)
        label = f"{v:.0f}"
        d.text((x1 + 8, yy - 7), label, font=f_axis, fill=BLUE, anchor="la")
    # 轴标题：放在绘图区顶部两端，避免与刻度数字/边缘重叠
    d.text((x0 + 2, y0 - 18), "左轴：融资净买入（亿元）", font=f_axis, fill=MUTED)
    d.text((x1 - 150, y0 - 18), "右轴：两融余额（亿元）", font=f_axis, fill=BLUE)

    n = len(valid)
    step = (x1 - x0) / n
    bw = max(6.0, step * 0.58)
    zero = y_net(0)
    # 柱状：净买入
    pts: list[tuple[float, float]] = []
    for i, s in enumerate(valid):
        cx = x0 + step * (i + 0.5)
        v = float(s["net_buy_yi"])
        yy = y_net(v)
        color = RED if v >= 0 else GREEN
        d.rectangle((cx - bw / 2, min(yy, zero), cx + bw / 2, max(yy, zero)), fill=color)
        pts.append((cx, y_bal(float(s["margin_bal_yi"]))))

    # 折线：两融余额
    for i in range(1, len(pts)):
        d.line((pts[i - 1], pts[i]), fill=BLUE, width=2)
    for cx, cy in pts:
        d.ellipse((cx - 2.5, cy - 2.5, cx + 2.5, cy + 2.5), fill=BLUE)

    # 横轴日期（隔一个显示，避免拥挤）
    for i, s in enumerate(valid):
        if i % 2 == 1 and n > 12:
            continue
        cx = x0 + step * (i + 0.5)
        ds = str(s["date"])
        label = f"{ds[4:6]}-{ds[6:8]}" if len(ds) == 8 else ds[-5:]
        d.text((cx, y1 + 12), label, font=f_axis, fill=MUTED, anchor="ma")

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG")
    return out


def margin_guidance(series: list[dict]) -> str:
    """基于叠加图的文字指引：只描述数据事实与验证条件，不含买卖建议/点位。

    产品政策：不提供投资决策、买卖建议或仓位指令（review_agent/product_policy）。
    因此这里只用「观察/验证/反证」措辞。
    """
    valid = [s for s in series if isinstance(s, dict)
             and s.get("net_buy_yi") is not None and s.get("margin_bal_yi") is not None]
    if len(valid) < 3:
        return ""
    first, last = valid[0], valid[-1]
    bal_delta = float(last["margin_bal_yi"]) - float(first["margin_bal_yi"])
    bal_trend = "回落" if bal_delta < 0 else ("抬升" if bal_delta > 0 else "基本持平")
    net_vals = [float(s["net_buy_yi"]) for s in valid]
    pos_days = sum(1 for v in net_vals if v > 0)
    neg_days = sum(1 for v in net_vals if v < 0)
    last5 = net_vals[-5:]
    last5_pos = sum(1 for v in last5 if v > 0)
    last_net = net_vals[-1]

    parts = [f"近 {len(valid)} 个交易日，融资余额自 {first['margin_bal_yi']:.0f} 亿"
             f"{bal_trend}至 {last['margin_bal_yi']:.0f} 亿（累计 {bal_delta:+.0f} 亿）；"]
    parts.append(f"融资净买入为正 {pos_days} 天、为负 {neg_days} 天，"
                 f"最近 5 日中 {last5_pos} 天为净买入，最新一日 {last_net:+.0f} 亿。")
    if bal_delta < 0 and neg_days > pos_days:
        parts.append("余额回落叠加多数日净偿还，指向杠杆资金持续收缩；"
                     "后续若净买入转正且余额止跌，才构成收缩缓和的反证。")
    elif bal_delta > 0 and pos_days >= neg_days:
        parts.append("余额抬升叠加净买入占优，指向杠杆资金加仓；"
                     "后续若净买入转负且余额回落，则构成加仓动能减弱的反证。")
    else:
        parts.append("余额与净买入方向不完全一致，杠杆资金处于分歧状态；"
                     "后续需两日以上同向才支持趋势判断。")
    parts.append("以上仅为公开数据的方向描述与后续验证条件，不构成操作指引；"
                 "余额为融资余额口径，不等同于全市场两融余额。")
    return "\n".join(parts)


def ensure_margin_chart(payload: dict, site_dir: str | Path,
                        log: Callable[[str], None] = lambda _m: None) -> bool:
    """确保复盘引用的两融图真实存在于 site_dir，并更新 file/image 指向它。

    复盘阶段图只写到「生成复盘那台容器」的本地文件系统；发布（Hugo 构建）与
    公众号上传在另一个进程/容器，读不到那个文件（复盘命中缓存时更不会重新生成），
    于是文章里有 img 标签、线上/草稿里却没有图。这里按复盘落盘的同一份 series
    在发布侧动态重生成；series 缺失时按 target_date 重新取数（Tushare）。
    不依赖写图容器的本地文件，因此跨容器/命中缓存也不会缺图。返回是否成功。
    """
    facts = payload.get("market_facts") or {}
    mc = facts.get("margin_chart") or {}
    if not mc:
        return False
    # 文件名以文章里已写死的 image 为准，保证与 HTML 引用完全一致
    img_name = Path(str(mc.get("image") or "")).name
    if not img_name.startswith("margin-") or not img_name.endswith(".png"):
        return False
    series = mc.get("series") or []
    if len(series) < 3:
        date = str(payload.get("target_date") or payload.get("trade_date") or "")
        if not date:
            dates = mc.get("dates") or []
            date = str(dates[-1]) if dates else ""
        try:
            from duanxian.fetchers import fetch_margin_history
            series = fetch_margin_history(date, days=20) if date else []
        except Exception as exc:  # noqa: BLE001  取数失败 → 降级
            log(f"两融图取数失败（{type(exc).__name__}: {exc}）")
            series = []
    if len(series) < 3:
        return False
    out = Path(site_dir) / "static" / "cards" / img_name
    try:
        img = render_margin_chart(series, out)
    except Exception as exc:  # noqa: BLE001  生成失败 → 降级
        log(f"两融图生成失败（{type(exc).__name__}: {exc}）")
        return False
    if not img:
        return False
    mc["series"] = series
    mc["file"] = str(out)
    return True

#!/usr/bin/env python3
"""揽宝投研 · 系列文章统一头图模板。

用法：
  python gen_series_cover.py <序号> <标题> <输出路径> [强调色 hex]

  # 不传强调色 → 默认蓝 #1e90ff（拉新篇）
  python gen_series_cover.py 01 "复盘别盯十几个指标了" output/x/cover.png
  # 传强调色 → 同系列内做区分（立人设青 / 干货橙 / 观点紫）
  python gen_series_cover.py 04 "一个不荐股的复盘号" output/x/cover.png 17a673

固定要素：深蓝渐变底 + 左上角系列角标 + 左下角序号 + 居中主标题 + 右侧临界线数据点。
可变要素：强调色（光晕 / 竖线 / 数据点 / 标题第二行 / 序号 / 底部线）。
分组建议：01-03 拉新蓝 #1e90ff；04-06 立人设青 #17a673；07-09 干货橙 #ff6a00；10 观点紫 #7c5cff。
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 720  # 16:9
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
SERIES = "揽宝投研 · 复盘方法论"


def _rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def make_cover(index: str, title: str, out_path: str, accent: str = "1e90ff") -> None:
    ar, ag, ab = _rgb(accent)

    # 1) 深蓝径向渐变背景（系列统一）
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            nx = (x - W * 0.62) / W
            ny = (y - H * 0.45) / H
            d = math.sqrt(nx * nx + ny * ny)
            t = max(0.0, min(1.0, 1.0 - d * 1.25))
            px[x, y] = (int(8 + 18 * t), int(16 + 46 * t), int(38 + 90 * t))

    # 2) 右侧光晕（强调色）
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [W * 0.45, H * 0.02, W * 1.05, H * 0.98], fill=(ar, ag, ab, 46)
    )
    img = Image.alpha_composite(
        img.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(90))
    ).convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")

    # 3) 抽象"临界线"与数据点（强调色）
    line_x = int(W * 0.72)
    draw.line([(line_x, 70), (line_x, H - 70)], fill=(ar, ag, ab, 110), width=2)
    for cy in range(110, H - 90, 34):
        cx = line_x + (cy % 7 - 3)
        r = 3 + (cy % 5)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(ar, ag, ab, 175))

    # 4) 左上角固定系列角标（每篇一致，深蓝底）
    f_tag = ImageFont.truetype(FONT, 26)
    draw.rounded_rectangle([64, 52, 470, 112], radius=26, fill=(60, 130, 220, 90))
    draw.text((88, 63), SERIES, font=f_tag, fill=(225, 240, 255, 255))

    # 5) 居中主标题：两行排版（第二行用强调色）
    f_title = ImageFont.truetype(FONT, 68)
    lines = _wrap(title, 11)
    y0 = 250 - (len(lines) - 1) * 42
    for i, line in enumerate(lines):
        color = (245, 249, 255, 255) if i % 2 == 0 else (ar, ag, ab, 255)
        draw.text((70, y0 + i * 92), line, font=f_title, fill=color)

    # 6) 左下角固定序号（强调色）
    f_idx = ImageFont.truetype(FONT, 34)
    f_sub = ImageFont.truetype(FONT_REG, 26)
    draw.text((72, H - 92), index, font=f_idx, fill=(ar, ag, ab, 255))
    draw.text((150, H - 86), "／ 10", font=f_sub, fill=(160, 185, 215, 200))

    # 7) 底部装饰线（强调色）
    draw.line([(72, H - 50), (W - 72, H - 50)], fill=(ar, ag, ab, 80), width=1)

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")
    print(f"saved {out_path} ({W}x{H}) accent=#{accent}")


def _wrap(text: str, limit: int) -> list[str]:
    """按字符数断行，优先在标点处断开。"""
    if len(text) <= limit:
        return [text]
    lines, cur = [], ""
    for ch in text:
        cur += ch
        if len(cur) >= limit or ch in "，。？！、：；":
            lines.append(cur)
            cur = ""
    if cur:
        lines.append(cur)
    return lines[:2]


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        raise SystemExit(
            "用法: gen_series_cover.py <序号> <标题> <输出路径> [强调色hex]\n"
            '例: gen_series_cover.py 01 "复盘别盯十几个指标了" output/x/cover.png 1e90ff'
        )
    make_cover(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) == 5 else "1e90ff")

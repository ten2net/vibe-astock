"""社媒 UTM 短链跳页生成（设计文档 §5）。

站内跳转页：``/go/<platform>/<date>/index.html`` → meta refresh 到带 UTM 的文章 URL。
零外部依赖、可离线验证。产物落 ``blog/static/go/``（Hugo staticDir → public/go/），
由 ``OWNED_DIRS`` 同步到 Pages。

平台：x / tg / xueqiu。UTM：utm_source=<platform>&utm_medium=social&utm_campaign=<date>。
"""
from __future__ import annotations

import html
from pathlib import Path
from typing import Callable
from urllib.parse import quote

BASE_URL = "https://ten2net.github.io"
PLATFORMS = ("x", "tg", "xueqiu")


def post_url(date: str) -> str:
    """文章 URL（中文段 percent-encode，与线上 Permalink 一致）。"""
    return f"{BASE_URL}/post/{quote(date + '-每日复盘')}/"


def go_url(platform: str, date: str) -> str:
    """跳页的公开 URL，供卡片二维码与社媒 caption 使用。"""
    if platform not in PLATFORMS:
        raise ValueError(f"未知平台：{platform!r}")
    return f"{BASE_URL}/go/{platform}/{date}/"


def target_url(platform: str, date: str) -> str:
    """跳页最终指向的带 UTM 文章 URL。"""
    return (f"{post_url(date)}?utm_source={platform}"
            f"&utm_medium=social&utm_campaign={date}")


def _page_html(url: str) -> str:
    """极简跳页：meta refresh 立即跳，兜底 <a> 供禁用 refresh 的环境。"""
    safe = html.escape(url, quote=True)
    return (
        "<!DOCTYPE html>\n<html lang=\"zh-cn\">\n<head>\n"
        "<meta charset=\"utf-8\">\n"
        f"<meta http-equiv=\"refresh\" content=\"0;url={safe}\">\n"
        "<meta name=\"robots\" content=\"noindex\">\n"
        f"<title>跳转中…</title>\n</head>\n<body>\n"
        f"<p>正在跳转，若未自动跳转请<a href=\"{safe}\">点此</a>。</p>\n"
        "</body>\n</html>\n"
    )


def go_pages(out_dir: Path | str, dates: list[str],
             *, platforms: tuple[str, ...] = PLATFORMS,
             log: Callable[[str], None] = lambda _m: None) -> list[Path]:
    """为 ``dates × platforms`` 批量生成跳页，返回写出的路径。

    幂等：内容不变不重写（与 ``sync_public`` 的按字节比对一致）。
    """
    out = Path(out_dir)
    written: list[Path] = []
    for date in sorted(dates):
        for platform in platforms:
            path = out / platform / date / "index.html"
            content = _page_html(target_url(platform, date))
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.is_file() and path.read_text(encoding="utf-8") == content:
                continue
            path.write_text(content, encoding="utf-8")
            written.append(path)
    log(f"UTM 跳页：生成/更新 {len(written)} 个（{len(dates)} 天 × {len(platforms)} 平台）")
    return written

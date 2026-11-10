"""社媒分发（设计文档 §7，2026-11-09 修订）—— 面向国内用户，小红书为主。

链路：复盘发布 → 生成平台 caption → 合规闸门 → 台账去重 → 半自动图文包 / 发帖。
- **小红书为主**（用户确认）：目标用户在国内，小红书无官方开放发帖 API，且正文
  外链/二维码会被限流或判营销 → **半自动图文包**（程序生成竖图 + 文案 + 话题标签，
  人工在 App 粘贴发布），文案**不放任何 URL/二维码/引流 CTA**。
- **雪球**：同样是半自动图文包（无官方发帖 API，不做浏览器自动化）。
- **X / Telegram 停用但保留代码**：默认分发不再触发（``DEFAULT_PLATFORMS`` 不含），
  显式传 ``platforms=("x","tg")`` 仍可用自动发帖 sender，便于日后恢复。
- **合规硬约束**：caption 与原始复盘都过不荐股闸门；产品政策不因社媒放宽
- **幂等**：``~/.duanxian-agents/social-posts.json`` 按 ``date:platform`` 记账，
  已发帖跳过（帖子不可撤回重发）；失败不写成功标记，下次可重试
- **凭据只从 env 读、不进日志**；``--dry-run`` 全流程不调任何平台 API

真实网络发送用可注入的 ``sender``，测试用 fake 断言零/有调用，不依赖外网。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable

from . import emotion_card, social_links
from .blog_publish import DISCLAIMER, check_public_text
from .product_policy import has_trade_recommendation

PLATFORMS = ("x", "tg", "xueqiu", "xiaohongshu")
# 默认分发集合：面向国内，小红书为主 + 雪球，两者都半自动出图文包。
# X/TG 从默认集合移除（停用但保留代码），显式指定 platforms 仍可触发自动发帖。
DEFAULT_PLATFORMS = ("xiaohongshu", "xueqiu")
# 半自动图文包平台（程序生成素材、人工发布）
PACK_PLATFORMS = ("xiaohongshu", "xueqiu")
# 会被自动发帖的平台（X/TG 保留，仅显式指定时生效）
AUTO_PLATFORMS = ("x", "tg")


class SocialError(RuntimeError):
    """可预期的分发失败（合规拦截、凭据缺失、接口报错）。"""


# ---------------------------------------------------------------- 文案

@dataclass(frozen=True)
class Caption:
    platform: str
    text: str
    go_url: str


def build_caption(platform: str, metrics: "emotion_card.CardMetrics",
                  go_url: str) -> Caption:
    """平台专属 caption：日期 + 档位 + 三读数 + 免责声明（+ 短链，小红书除外）。

    X 限 280 字符，故用紧凑版；TG 可长；雪球偏长并带数据口径；小红书干货数据向，
    **不放任何 URL/二维码/引流 CTA**（平台限流/营销判定），只留话题标签。
    **只陈述已统计读数，不写任何操作/点位/预测**（合规红线）。
    """
    head = f"{metrics.date} A股情绪档位：{metrics.phase}"
    stats = f"涨停 {metrics.limit_up} 家 · 晋级率 {metrics.promote_rate} · 炸板率 {metrics.broken_rate}"
    source = "（数据来源：公开榜单与程序统计）"

    if platform == "x":
        # X 字符预算紧：免责声明用短版，含「不构成投资建议」口径
        short_disclaimer = "仅呈现公开数据与统计，不构成投资建议。"
        text = (f"{head}\n{stats}\n{short_disclaimer}\n"
                f"全文 {go_url}\n#A股复盘 #情绪周期")
    elif platform == "tg":
        text = (f"{head}\n{stats}\n\n{DISCLAIMER}\n\n全文：{go_url}")
    elif platform == "xiaohongshu":
        # 干货数据向：标题 + 读数 + 口径 + 免责声明 + 话题标签，全文不出现 URL，
        # 也不写任何「看主页/简介」等导流话术，规避小红书对站外引流的限流与违规判定。
        text = (f"{head}\n\n"
                f"当日读数\n{stats}\n\n"
                f"数据来源：公开榜单与程序统计。\n"
                "情绪档位是分析框架，非客观事实。\n\n"
                f"{DISCLAIMER}\n\n"
                "#A股复盘 #情绪周期 #市场情绪 #复盘笔记 #数据复盘")
        return Caption(platform=platform, text=text, go_url="")
    else:  # xueqiu
        text = (f"{head}\n\n{stats} {source}\n\n"
                f"{DISCLAIMER}\n\n全文：{go_url}\n"
                "（本图文由程序从当日已核对复盘产物生成，供人工发布）")
    return Caption(platform=platform, text=text, go_url=go_url)


def compliance_ok(caption: Caption, payload: dict) -> bool:
    """两道合规闸：原始复盘（与博客同闸）+ caption（剔除免责声明再扫）。

    ``has_trade_recommendation(DISCLAIMER)`` 会命中「不推荐个股」这类产品口径词，
    故扫描 caption 时先去掉免责声明，只扫实际陈述部分。
    """
    try:
        check_public_text(payload)
    except Exception:
        return False
    scan = caption.text.replace(DISCLAIMER, "").replace(
        "仅呈现公开数据与统计，不构成投资建议。", "")
    return not has_trade_recommendation(scan)


# ---------------------------------------------------------------- 台账

LEDGER_FILENAME = "social-posts.json"


def ledger_path(home: Path | str | None = None) -> Path:
    root = Path(home) if home else Path(os.environ.get(
        "ASTOCK_DATA_HOME", "~/.duanxian-agents")).expanduser()
    return root / LEDGER_FILENAME


def _load_ledger(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_ledger(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _key(date: str, platform: str) -> str:
    return f"{date}:{platform}"


def is_posted(ledger: dict, date: str, platform: str) -> bool:
    return ledger.get(_key(date, platform), {}).get("status") == "posted"


def record(ledger: dict, date: str, platform: str, *, status: str,
           post_id: str = "", url: str = "", reason: str = "") -> None:
    ledger[_key(date, platform)] = {
        "status": status, "posted_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "post_id": post_id, "url": url, "reason": reason,
    }


# ---------------------------------------------------------------- 平台发送（真实实现，可注入替身）

def _http_json(url: str, data: bytes, headers: dict[str, str], timeout: float = 20.0) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310  固定官方 API 域名
        return json.loads(resp.read().decode("utf-8"))


def tg_send(photo: Path, caption: str, *, chat_id: str, token: str) -> str:
    """Telegram Bot API sendPhoto（multipart），返回 message_id 字符串。"""
    boundary = "----va" + hashlib.sha1(os.urandom(16)).hexdigest()
    def part(name: str, value: str) -> bytes:
        return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                f"{value}\r\n").encode("utf-8")
    body = bytearray()
    body += part("chat_id", chat_id)
    body += part("caption", caption)
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; "
             f"filename=\"{photo.name}\"\r\nContent-Type: image/png\r\n\r\n").encode()
    body += photo.read_bytes() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    result = _http_json(f"https://api.telegram.org/bot{token}/sendPhoto", bytes(body),
                        {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    if not result.get("ok"):
        raise SocialError(f"TG 返回失败：{result.get('description', result)}")
    return str(result.get("result", {}).get("message_id", ""))


def x_send(photo: Path, text: str, *, creds: dict[str, str]) -> str:
    """X API v1.1 media/upload + v2 POST /2/tweets（OAuth 1.0a 手写签名）。"""
    import base64
    import secrets

    def oauth1(method: str, url: str, params: dict[str, str]) -> str:
        oauth = {
            "oauth_consumer_key": creds["api_key"],
            "oauth_nonce": secrets.token_hex(16),
            "oauth_signature_method": "HMAC-SHA1",
            "oauth_timestamp": str(int(time.time())),
            "oauth_token": creds["access_token"],
            "oauth_version": "1.0",
        }
        all_params = {**params, **oauth}
        enc = urllib.parse.quote
        base = "&".join(f"{enc(k)}={enc(str(v))}" for k, v in sorted(all_params.items()))
        base_string = f"{method}&{enc(url)}&{enc(base)}"
        key = f"{enc(creds['api_secret'])}&{enc(creds['access_secret'])}"
        sig = base64.b64encode(hmac.new(key.encode(), base_string.encode(), hashlib.sha1).digest()).decode()
        oauth["oauth_signature"] = sig
        return "OAuth " + ", ".join(f'{enc(k)}="{enc(v)}"' for k, v in sorted(oauth.items()))

    # 1) 上传图片（multipart，简化：media 用 base64 字段）
    upload_url = "https://upload.twitter.com/1.1/media/upload.json"
    form = urllib.parse.urlencode({"media_data": base64.b64encode(photo.read_bytes()).decode()}).encode()
    auth = oauth1("POST", upload_url, {})
    with urllib.request.urlopen(urllib.request.Request(
            upload_url, data=form,
            headers={"Authorization": auth, "Content-Type": "application/x-www-form-urlencoded"},
            method="POST"), timeout=30) as resp:
        media = json.loads(resp.read().decode("utf-8"))
    media_id = str(media.get("media_id_string") or "")
    if not media_id:
        raise SocialError(f"X 图片上传失败：{media}")
    # 2) 发推
    tweet_url = "https://api.twitter.com/2/tweets"
    payload = json.dumps({"text": text, "media": {"media_ids": [media_id]}}).encode("utf-8")
    result = _http_json(tweet_url, payload,
                        {"Authorization": oauth1("POST", tweet_url, {}),
                         "Content-Type": "application/json"})
    return str(result.get("data", {}).get("id", ""))


# ---------------------------------------------------------------- 编排

@dataclass(frozen=True)
class DistResult:
    date: str
    outcomes: dict[str, str]   # platform -> posted|skipped|failed|dry-run|pack


def _pack_card(cards_dir: Path, date: str, platform: str) -> Path:
    """半自动图文包用的竖版卡片路径：小红书用无码/无外链的 ``-xhs.png``，
    其余（雪球）沿用带二维码的 ``-vertical.png``。"""
    name = f"{date}-xhs.png" if platform == "xiaohongshu" else f"{date}-vertical.png"
    return cards_dir / name


def _pack_dir(packs_dir: Path, date: str, platform: str) -> Path:
    """图文包目录。雪球保持既有 ``packs/<date>/`` 契约；小红书单独分目录避免覆盖。"""
    if platform == "xiaohongshu":
        return packs_dir / "xiaohongshu" / date
    return packs_dir / date


def distribute(date: str, payload: dict, *, reviews_dir: Path | str,
               cards_dir: Path | str, packs_dir: Path | str,
               dry_run: bool = False, platforms: tuple[str, ...] = DEFAULT_PLATFORMS,
               ledger_home: Path | str | None = None,
               sender: Callable[..., str] | None = None,
               log: Callable[[str], None] = lambda _m: None) -> DistResult:
    """分发一篇复盘到各平台。**任何失败只记台账/日志并返回，不抛异常到调用方**。

    默认 ``DEFAULT_PLATFORMS``（小红书 + 雪球）都只写半自动图文包、人工发布；
    X/TG 代码保留但需显式传 ``platforms`` 才会走自动发帖 sender。
    ``sender`` 注入便于离线测试；缺省 ``None`` 时用真实实现（凭据从 env 读）。
    """
    metrics = emotion_card.extract_metrics(payload, date)
    ledger_file = ledger_path(ledger_home)
    ledger = _load_ledger(ledger_file)
    cards = Path(cards_dir)
    vertical = cards / f"{date}-vertical.png"
    outcomes: dict[str, str] = {}

    for platform in platforms:
        key = f"{date}:{platform}"
        try:
            go = social_links.go_url(platform, date)
            caption = build_caption(platform, metrics, go)

            # 1) 合规闸门（两道）
            if not compliance_ok(caption, payload):
                record(ledger, date, platform, status="skipped", reason="合规拦截")
                outcomes[platform] = "skipped"
                log(f"社媒 {key}：合规拦截，跳过")
                continue

            # 2) 幂等：已发帖不再发
            if is_posted(ledger, date, platform):
                outcomes[platform] = "skipped"
                log(f"社媒 {key}：已发过，跳过")
                continue

            # 3) 半自动图文包（小红书 / 雪球）：只出素材，人工发布
            if platform in PACK_PLATFORMS:
                pack = _pack_dir(Path(packs_dir), date, platform)
                pack.mkdir(parents=True, exist_ok=True)
                (pack / "caption.md").write_text(caption.text, encoding="utf-8")
                card = _pack_card(cards, date, platform)
                if card.is_file():
                    (pack / "card.png").write_bytes(card.read_bytes())
                if not dry_run:
                    record(ledger, date, platform, status="pack", url=str(pack))
                outcomes[platform] = "pack"
                log(f"社媒 {key}：图文包已生成 {pack}（人工发布）")
                continue

            # 4) dry-run：不调 API、不写成功台账
            if dry_run:
                outcomes[platform] = "dry-run"
                log(f"社媒 {key}：dry-run，未发帖")
                continue

            # 5) 自动发帖（X / TG）
            cred = _credentials(platform)
            if cred is None:
                record(ledger, date, platform, status="skipped", reason="凭据未配置")
                outcomes[platform] = "skipped"
                log(f"社媒 {key}：凭据未配置，跳过")
                continue
            if not vertical.is_file():
                record(ledger, date, platform, status="failed", reason="缺竖版卡片")
                outcomes[platform] = "failed"
                log(f"社媒 {key}：缺竖版卡片，跳过")
                continue
            try:
                post_id = _do_send(platform, vertical, caption.text, cred, sender)
            except Exception as exc:  # noqa: BLE001  平台失败不阻断
                record(ledger, date, platform, status="failed", reason=str(exc)[:200])
                outcomes[platform] = "failed"
                log(f"社媒 {key}：发送失败，跳过（{type(exc).__name__}: {exc}）")
                continue
            record(ledger, date, platform, status="posted", post_id=post_id, url=caption.go_url)
            outcomes[platform] = "posted"
            log(f"社媒 {key}：已发帖 {post_id}")
        except Exception as exc:  # noqa: BLE001  单平台兜底，绝不影响其他平台
            outcomes[platform] = "failed"
            log(f"社媒 {key}：异常，跳过（{type(exc).__name__}: {exc}）")

    if not dry_run:
        try:
            _save_ledger(ledger_file, ledger)
        except OSError as exc:
            log(f"社媒台账写入失败（{exc}），本次发帖状态可能未被记住")
    return DistResult(date=date, outcomes=outcomes)


def _credentials(platform: str) -> dict | None:
    """从 env 读凭据；缺任一项返回 None（跳过，不报错）。"""
    if platform == "tg":
        token = os.environ.get("TG_BOT_TOKEN", "").strip()
        chat = os.environ.get("TG_CHAT_ID", "").strip()
        return {"token": token, "chat_id": chat} if token and chat else None
    if platform == "x":
        keys = {
            "api_key": "X_API_KEY", "api_secret": "X_API_SECRET",
            "access_token": "X_ACCESS_TOKEN", "access_secret": "X_ACCESS_SECRET",
        }
        vals = {k: os.environ.get(env, "").strip() for k, env in keys.items()}
        return vals if all(vals.values()) else None
    return None


def _do_send(platform: str, photo: Path, text: str, cred: dict,
             sender: Callable[..., str] | None) -> str:
    if sender is not None:
        return sender(platform, photo, text, cred)
    if platform == "tg":
        return tg_send(photo, text, chat_id=cred["chat_id"], token=cred["token"])
    if platform == "x":
        return x_send(photo, text, creds=cred)
    raise SocialError(f"平台 {platform} 不支持自动发帖")

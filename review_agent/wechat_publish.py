"""微信公众号发布客户端：草稿箱 → 发布。订阅号（已认证）专用。

凭据只从环境变量 / .env 读（WECHAT_APPID / WECHAT_SECRET），不入库、不进日志。
封面图优先用每日情绪卡片（blog/static/cards/<date>.png），没有卡片才退回全站共用的
硬币徽章；media_id 按图片缓存缓存在数据区，避免重复上传永久素材。

接口文档：微信公众平台开发者文档 → 草稿箱 / 发布能力。
"""
from __future__ import annotations

import json
import os
import secrets
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from .blog_publish import PublishError, check_public_text, load_review, post_title
from .wechat_render import article_html
from duanxian.paths import data_path  # noqa: E402

API = "https://api.weixin.qq.com"
PRODUCT_NAME = "揽宝投研"
# 卡片图缺失时退回的默认封面（仓库里的硬币徽章）；卡片见 card_cover()
# 草稿接口里 thumb_media_id 必填，必须给一张
DEFAULT_COVER = Path(__file__).resolve().parents[1] / "blog" / "static" / "img" / "avatar.png"

# 公众号头条封面按 2.35:1（1080×460）展示，thumb_media_id 也按这个比例给，
# 否则后台/分享时会被上下裁切。情绪卡片是 1.9:1，上传前居中裁一刀。
THUMB_RATIO = 2.35

# 默认直连，避免通用代理改变微信校验的出口 IP；需要固定出口时只走 WECHAT_PROXY。
def _build_opener() -> urllib.request.OpenerDirector:
    proxy = os.environ.get("WECHAT_PROXY", "").strip()
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))


_OPENER = _build_opener()


class WechatError(PublishError):
    """可预期的失败：凭据缺失、接口报错、发布状态失败。"""


def _credentials(env_file: Path | None = None) -> tuple[str, str]:
    appid = os.environ.get("WECHAT_APPID", "").strip()
    secret = os.environ.get("WECHAT_SECRET", "").strip()
    if not appid or not secret:
        env = Path(env_file) if env_file else Path(__file__).resolve().parents[1] / ".env"
        for line in env.read_text(encoding="utf-8").splitlines() if env.exists() else []:
            if line.startswith("WECHAT_APPID="):
                appid = line.split("=", 1)[1].strip()
            elif line.startswith("WECHAT_SECRET="):
                secret = line.split("=", 1)[1].strip()
    if not appid or not secret:
        raise WechatError("没有 WECHAT_APPID / WECHAT_SECRET：在 .env 里填公众号开发者凭据")
    return appid, secret


def _get_json(url: str, timeout: float = 15.0) -> dict:
    try:
        with _OPENER.open(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise WechatError(f"微信接口请求失败：{type(exc).__name__}") from exc


def _post_json(path: str, payload: dict, token: str, timeout: float = 20.0) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    url = f"{API}{path}?access_token={urllib.parse.quote(token)}"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    with _OPENER.open(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("errcode"):
        raise WechatError(f"微信接口报错 {data.get('errcode')}: {data.get('errmsg')}")
    return data


def get_access_token(cache_file: Path | None = None) -> str:
    """access_token 有效期 7200s，提前 5 分钟换新；缓存在数据区避免每次重新获取。"""
    cache_file = cache_file or (Path(data_path("reviews")).parent / "wechat-token.json")
    now = time.time()
    try:
        cache = json.loads(cache_file.read_text(encoding="utf-8"))
        if cache.get("token") and now < float(cache.get("expires_at", 0)) - 300:
            return str(cache["token"])
    except (OSError, ValueError):
        pass
    appid, secret = _credentials()
    data = _get_json(f"{API}/cgi-bin/token?grant_type=client_credential"
                     f"&appid={urllib.parse.quote(appid)}&secret={urllib.parse.quote(secret)}")
    token = data.get("access_token")
    if not token:
        raise WechatError(f"拿不到 access_token：{data.get('errmsg')}")
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(
            {"token": token, "expires_at": now + int(data.get("expires_in", 7200))}),
            encoding="utf-8")
        os.chmod(cache_file, 0o600)
    except OSError:
        pass  # 缓存写失败不影响本次使用
    return str(token)


def _multipart_body(field: str, filename: str, data: bytes) -> tuple[bytes, str]:
    """最小的 multipart/form-data 编码（urllib 没有现成实现）。"""
    boundary = f"----vra{secrets.token_hex(12)}"
    body = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n").encode("utf-8")
    body += data + f"\r\n--{boundary}--\r\n".encode("utf-8")
    return body, boundary


def card_cover(date: str) -> Path | None:
    """该日复盘的情绪卡片图（横版）；不存在则 None（调用方退回默认封面）。"""
    card = Path(__file__).resolve().parents[1] / "blog" / "static" / "cards" / f"{date}.png"
    return card if card.is_file() else None


def _fit_cover(image: Path) -> Path:
    """把封面图补成 2.35:1（微信头条封面比例）：不足宽度的图放在同色画布里居中，
    只裁过高的部分（上下各留边），不裁左右内容。产物缓存在数据区。

    Pillow 不可用或处理失败时原样返回，不阻断发布（增强项）。
    """
    try:
        from PIL import Image  # noqa: PLC0415  与 emotion_card 同一降级思路
    except ImportError:
        return image
    try:
        with Image.open(image) as im:
            im.load()
            w, h = im.size
            ratio = w / h
            if ratio >= THUMB_RATIO or ratio < 1.4:  # 太宽，或竖图：上下居中裁到 2.35:1
                target_h = round(w / THUMB_RATIO)
                top = (h - target_h) // 2
                out_im = im.crop((0, top, w, top + target_h))
            else:  # 略扁于 2.35:1：加宽画布（取卡片底色），内容完整保留
                target_w = round(h * THUMB_RATIO)
                bg = Image.new("RGB", (target_w, h), im.convert("RGB").getpixel((0, h - 1)))
                bg.paste(im.convert("RGB"), ((target_w - w) // 2, 0))
                out_im = bg
            out_dir = Path(data_path("reviews")).parent / "wechat-thumbs"
            out_dir.mkdir(parents=True, exist_ok=True)
            out = out_dir / f"{image.stem}-{out_im.size[0]}x{out_im.size[1]}.png"
            if not out.exists():
                out_im.save(out, format="PNG")
            return out
    except Exception:  # noqa: BLE001  封面处理是增强项，失败退回原图
        return image


def upload_cover(token: str, image: Path | None = None) -> str:
    """上传永久图片素材，返回 media_id。media_id 按图片（路径+mtime+大小）缓存。"""
    image = _fit_cover(Path(image or DEFAULT_COVER))
    if not image.exists():
        raise WechatError(f"封面图不存在：{image}")
    cache_file = Path(data_path("reviews")).parent / "wechat-cover.json"
    cache_key = f"{image.resolve()}:{image.stat().st_mtime_ns}:{image.stat().st_size}"
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        entry = cached.get(cache_key) if isinstance(cached, dict) else None
        if isinstance(entry, dict) and entry.get("media_id") and time.time() < float(entry.get("expires_at", 0)):
            return str(entry["media_id"])
    except (OSError, ValueError):
        pass
    body, boundary = _multipart_body("media", image.name, image.read_bytes())
    url = f"{API}/cgi-bin/material/add_material?access_token={urllib.parse.quote(token)}&type=image"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with _OPENER.open(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise WechatError(f"封面上传失败：{type(exc).__name__}") from exc
    media_id = data.get("media_id")
    if not media_id:
        raise WechatError(f"封面上传被拒：{data.get('errcode')} {data.get('errmsg')}")
    try:
        # 永久素材不过期，但留 30 天缓存期，之后重传一次防素材被清
        cached = {}
        try:
            old = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(old, dict):
                cached = {k: v for k, v in old.items() if isinstance(k, str) and isinstance(v, dict)}
        except (OSError, ValueError):
            pass
        cached[cache_key] = {"media_id": media_id, "expires_at": time.time() + 30 * 86400}
        cache_file.write_text(json.dumps(cached), encoding="utf-8")
        os.chmod(cache_file, 0o600)
    except OSError:
        pass
    return str(media_id)


def add_draft(token: str, *, title: str, content: str, digest: str,
              source_url: str, thumb_media_id: str, author: str = PRODUCT_NAME) -> str:
    """写入草稿箱，返回草稿 media_id。title 超 64 字符会被拒，先截断。"""
    article = {
        "title": title[:64],
        "author": author[:8],
        "digest": digest[:120],
        "content": content,
        "content_source_url": source_url,
        "thumb_media_id": thumb_media_id,
        "need_open_comment": 0,
        "only_fans_can_comment": 0,
    }
    data = _post_json("/cgi-bin/draft/add", {"articles": [article]}, token)
    media_id = data.get("media_id")
    if not media_id:
        raise WechatError("草稿接口没有返回 media_id")
    return str(media_id)


def freepublish(token: str, draft_media_id: str, *, wait: bool = True,
                timeout_s: float = 120.0) -> str:
    """提交发布并轮询结果；返回 publish_id。发布失败抛 WechatError。"""
    data = _post_json("/cgi-bin/freepublish/submit", {"media_id": draft_media_id}, token)
    publish_id = data.get("publish_id")
    if not publish_id:
        raise WechatError("发布接口没有返回 publish_id")
    if not wait:
        return str(publish_id)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(3)
        st = _post_json("/cgi-bin/freepublish/get", {"publish_id": publish_id}, token)
        # publish_status: 0 成功 / 1 发布中 / 2 原创失败 / 3 常规失败 / 4 平台审核不过 / 5 已删除
        status = int(st.get("publish_status", -1))
        if status == 0:
            return str(publish_id)
        if status >= 2:
            raise WechatError(f"发布失败（status={status}）: {st.get('fail_msg') or st}")
    raise WechatError("发布状态轮询超时")


def blog_post_url(date: str) -> str:
    return f"https://ten2net.github.io/post/{date}-每日复盘/"


def publish_review(reviews_dir: Path | str, date: str, *, draft_only: bool = True,
                   cover: Path | None = None,
                   log: Callable[[str], None] = lambda _m: None) -> dict:
    """一篇复盘 → 公众号草稿（可选直接发布）。微信侧失败抛 WechatError。"""
    payload = load_review(reviews_dir, date)   # 缺文件/没正文如实报错
    check_public_text(payload)                 # 与博客同一道不荐股闸门
    focus = payload.get("focus") or {}
    one = str(focus.get("market_oneliner") or "")
    title = post_title(payload, date)
    content = article_html(payload, date, blog_post_url(date))
    log(f"{date}：正文 {len(content)} 字符")
    token = get_access_token()
    thumb = upload_cover(token, cover or card_cover(date))
    draft_id = add_draft(token, title=title, content=content, digest=one[:120],
                         source_url=blog_post_url(date), thumb_media_id=thumb)
    log(f"{date}：已写入草稿箱 {draft_id}")
    result = {"date": date, "draft_id": draft_id, "publish_id": ""}
    if not draft_only:
        result["publish_id"] = freepublish(token, draft_id)
        log(f"{date}：已提交发布 {result['publish_id']}")
    return result

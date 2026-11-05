"""微信公众号发布客户端：草稿箱 → 发布。订阅号（已认证）专用。

凭据只从环境变量 / .env 读（WECHAT_APPID / WECHAT_SECRET），不入库、不进日志。
封面图全站复用一张（硬币徽章），media_id 缓存在数据区，避免每天累积永久素材。

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
# 全部复盘文章共用的封面（仓库里的硬币徽章）；None=不上封面（草稿接口里 thumb_media_id 必填，必须给）
DEFAULT_COVER = Path(__file__).resolve().parents[1] / "blog" / "static" / "img" / "avatar.png"

# 微信 IP 白名单按调用方出口 IP 校验：必须直连，绝不能走环境变量里的代理
# （容器部署里 http_proxy 会把请求发到代理出口，微信看到的 IP 就不在白名单里）。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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


def upload_cover(token: str, image: Path | None = None) -> str:
    """上传永久图片素材，返回 media_id。全站一张封面，media_id 按天缓存。"""
    image = Path(image or DEFAULT_COVER)
    if not image.exists():
        raise WechatError(f"封面图不存在：{image}")
    cache_file = Path(data_path("reviews")).parent / "wechat-cover.json"
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        if cached.get("media_id") and time.time() < float(cached.get("expires_at", 0)):
            return str(cached["media_id"])
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
        cache_file.write_text(json.dumps({"media_id": media_id, "expires_at": time.time() + 30 * 86400}),
                              encoding="utf-8")
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
    thumb = upload_cover(token, cover)
    draft_id = add_draft(token, title=title, content=content, digest=one[:120],
                         source_url=blog_post_url(date), thumb_media_id=thumb)
    log(f"{date}：已写入草稿箱 {draft_id}")
    result = {"date": date, "draft_id": draft_id, "publish_id": ""}
    if not draft_only:
        result["publish_id"] = freepublish(token, draft_id)
        log(f"{date}：已提交发布 {result['publish_id']}")
    return result

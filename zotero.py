"""Read-only bridge to the user's locally running Zotero."""
from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import requests

import storage


class ZoteroError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 180.0


def _base_and_user() -> tuple[str, str]:
    config = storage.load_config()
    base = str(config.get("zotero_api") or "http://127.0.0.1:23119").rstrip("/")
    user = str(config.get("zotero_user_id") or "0").strip() or "0"
    return base, user


def _get(path: str, params: dict[str, Any] | None = None, timeout: float = 6.0) -> Any:
    base, user = _base_and_user()
    url = f"{base}/api/users/{user}/{path.lstrip('/')}"
    try:
        response = requests.get(url, params=params, timeout=timeout)
    except requests.RequestException as exc:
        raise ZoteroError(
            "offline",
            "连接不上本机 Zotero。请先打开 Zotero 桌面端，并确认已启用本地 API。",
        ) from exc
    if response.status_code == 404:
        raise ZoteroError("not_found", "Zotero 中没有找到这个条目。")
    if response.status_code != 200:
        raise ZoteroError("http", f"Zotero 返回 HTTP {response.status_code}。")
    try:
        return response.json()
    except ValueError as exc:
        raise ZoteroError("parse", "Zotero 返回了无法解析的数据。") from exc


def _item_year(data: dict[str, Any]) -> str:
    raw = str(data.get("date") or "")
    match = re.search(r"(19|20)\d{2}", raw)
    return match.group(0) if match else ""


def _venue(data: dict[str, Any]) -> str:
    for key in (
        "publicationTitle",
        "proceedingsTitle",
        "bookTitle",
        "repository",
        "university",
        "publisher",
    ):
        value = str(data.get(key) or "").strip()
        if value:
            return value
    return ""


def _authors(data: dict[str, Any]) -> list[str]:
    creators = data.get("creators") or []
    preferred = []
    fallback = []
    for creator in creators:
        if not isinstance(creator, dict):
            continue
        name = str(creator.get("name") or "").strip()
        if not name:
            given = str(creator.get("firstName") or "").strip()
            family = str(creator.get("lastName") or "").strip()
            name = (given + " " + family).strip()
        if not name:
            continue
        creator_type = creator.get("creatorType", "")
        if creator_type in {"author", "inventor", "presenter"}:
            preferred.append(name)
        elif creator_type in {"editor", "contributor"}:
            fallback.append(name)
    return (preferred or fallback)[:20]


def _tags(data: dict[str, Any]) -> list[str]:
    result = []
    for tag in data.get("tags") or []:
        if isinstance(tag, dict):
            value = str(tag.get("tag") or "").strip()
        else:
            value = str(tag).strip()
        if value and not value.startswith("//") and len(value) < 36:
            result.append(value)
    return result[:10]


def _children(item_key: str) -> list[dict[str, Any]]:
    now = time.time()
    with _CACHE_LOCK:
        cached = _CACHE.get(item_key)
        if cached and now - cached[0] < _CACHE_TTL:
            return cached[1]
    children = _get(f"items/{item_key}/children", {"format": "json"})
    if not isinstance(children, list):
        children = []
    with _CACHE_LOCK:
        _CACHE[item_key] = (now, children)
    return children


def _pick_pdf(children: list[dict[str, Any]]) -> dict[str, Any] | None:
    candidates = []
    for child in children:
        data = child.get("data") or {}
        if data.get("contentType") != "application/pdf" and not str(data.get("filename", "")).lower().endswith(".pdf"):
            continue
        filename = str(data.get("filename") or "")
        title = str(data.get("title") or "")
        enclosure = ((child.get("links") or {}).get("enclosure") or {}).get("href", "")
        if not enclosure:
            continue
        score = 0
        if title.strip().lower() == "pdf":
            score += 8
        if ".zh-cn" in filename.lower():
            score -= 8
        if "translated" in title.lower() or "翻译" in title:
            score -= 4
        if "mono" in filename.lower():
            score -= 1
        candidates.append((score, filename, child))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return candidates[0][2]


def _has_pdf(children: list[dict[str, Any]]) -> bool:
    return _pick_pdf(children) is not None


def _describe(item: dict[str, Any], has_pdf: bool) -> dict[str, Any]:
    data = item.get("data") or {}
    return {
        "key": item.get("key") or data.get("key"),
        "title": str(data.get("title") or data.get("caseName") or "未命名条目"),
        "authors": _authors(data),
        "year": _item_year(data),
        "venue": _venue(data),
        "doi": str(data.get("DOI") or ""),
        "item_type": str(data.get("itemType") or ""),
        "has_pdf": has_pdf,
    }


def search_items(query: str = "", limit: int = 30) -> list[dict[str, Any]]:
    params: dict[str, Any] = {
        "format": "json",
        "limit": max(1, min(int(limit), 60)),
        "sort": "dateAdded" if not query.strip() else "title",
        "direction": "desc" if not query.strip() else "asc",
    }
    if query.strip():
        params["q"] = query.strip()
        params["qmode"] = "everything"
    items = _get("items/top", params)
    if not isinstance(items, list):
        return []
    allowed = {
        "journalArticle",
        "conferencePaper",
        "book",
        "bookSection",
        "thesis",
        "report",
        "preprint",
        "manuscript",
        "document",
    }
    items = [
        item
        for item in items
        if (item.get("data") or {}).get("itemType") in allowed
        and not (item.get("data") or {}).get("deleted")
    ]

    def enrich(item: dict[str, Any]) -> dict[str, Any]:
        key = item.get("key") or (item.get("data") or {}).get("key")
        try:
            children = _children(str(key))
        except ZoteroError:
            children = []
        return _describe(item, _has_pdf(children))

    with ThreadPoolExecutor(max_workers=8) as pool:
        described = list(pool.map(enrich, items[:limit]))
    return [item for item in described if item.get("key")]


def _resolve_file_url(href: str) -> Path | None:
    if not href:
        return None
    parsed = urlparse(href)
    if parsed.scheme != "file":
        return None
    path_text = unquote(parsed.path)
    if re.match(r"^/[A-Za-z]:/", path_text):
        path_text = path_text[1:]
    return Path(path_text)


def import_item(item_key: str) -> tuple[dict[str, Any], bool]:
    if not re.fullmatch(r"[A-Za-z0-9]{8}", item_key or ""):
        raise ZoteroError("invalid", "条目编号格式不正确。")
    item = _get(f"items/{item_key}", {"format": "json"})
    data = item.get("data") or {}
    if data.get("itemType") == "attachment":
        raise ZoteroError("invalid", "请选择文献条目，而不是附件。")
    children = _get(f"items/{item_key}/children", {"format": "json"})
    if not isinstance(children, list):
        children = []
    attachment = _pick_pdf(children)
    if not attachment:
        raise ZoteroError("no_pdf", "这个条目没有 PDF 附件。请先在 Zotero 中下载全文，再试一次。")
    att_data = attachment.get("data") or {}
    href = ((attachment.get("links") or {}).get("enclosure") or {}).get("href", "")
    pdf_path = _resolve_file_url(href)
    if not pdf_path or not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        raise ZoteroError(
            "file_missing",
            "找到了 PDF 附件，但本机文件不可访问。若文件在外部目录，请确认 Zotero 中的链接仍然有效。",
        )

    doi = str(data.get("DOI") or "").strip()
    if doi:
        for existing in storage.list_papers():
            if (existing.get("doi") or "").strip().lower() == doi.lower():
                return existing, True

    hint = {
        "title": str(data.get("title") or ""),
        "authors": _authors(data),
        "year": _item_year(data),
        "venue": _venue(data),
        "doi": doi,
        "abstract": str(data.get("abstractNote") or ""),
        "url": str(data.get("url") or ""),
        "volume": str(data.get("volume") or ""),
        "issue": str(data.get("issue") or ""),
        "pages": str(data.get("pages") or ""),
        "tags": _tags(data),
        "zotero_key": item_key,
    }
    filename = str(att_data.get("filename") or pdf_path.name or "zotero.pdf")
    meta, duplicate = storage.import_pdf(pdf_path, filename, hint=hint, source="zotero")
    return meta, duplicate


def test_connection() -> dict[str, Any]:
    base, user = _base_and_user()
    started = time.time()
    items = _get("items/top", {"format": "json", "limit": 1}, timeout=4.0)
    return {
        "ok": True,
        "api": base,
        "user_id": user,
        "items": len(items) if isinstance(items, list) else 0,
        "ms": int((time.time() - started) * 1000),
    }

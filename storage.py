"""Local data layer for the literature workbench.

Everything is stored as plain files under ./data so the library is easy to
inspect, back up and keep private.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import pymupdf
import requests

FROZEN = bool(getattr(sys, "frozen", False))
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def _resolve_data_dir() -> Path:
    """Keep the library next to the exe when frozen, with a writable fallback."""
    if not FROZEN:
        return RESOURCE_DIR / "data"
    candidate = Path(sys.executable).resolve().parent / "data"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return candidate
    except OSError:
        root = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
        fallback = root / "LanduWorkbench" / "data"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


DATA_DIR = _resolve_data_dir()
PAPERS_DIR = DATA_DIR / "papers"
COMPARISONS_DIR = DATA_DIR / "comparisons"
TMP_DIR = DATA_DIR / "tmp"
TRASH_DIR = DATA_DIR / "trash"
CONFIG_PATH = DATA_DIR / "config.json"
CATEGORIES_PATH = DATA_DIR / "categories.json"
OBSIDIAN_MANIFEST_PATH = DATA_DIR / "obsidian_exports.json"
OBSIDIAN_DEFAULT_FOLDER = "澜读文献"
CATEGORY_PALETTE = (
    "#4f7b67",
    "#a46b3f",
    "#5b7d97",
    "#8a7a45",
    "#8a5a72",
    "#6e7f5a",
    "#96704b",
    "#5f6f8f",
)
CATEGORY_ID_RE = re.compile(r"cat_[0-9a-f]{8}$")
CATEGORY_NAME_MAX = 24
CATEGORY_LIMIT = 30

_LOCK = threading.RLock()
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}

DEFAULT_CONFIG: dict[str, Any] = {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "api_key": "",
    "research_profile": "",
    "context_char_limit": 130000,
    "auto_analyze": True,
    "auto_takeaways": True,
    "obsidian_vault": "",
    "obsidian_folder": OBSIDIAN_DEFAULT_FOLDER,
    "lan_access": False,
    "lan_pin": "",
    "zotero_api": "http://127.0.0.1:23119",
    "zotero_user_id": "0",
}

ALLOWED_CONFIG_KEYS = set(DEFAULT_CONFIG.keys())

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b", re.I)
REFERENCE_HEAD_RE = re.compile(
    r"^\s*(references|bibliography|literature cited|参考文献|引用文献)\s*$",
    re.I | re.M,
)
SECTION_HINTS = (
    "abstract",
    "introduction",
    "method",
    "material",
    "result",
    "discussion",
    "conclusion",
    "摘要",
    "引言",
    "方法",
    "材料",
    "结果",
    "讨论",
    "结论",
)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def ensure_dirs() -> None:
    for directory in (DATA_DIR, PAPERS_DIR, COMPARISONS_DIR, TMP_DIR, TRASH_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def load_config() -> dict[str, Any]:
    with _LOCK:
        config = dict(DEFAULT_CONFIG)
        stored = _read_json(CONFIG_PATH, {})
        if isinstance(stored, dict):
            for key, value in stored.items():
                if key in ALLOWED_CONFIG_KEYS:
                    config[key] = value
        return config


def save_config(patch: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        config = load_config()
        for key, value in patch.items():
            if key not in ALLOWED_CONFIG_KEYS:
                continue
            if key == "api_key":
                if isinstance(value, str) and value.strip():
                    config[key] = value.strip()
                continue
            if key == "context_char_limit":
                try:
                    config[key] = max(20000, min(180000, int(value)))
                except (TypeError, ValueError):
                    continue
            elif key == "auto_analyze":
                config[key] = bool(value)
            elif key == "auto_takeaways":
                config[key] = bool(value)
            elif key == "lan_access":
                config[key] = bool(value)
            elif key == "lan_pin":
                config[key] = str(value).strip()
            elif key == "zotero_user_id":
                config[key] = str(value).strip() or "0"
            elif key == "base_url":
                clean = str(value).strip().rstrip("/")
                if clean:
                    config[key] = clean
            elif key == "model":
                clean = str(value).strip()
                if clean:
                    config[key] = clean
            elif key == "api_key":
                continue
            else:
                config[key] = str(value).strip() if isinstance(value, str) else value
        if patch.get("clear_api_key"):
            config["api_key"] = ""
        _write_json(CONFIG_PATH, config)
        return config


def public_settings() -> dict[str, Any]:
    config = load_config()
    key = config.get("api_key", "")
    hint = ""
    if key:
        hint = key[:3] + "…" + key[-4:] if len(key) > 9 else "已设置"
    safe = {k: v for k, v in config.items() if k != "api_key"}
    safe["api_key_set"] = bool(key)
    safe["api_key_hint"] = hint
    safe["data_dir"] = str(DATA_DIR)
    return safe


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------


def _clean_category_name(name: Any) -> str:
    text = re.sub(r"[\x00-\x1f]+", " ", str(name or ""))
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        raise ValueError("分类名称不能为空")
    if text == "未分类":
        raise ValueError("「未分类」是保留名称，请换一个名字")
    if len(text) > CATEGORY_NAME_MAX:
        raise ValueError(f"分类名称最多 {CATEGORY_NAME_MAX} 个字")
    return text


def _clean_category_color(color: Any, fallback_index: int = 0) -> str:
    text = str(color or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return text.lower()
    return CATEGORY_PALETTE[fallback_index % len(CATEGORY_PALETTE)]


def _category_records() -> list[dict[str, Any]]:
    payload = _read_json(CATEGORIES_PATH, [])
    if isinstance(payload, dict):
        raw_items = payload.get("categories", [])
    elif isinstance(payload, list):
        raw_items = payload
    else:
        raw_items = []
    if not isinstance(raw_items, list):
        return []
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            continue
        category_id = str(raw.get("id") or "").strip()
        if not CATEGORY_ID_RE.fullmatch(category_id) or category_id in seen:
            continue
        name = re.sub(r"[\x00-\x1f]+", " ", str(raw.get("name") or ""))
        name = re.sub(r"\s+", " ", name).strip()[:CATEGORY_NAME_MAX]
        if not name:
            continue
        try:
            order = int(raw.get("order", index))
        except (TypeError, ValueError):
            order = index
        seen.add(category_id)
        items.append(
            {
                "id": category_id,
                "name": name,
                "color": _clean_category_color(raw.get("color"), index),
                "order": order,
                "created_at": str(raw.get("created_at") or ""),
            }
        )
    items.sort(key=lambda item: (item["order"], item["created_at"], item["name"].lower()))
    return items


def _save_category_records(items: list[dict[str, Any]]) -> None:
    _write_json(CATEGORIES_PATH, {"version": 1, "categories": items})


def list_categories() -> list[dict[str, Any]]:
    with _LOCK:
        return _category_records()


def category_names_for_ids(category_ids: list[str] | None) -> list[str]:
    if not category_ids:
        return []
    names = {item["id"]: item["name"] for item in list_categories()}
    return [names[category_id] for category_id in category_ids if category_id in names]


def create_category(name: Any, color: Any = "") -> dict[str, Any]:
    with _LOCK:
        clean_name = _clean_category_name(name)
        items = _category_records()
        if len(items) >= CATEGORY_LIMIT:
            raise ValueError(f"最多创建 {CATEGORY_LIMIT} 个分类")
        if any(item["name"].casefold() == clean_name.casefold() for item in items):
            raise ValueError("已经有同名分类了")
        existing_ids = {item["id"] for item in items}
        for _ in range(20):
            category_id = "cat_" + uuid.uuid4().hex[:8]
            if category_id not in existing_ids:
                break
        else:
            raise ValueError("分类编号冲突，请重试")
        category = {
            "id": category_id,
            "name": clean_name,
            "color": _clean_category_color(color, len(items)),
            "order": max((item["order"] for item in items), default=0) + 1,
            "created_at": now_iso(),
        }
        items.append(category)
        _save_category_records(items)
        return dict(category)


def update_category(category_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    if not CATEGORY_ID_RE.fullmatch(str(category_id or "")):
        raise ValueError("无效的分类编号")
    with _LOCK:
        items = _category_records()
        target = next((item for item in items if item["id"] == category_id), None)
        if not target:
            raise FileNotFoundError("分类不存在")
        if "name" in patch:
            clean_name = _clean_category_name(patch.get("name"))
            if any(
                item["id"] != category_id and item["name"].casefold() == clean_name.casefold()
                for item in items
            ):
                raise ValueError("已经有同名分类了")
            target["name"] = clean_name
        if "color" in patch:
            color = str(patch.get("color") or "").strip()
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                raise ValueError("颜色格式不正确")
            target["color"] = color.lower()
        _save_category_records(items)
        return dict(target)


def delete_category(category_id: str) -> dict[str, Any]:
    if not CATEGORY_ID_RE.fullmatch(str(category_id or "")):
        raise ValueError("无效的分类编号")
    with _LOCK:
        items = _category_records()
        if not any(item["id"] == category_id for item in items):
            raise FileNotFoundError("分类不存在")
        affected = 0
        for base_dir in (PAPERS_DIR, TRASH_DIR):
            for meta_path in base_dir.glob("*/meta.json"):
                meta = _read_json(meta_path, {})
                if not isinstance(meta, dict):
                    continue
                category_ids = meta.get("categories")
                if not isinstance(category_ids, list) or category_id not in category_ids:
                    continue
                meta["categories"] = [value for value in category_ids if value != category_id]
                _write_json(meta_path, meta)
                affected += 1
        _save_category_records([item for item in items if item["id"] != category_id])
        return {"id": category_id, "affected": affected}


def clean_category_ids(values: Any) -> list[str]:
    valid_ids = {item["id"] for item in list_categories()}
    raw_values = values if isinstance(values, list) else [values]
    result: list[str] = []
    for value in raw_values:
        category_id = str(value or "").strip()
        if category_id in valid_ids and category_id not in result:
            result.append(category_id)
    return result[:12]


# ---------------------------------------------------------------------------
# PDF extraction and metadata
# ---------------------------------------------------------------------------


def _clean_text(text: str) -> str:
    text = text.replace("\x00", " ")
    text = text.replace("\u00a0", " ")
    # Re-join words split by a hyphen at a line break.
    text = re.sub(r"(?<=[A-Za-z])-\n(?=[a-z])", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _strip_running_lines(pages: list[str]) -> list[str]:
    """Remove repeated running headers/footers and lone page numbers."""
    if len(pages) < 5:
        return pages
    first_counts: dict[str, int] = {}
    last_counts: dict[str, int] = {}
    for text in pages:
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if not lines:
            continue
        first_counts[lines[0]] = first_counts.get(lines[0], 0) + 1
        last_counts[lines[-1]] = last_counts.get(lines[-1], 0) + 1
    threshold = max(3, int(len(pages) * 0.4))
    repeated = {
        line
        for line, count in {**first_counts, **last_counts}.items()
        if count >= threshold and 2 < len(line) < 180
    }
    cleaned = []
    for text in pages:
        lines = text.splitlines()
        out: list[str] = []
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if stripped and stripped in repeated:
                continue
            if stripped.isdigit() and idx in (0, 1, len(lines) - 2, len(lines) - 1):
                continue
            out.append(line)
        cleaned.append(_clean_text("\n".join(out)))
    return cleaned


def extract_pages(pdf_path: Path) -> tuple[list[str], dict[str, Any], list[str]]:
    warnings: list[str] = []
    doc = pymupdf.open(pdf_path)
    try:
        if doc.needs_pass:
            raise ValueError("PDF 已加密，无法读取")
        pages = [_clean_text(page.get_text("text")) for page in doc]
        raw_meta = dict(doc.metadata or {})
        page_count = doc.page_count
        toc: list[list[Any]] = []
        try:
            toc = doc.get_toc(simple=True) or []
        except Exception:
            pass
    finally:
        doc.close()

    pages = _strip_running_lines(pages)
    total_chars = sum(len(text) for text in pages)
    non_empty = sum(1 for text in pages if len(text) > 40)
    if page_count == 0 or total_chars < 120:
        raise ValueError("没有抽取到可用文字；这可能是扫描版 PDF（首版暂不支持 OCR）")
    if non_empty / max(page_count, 1) < 0.5:
        warnings.append("部分页面没有文字层，可能是扫描件；相关页面的分析会不完整。")
    if raw_meta.get("encryption"):
        warnings.append("PDF 带有加密标记，解析质量可能受影响。")
    raw_meta["_page_count"] = page_count
    raw_meta["_toc"] = toc
    raw_meta["_total_chars"] = total_chars
    return pages, raw_meta, warnings


def _find_doi(text: str) -> str:
    patterns = [
        r"doi\.org/(10\.\d{4,9}/[^\s<>\"']+)",
        r"\bDOI\s*[:：]\s*(10\.\d{4,9}/[^\s<>\"']+)",
        r"\bdoi\s*[:：]\s*(10\.\d{4,9}/[^\s<>\"']+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return match.group(1).rstrip(".,;)]}")
    match = DOI_RE.search(text)
    return match.group(0).rstrip(".,;)]}") if match else ""


def _strip_tags(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value or "")
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def crossref_lookup(doi: str, timeout: float = 8.0) -> dict[str, Any]:
    if not doi:
        return {}
    try:
        response = requests.get(
            "https://api.crossref.org/works/" + requests.utils.quote(doi, safe=""),
            timeout=timeout,
            headers={
                "User-Agent": "LanduPaperWorkbench/1.0 (local research tool)",
                "Accept": "application/json",
            },
        )
        if response.status_code != 200:
            return {}
        message = response.json().get("message", {})
    except (requests.RequestException, ValueError):
        return {}

    def pick_year() -> str:
        for key in ("published-print", "published-online", "issued", "created"):
            parts = message.get(key, {}).get("date-parts") or []
            if parts and parts[0] and parts[0][0]:
                return str(parts[0][0])
        return ""

    authors = []
    for author in message.get("author", []) or []:
        if author.get("family"):
            given = author.get("given", "").strip()
            authors.append((given + " " + author["family"]).strip())
        elif author.get("name"):
            authors.append(author["name"].strip())
    titles = message.get("title") or []
    venues = message.get("container-title") or message.get("short-container-title") or []
    return {
        "title": _strip_tags(titles[0]) if titles else "",
        "authors": authors,
        "year": pick_year(),
        "venue": _strip_tags(venues[0]) if venues else "",
        "doi": message.get("DOI", doi),
        "abstract": _strip_tags(message.get("abstract", "")),
        "volume": message.get("volume", "") or "",
        "issue": message.get("issue", "") or "",
        "pages": message.get("page", "") or "",
        "url": message.get("URL", "") or "",
    }


def _guess_title(page_text: str, fallback: str) -> str:
    lines = [ln.strip() for ln in page_text.splitlines() if ln.strip()]
    skip = re.compile(
        r"(water research|science of the total|journal of|volume|doi|http|received|accepted|"
        r"available online|contents lists|copyright|©|elsevier|springer|wiley|mdpi|abstract)",
        re.I,
    )
    for line in lines[:18]:
        if 25 <= len(line) <= 240 and not skip.search(line) and line.count(" ") >= 3:
            return line
    return fallback


def _guess_abstract(pages: list[str]) -> str:
    text = "\n".join(pages[:3])
    match = re.search(r"\bAbstract\b\s*[:.\-—]?\s*(.{120,2600}?)(?:\n\s*(?:Keywords|Key words|1\.\s*Introduction|©)|\Z)", text, re.S | re.I)
    if match:
        return re.sub(r"\s+", " ", match.group(1)).strip()
    return ""


def _clean_tags(values: list[str]) -> list[str]:
    seen: set[str] = set()
    tags: list[str] = []
    for value in values:
        for part in re.split(r"[;,，；]", value or ""):
            tag = part.strip().strip("/").strip()
            if not tag or len(tag) > 36:
                continue
            if tag.lower() in {"done", "todo", "read", "unread"}:
                continue
            key = tag.casefold()
            if key not in seen:
                seen.add(key)
                tags.append(tag)
    return tags[:10]


def build_metadata(
    pages: list[str],
    raw_meta: dict[str, Any],
    filename: str,
    hint: dict[str, Any] | None = None,
    use_crossref: bool = True,
) -> dict[str, Any]:
    hint = hint or {}
    first_pages = "\n".join(pages[:3])
    doi = hint.get("doi") or _find_doi(
        "\n".join(
            [
                raw_meta.get("subject", "") or "",
                raw_meta.get("keywords", "") or "",
                first_pages,
            ]
        )
    )
    fallback_title = Path(filename).stem.replace("_", " ").strip()
    title = (hint.get("title") or raw_meta.get("title") or "").strip()
    authors = list(hint.get("authors") or [])
    year = str(hint.get("year") or "")
    venue = (hint.get("venue") or "").strip()
    abstract = (hint.get("abstract") or "").strip()
    url = (hint.get("url") or "").strip()
    volume = str(hint.get("volume") or "")
    issue = str(hint.get("issue") or "")
    page_range = str(hint.get("pages") or "")
    tags = _clean_tags(list(hint.get("tags") or []))

    if use_crossref and doi:
        crossref = crossref_lookup(doi)
        if crossref:
            title = title or crossref.get("title", "")
            authors = authors or crossref.get("authors", [])
            year = year or crossref.get("year", "")
            venue = venue or crossref.get("venue", "")
            abstract = abstract or crossref.get("abstract", "")
            volume = volume or crossref.get("volume", "")
            issue = issue or crossref.get("issue", "")
            page_range = page_range or crossref.get("pages", "")
            url = url or crossref.get("url", "")

    if not title:
        title = _guess_title(pages[0] if pages else "", fallback_title)
    if not authors:
        raw_author = (raw_meta.get("author") or "").strip()
        if raw_author and len(raw_author) < 300:
            authors = [part.strip() for part in re.split(r";|,\s*(?=[A-Z])", raw_author) if part.strip()]
    if not year:
        joined = " ".join([raw_meta.get("creationDate", "") or "", first_pages[:1500]])
        years = re.findall(r"\b(19[89]\d|20[0-3]\d)\b", joined)
        year = years[0] if years else ""
    if not venue:
        subject = raw_meta.get("subject") or ""
        venue = re.split(r"[,;]", subject)[0].strip() if subject else ""
    if not abstract:
        abstract = _guess_abstract(pages)
    if not tags:
        keywords = raw_meta.get("keywords") or ""
        tags = _clean_tags([keywords])

    return {
        "title": re.sub(r"\s+", " ", title).strip() or fallback_title,
        "authors": authors[:20],
        "year": year,
        "venue": venue,
        "doi": doi,
        "abstract": abstract[:4000],
        "url": url,
        "volume": volume,
        "issue": issue,
        "pages": page_range,
        "tags": tags,
    }


def _guess_summary(card: str) -> str:
    match = re.search(r"##\s*一句话结论\s*\n+(.+?)(?=\n##|\Z)", card, re.S)
    if not match:
        return ""
    text = re.sub(r"\[p\.\d+\]", "", match.group(1))
    text = re.sub(r"[*_#>`]", "", text)
    return re.sub(r"\s+", " ", text).strip()[:220]


def paper_dir(paper_id: str) -> Path:
    if not re.fullmatch(r"p_[0-9a-f]{12}", paper_id or ""):
        raise ValueError("无效的文献编号")
    path = (PAPERS_DIR / paper_id).resolve()
    if PAPERS_DIR.resolve() not in path.parents:
        raise ValueError("无效的文献路径")
    return path


def read_meta(paper_id: str) -> dict[str, Any]:
    path = paper_dir(paper_id) / "meta.json"
    meta = _read_json(path, None)
    if not isinstance(meta, dict):
        raise FileNotFoundError("文献不存在")
    return meta


def write_meta(meta: dict[str, Any]) -> None:
    with _LOCK:
        meta["updated_at"] = now_iso()
        _write_json(paper_dir(meta["id"]) / "meta.json", meta)


def load_pages(paper_id: str) -> list[dict[str, Any]]:
    path = paper_dir(paper_id) / "pages.json"
    pages = _read_json(path, [])
    return pages if isinstance(pages, list) else []


def pages_as_text(paper_id: str) -> list[str]:
    return [item.get("text", "") for item in load_pages(paper_id)]


def get_card(paper_id: str) -> str:
    path = paper_dir(paper_id) / "card.md"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def save_card(paper_id: str, card: str, focus: str, model: str) -> dict[str, Any]:
    path = paper_dir(paper_id) / "card.md"
    path.write_text(card.strip() + "\n", encoding="utf-8")
    meta = read_meta(paper_id)
    meta["card_updated_at"] = now_iso()
    meta["card_focus"] = focus
    meta["card_model"] = model
    meta["summary"] = _guess_summary(card)
    write_meta(meta)
    return meta


def get_notes(paper_id: str) -> str:
    try:
        return (paper_dir(paper_id) / "notes.md").read_text(encoding="utf-8")
    except OSError:
        return ""


def save_notes(paper_id: str, notes: str) -> None:
    (paper_dir(paper_id) / "notes.md").write_text(notes, encoding="utf-8")
    meta = read_meta(paper_id)
    meta["notes_updated_at"] = now_iso()
    write_meta(meta)


def get_takeaways(paper_id: str) -> str:
    try:
        return (paper_dir(paper_id) / "takeaways.md").read_text(encoding="utf-8")
    except OSError:
        return ""


def save_takeaways(paper_id: str, takeaways: str) -> dict[str, Any]:
    (paper_dir(paper_id) / "takeaways.md").write_text(takeaways, encoding="utf-8")
    meta = read_meta(paper_id)
    meta["takeaways_updated_at"] = now_iso()
    write_meta(meta)
    return meta


def get_chat(paper_id: str) -> list[dict[str, Any]]:
    data = _read_json(paper_dir(paper_id) / "chat.json", [])
    return data if isinstance(data, list) else []


def save_chat(paper_id: str, messages: list[dict[str, Any]]) -> None:
    trimmed = messages[-80:]
    _write_json(paper_dir(paper_id) / "chat.json", trimmed)


def clear_chat(paper_id: str) -> None:
    path = paper_dir(paper_id) / "chat.json"
    if path.exists():
        path.unlink()
    meta = read_meta(paper_id)
    meta["chat_updated_at"] = ""
    write_meta(meta)


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


DEMO_ID = "p_deadbeef0001"
DEMO_SRC_DIR = RESOURCE_DIR / "demo"


def import_demo() -> tuple[dict[str, Any], bool]:
    """Copy the bundled, clearly-labelled demo paper into the local library."""
    ensure_dirs()
    target_dir = PAPERS_DIR / DEMO_ID
    meta_path = target_dir / "meta.json"
    if meta_path.exists():
        meta = _read_json(meta_path, {})
        if isinstance(meta, dict) and meta.get("id"):
            return meta, True
    if target_dir.exists():
        shutil.rmtree(target_dir, ignore_errors=True)
    required = ("paper.pdf", "meta.json", "pages.json", "card.md", "chat.json", "notes.md")
    missing = [name for name in required if not (DEMO_SRC_DIR / name).exists()]
    if missing:
        raise FileNotFoundError("内置示例文件不完整：" + "、".join(missing))
    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        for name in required:
            shutil.copyfile(DEMO_SRC_DIR / name, target_dir / name)
        if (DEMO_SRC_DIR / "takeaways.md").exists():
            shutil.copyfile(DEMO_SRC_DIR / "takeaways.md", target_dir / "takeaways.md")
        meta = _read_json(target_dir / "meta.json", {})
        pages = _read_json(target_dir / "pages.json", [])
        chat = _read_json(target_dir / "chat.json", [])
        now = now_iso()
        meta.update(
            {
                "id": DEMO_ID,
                "demo": True,
                "source": "demo",
                "status": "read",
                "created_at": now,
                "updated_at": now,
                "card_updated_at": now,
                "notes_updated_at": now,
                "takeaways_updated_at": now,
                "chat_updated_at": now,
                "page_count": len(pages),
                "text_chars": sum(len(item.get("text", "")) for item in pages),
                "chat_count": len(chat),
            }
        )
        _write_json(target_dir / "meta.json", meta)
        return meta, False
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise


def _find_existing_by_sha(sha: str) -> dict[str, Any] | None:
    for meta_path in PAPERS_DIR.glob("*/meta.json"):
        meta = _read_json(meta_path, {})
        if meta.get("pdf_sha256") == sha:
            return meta
    return None


def _find_existing_by_doi(doi: str) -> dict[str, Any] | None:
    target = (doi or "").strip().lower()
    if not target:
        return None
    for meta_path in PAPERS_DIR.glob("*/meta.json"):
        meta = _read_json(meta_path, {})
        if str(meta.get("doi") or "").strip().lower() == target:
            return meta
    return None


def import_pdf(
    source_path: Path,
    original_name: str,
    hint: dict[str, Any] | None = None,
    source: str = "upload",
) -> tuple[dict[str, Any], bool]:
    ensure_dirs()
    sha = hashlib.sha256()
    with source_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(chunk)
    digest = sha.hexdigest()
    with _LOCK:
        existing = _find_existing_by_sha(digest)
    if existing:
        return existing, True

    paper_id = "p_" + uuid.uuid4().hex[:12]
    target_dir = PAPERS_DIR / paper_id
    target_dir.mkdir(parents=True, exist_ok=False)
    pdf_path = target_dir / "paper.pdf"
    try:
        shutil.copyfile(source_path, pdf_path)
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise

    try:
        pages, raw_meta, warnings = extract_pages(pdf_path)
        metadata = build_metadata(
            pages,
            raw_meta,
            original_name,
            hint=hint,
            use_crossref=not hint,
        )
        with _LOCK:
            existing = _find_existing_by_doi(metadata.get("doi", ""))
        if existing:
            shutil.rmtree(target_dir, ignore_errors=True)
            return existing, True
        page_items = [{"page": idx + 1, "text": text} for idx, text in enumerate(pages)]
        _write_json(target_dir / "pages.json", page_items)
        created = now_iso()
        meta = {
            "id": paper_id,
            **metadata,
            "status": "unread",
            "starred": False,
            "source": source,
            "pdf_filename": Path(original_name).name,
            "pdf_sha256": digest,
            "file_size": pdf_path.stat().st_size,
            "page_count": len(pages),
            "text_chars": sum(len(text) for text in pages),
            "scanned": not pages or sum(len(t) for t in pages) / max(len(pages), 1) < 80,
            "warnings": warnings,
            "summary": "",
            "created_at": created,
            "updated_at": created,
            "card_updated_at": "",
            "card_focus": "",
            "card_model": "",
            "notes_updated_at": "",
            "takeaways_updated_at": "",
            "chat_updated_at": "",
        }
        if hint and hint.get("zotero_key"):
            meta["zotero_key"] = hint["zotero_key"]
        _write_json(target_dir / "meta.json", meta)
        return meta, False
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise


def update_paper(paper_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    meta = read_meta(paper_id)
    allowed = {"title", "authors", "year", "venue", "doi", "status", "tags", "starred", "abstract", "categories"}
    for key, value in patch.items():
        if key not in allowed:
            continue
        if key == "authors":
            if isinstance(value, str):
                value = [part.strip() for part in re.split(r";|,", value) if part.strip()]
            meta[key] = list(value)[:20]
        elif key == "tags":
            meta[key] = _clean_tags(list(value) if isinstance(value, list) else [str(value)])
        elif key == "categories":
            meta[key] = clean_category_ids(value)
        elif key == "status":
            meta[key] = value if value in {"unread", "reading", "read"} else meta.get("status", "unread")
        elif key == "starred":
            meta[key] = bool(value)
        else:
            meta[key] = str(value).strip()
    write_meta(meta)
    return meta


def delete_paper(paper_id: str) -> None:
    path = paper_dir(paper_id)
    if path.exists():
        shutil.rmtree(path)


def trash_dir(trash_id: str) -> Path:
    if not re.fullmatch(r"t_[0-9a-f]{12}", trash_id or ""):
        raise ValueError("无效的回收站编号")
    path = (TRASH_DIR / trash_id).resolve()
    if TRASH_DIR.resolve() not in path.parents:
        raise ValueError("无效的回收站路径")
    return path


def trash_paper(paper_id: str) -> dict[str, Any]:
    """Move a paper folder to the local recycle bin instead of deleting it."""
    ensure_dirs()
    with _LOCK:
        meta = read_meta(paper_id)
        source = paper_dir(paper_id)
        trash_id = "t_" + uuid.uuid4().hex[:12]
        target = TRASH_DIR / trash_id
        if target.exists():
            raise ValueError("回收站编号冲突，请重试")
        meta["trash_id"] = trash_id
        meta["trashed_at"] = now_iso()
        meta["updated_at"] = meta["trashed_at"]
        shutil.move(str(source), str(target))
        _write_json(target / "meta.json", meta)
        return meta


def list_trash() -> list[dict[str, Any]]:
    ensure_dirs()
    items: list[dict[str, Any]] = []
    for meta_path in TRASH_DIR.glob("*/meta.json"):
        meta = _read_json(meta_path, {})
        if not isinstance(meta, dict) or not meta.get("id"):
            continue
        trash_id = meta.get("trash_id") or meta_path.parent.name
        if not re.fullmatch(r"t_[0-9a-f]{12}", trash_id or ""):
            continue
        meta = dict(meta)
        meta["trash_id"] = trash_id
        meta.pop("pdf_sha256", None)
        items.append(meta)
    items.sort(key=lambda item: item.get("trashed_at", ""), reverse=True)
    return items


def trash_count() -> int:
    try:
        return len(list_trash())
    except Exception:
        return 0


def restore_trash(trash_id: str) -> dict[str, Any]:
    ensure_dirs()
    with _LOCK:
        source = trash_dir(trash_id)
        meta = _read_json(source / "meta.json", None)
        if not isinstance(meta, dict) or not meta.get("id"):
            raise FileNotFoundError("回收站里没有这篇文献")
        paper_id = str(meta["id"])
        target = paper_dir(paper_id)
        if target.exists():
            raise ValueError("文献库中已有同一编号的文献，请先处理后再恢复")
        shutil.move(str(source), str(target))
        meta.pop("trash_id", None)
        meta.pop("trashed_at", None)
        meta["updated_at"] = now_iso()
        _write_json(target / "meta.json", meta)
        return meta


def delete_trash(trash_id: str) -> None:
    path = trash_dir(trash_id)
    if not path.exists():
        raise FileNotFoundError("回收站条目不存在")
    shutil.rmtree(path)


def empty_trash() -> tuple[list[str], list[dict[str, str]]]:
    ensure_dirs()
    deleted: list[str] = []
    failed: list[dict[str, str]] = []
    for item in list_trash():
        trash_id = item.get("trash_id", "")
        try:
            delete_trash(trash_id)
            deleted.append(trash_id)
        except Exception:
            failed.append({"id": trash_id, "error": "文件可能正在被占用"})
    return deleted, failed


def list_papers() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for meta_path in PAPERS_DIR.glob("*/meta.json"):
        meta = _read_json(meta_path, {})
        if isinstance(meta, dict) and meta.get("id"):
            meta.pop("pdf_sha256", None)
            items.append(meta)
    items.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return items


def library_stats(papers: list[dict[str, Any]]) -> dict[str, Any]:
    tags: dict[str, int] = {}
    for paper in papers:
        for tag in paper.get("tags", []):
            tags[tag] = tags.get(tag, 0) + 1
    categories = list_categories()
    category_counts = {category["id"]: 0 for category in categories}
    uncategorized = 0
    for paper in papers:
        paper_categories = paper.get("categories") if isinstance(paper.get("categories"), list) else []
        known = [category_id for category_id in paper_categories if category_id in category_counts]
        for category_id in set(known):
            category_counts[category_id] += 1
        if not known:
            uncategorized += 1
    for category in categories:
        category["count"] = category_counts.get(category["id"], 0)
    return {
        "total": len(papers),
        "unread": sum(1 for p in papers if p.get("status") == "unread"),
        "reading": sum(1 for p in papers if p.get("status") == "reading"),
        "read": sum(1 for p in papers if p.get("status") == "read"),
        "with_card": sum(1 for p in papers if p.get("card_updated_at")),
        "starred": sum(1 for p in papers if p.get("starred")),
        "tags": sorted(tags.items(), key=lambda pair: (-pair[1], pair[0])),
        "categories": categories,
        "uncategorized": uncategorized,
    }


# ---------------------------------------------------------------------------
# Context building for the model
# ---------------------------------------------------------------------------


def main_text_pages(pages: list[str]) -> list[str]:
    """Drop the reference list and back matter when we can find it."""
    if not pages:
        return []
    start = max(2, int(len(pages) * 0.4))
    for idx in range(start, len(pages)):
        match = REFERENCE_HEAD_RE.search(pages[idx])
        if match:
            before = pages[idx][: match.start()].strip()
            result = pages[:idx]
            if before:
                result.append(before)
            return result
    return pages


def build_context(
    pages: list[str],
    max_chars: int,
    query: str = "",
    include_note: bool = True,
) -> tuple[str, bool]:
    """Return page-marked context, plus whether it had to be sampled."""
    pages = main_text_pages(pages)
    if not pages:
        return "", False
    total = sum(len(page) for page in pages)
    if total <= max_chars:
        body = "\n\n".join(
            f"<<<PAGE {idx + 1}>>>\n{text}" for idx, text in enumerate(pages) if text.strip()
        )
        return body, False

    # Long document: keep opening/closing pages, section pages, query hits,
    # then fill the remaining budget evenly.
    chosen: set[int] = set(range(min(2, len(pages))))
    chosen.update(range(max(0, len(pages) - 3), len(pages)))
    for idx, text in enumerate(pages):
        head = "\n".join(text.splitlines()[:8]).lower()
        if any(hint in head for hint in SECTION_HINTS):
            chosen.add(idx)
    terms = [term.lower() for term in re.findall(r"[\w\u4e00-\u9fff]{3,}", query or "")][:12]
    if terms:
        hits = []
        for idx, text in enumerate(pages):
            lower = text.lower()
            score = sum(lower.count(term) for term in terms)
            if score:
                hits.append((score, idx))
        for _, idx in sorted(hits, reverse=True)[:10]:
            chosen.add(idx)

    budget = max_chars
    ordered: list[int] = []
    for idx in sorted(chosen):
        length = len(pages[idx]) + 24
        if length <= budget:
            ordered.append(idx)
            budget -= length
    if budget > 2000:
        for idx, text in enumerate(pages):
            if idx in chosen:
                continue
            length = len(text) + 24
            if length <= budget:
                ordered.append(idx)
                budget -= length
            if budget <= 2000:
                break
            if len(ordered) > 120:
                break
    ordered.sort()
    body = "\n\n".join(f"<<<PAGE {idx + 1}>>>\n{pages[idx]}" for idx in ordered)
    note = (
        "\n\n[说明：原文较长，以上为按原页码抽取的核心页面，并非全文；"
        "请在引用时仍然使用页面上标注的 PAGE 页码。]"
    )
    return body + (note if include_note else ""), True


def paper_context(paper_id: str, query: str = "", max_chars: int | None = None) -> tuple[str, bool]:
    config = load_config()
    limit = max_chars or int(config.get("context_char_limit", 100000))
    return build_context(pages_as_text(paper_id), limit, query=query)


# ---------------------------------------------------------------------------
# Comparisons
# ---------------------------------------------------------------------------


def comparison_dir(comp_id: str) -> Path:
    if not re.fullmatch(r"c_[0-9a-f]{12}", comp_id or ""):
        raise ValueError("无效的对比编号")
    path = (COMPARISONS_DIR / comp_id).resolve()
    if COMPARISONS_DIR.resolve() not in path.parents:
        raise ValueError("无效的对比路径")
    return path


def save_comparison(payload: dict[str, Any]) -> dict[str, Any]:
    comp_id = payload.get("id") or "c_" + uuid.uuid4().hex[:12]
    path = comparison_dir(comp_id) / "comparison.json"
    payload["id"] = comp_id
    payload["updated_at"] = now_iso()
    if not payload.get("created_at"):
        payload["created_at"] = payload["updated_at"]
    _write_json(path, payload)
    return payload


def list_comparisons() -> list[dict[str, Any]]:
    items = []
    for path in COMPARISONS_DIR.glob("*/comparison.json"):
        data = _read_json(path, {})
        if isinstance(data, dict) and data.get("id"):
            items.append(data)
    items.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return items


def read_comparison(comp_id: str) -> dict[str, Any]:
    path = comparison_dir(comp_id) / "comparison.json"
    data = _read_json(path, None)
    if not isinstance(data, dict):
        raise FileNotFoundError("对比不存在")
    return data


def delete_comparison(comp_id: str) -> None:
    path = comparison_dir(comp_id)
    if path.exists():
        shutil.rmtree(path)


# ---------------------------------------------------------------------------
# Obsidian export
# ---------------------------------------------------------------------------


def _obsidian_config_candidates() -> list[Path]:
    """Return likely locations of Obsidian's small vault registry."""
    home = Path.home()
    candidates: list[Path] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "obsidian" / "obsidian.json")
    candidates.extend(
        [
            home / ".config" / "obsidian" / "obsidian.json",
            home / "Library" / "Application Support" / "obsidian" / "obsidian.json",
        ]
    )
    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def detect_obsidian_vaults() -> list[dict[str, Any]]:
    """Read Obsidian's vault registry. This is read-only and never creates files."""
    found: dict[str, dict[str, Any]] = {}
    for config_path in _obsidian_config_candidates():
        payload = _read_json(config_path, {})
        vaults = payload.get("vaults") if isinstance(payload, dict) else None
        if not isinstance(vaults, dict):
            continue
        for vault_id, info in vaults.items():
            if not isinstance(info, dict):
                continue
            raw_path = str(info.get("path") or "").strip()
            if not raw_path:
                continue
            try:
                vault = Path(raw_path).expanduser().resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if not vault.is_dir() or not (vault / ".obsidian").is_dir():
                continue
            try:
                last_used = int(info.get("ts") or 0)
            except (TypeError, ValueError):
                last_used = 0
            record = {
                "id": str(vault_id),
                "name": vault.name or str(vault),
                "path": str(vault),
                "open": bool(info.get("open")),
                "last_used": last_used,
            }
            previous = found.get(str(vault))
            if previous:
                previous["open"] = previous["open"] or record["open"]
                previous["last_used"] = max(previous["last_used"], record["last_used"])
            else:
                found[str(vault)] = record
    items = list(found.values())
    items.sort(key=lambda item: (not item["open"], -item["last_used"], item["name"].lower()))
    return items


def validate_obsidian_vault(vault_path: str) -> Path:
    raw = str(vault_path or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        raw = raw[1:-1].strip()
    if not raw:
        raise ValueError("请先选择 Obsidian 笔记库")
    try:
        vault = Path(raw).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError("找不到这个笔记库路径，请检查路径是否正确") from exc
    if vault.name == ".obsidian" and (vault.parent / ".obsidian").is_dir():
        vault = vault.parent
    if not vault.is_dir():
        raise ValueError("这个路径不是文件夹")
    if not (vault / ".obsidian").is_dir():
        raise ValueError("这个文件夹不是 Obsidian 笔记库（缺少 .obsidian 文件夹）")
    return vault


def _safe_path_component(value: Any) -> str:
    text = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", " ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip(" .")
    if not text:
        text = "未命名"
    if text.split(".", 1)[0].strip().upper() in _WINDOWS_RESERVED_NAMES:
        text = "_" + text
    return text[:60].rstrip(" .") or "未命名"


def normalize_obsidian_folder(folder: str) -> str:
    raw = str(folder or "").strip().replace("\\", "/")
    if re.match(r"^[A-Za-z]:", raw) or raw.startswith("/"):
        raise ValueError("子文件夹需要使用笔记库内的相对路径")
    raw = raw.strip("/")
    if not raw:
        return OBSIDIAN_DEFAULT_FOLDER
    parts = [part.strip() for part in raw.split("/") if part.strip()]
    if any(part in {".", ".."} for part in parts):
        raise ValueError("子文件夹路径不合法")
    if len(parts) > 4:
        raise ValueError("子文件夹层级太深，最多 4 层")
    return "/".join(_safe_path_component(part) for part in parts)


def _obsidian_target(vault_path: str, folder: str, create: bool = False) -> tuple[Path, Path, str]:
    vault = validate_obsidian_vault(vault_path)
    relative_folder = normalize_obsidian_folder(folder)
    target = vault.joinpath(*relative_folder.split("/"))
    try:
        resolved = target.resolve()
    except (OSError, RuntimeError) as exc:
        raise ValueError("子文件夹路径不合法") from exc
    if resolved != vault and vault not in resolved.parents:
        raise ValueError("子文件夹必须位于笔记库内")
    if create:
        try:
            resolved.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError("无法在笔记库里创建这个文件夹，请检查权限") from exc
    return vault, resolved, relative_folder


def _safe_markdown_stem(title: str) -> str:
    text = re.sub(r"\s+", " ", str(title or "")).strip()
    text = re.sub(r'[\x00-\x1f<>:"/\\|?*#^\[\]]+', " ", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    if not text:
        text = "未命名文献"
    if text.split(".", 1)[0].strip().upper() in _WINDOWS_RESERVED_NAMES:
        text = "_" + text
    limit = 72
    if len(text) > limit:
        cut = text[:limit]
        if " " in cut:
            cut = cut.rsplit(" ", 1)[0]
        text = cut.rstrip(" .,-—:;") or text[:limit]
    return text.rstrip(" .") or "未命名文献"


def _unique_note_path(directory: Path, stem: str) -> Path:
    candidate = directory / f"{stem}.md"
    if not candidate.exists():
        return candidate
    for index in range(2, 1000):
        candidate = directory / f"{stem} ({index}).md"
        if not candidate.exists():
            return candidate
    raise ValueError("同名笔记太多，请换一个笔记库或清理旧文件")


def _text_hash(text: str) -> str:
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _read_note_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _atomic_write_text(path: Path, text: str) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        temp.replace(path)
    finally:
        if temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass


def _yaml_string(value: Any) -> str:
    return json.dumps("" if value is None else str(value), ensure_ascii=False)


def _yaml_list(key: str, values: list[str]) -> list[str]:
    if not values:
        return [f"{key}: []"]
    return [f"{key}:"] + [f"  - {_yaml_string(value)}" for value in values]


def _obsidian_tag(value: Any) -> str:
    tag = re.sub(r"\s+", "-", str(value or "").strip().lstrip("#"))
    tag = re.sub(r"[\[\],;:#^|]+", "-", tag)
    tag = re.sub(r"-{2,}", "-", tag).strip("-")
    return tag[:48]


def _obsidian_tags(raw_tags: Any) -> list[str]:
    tags = ["literature"]
    seen = {"literature"}
    if isinstance(raw_tags, str):
        raw_tags = re.split(r"[,，;；]", raw_tags)
    for raw in raw_tags or []:
        tag = _obsidian_tag(raw)
        if tag and tag.lower() not in seen:
            seen.add(tag.lower())
            tags.append(tag)
    return tags


def build_obsidian_markdown(
    paper_id: str,
    source_url: str | None = None,
    include_chat: bool = True,
    exported_at: str | None = None,
) -> str:
    """Build a self-contained, Obsidian-friendly note with YAML properties."""
    meta = read_meta(paper_id)
    title = re.sub(r"\s+", " ", str(meta.get("title") or "未命名文献")).strip()
    raw_authors = meta.get("authors") or []
    if isinstance(raw_authors, str):
        raw_authors = [raw_authors]
    authors = [
        re.sub(r"\s+", " ", str(author)).strip()
        for author in raw_authors
        if str(author).strip()
    ]
    raw_tags = meta.get("tags") or []
    if isinstance(raw_tags, str):
        raw_tags = re.split(r"[,，;；]", raw_tags)
    keywords = []
    seen_keywords = set()
    for raw in raw_tags:
        keyword = str(raw).strip()
        if keyword and keyword.lower() not in seen_keywords:
            seen_keywords.add(keyword.lower())
            keywords.append(keyword)
    exported_at = exported_at or now_iso()
    status = str(meta.get("status") or "unread")
    status_label = {"unread": "待读", "reading": "在读", "read": "已读"}.get(status, status)
    year_text = str(meta.get("year") or "").strip()
    venue = re.sub(r"\s+", " ", str(meta.get("venue") or "")).strip()
    doi = str(meta.get("doi") or "").strip()
    pdf_filename = re.sub(r"\s+", " ", str(meta.get("pdf_filename") or "")).strip()
    page_count = meta.get("page_count") or 0

    lines = ["---", f"title: {_yaml_string(title)}"]
    lines.extend(_yaml_list("authors", authors))
    if year_text:
        lines.append(f"year: {year_text}" if re.fullmatch(r"\d{4}", year_text) else f"year: {_yaml_string(year_text)}")
    if venue:
        lines.append(f"venue: {_yaml_string(venue)}")
    if doi:
        lines.append(f"doi: {_yaml_string(doi)}")
    if pdf_filename:
        lines.append(f"pdf: {_yaml_string(pdf_filename)}")
    try:
        page_count = int(page_count)
    except (TypeError, ValueError):
        page_count = 0
    if page_count > 0:
        lines.append(f"pages: {page_count}")
    lines.extend(_yaml_list("tags", _obsidian_tags(raw_tags)))
    if keywords:
        lines.extend(_yaml_list("keywords", keywords))
    category_names = category_names_for_ids(meta.get("categories") if isinstance(meta.get("categories"), list) else [])
    if category_names:
        lines.extend(_yaml_list("categories", category_names))
    lines.extend(
        [
            "type: literature",
            f"status: {_yaml_string(status)}",
            f"landu_id: {_yaml_string(paper_id)}",
        ]
    )
    if source_url:
        lines.append(f"landu_url: {_yaml_string(source_url)}")
    if meta.get("created_at"):
        lines.append(f"created: {_yaml_string(meta['created_at'])}")
    lines.append(f"exported: {_yaml_string(exported_at)}")
    lines.extend(["---", "", f"# {title}", ""])

    lines.append("> [!info] 文献信息")
    lines.append("> **作者**：" + ("、".join(authors) if authors else "未知作者"))
    lines.append("> **年份 / 来源**：" + (year_text or "—") + " · " + (venue or "—"))
    if doi:
        lines.append(f"> **DOI**：<https://doi.org/{doi}>")
    if category_names:
        lines.append("> **分类**：" + "、".join(category_names))
    lines.append(f"> **阅读状态**：{status_label} · **导出时间**：{exported_at[:16].replace('T', ' ')}")
    if source_url:
        lines.append(f"> **原文**：[在澜读中打开]({source_url})")
    lines.append("")

    card = get_card(paper_id).strip()
    takeaways = get_takeaways(paper_id).strip()
    notes = get_notes(paper_id).strip()
    chat = get_chat(paper_id) if include_chat else []
    if card:
        lines.extend(["## 精读卡", "", card, ""])
    if takeaways:
        lines.extend(["## 我的收获", "", takeaways, ""])
    if notes:
        lines.extend(["## 我的笔记", "", notes, ""])
    if include_chat and chat:
        lines.extend(["## 追问记录", ""])
        for message in chat:
            content = str(message.get("content") or "").strip()
            if not content:
                continue
            who = "我" if message.get("role") == "user" else "精读助手"
            lines.extend([f"### {who}", "", content, ""])
    if not any((card, takeaways, notes, include_chat and chat)):
        lines.extend(["> 这篇文献还没有精读卡或笔记。", ""])

    stamp = exported_at[:16].replace("T", " ")
    if source_url:
        lines.extend(["---", "", f"<sub>由 [澜读 · 文献工作台]({source_url}) 导出 · {stamp}</sub>"])
    else:
        lines.extend(["---", "", f"<sub>由澜读 · 文献工作台导出 · {stamp}</sub>"])
    lines.extend(["", f"<!-- landu_id: {paper_id} -->", ""])
    return "\n".join(lines).strip() + "\n"


def export_to_obsidian(
    paper_id: str,
    vault_path: str,
    folder: str = "",
    source_url: str | None = None,
    include_chat: bool = True,
) -> dict[str, Any]:
    """Write one note into a vault without clobbering user-edited notes."""
    with _LOCK:
        meta = read_meta(paper_id)
        vault, target_dir, relative_folder = _obsidian_target(vault_path, folder, create=True)
        exported_at = now_iso()
        text = build_obsidian_markdown(
            paper_id,
            source_url=source_url,
            include_chat=include_chat,
            exported_at=exported_at,
        )
        digest = _text_hash(text)
        manifest = _read_json(OBSIDIAN_MANIFEST_PATH, {})
        if not isinstance(manifest, dict):
            manifest = {}
        paper_entries = manifest.get(paper_id)
        if not isinstance(paper_entries, dict):
            paper_entries = {}
        elif "path" in paper_entries and "vault" in paper_entries:
            # Migrate the one-vault entry shape used by early builds.
            paper_entries = {str(paper_entries.get("vault") or ""): paper_entries}
        entry = paper_entries.get(str(vault))
        if not isinstance(entry, dict):
            entry = {}

        previous: Path | None = None
        previous_is_ours = False
        if entry.get("path"):
            try:
                candidate = (vault / str(entry["path"])).resolve()
            except (OSError, RuntimeError):
                candidate = None
            if candidate and candidate.parent == target_dir and candidate.is_file():
                previous = candidate
                previous_is_ours = _text_hash(_read_note_text(candidate)) == str(entry.get("hash") or "")

        stem = _safe_markdown_stem(meta.get("title", "未命名文献"))
        if previous and previous_is_ours:
            path = previous
            path_text = _read_note_text(path)
            if _text_hash(path_text) == digest:
                mode = "unchanged"
            else:
                mode = "updated"
        else:
            path = target_dir / f"{stem}.md"
            if path.exists():
                if path.is_file() and _text_hash(_read_note_text(path)) == digest:
                    mode = "unchanged"
                else:
                    path = _unique_note_path(target_dir, stem)
                    mode = "created_copy"
            else:
                mode = "created"

        if mode in {"created", "created_copy", "updated"}:
            try:
                _atomic_write_text(path, text)
            except OSError as exc:
                raise ValueError("写入笔记失败，请检查笔记库的写入权限") from exc

        relative_path = path.relative_to(vault).as_posix()
        paper_entries[str(vault)] = {
            "path": relative_path,
            "hash": digest,
            "exported_at": exported_at,
            "title": meta.get("title", ""),
        }
        manifest[paper_id] = paper_entries
        _write_json(OBSIDIAN_MANIFEST_PATH, manifest)
        return {
            "paper_id": paper_id,
            "vault": str(vault),
            "vault_name": vault.name,
            "folder": relative_folder,
            "filename": path.name,
            "path": str(path),
            "rel_path": relative_path,
            "mode": mode,
            "chars": len(text),
            "exported_at": exported_at,
        }


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export_markdown(paper_id: str) -> str:
    meta = read_meta(paper_id)
    authors = "、".join(meta.get("authors") or []) or "未知作者"
    lines = [
        f"# {meta.get('title', '未命名文献')}",
        "",
        f"- 作者：{authors}",
        f"- 年份：{meta.get('year') or '—'}",
        f"- 期刊/来源：{meta.get('venue') or '—'}",
        f"- DOI：{meta.get('doi') or '—'}",
        f"- 阅读状态：{meta.get('status', 'unread')}",
        "",
    ]
    if meta.get("tags"):
        lines += [f"- 标签：{'、'.join(meta['tags'])}", ""]
    category_names = category_names_for_ids(meta.get("categories") if isinstance(meta.get("categories"), list) else [])
    if category_names:
        lines += [f"- 分类：{'、'.join(category_names)}", ""]
    card = get_card(paper_id)
    if card.strip():
        lines += ["## 精读卡", "", card.strip(), ""]
    takeaways = get_takeaways(paper_id)
    if takeaways.strip():
        lines += ["## 我的收获", "", takeaways.strip(), ""]
    notes = get_notes(paper_id)
    if notes.strip():
        lines += ["## 我的笔记", "", notes.strip(), ""]
    chat = get_chat(paper_id)
    if chat:
        lines += ["## 追问记录", ""]
        for message in chat:
            who = "我" if message.get("role") == "user" else "精读助手"
            lines += [f"### {who}", "", str(message.get("content", "")).strip(), ""]
    return "\n".join(lines).strip() + "\n"


def touch_chat_meta(paper_id: str, count: int) -> None:
    meta = read_meta(paper_id)
    meta["chat_updated_at"] = now_iso()
    meta["chat_count"] = count
    write_meta(meta)

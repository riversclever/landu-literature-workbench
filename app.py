"""澜读 · 文献工作台 — a private, local-first literature workbench.

Run:  python app.py
Then open http://127.0.0.1:8765
"""
from __future__ import annotations

import argparse
import html
import json
import mimetypes
import secrets
import socket
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.request
import uuid
import webbrowser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

import ai
import storage
import zotero

BASE_DIR = storage.RESOURCE_DIR
STATIC_DIR = BASE_DIR / "static"
START_PORT = 8765
MAX_UPLOAD = 120 * 1024 * 1024

storage.ensure_dirs()


class AppError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "bad_request"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


SESSION_COOKIE = "landu_session"
SESSION_TTL = 30 * 24 * 3600
_SESSIONS: dict[str, float] = {}
_SESSIONS_LOCK = threading.Lock()
_AUTH_FAILS: dict[str, tuple[int, float]] = {}
_AUTH_LOCK = threading.Lock()


def _new_lan_pin() -> str:
    while True:
        pin = f"{secrets.randbelow(1_000_000):06d}"
        if pin != "000000":
            return pin


def _clear_sessions() -> None:
    with _SESSIONS_LOCK:
        _SESSIONS.clear()


def _lan_urls(port: int) -> list[str]:
    ips: list[str] = []
    primary = ""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            primary = probe.getsockname()[0]
        finally:
            probe.close()
    except OSError:
        pass
    if primary and not primary.startswith(("127.", "169.254.")):
        ips.append(primary)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith(("127.", "169.254.")) and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return [f"http://{ip}:{port}" for ip in ips]


def _lean_meta(meta: dict[str, Any]) -> dict[str, Any]:
    clean = dict(meta)
    clean.pop("pdf_sha256", None)
    return clean


class WorkbenchServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    server_version = "LanduWorkbench/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------------
    # Plumbing
    # ------------------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:
        if not str(args[0] if args else "").startswith("GET /api/papers/") or str(
            args[1] if len(args) > 1 else ""
        ).startswith(("4", "5")):
            sys.stderr.write("[workbench] " + (fmt % args) + "\n")

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            parsed = urlparse(origin)
        except ValueError:
            return False
        if parsed.port and parsed.port != self.server.server_port:
            return False
        host_header = (self.headers.get("Host") or "").strip()
        if host_header.startswith("["):
            host_only = host_header.split("]")[0] + "]"
        else:
            host_only = host_header.rsplit(":", 1)[0] if ":" in host_header else host_header
        return parsed.hostname in {"127.0.0.1", "localhost", "::1", host_only}

    def _client_is_local(self) -> bool:
        # A local reverse proxy or tunnel still connects from 127.0.0.1. If any
        # forwarding header is present, treat the request as remote so the
        # access-code check cannot be bypassed by exposing this port publicly.
        if any(
            self.headers.get(name)
            for name in ("X-Forwarded-For", "X-Real-IP", "CF-Connecting-IP", "Forwarded")
        ):
            return False
        address = (self.client_address[0] or "").strip()
        return address.startswith("127.") or address in {"::1", "localhost"}

    def _session_valid(self) -> bool:
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return False
        try:
            jar = SimpleCookie()
            jar.load(raw_cookie)
        except Exception:
            return False
        morsel = jar.get(SESSION_COOKIE)
        if not morsel:
            return False
        token = morsel.value
        now = time.time()
        with _SESSIONS_LOCK:
            expires = _SESSIONS.get(token)
            if not expires:
                return False
            if expires < now:
                _SESSIONS.pop(token, None)
                return False
            return True

    def _is_authorized(self, path: str) -> bool:
        if self._client_is_local():
            return True
        if path.startswith("/login"):
            return True
        config = storage.load_config()
        if not config.get("lan_access"):
            return False
        if not str(config.get("lan_pin") or "").strip():
            return False
        return self._session_valid()

    def _unauthorized(self, path: str) -> None:
        if path.startswith("/api/"):
            self.send_error_json("手机访问需要先登录", 401, "unauthorized")
            return
        if self.command in {"GET", "HEAD"}:
            self.send_response(302)
            self.send_header("Location", "/login")
            self.send_header("Content-Length", "0")
            self._security_headers()
            self.end_headers()
        else:
            self.send_error_json("手机访问需要先登录", 401, "unauthorized")

    def _login_page_html(self, error: str = "") -> str:
        config = storage.load_config()
        enabled = bool(config.get("lan_access") and str(config.get("lan_pin") or "").strip())
        error_html = (
            '<div class="error">' + html.escape(error) + "</div>" if error else ""
        )
        form_html = (
            '<form method="post" action="/login">'
            '<label for="pin">访问码</label>'
            '<input id="pin" name="pin" type="password" inputmode="numeric" '
            'autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" '
            'placeholder="6 位访问码" autofocus required>'
            '<button type="submit">进入工作台</button>'
            "</form>"
            if enabled
            else '<div class="disabled">手机访问暂未开启。<br>请在电脑端「设置 → 手机访问」中开启。</div>'
        )
        return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>手机访问 · 澜读</title>
<style>
  :root {{ --ink:#1e2b26; --muted:#7c857f; --line:#e3dccd; --green:#20584b; --copper:#ad7746; }}
  * {{ box-sizing:border-box; }}
  html, body {{ max-width:100%; overflow-x:hidden; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    padding:24px; color:var(--ink); background:
      radial-gradient(700px 380px at 85% 0%, rgba(173,119,70,.12), transparent 65%),
      radial-gradient(600px 400px at 0% 100%, rgba(32,88,75,.12), transparent 65%),
      #f2ede3;
    font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }}
  .card {{ width:100%; min-width:0; max-width:390px; padding:30px 28px 25px; background:#fbf8f1;
    border:1px solid var(--line); border-radius:18px; box-shadow:0 20px 55px rgba(37,48,42,.12); }}
  .brand {{ display:flex; align-items:center; gap:10px; color:var(--green); }}
  .mark {{ width:34px; height:34px; border:1px solid rgba(32,88,75,.25); border-radius:50%;
    display:flex; align-items:center; justify-content:center; font-family:Georgia,serif; font-size:15px; }}
  .brand strong {{ font-family:Georgia,"Songti SC",serif; font-size:20px; font-weight:500; letter-spacing:.12em; }}
  .kicker {{ margin-top:30px; color:var(--copper); font-size:9.5px; font-weight:700; letter-spacing:.16em; }}
  h1 {{ margin:7px 0 8px; font-family:Georgia,"Songti SC",serif; font-size:27px; font-weight:500; }}
  p {{ margin:0; color:var(--muted); font-size:12px; line-height:1.8; overflow-wrap:anywhere; }}
  form {{ margin-top:24px; }}
  label {{ display:block; margin-bottom:6px; color:#40504a; font-size:11.5px; font-weight:600; }}
  input {{ width:100%; min-width:0; height:48px; padding:0 14px; color:var(--ink); background:#fffdf8;
    border:1px solid var(--line); border-radius:9px; outline:none; font-size:22px;
    letter-spacing:.32em; text-align:center; }}
  input:focus {{ border-color:rgba(32,88,75,.4); box-shadow:0 0 0 3px rgba(32,88,75,.06); }}
  button {{ width:100%; height:43px; margin-top:12px; color:#f8f3e7; background:var(--green);
    border:0; border-radius:9px; font-size:13px; font-weight:600; }}
  .error {{ margin-top:13px; padding:9px 11px; color:#7d3d31; background:#f6e8e4;
    border:1px solid rgba(161,77,63,.16); border-radius:7px; font-size:11.5px; line-height:1.65; }}
  .disabled {{ margin-top:22px; padding:15px; color:#6b4a2e; background:#fbf6ed;
    border:1px dashed rgba(173,119,70,.35); border-radius:9px; font-size:12px; line-height:1.8; }}
  .hint {{ margin-top:18px; padding-top:14px; border-top:1px solid var(--line); }}
  .hint strong {{ color:#40504a; font-weight:600; }}
  @media (max-width:420px) {{ .card {{ padding:25px 21px 21px; }} h1 {{ font-size:24px; }} }}
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="mark">澜</span><strong>澜读</strong></div>
  <div class="kicker">PRIVATE MOBILE ACCESS</div>
  <h1>在手机继续读</h1>
  <p>论文和数据仍保存在你的电脑上。手机和电脑需要连接同一个 Wi-Fi。</p>
  {error_html}
  {form_html}
  <p class="hint"><strong>访问码</strong>可在电脑端的「设置 → 手机访问」查看。仅在你信任的家庭或办公室网络下使用。</p>
</main>
</body>
</html>"""

    def _handle_login_page(self) -> None:
        if self._client_is_local():
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self._security_headers()
            self.end_headers()
            return
        self._send_bytes(
            self._login_page_html().encode("utf-8"),
            content_type="text/html; charset=utf-8",
            cache="no-store",
        )

    def _handle_login_post(self) -> None:
        config = storage.load_config()
        expected = str(config.get("lan_pin") or "").strip()
        if not config.get("lan_access") or not expected:
            self._send_bytes(
                self._login_page_html("手机访问尚未开启，请在电脑端设置。").encode("utf-8"),
                status=403,
                content_type="text/html; charset=utf-8",
            )
            return
        ip = self.client_address[0]
        now = time.time()
        with _AUTH_LOCK:
            attempts, last = _AUTH_FAILS.get(ip, (0, 0.0))
            if now - last > 600:
                attempts = 0
            if attempts >= 5 and now - last < 60:
                self._send_bytes(
                    self._login_page_html("尝试次数过多，请一分钟后再试。").encode("utf-8"),
                    status=429,
                    content_type="text/html; charset=utf-8",
                )
                return
        raw = self._read_body(4096).decode("utf-8", errors="ignore")
        form = parse_qs(raw)
        pin = (form.get("pin") or [""])[0].strip()
        if pin and secrets.compare_digest(pin, expected):
            token = secrets.token_urlsafe(32)
            with _SESSIONS_LOCK:
                _SESSIONS[token] = now + SESSION_TTL
            with _AUTH_LOCK:
                _AUTH_FAILS.pop(ip, None)
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}",
            )
            self.send_header("Content-Length", "0")
            self._security_headers()
            self.end_headers()
            return
        with _AUTH_LOCK:
            _AUTH_FAILS[ip] = (attempts + 1, now)
        time.sleep(0.35)
        self._send_bytes(
            self._login_page_html("访问码不正确，请重新输入。").encode("utf-8"),
            status=401,
            content_type="text/html; charset=utf-8",
        )

    def _settings_payload(self) -> dict[str, Any]:
        payload = storage.public_settings()
        config = storage.load_config()
        payload["lan_access"] = bool(config.get("lan_access"))
        payload["lan_urls"] = _lan_urls(self.server.server_port)
        payload["lan_local"] = self._client_is_local()
        payload["obsidian_vaults"] = storage.detect_obsidian_vaults()
        if not payload["lan_local"]:
            payload["lan_pin"] = ""
        return payload

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' blob:; "
            "connect-src 'self'; base-uri 'none'; form-action 'self'",
        )

    def _send_bytes(
        self,
        payload: bytes,
        status: int = 200,
        content_type: str = "application/octet-stream",
        extra_headers: dict[str, str] | None = None,
        head_only: bool = False,
        cache: str = "no-store",
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", cache)
        self._security_headers()
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        if not head_only:
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, status=status, content_type="application/json; charset=utf-8")

    def send_error_json(self, message: str, status: int = 400, code: str = "bad_request") -> None:
        self.send_json({"error": message, "code": code}, status=status)

    def _read_body(self, limit: int = 2 * 1024 * 1024) -> bytes:
        raw_length = self.headers.get("Content-Length")
        if not raw_length:
            return b""
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise AppError("Content-Length 不合法") from exc
        if length < 0 or length > limit:
            raise AppError("请求内容过大", status=413, code="too_large")
        chunks = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_json(self, limit: int = 2 * 1024 * 1024) -> dict[str, Any]:
        raw = self._read_body(limit)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AppError("请求 JSON 格式不正确") from exc
        if not isinstance(data, dict):
            raise AppError("请求内容必须是对象")
        return data

    def _sse_headers(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self._security_headers()
        self.end_headers()
        self.close_connection = True

    def _sse(self, payload: dict[str, Any]) -> None:
        line = "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
        self.wfile.write(line.encode("utf-8"))
        self.wfile.flush()

    # ------------------------------------------------------------------
    # Static
    # ------------------------------------------------------------------
    def _serve_static(self, path: str, head_only: bool = False) -> None:
        if path in {"", "/", "/index.html"}:
            relative = "index.html"
        elif path.startswith("/static/"):
            relative = unquote(path[len("/static/") :])
        else:
            raise AppError("页面不存在", status=404, code="not_found")
        target = (STATIC_DIR / relative).resolve()
        if STATIC_DIR.resolve() not in target.parents and target != STATIC_DIR.resolve():
            raise AppError("页面不存在", status=404, code="not_found")
        if not target.exists() or not target.is_file():
            raise AppError("页面不存在", status=404, code="not_found")
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif target.suffix in {".css"}:
            content_type = "text/css; charset=utf-8"
        elif target.suffix in {".html"}:
            content_type = "text/html; charset=utf-8"
        elif target.suffix == ".svg":
            content_type = "image/svg+xml"
        self._send_bytes(target.read_bytes(), content_type=content_type, head_only=head_only, cache="no-cache")

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/login":
            self._send_bytes(
                b"",
                status=200,
                content_type="text/html; charset=utf-8",
                head_only=True,
            )
            return
        if not self._is_authorized(path):
            self._unauthorized(path)
            return
        if path.startswith("/api/papers/") and path.endswith("/file"):
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/file", path)
            if match:
                self._serve_pdf(match.group(1), head_only=True)
                return
        if path.startswith("/api/"):
            self.send_json({}, status=200)
            return
        try:
            self._serve_static(path, head_only=True)
        except AppError:
            self._send_bytes(b"", status=404, content_type="text/plain; charset=utf-8", head_only=True)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        if path == "/login":
            self._handle_login_page()
            return
        if not self._is_authorized(path):
            self._unauthorized(path)
            return
        try:
            if path == "/api/ping":
                self.send_json({"ok": True, "version": "1.0"})
                return
            if path == "/api/state":
                papers = storage.list_papers()
                self.send_json(
                    {
                        "papers": papers,
                        "stats": storage.library_stats(papers),
                        "settings": self._settings_payload(),
                        "trash_count": storage.trash_count(),
                        "version": "1.0",
                    }
                )
                return
            if path == "/api/papers":
                papers = storage.list_papers()
                self.send_json({"papers": papers, "stats": storage.library_stats(papers)})
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})", path)
            if match:
                self._get_paper(match.group(1))
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/pages", path)
            if match:
                paper_id = match.group(1)
                meta = storage.read_meta(paper_id)
                self.send_json({"paper_id": paper_id, "page_count": meta.get("page_count"), "pages": storage.load_pages(paper_id)})
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/file", path)
            if match:
                self._serve_pdf(match.group(1))
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/export", path)
            if match:
                self._export_paper(match.group(1))
                return
            if path == "/api/settings":
                self.send_json({"settings": self._settings_payload()})
                return
            if path == "/api/zotero/search":
                q = (query.get("q") or [""])[0]
                limit = int((query.get("limit") or ["30"])[0])
                try:
                    items = zotero.search_items(q, limit)
                    self.send_json({"items": items})
                except zotero.ZoteroError as exc:
                    self.send_json({"error": exc.message, "code": exc.code, "items": []}, status=502)
                return
            if path == "/api/zotero/test":
                try:
                    self.send_json(zotero.test_connection())
                except zotero.ZoteroError as exc:
                    self.send_json({"ok": False, "error": exc.message, "code": exc.code}, status=502)
                return
            if path == "/api/trash":
                self.send_json({"items": storage.list_trash()})
                return
            if path == "/api/comparisons":
                items = []
                for comparison in storage.list_comparisons():
                    trimmed = {k: v for k, v in comparison.items() if k != "content"}
                    items.append(trimmed)
                self.send_json({"comparisons": items})
                return
            match = re.fullmatch(r"/api/comparisons/(c_[0-9a-f]{12})", path)
            if match:
                self.send_json({"comparison": storage.read_comparison(match.group(1))})
                return
            if path.startswith("/api/"):
                raise AppError("接口不存在", status=404, code="not_found")
            self._serve_static(path)
        except AppError as exc:
            self.send_error_json(exc.message, exc.status, exc.code)
        except FileNotFoundError:
            self.send_error_json("没有找到这条记录，它可能已被删除。", 404, "not_found")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_error_json("服务器处理请求时出错，请查看启动窗口的日志。", 500, "server_error")

    # ------------------------------------------------------------------
    # Paper helpers
    # ------------------------------------------------------------------
    def _get_paper(self, paper_id: str) -> None:
        meta = _lean_meta(storage.read_meta(paper_id))
        self.send_json(
            {
                "paper": meta,
                "card": storage.get_card(paper_id),
                "takeaways": storage.get_takeaways(paper_id),
                "notes": storage.get_notes(paper_id),
                "chat": storage.get_chat(paper_id),
            }
        )

    def _serve_pdf(self, paper_id: str, head_only: bool = False) -> None:
        meta = storage.read_meta(paper_id)
        path = storage.paper_dir(paper_id) / "paper.pdf"
        if not path.exists():
            raise AppError("PDF 文件不存在", status=404, code="not_found")
        size = path.stat().st_size
        range_header = self.headers.get("Range", "")
        start, end = 0, size - 1
        status = 200
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
            if not match:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start_text, end_text = match.groups()
            if start_text:
                start = int(start_text)
                end = int(end_text) if end_text else size - 1
            elif end_text:
                suffix = int(end_text)
                start = max(0, size - suffix)
                end = size - 1
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, size - 1)
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "private, max-age=3600")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self._security_headers()
        self.end_headers()
        if head_only:
            return
        try:
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _export_paper(self, paper_id: str) -> None:
        meta = storage.read_meta(paper_id)
        text = storage.export_markdown(paper_id)
        filename = re.sub(r'[\\/:*?"<>|\s]+', "_", meta.get("title", "paper"))[:60] + ".md"
        headers = {
            "Content-Disposition": (
                'attachment; filename="paper.md"; '
                "filename*=UTF-8''" + quote(filename)
            )
        }
        self._send_bytes(
            text.encode("utf-8"),
            content_type="text/markdown; charset=utf-8",
            extra_headers=headers,
            cache="no-store",
        )

    def _export_to_obsidian(self, paper_id: str) -> None:
        body = self._read_json(limit=256 * 1024)
        config = storage.load_config()
        local = self._client_is_local()
        if local:
            vault = str(body.get("vault") or config.get("obsidian_vault") or "").strip()
            folder = str(body.get("folder") or config.get("obsidian_folder") or storage.OBSIDIAN_DEFAULT_FOLDER).strip()
            if not vault:
                raise AppError("请先选择 Obsidian 笔记库", 400, "no_vault")
            try:
                vault = str(storage.validate_obsidian_vault(vault))
                folder = storage.normalize_obsidian_folder(folder)
            except ValueError as exc:
                raise AppError(str(exc), 400, "bad_vault") from exc
        else:
            vault = str(config.get("obsidian_vault") or "").strip()
            folder = str(config.get("obsidian_folder") or storage.OBSIDIAN_DEFAULT_FOLDER).strip()
            if not vault:
                raise AppError("请先在电脑上设置 Obsidian 笔记库", 409, "no_vault")
            try:
                storage.validate_obsidian_vault(vault)
                storage.normalize_obsidian_folder(folder)
            except ValueError as exc:
                raise AppError("电脑上的 Obsidian 设置无效，请重新选择笔记库", 409, "bad_vault") from exc

        include_chat = body.get("include_chat", True)
        if isinstance(include_chat, str):
            include_chat = include_chat.lower() not in {"false", "0", "no", "off"}
        source_url = f"http://127.0.0.1:{self.server.server_port}/#/paper/{paper_id}"
        try:
            result = storage.export_to_obsidian(
                paper_id,
                vault,
                folder,
                source_url=source_url,
                include_chat=bool(include_chat),
            )
        except ValueError as exc:
            raise AppError(str(exc), 400, "export_failed") from exc
        except OSError:
            traceback.print_exc()
            raise AppError("写入笔记失败，请检查笔记库的写入权限", 500, "export_failed") from None
        if local:
            storage.save_config(
                {
                    "obsidian_vault": result["vault"],
                    "obsidian_folder": result["folder"],
                }
            )
        result["settings"] = self._settings_payload()
        self.send_json(result)

    def _create_category(self) -> None:
        body = self._read_json(limit=64 * 1024)
        try:
            category = storage.create_category(body.get("name"), body.get("color"))
        except ValueError as exc:
            raise AppError(str(exc), 400, "bad_category") from exc
        except OSError:
            traceback.print_exc()
            raise AppError("分类保存失败，请检查数据目录权限", 500, "server_error") from None
        self.send_json({"category": category})

    # ------------------------------------------------------------------
    # POST / PATCH / DELETE
    # ------------------------------------------------------------------
    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if not self._is_authorized(path):
            self._unauthorized(path)
            return
        if not self._origin_ok():
            self.send_error_json("不允许跨站请求", 403, "forbidden")
            return
        try:
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})", path)
            if match:
                body = self._read_json()
                meta = storage.update_paper(match.group(1), body)
                self.send_json({"paper": _lean_meta(meta)})
                return
            match = re.fullmatch(r"/api/categories/(cat_[0-9a-f]{8})", path)
            if match:
                body = self._read_json()
                try:
                    category = storage.update_category(match.group(1), body)
                except ValueError as exc:
                    raise AppError(str(exc), 400, "bad_category") from exc
                except FileNotFoundError as exc:
                    raise AppError("分类不存在", 404, "not_found") from exc
                self.send_json({"category": category})
                return
            raise AppError("接口不存在", 404, "not_found")
        except AppError as exc:
            self.send_error_json(exc.message, exc.status, exc.code)
        except FileNotFoundError:
            self.send_error_json("文献不存在", 404, "not_found")
        except Exception:
            traceback.print_exc()
            self.send_error_json("更新失败，请查看日志。", 500, "server_error")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if not self._is_authorized(path):
            self._unauthorized(path)
            return
        if not self._origin_ok():
            self.send_error_json("不允许跨站请求", 403, "forbidden")
            return
        try:
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})", path)
            if match:
                try:
                    meta = storage.trash_paper(match.group(1))
                except FileNotFoundError as exc:
                    raise AppError("文献不存在", 404, "not_found") from exc
                except OSError as exc:
                    raise AppError(
                        "无法移入回收站；PDF 可能正在阅读器中打开，请关闭后重试",
                        409,
                        "busy",
                    ) from exc
                self.send_json({"ok": True, "trash_id": meta.get("trash_id")})
                return
            match = re.fullmatch(r"/api/categories/(cat_[0-9a-f]{8})", path)
            if match:
                try:
                    result = storage.delete_category(match.group(1))
                except ValueError as exc:
                    raise AppError(str(exc), 400, "bad_category") from exc
                except FileNotFoundError as exc:
                    raise AppError("分类不存在", 404, "not_found") from exc
                self.send_json({"ok": True, **result})
                return
            if path == "/api/trash":
                deleted, failed = storage.empty_trash()
                self.send_json({"deleted": len(deleted), "failed": failed})
                return
            match = re.fullmatch(r"/api/trash/(t_[0-9a-f]{12})", path)
            if match:
                try:
                    storage.delete_trash(match.group(1))
                except FileNotFoundError as exc:
                    raise AppError("回收站条目不存在", 404, "not_found") from exc
                except OSError as exc:
                    raise AppError("彻底删除失败；文件可能正在被占用", 409, "busy") from exc
                self.send_json({"ok": True})
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/chat", path)
            if match:
                storage.clear_chat(match.group(1))
                self.send_json({"ok": True})
                return
            match = re.fullmatch(r"/api/comparisons/(c_[0-9a-f]{12})", path)
            if match:
                storage.delete_comparison(match.group(1))
                self.send_json({"ok": True})
                return
            raise AppError("接口不存在", 404, "not_found")
        except AppError as exc:
            self.send_error_json(exc.message, exc.status, exc.code)
        except Exception:
            traceback.print_exc()
            self.send_error_json("删除失败，请查看日志。", 500, "server_error")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/login":
            self._handle_login_post()
            return
        if not self._is_authorized(path):
            self._unauthorized(path)
            return
        if not self._origin_ok():
            self.send_error_json("不允许跨站请求", 403, "forbidden")
            return
        try:
            if path == "/api/papers":
                self._upload()
                return
            if path == "/api/categories":
                self._create_category()
                return
            if path == "/api/papers/bulk-trash":
                self._bulk_trash()
                return
            if path == "/api/trash/restore":
                self._restore_trash()
                return
            if path == "/api/demo":
                try:
                    meta, duplicate = storage.import_demo()
                    self.send_json({"paper": _lean_meta(meta), "duplicate": duplicate})
                except FileNotFoundError as exc:
                    self.send_json({"error": str(exc), "code": "demo_missing"}, status=500)
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/card", path)
            if match:
                self._generate_card(match.group(1))
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/chat", path)
            if match:
                self._chat(match.group(1))
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/notes", path)
            if match:
                body = self._read_json(limit=3 * 1024 * 1024)
                storage.save_notes(match.group(1), str(body.get("notes") or ""))
                meta = storage.read_meta(match.group(1))
                self.send_json({"ok": True, "updated_at": meta.get("notes_updated_at", "")})
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/takeaways", path)
            if match:
                body = self._read_json(limit=1024 * 1024)
                storage.save_takeaways(match.group(1), str(body.get("takeaways") or ""))
                meta = storage.read_meta(match.group(1))
                self.send_json({"ok": True, "updated_at": meta.get("takeaways_updated_at", "")})
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/takeaways/draft", path)
            if match:
                paper_id = match.group(1)
                meta = storage.read_meta(paper_id)
                if not storage.get_card(paper_id).strip():
                    raise AppError("请先生成精读卡，再让 AI 起草收获", 400, "no_card")
                try:
                    text = ai.generate_takeaways(meta)
                    self.send_json({"takeaways": text})
                except ai.AIError as exc:
                    self.send_json({"error": exc.message, "code": exc.code}, status=502)
                return
            match = re.fullmatch(r"/api/papers/(p_[0-9a-f]{12})/obsidian", path)
            if match:
                self._export_to_obsidian(match.group(1))
                return
            if path == "/api/lan/regenerate":
                if not self._client_is_local():
                    raise AppError("访问码只能在电脑上修改", 403, "forbidden")
                pin = _new_lan_pin()
                storage.save_config({"lan_pin": pin})
                _clear_sessions()
                self.send_json({"pin": pin, "settings": self._settings_payload()})
                return
            if path == "/api/settings":
                body = self._read_json()
                if ("lan_access" in body or "lan_pin" in body) and not self._client_is_local():
                    raise AppError("手机访问设置只能在电脑上修改", 403, "forbidden")
                if ("obsidian_vault" in body or "obsidian_folder" in body) and not self._client_is_local():
                    raise AppError("Obsidian 设置只能在电脑上修改", 403, "forbidden")
                if "obsidian_vault" in body:
                    raw_vault = str(body.get("obsidian_vault") or "").strip()
                    if raw_vault:
                        try:
                            body["obsidian_vault"] = str(storage.validate_obsidian_vault(raw_vault))
                        except ValueError as exc:
                            raise AppError(str(exc), 400, "bad_vault") from exc
                    else:
                        body["obsidian_vault"] = ""
                if "obsidian_folder" in body:
                    try:
                        body["obsidian_folder"] = storage.normalize_obsidian_folder(str(body.get("obsidian_folder") or ""))
                    except ValueError as exc:
                        raise AppError(str(exc), 400, "bad_folder") from exc
                base = str(body.get("base_url") or "")
                if base and not base.startswith(("http://", "https://")):
                    raise AppError("Base URL 需要以 http:// 或 https:// 开头")
                current = storage.load_config()
                if body.get("lan_access") and not (current.get("lan_pin") or body.get("lan_pin")):
                    body["lan_pin"] = _new_lan_pin()
                access_changed = "lan_access" in body and bool(body.get("lan_access")) != bool(current.get("lan_access"))
                pin_changed = "lan_pin" in body and str(body.get("lan_pin")) != str(current.get("lan_pin") or "")
                config = storage.save_config(body)
                if access_changed or pin_changed:
                    _clear_sessions()
                self.send_json({"settings": self._settings_payload()})
                return
            if path == "/api/settings/test":
                body = self._read_json()
                overrides = {}
                if body.get("api_key"):
                    overrides["api_key"] = str(body["api_key"]).strip()
                if body.get("base_url"):
                    overrides["base_url"] = str(body["base_url"]).strip()
                if body.get("model"):
                    overrides["model"] = str(body["model"]).strip()
                try:
                    result = ai.complete_once(overrides=overrides)
                    self.send_json(result)
                except ai.AIError as exc:
                    self.send_json({"ok": False, "error": exc.message, "code": exc.code}, status=502)
                return
            if path == "/api/zotero/import":
                body = self._read_json()
                try:
                    meta, duplicate = zotero.import_item(str(body.get("key") or ""))
                    self.send_json({"paper": _lean_meta(meta), "duplicate": duplicate})
                except zotero.ZoteroError as exc:
                    self.send_json({"error": exc.message, "code": exc.code}, status=502)
                return
            if path == "/api/comparisons":
                self._generate_comparison()
                return
            raise AppError("接口不存在", 404, "not_found")
        except AppError as exc:
            self.send_error_json(exc.message, exc.status, exc.code)
        except FileNotFoundError:
            self.send_error_json("文献不存在，可能已被删除。", 404, "not_found")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_error_json("服务器处理请求时出错，请查看启动窗口的日志。", 500, "server_error")

    def _bulk_trash(self) -> None:
        body = self._read_json()
        raw_ids = body.get("ids")
        if not isinstance(raw_ids, list):
            raise AppError("请选择要删除的文献")
        ids: list[str] = []
        for value in raw_ids:
            paper_id = str(value)
            if paper_id not in ids:
                ids.append(paper_id)
        if not ids or len(ids) > 200:
            raise AppError("一次可删除 1–200 篇文献")
        trashed: list[str] = []
        missing: list[str] = []
        failed: list[dict[str, str]] = []
        for paper_id in ids:
            if not re.fullmatch(r"p_[0-9a-f]{12}", paper_id):
                failed.append({"id": paper_id, "error": "文献编号不合法"})
                continue
            try:
                storage.trash_paper(paper_id)
                trashed.append(paper_id)
            except FileNotFoundError:
                missing.append(paper_id)
            except Exception:
                traceback.print_exc()
                failed.append({
                    "id": paper_id,
                    "error": "移入回收站失败；PDF 可能正在阅读器中打开，请关闭后重试",
                })
        self.send_json({"trashed": trashed, "missing": missing, "failed": failed})

    def _restore_trash(self) -> None:
        body = self._read_json()
        raw_ids = body.get("trash_ids")
        if not isinstance(raw_ids, list):
            raise AppError("请选择要恢复的文献")
        ids: list[str] = []
        for value in raw_ids:
            trash_id = str(value)
            if trash_id not in ids:
                ids.append(trash_id)
        if not ids or len(ids) > 200:
            raise AppError("一次可恢复 1–200 篇文献")
        restored: list[str] = []
        missing: list[str] = []
        failed: list[dict[str, str]] = []
        for trash_id in ids:
            if not re.fullmatch(r"t_[0-9a-f]{12}", trash_id):
                failed.append({"id": trash_id, "error": "回收站编号不合法"})
                continue
            try:
                storage.restore_trash(trash_id)
                restored.append(trash_id)
            except FileNotFoundError:
                missing.append(trash_id)
            except ValueError as exc:
                failed.append({"id": trash_id, "error": str(exc)})
            except Exception:
                traceback.print_exc()
                failed.append({
                    "id": trash_id,
                    "error": "恢复失败；文件可能正在被占用，请稍后重试",
                })
        self.send_json({"restored": restored, "missing": missing, "failed": failed})

    def _upload(self) -> None:
        raw_name = self.headers.get("X-Filename", "")
        filename = unquote(raw_name).strip() or "paper.pdf"
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise AppError("没有收到 PDF 文件")
        if length > MAX_UPLOAD:
            raise AppError("PDF 超过 120 MB，暂不支持", 413, "too_large")
        temp_path = storage.TMP_DIR / (uuid.uuid4().hex + ".upload.pdf")
        try:
            remaining = length
            head = b""
            with temp_path.open("wb") as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    if len(head) < 5:
                        head += chunk[: 5 - len(head)]
                    handle.write(chunk)
                    remaining -= len(chunk)
            if not head.startswith(b"%PDF"):
                raise AppError("这不是有效的 PDF 文件")
            try:
                meta, duplicate = storage.import_pdf(temp_path, filename, source="upload")
            except ValueError as exc:
                raise AppError(str(exc), 422, "parse_failed") from exc
            self.send_json({"paper": _lean_meta(meta), "duplicate": duplicate})
        finally:
            temp_path.unlink(missing_ok=True)

    def _generate_card(self, paper_id: str) -> None:
        body = self._read_json()
        focus = str(body.get("focus") or "standard")
        if focus not in ai.CARD_FOCUS:
            focus = "standard"
        meta = storage.read_meta(paper_id)
        self._sse_headers()
        started = time.time()
        try:
            if int(meta.get("text_chars") or 0) < 500:
                raise ai.AIError("scanned", "这篇 PDF 没有足够的文字层，暂无法生成精读卡。")
            context, sampled = storage.paper_context(paper_id)
            if not context.strip():
                raise ai.AIError("empty", "没有可分析的正文内容。")
            config = storage.load_config()
            self._sse(
                {
                    "type": "start",
                    "paper_id": paper_id,
                    "model": config.get("model", ""),
                    "focus": focus,
                    "sampled": sampled,
                }
            )
            messages = ai.card_messages(meta, context, focus=focus)
            parts: list[str] = []
            for delta in ai.stream_completion(messages, temperature=0.25, max_tokens=6000):
                parts.append(delta)
                self._sse({"type": "delta", "text": delta})
            text = "".join(parts).strip()
            if len(text) < 120:
                raise ai.AIError("empty_answer", "模型返回内容为空，请稍后重试。")
            saved_meta = storage.save_card(paper_id, text, focus, config.get("model", ""))
            self._sse(
                {
                    "type": "done",
                    "length": len(text),
                    "meta": _lean_meta(saved_meta),
                    "seconds": int(time.time() - started),
                }
            )
        except ai.AIError as exc:
            self._safe_sse({"type": "error", "code": exc.code, "message": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self._safe_sse({"type": "error", "code": "server_error", "message": "生成精读卡时出错，请查看日志。"})

    def _chat(self, paper_id: str) -> None:
        body = self._read_json(limit=4 * 1024 * 1024)
        raw_messages = body.get("messages")
        if not isinstance(raw_messages, list) or not raw_messages:
            raise AppError("缺少对话内容")
        messages = []
        for item in raw_messages[-30:]:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = str(item.get("content") or "").strip()
            if role in {"user", "assistant"} and content:
                messages.append({"role": role, "content": content[:20000]})
        if not messages or messages[-1]["role"] != "user":
            raise AppError("最后一条消息必须是你的问题")
        mode = str(body.get("mode") or "reading")
        if mode not in ai.MODE_INSTRUCTIONS:
            mode = "reading"
        meta = storage.read_meta(paper_id)
        if int(meta.get("text_chars") or 0) < 500:
            self._sse_headers()
            self._safe_sse({"type": "error", "code": "scanned", "message": "这篇 PDF 没有足够的文字层，暂不能追问。"})
            return
        query = messages[-1]["content"]
        context, sampled = storage.paper_context(paper_id, query=query)
        config = storage.load_config()
        self._sse_headers()
        try:
            self._sse(
                {
                    "type": "start",
                    "paper_id": paper_id,
                    "model": config.get("model", ""),
                    "mode": mode,
                    "sampled": sampled,
                }
            )
            prompt_messages = ai.chat_messages(meta, context, messages, mode)
            temperature = 0.55 if mode == "wechat" else 0.3
            max_tokens = 5000 if mode in {"meeting", "wechat", "reviewer", "methods"} else 3500
            parts: list[str] = []
            for delta in ai.stream_completion(prompt_messages, temperature=temperature, max_tokens=max_tokens):
                parts.append(delta)
                self._sse({"type": "delta", "text": delta})
            answer = "".join(parts).strip()
            if not answer:
                raise ai.AIError("empty_answer", "模型没有返回内容，请重试。")
            history = messages + [{"role": "assistant", "content": answer}]
            storage.save_chat(paper_id, history)
            storage.touch_chat_meta(paper_id, len(history))
            saved_meta = storage.read_meta(paper_id)
            self._sse({"type": "done", "answer": answer, "meta": _lean_meta(saved_meta)})
        except ai.AIError as exc:
            self._safe_sse({"type": "error", "code": exc.code, "message": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self._safe_sse({"type": "error", "code": "server_error", "message": "生成回答时出错，请查看日志。"})

    def _generate_comparison(self) -> None:
        body = self._read_json()
        raw_ids = body.get("paper_ids") or []
        if not isinstance(raw_ids, list):
            raise AppError("请选择要对比的文献")
        paper_ids: list[str] = []
        for value in raw_ids:
            pid = str(value)
            if re.fullmatch(r"p_[0-9a-f]{12}", pid) and pid not in paper_ids:
                paper_ids.append(pid)
        if len(paper_ids) < 2 or len(paper_ids) > 5:
            raise AppError("请选择 2–5 篇文献进行对比")
        papers = [storage.read_meta(pid) for pid in paper_ids]
        focus = str(body.get("focus") or "").strip()[:300]
        config = storage.load_config()
        self._sse_headers()
        try:
            self._sse(
                {
                    "type": "start",
                    "papers": [{"id": p["id"], "title": p.get("title", "")} for p in papers],
                    "model": config.get("model", ""),
                }
            )
            messages = ai.compare_messages(papers, focus=focus)
            parts: list[str] = []
            for delta in ai.stream_completion(messages, temperature=0.35, max_tokens=6000):
                parts.append(delta)
                self._sse({"type": "delta", "text": delta})
            content = "".join(parts).strip()
            if len(content) < 120:
                raise ai.AIError("empty_answer", "模型返回内容为空，请稍后重试。")
            heading = re.search(r"^#\s+(.+)$", content, re.M)
            title = heading.group(1).strip() if heading else "文献对比"
            title = re.sub(r"^#+\s*", "", title)[:80]
            body = re.sub(r"^\s*#\s+[^\n]*\n+", "", content, count=1).strip()
            comparison = storage.save_comparison(
                {
                    "title": title,
                    "paper_ids": paper_ids,
                    "paper_titles": [p.get("title", "") for p in papers],
                    "focus": focus,
                    "model": config.get("model", ""),
                    "content": body,
                }
            )
            self._sse(
                {
                    "type": "done",
                    "comparison": {
                        "id": comparison["id"],
                        "title": comparison["title"],
                        "paper_ids": paper_ids,
                        "paper_titles": comparison["paper_titles"],
                        "created_at": comparison["created_at"],
                    },
                }
            )
        except ai.AIError as exc:
            self._safe_sse({"type": "error", "code": exc.code, "message": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self._safe_sse({"type": "error", "code": "server_error", "message": "生成对比时出错，请查看日志。"})

    def _safe_sse(self, payload: dict[str, Any]) -> None:
        try:
            self._sse(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def _open_browser(url: str) -> None:
    time.sleep(0.9)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/ping", timeout=0.9
        ) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read(2000).decode("utf-8", errors="ignore"))
            return bool(payload.get("ok") and payload.get("version"))
    except Exception:
        return False


def main() -> None:
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:
            pass
        try:
            if sys.stdout is not None:
                sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
            if sys.stderr is not None:
                sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="澜读 · 本地文献工作台")
    parser.add_argument("--port", type=int, default=START_PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if _already_running(args.port):
        url = f"http://127.0.0.1:{args.port}"
        print(f"澜读已经在运行：{url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    server = None
    port = args.port
    for candidate in range(args.port, args.port + 20):
        try:
            server = WorkbenchServer(("0.0.0.0", candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        print("无法找到可用端口，请关闭占用 8765–8784 的程序后重试。")
        raise SystemExit(1)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{port}"
    config = storage.load_config()
    key_state = "已配置" if config.get("api_key") else "未配置"
    print("")
    print("  澜读 · 文献工作台")
    print("  " + "─" * 44)
    print(f"  电脑：{url}")
    if config.get("lan_access"):
        lan_urls = _lan_urls(port)
        if lan_urls:
            print(f"  手机：{lan_urls[0]}")
            for extra_url in lan_urls[1:]:
                print(f"        {extra_url}")
            print("  手机访问码请在「设置 → 手机访问」中查看。")
        else:
            print("  手机：未检测到局域网地址，请确认网络连接。")
    else:
        print("  手机访问：未开启（设置 → 手机访问）")
    print(f"  模型：{config.get('model', '')}（API Key {key_state}）")
    print(f"  数据：{storage.DATA_DIR}")
    print("  关闭此窗口即停止服务。")
    print("")
    try:
        sys.stdout.flush()
    except Exception:
        pass
    if not args.no_browser:
        threading.Thread(target=_open_browser, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

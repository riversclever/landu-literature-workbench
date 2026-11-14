"""Desktop window wrapper for 澜读 · 文献工作台 (Windows / WebView2)."""
from __future__ import annotations

import argparse
import ctypes
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

import webview

import app
import storage

TITLE = "澜读 · 文献工作台"
BASE_DIR = Path(__file__).resolve().parent


def _message(text: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(None, text, TITLE, 0x10)
    except Exception:
        print(text)


def _start_server(
    start_port: int,
) -> tuple[app.WorkbenchServer | None, int]:
    """Bind the first free port; reuse an existing instance if one is found.

    Probing every port over HTTP before binding is very slow on some Windows
    setups (closed local ports can take ~1s to time out). Binding is immediate,
    so only check for an existing instance after a bind actually fails.
    """
    last_error: Exception | None = None
    for port in range(start_port, start_port + 20):
        try:
            server = app.WorkbenchServer(("0.0.0.0", port), app.Handler)
        except OSError as exc:
            last_error = exc
            if app._already_running(port):
                return None, port
            continue
        threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.5},
            daemon=True,
        ).start()
        return server, port
    raise RuntimeError("无法找到可用端口（8765–8784）。") from last_error


def _wait_ready(port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="澜读 · 桌面版")
    parser.add_argument("--port", type=int, default=app.START_PORT)
    args = parser.parse_args()

    app._setup_logging()
    if sys.platform == "win32":
        app._disable_quick_edit()

    server: app.WorkbenchServer | None = None
    try:
        server, port = _start_server(args.port)
        if server is None:
            app.LOGGER.info("Reusing existing workbench on port %s", port)
        elif not _wait_ready(port):
            raise RuntimeError("工作台服务没有正常启动。")
        url = f"http://127.0.0.1:{port}"

        webview.settings["ALLOW_DOWNLOADS"] = True
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True

        window = webview.create_window(
            TITLE,
            url=url,
            width=1280,
            height=880,
            min_size=(980, 640),
            background_color="#f3eee3",
            text_select=True,
            confirm_close=False,
        )

        def stop_server() -> None:
            if server is None:
                return
            try:
                server.shutdown()
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass

        window.events.closed += stop_server
        webview.start(
            debug=False,
            private_mode=False,
            storage_path=str(storage.DATA_DIR / "webview"),
            icon=str(BASE_DIR / "landu.ico"),
        )
        return 0
    except Exception:
        app.LOGGER.exception("Desktop app failed")
        _message("工作台启动失败：\n\n" + traceback.format_exc(limit=3))
        return 1
    finally:
        if server is not None:
            try:
                server.server_close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())

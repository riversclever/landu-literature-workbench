#!/usr/bin/env bash
# 澜读 · 文献工作台 — macOS / Linux launcher
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python 3.10+ was not found. Install it from https://www.python.org/downloads/"
  exit 1
fi

if ! "$PYTHON" -c "import requests, pymupdf" >/dev/null 2>&1; then
  echo "First run: installing required packages..."
  "$PYTHON" -m pip install --user -r requirements.txt \
    || "$PYTHON" -m pip install -r requirements.txt
fi

exec "$PYTHON" app.py "$@"

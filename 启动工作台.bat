@echo off
setlocal
chcp 65001 >nul
title Landu Literature Workbench
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set PYTHONDONTWRITEBYTECODE=1

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python was not found. Please install Python 3.10+ from https://www.python.org/downloads/
  echo Remember to check "Add Python to PATH" during installation.
  echo.
  pause
  exit /b 1
)

python -c "import requests, pymupdf" >nul 2>nul
if errorlevel 1 (
  echo.
  echo First run: installing required Python packages...
  echo.
  python -m pip install --disable-pip-version-check -r requirements.txt
  if errorlevel 1 (
    echo.
    echo Package installation failed. Please run this command in this folder:
    echo   python -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
  )
)

python app.py
if errorlevel 1 (
  echo.
  echo The workbench failed to start. Please see the error above.
  pause
)

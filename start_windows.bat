@echo off
rem Start the docs site service (double-click friendly).
rem   - Default: authenticated editing service (Python 3.6.8+, deps in server/requirements.txt)
rem   - Missing deps: tries to install them; if that fails, falls back to read-only preview
rem   - Default: listens on all interfaces (LAN access); use --bind 127.0.0.1 for local-only
rem   - Read-only preview: start_windows.bat --preview
rem NOTE: keep this file ASCII-only (cmd parses .bat with the OEM codepage).
setlocal
cd /d "%~dp0"

rem Default to listening on all interfaces (LAN access).
rem Use --bind 127.0.0.1 for local-only.
set "APP_ARGS=%*"
echo %APP_ARGS% | findstr /C:"--bind" >nul
if errorlevel 1 set "APP_ARGS=%APP_ARGS% --bind 0.0.0.0"

set "PY=python"
%PY% -c "import sys" >nul 2>&1
if errorlevel 1 set "PY=py -3"
%PY% -c "import sys" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.6.8+ and enable "Add Python to PATH".
  echo         Download: https://www.python.org/downloads/
  pause
  exit /b 1
)

%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python 3.6.8 or newer is required. Current version:
  %PY% --version
  pause
  exit /b 1
)

%PY% -c "import flask, waitress" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Installing authenticated-editing dependencies ...
  %PY% -m pip install -r server/requirements.txt
  if errorlevel 1 (
    echo [WARN] Dependency install failed. Starting in READ-ONLY preview mode.
    echo        Install later with: %PY% -m pip install -r server/requirements.txt
  )
)

echo.
echo The browser will open http://localhost:8882
echo Default administrator: admin / admin  (change it in Settings after first login)
echo Press Ctrl+C to stop the service.
echo.
%PY% serve.py %APP_ARGS%

echo.
echo Service stopped.
pause

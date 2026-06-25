@echo off
REM ThreadNotes local dev launcher.
REM   Cloud Vault (auth + Azure token + GPT-4o diarization) -> http://localhost:8001
REM   Frontend    (Next.js dev)                             -> http://localhost:3000
REM Frontend reads the vault URL from frontend\.env.development automatically.
REM The local Python engine has been removed; the desktop uses the bundled ffmpeg.
setlocal

set "ROOT=%~dp0"
set "PY=%ROOT%backend\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

REM 1) Cloud Vault on :8001 (module path resolves from repo root)
start "ThreadNotes Vault :8001" cmd /k ""%PY%" -m uvicorn backend.vault.main:app --reload --port 8001"

REM 2) Frontend dev server on :3000
start "ThreadNotes Frontend :3000" cmd /k "cd /d "%ROOT%frontend" && npm run dev"

echo.
echo Launched Vault (8001) and Frontend (3000) in separate windows.
endlocal

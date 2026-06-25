@echo off
setlocal enabledelayedexpansion

REM The local Python AI engine has been purged. The desktop app is now pure
REM Node/Electron: it records, compresses via the bundled ffmpeg, and talks only
REM to the Cloud Vault. No PyInstaller step is required.

echo Verifying bundled ffmpeg.exe is present...
if not exist "%~dp0frontend\resources\ffmpeg.exe" (
  echo ERROR: frontend\resources\ffmpeg.exe is missing.
  echo Download a static Windows ffmpeg build and place ffmpeg.exe at frontend\resources\ffmpeg.exe
  pause
  exit /b 1
)

echo.
echo Building Electron app with electron-builder...
cd /d "%~dp0frontend"
npm install
npm run dist:win

if errorlevel 1 (
  echo Electron packaging failed.
  pause
  exit /b 1
)

echo.
echo Build complete. Check frontend\dist-electron for the installer.
pause

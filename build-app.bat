@echo off
setlocal enabledelayedexpansion

REM 1. Build the local AI engine executable with PyInstaller from the spec file
cd /d "%~dp0backend"
python -m pip install --upgrade pyinstaller
pyinstaller "local_ai_engine.spec" --clean

if errorlevel 1 (
  echo PyInstaller build failed.
  pause
  exit /b 1
)

echo.
echo Local AI engine built successfully.

echo Copying local_ai_engine.exe into frontend resource path...
if not exist "%~dp0frontend\backend\dist" mkdir "%~dp0frontend\backend\dist"
copy /y "%~dp0backend\dist\local_ai_engine.exe" "%~dp0frontend\backend\dist\local_ai_engine.exe"

if errorlevel 1 (
  echo Failed to copy local_ai_engine.exe.
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

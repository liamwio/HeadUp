@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 24.12+ is required. Please install Node.js and try again.
  pause
  exit /b 1
)
node scripts/start-headup.mjs %*
set "HEADUP_START_EXIT=%ERRORLEVEL%"
if /I not "%~1"=="--no-pause" pause
exit /b %HEADUP_START_EXIT%

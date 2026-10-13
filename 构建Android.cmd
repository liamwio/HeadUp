@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts/build-android.mjs
set "HEADUP_ANDROID_EXIT=%ERRORLEVEL%"
pause
exit /b %HEADUP_ANDROID_EXIT%

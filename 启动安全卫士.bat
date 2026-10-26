@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title XHY Security Guard
set PYTHONUTF8=1
python -m security_guard %*
if errorlevel 1 pause
endlocal

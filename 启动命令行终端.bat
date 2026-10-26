@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title XHY Personal Terminal
set PYTHONUTF8=1
python cli.py %*
if errorlevel 1 pause
endlocal

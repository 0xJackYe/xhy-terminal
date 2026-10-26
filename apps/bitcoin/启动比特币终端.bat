@echo off
chcp 65001 >nul
cd /d "%~dp0"
"C:\Users\yxh\AppData\Local\Programs\Python\Python39\python.exe" launch_btc_terminal.py
if errorlevel 1 pause

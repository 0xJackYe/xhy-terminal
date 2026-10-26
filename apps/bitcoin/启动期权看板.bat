@echo off
cd /d "%~dp0"
python launch_dashboard.py
if errorlevel 1 pause

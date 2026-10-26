@echo off
setlocal
cd /d "%~dp0"
if exist "C:\Users\yxh\AppData\Local\Programs\Python\Python39\pythonw.exe" (
  start "" "C:\Users\yxh\AppData\Local\Programs\Python\Python39\pythonw.exe" "%~dp0options_account_audit.py"
) else (
  python "%~dp0options_account_audit.py"
)
endlocal

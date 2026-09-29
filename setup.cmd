@echo off
rem Double-click to set up ReGain on Windows (runs setup.ps1 without changing the system policy).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause

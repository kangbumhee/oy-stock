@echo off
title OliveYoung Auto Login Settings
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0oy-login-secrets.ps1" -Action Setup
echo.
pause

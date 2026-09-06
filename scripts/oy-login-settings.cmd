@echo off
title OliveYoung Auto Login Settings
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0oy-login-secrets.ps1" -Action Setup
if errorlevel 1 goto done
powershell.exe -NoProfile -NonInteractive -Command "Start-ScheduledTask -TaskName 'OY Refresh Cookie Daily' -ErrorAction Stop"
if errorlevel 1 goto done
echo Saved. The first refresh has started in the background.
:done
echo.
pause

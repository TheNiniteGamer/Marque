@echo off
rem Runs marquee.ps1 (all the logic lives there). Double-click to use.
title Marquee - stop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0marquee.ps1" Stop
echo.
pause

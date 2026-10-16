@echo off
rem Runs marquee.ps1 (all the logic lives there). Double-click to use.
title Marquee - update
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0marquee.ps1" Update
echo.
pause

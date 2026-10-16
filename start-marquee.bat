@echo off
setlocal
title Marquee
cd /d "%~dp0"

rem ---- 1. Docker Desktop installed and running? ----
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker Desktop is not installed.
  echo   Install it from https://www.docker.com/products/docker-desktop/
  echo   start it once, then run this file again.
  echo.
  start "" https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)

docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
echo Starting Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
echo Waiting for Docker to be ready (this can take a minute)...
for /l %%i in (1,1,60) do (
  timeout /t 3 /nobreak >nul
  docker info >nul 2>&1 && goto docker_ready
)
echo.
echo   Docker did not start. Open Docker Desktop yourself, wait until it says
echo   "Engine running", then run this file again.
pause
exit /b 1
:docker_ready

rem ---- 2. First run: create the settings file ----
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo   First run: Notepad will open your settings file.
  echo   Set MOVIES_DIR, TV_DIR and YOUTUBE_DIR to your folders, e.g. D:/Movies
  echo   then SAVE and CLOSE Notepad to continue.
  echo.
  start /wait notepad ".env"
)

rem ---- 3. Build and start ----
echo.
echo Building and starting Marquee (the first time takes a few minutes)...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo   Something went wrong - see the messages above.
  echo   Tip: check that the folders in .env exist.
  pause
  exit /b 1
)

set PORT=
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"MARQUEE_PORT=" ".env"') do set PORT=%%b
if "%PORT%"=="" set PORT=32500

echo Waiting for Marquee to come up...
for /l %%i in (1,1,30) do (
  curl -s -o nul http://localhost:%PORT%/api/health && goto up
  timeout /t 2 /nobreak >nul
)
:up
start "" http://localhost:%PORT%
echo.
echo   Marquee is running:  http://localhost:%PORT%
echo   Other devices on your network:  http://%COMPUTERNAME%:%PORT%
echo   (allow Docker through Windows Firewall if your phone/TV can't connect)
echo.
echo   It keeps running in the background and starts with Docker Desktop.
echo   Use stop-marquee.bat to stop it.
echo.
pause

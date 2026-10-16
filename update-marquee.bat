@echo off
setlocal
cd /d "%~dp0"
if exist ".git" (
  where git >nul 2>&1 && (
    echo Getting the latest Marquee code...
    git pull --ff-only
  )
)
echo Rebuilding with the newest ffmpeg and yt-dlp...
docker compose build --pull --no-cache
if errorlevel 1 ( pause & exit /b 1 )
docker compose up -d
echo.
echo Marquee is updated. Your libraries, users and watch history are kept.
pause

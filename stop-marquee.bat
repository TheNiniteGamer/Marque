@echo off
cd /d "%~dp0"
echo Stopping Marquee...
docker compose down
echo Done. Your libraries, users and watch history are kept.
pause

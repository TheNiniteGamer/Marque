@echo off
cd /d "%~dp0"
echo Showing Marquee's log (press Ctrl+C to close)...
docker compose logs -f --tail 200

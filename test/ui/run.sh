#!/usr/bin/env bash
# Checks the web app in a real browser (Chromium, through Playwright), against a server started
# from the Docker image with two short films: pages load without errors, the library's ⋯ menu
# works, search and empty pages show, a title opens, and its video plays. Needs only Docker.
#
#   test/ui/run.sh              builds the image from this folder first
#   test/ui/run.sh IMAGE        uses an image already built (as GitHub's check does)
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then docker build -q -t marquee-ui . >/dev/null; IMAGE=marquee-ui; fi
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.48.2-noble
NET="marquee-ui-$$"
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$NET-server" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/films" "$WORK/data"

# Two short films a browser plays as they are (VP9 and Opus in WebM), so it's the player being
# checked rather than the server converting.
docker run --rm --user "$(id -u):$(id -g)" -v "$WORK/films:/films" --entrypoint ffmpeg "$IMAGE" -v error -y \
  -f lavfi -i testsrc2=size=640x360:rate=25:duration=20 -f lavfi -i sine=frequency=440:duration=20 \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 400k -c:a libopus "/films/Test Clip (2020).webm"
cp "$WORK/films/Test Clip (2020).webm" "$WORK/films/Second Clip (2021).webm"

docker network create "$NET" >/dev/null
docker run -d --name "$NET-server" --network "$NET" --user "$(id -u):$(id -g)" -v "$WORK/data:/data" -v "$WORK/films:/films:ro" \
  -e TVMAZE_DISABLED=1 -e SCAN_INTERVAL=0 "$IMAGE" >/dev/null

docker run --rm --network "$NET" -v "$PWD/test/ui:/ui:ro" -e BASE="http://$NET-server:32500" -e FILMS=/films "$PLAYWRIGHT" \
  sh -c 'cd /tmp && npm install --silent --no-audit --no-fund playwright@1.48.2 >/dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /ui/smoke.js' \
  || { echo "--- server log ---"; docker logs --tail 40 "$NET-server"; exit 1; }

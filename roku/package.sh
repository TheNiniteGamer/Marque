#!/usr/bin/env bash
# Zips the channel for sideloading onto a Roku in developer mode -> build/Marquee-Roku.zip
# (and a copy in the server's downloads, offered on the Account page).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf build && mkdir -p build
zip -qr -9 build/Marquee-Roku.zip manifest source components images fonts -x '*.DS_Store'
cp build/Marquee-Roku.zip ../public/downloads/Marquee-Roku.zip
echo "build/Marquee-Roku.zip ($(du -h build/Marquee-Roku.zip | cut -f1))"

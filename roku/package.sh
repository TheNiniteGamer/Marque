#!/usr/bin/env bash
# Zips the channel for sideloading onto a Roku in developer mode -> build/Marquee-Roku.zip
# (and a copy in the server's downloads, offered on the Account page).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf build && mkdir -p build
if command -v zip > /dev/null; then
  zip -qr -9 build/Marquee-Roku.zip manifest source components images fonts sounds -x '*.DS_Store'
else
  # (Debian doesn't come with zip; Python does the same.)
  python3 -I - <<'PY'
import os, zipfile
with zipfile.ZipFile('build/Marquee-Roku.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.write('manifest')
    for d in ['source', 'components', 'images', 'fonts', 'sounds']:
        for root, dirs, files in os.walk(d):
            dirs.sort()
            for f in sorted(files):
                if f != '.DS_Store': z.write(os.path.join(root, f))
PY
fi
cp build/Marquee-Roku.zip ../public/downloads/Marquee-Roku.zip
echo "build/Marquee-Roku.zip ($(du -h build/Marquee-Roku.zip | cut -f1))"

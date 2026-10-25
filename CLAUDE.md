# Marquee: notes for Claude

Marquee is a self-hosted, Plex-like media server for one family and a few close friends. It's
never released publicly, so favour what works well in this house over general-purpose options.

## The setup it runs on

- **Server PC:** moving from Windows 11 + Docker Desktop to **Debian 13 (Trixie)** + Docker Engine.
  Follow [docs/LINUX.md](docs/LINUX.md) for the move; `marquee.sh` is the Linux control script
  (`marquee.ps1` and the `.bat` files are the Windows ones, kept working too).
- **Graphics card:** NVIDIA RTX 3070 (NVENC), used with `GPU=nvidia` in `.env`.
- **Radarr and Sonarr** run on the same PC, outside Marquee's container (natively on Windows;
  reached from the container at `http://host.docker.internal:7878` / `:8989`).
- **Players:** an LG OLED with an NVIDIA Shield (the Android TV app), TCL 4K Rokus (the Roku
  channel), 1080p TVs, phones (the Android app) and browsers.
- **Media:** lots of MPEG-2 DVD rips (the overnight conversions make 1080p H.264 copies of these),
  films, TV shows and a YouTube folder.

## The code

- **Server:** Node 22, **no npm dependencies** (only Node's own modules, plus ffmpeg/ffprobe and
  yt-dlp in the Docker image). `server.js` sets things up; `routes/*.js` hold the API by area;
  `lib/*.js` the services. The database is one JSON file (`lib/store.js`).
- **Web client** (`public/`): plain JavaScript, no build step, no framework. The scripts share one
  global scope and load in the order listed in `public/index.html` (`core.js` first, `app.js`
  last). The Content-Security-Policy allows only same-origin scripts: no inline scripts, no CDNs
  (a library would have to be copied into `public/`). TV mode in the same files serves the Android
  TV app, which is a WebView.
- **Android phone app** (`android/`) and **Android TV app** (`androidtv/`, built from the phone
  app's Java with its own manifest): WebViews around the web client plus native players. Built with
  `build.sh` (just the Android SDK and a JDK, no Gradle; on the server PC in Docker, see
  `android/README.md`), signed with keys kept outside the repo in `~/.config/marquee-signing` (never
  commit a key). Versions are set in each `build.sh`.
- **Roku channel** (`roku/`): SceneGraph/BrightScript. `roku/package.sh` builds
  `public/downloads/Marquee-Roku.zip`; the version is `minor_version` in `roku/manifest`.
- **Keep the clients in step:** a feature in the web app should reach the Android, Android TV and
  Roku apps too, but TV apps stay simple (no watch-together, nothing that's awkward with a remote).

## Conventions

- Write code like the code around it: the same comment density, naming and idioms. Comments
  explain *why*, briefly.
- Text in the app is plain and friendly, written for family members, not technicians, with
  British spellings ("colour", "organise").
- `npm test` runs every test (`node --test`). Commit only when it reports `# fail 0`; add tests
  for server changes.
- **Releases:** bump `package.json`, add a section at the top of `CHANGELOG.md` (what changed, in
  plain words), update the README if a feature changes, and bump and rebuild whichever apps changed
  (Roku zip, APKs in `public/downloads/`).
- **Git:** commit as `Marquee Dev <theninitegamer@gmail.com>` (in a fresh clone:
  `git config user.name "Marquee Dev"` and `git config user.email theninitegamer@gmail.com`), on
  `main`, and push with `git push -u origin main`. No pull requests unless asked. No AI model names
  in code, docs or commit messages.
- **The GitHub repo is public:** don't commit copyrighted or branded material (e.g. a streaming
  service's intro sound or logo). Things like that are uploaded into a running server instead.
- When testing locally, stop only the processes you started (by PID); never `pkill -f node`.
- **Don't update or restart the live server** (`./marquee.sh update`/`start`, rebuilding the
  `marquee` container) without asking: the family may be watching. Push the release, then the user
  installs it from Settings → Updates (or asks you to). Try changes in the test copy instead.

## Running it for development

```bash
DATA_DIR=/tmp/marquee-data PORT=32500 node server.js   # then open http://localhost:32500
npm test
```

In Docker (as in production): `./marquee.sh start` on Linux, `start-marquee.bat` on Windows.

On the server PC, Node isn't installed; run the tests in the image with the code mounted:
`docker run --rm --user 1000:1000 -e HOME=/tmp -v ~/marquee:/src -w /src --entrypoint sh marquee:latest -c 'node --test test/*.test.js'`.
A **test copy** (`~/marquee-test/compose.yml`: its own image, data and port 32501, drives read-only)
runs the current code beside the live server:
`docker compose -f ~/marquee-test/compose.yml up -d --build`, and `… down` when done.

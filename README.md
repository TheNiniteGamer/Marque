# Marquee

A small, self-hosted media server inspired by Plex. Point it at your movie and TV folders, and it
organizes them into a browsable library you can stream to any browser on your network. Everyone in
the house gets their own account and their own watch history, and there's a built-in YouTube
downloader.

## Quick start on Windows (Docker)

1. **Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)** and start it once.
   Let it finish setting up (it may ask to enable WSL 2 and restart).
2. **Get Marquee:** on GitHub click **Code → Download ZIP** and extract it, or
   `git clone https://github.com/TheNiniteGamer/Marque.git`.
3. **Double-click `start-marquee.bat`.** The first time, Notepad opens your settings file. Point it
   at your folders, using forward slashes:
   ```ini
   MOVIES_DIR=D:/Movies
   TV_DIR=D:/TV Shows
   YOUTUBE_DIR=D:/YouTube
   ```
   Save and close Notepad. Marquee builds (a few minutes the first time), starts, and opens
   **http://localhost:32500** in your browser.
4. **Create your admin account** on the first screen. Your Movies, TV Shows and YouTube libraries
   are already set up and scanned.

| Script | What it does |
| --- | --- |
| `start-marquee.bat` | Starts Marquee (and Docker Desktop if needed), then opens the browser |
| `stop-marquee.bat` | Stops Marquee. Users, libraries and watch history are kept. |
| `update-marquee.bat` | Pulls the latest code (if you used `git clone`), rebuilds with the newest ffmpeg and yt-dlp, and restarts |
| `marquee-logs.bat` | Shows the server log, for troubleshooting |

Marquee restarts on its own whenever Docker Desktop is running. To start Docker Desktop with
Windows, turn on *Settings → General → Start Docker Desktop when you sign in*.

**Phones, TVs and other computers** can use `http://YOUR-PC-NAME:32500`. If they can't connect,
allow Docker Desktop through Windows Firewall on private networks.

### Movies (or TV) spread over several drives

One library can combine folders from several drives. They show up as a single collection, and
each folder is labelled in Settings with its file count. In `.env`, remove the `#` in front of the
extra slots and fill them in:

```ini
MOVIES_DIR=D:/Movies
MOVIES_DIR_2=E:/Movies
MOVIES_DIR_3=F:/More Movies
TV_DIR=D:/TV Shows
TV_DIR_2=E:/TV Shows
```

Run `start-marquee.bat` again, and the new folders join your existing Movies / TV Shows library on
their own. There are up to 4 movie and 4 TV folders. If a drive is unplugged, its movies and watch
history are kept, and the folder is marked *offline* in Settings until it's back.

You can also manage folders by hand in **Settings → Edit** on a library, using
**＋ Add another folder** and **Browse…**. Folders you remove there stay removed, even if they're
still listed in `.env`.

**Changing other settings later:** edit `.env`, then run `start-marquee.bat` again.

## Features

| Feature | What Marquee does |
| --- | --- |
| **Accounts** | Sign-in screen, with an admin account created on first run. Admins add users, choose which libraries each one can see, and decide who can use the downloader. Each user has their own watch history, Continue Watching and resume points. |
| **Libraries** | Movie and TV Show libraries, each combining one or more folders, which can be on different drives. Add, edit and remove them in Settings with a built-in folder picker. |
| **Scanning** | Probes new or changed files with `ffprobe`, removes deleted ones, and rescans periodically. If a drive is offline, its items and watch history are kept. |
| **Filename matching** | `Movie (Year).ext`, release-style names like `Movie.2019.1080p.BluRay.x264`, `Show/Season 01/Show - S01E02 - Title.ext`, `1x02`, `S01E01-E02`, Specials folders. |
| **Artwork & metadata** | Local `poster.jpg` / `fanart.jpg` / `<name>-poster.jpg`, or a frame from the video. Optional **TMDB** posters, summaries, genres, ratings and episode titles. |
| **Browsing** | Home screen with Continue Watching and Recently Added, poster grids with sort and an Unwatched filter, show pages with seasons, and live search (press `/`). |
| **Streaming** | **Direct Play** with instant seeking when the browser supports the file. Otherwise ffmpeg converts it **on the fly**, copying the video when possible so only the audio is converted. Falls back automatically if direct play fails. |
| **Player** | Seek bar with hover time, skip, volume, fullscreen, keyboard shortcuts, audio track choice, subtitles (sidecar `.srt`/`.vtt` or embedded), and an Up Next countdown. |
| **YouTube downloader** | Paste a video or playlist link, pick a library and quality. Saves an MP4 that plays directly, the thumbnail as its poster, and English subtitles when available, then adds it to the library. Has a queue with progress, cancel and retry, plus **Update yt-dlp** for when YouTube changes. |

Only download videos you have the right to save. Respect the site's terms and copyright.

## Running without Docker

Requires Node.js 18+ and `ffmpeg` / `ffprobe`. For downloads, also install
[yt-dlp](https://github.com/yt-dlp/yt-dlp#installation).

```bash
npm start                 # → http://localhost:32500
```

`npm run sample` creates a demo library in `./sample-media` with synthetic clips covering every
playback path.

## Recommended folder layout

```
Movies/
  The Matrix (1999)/The Matrix (1999).mkv
  The Matrix (1999)/The Matrix (1999).en.srt
  The Matrix (1999)/poster.jpg
  Heat (1995).mp4
TV Shows/
  Breaking Bad/
    poster.jpg
    Season 01/Breaking Bad - S01E01 - Pilot.mkv
```

## Configuration (environment variables)

With Docker, the common ones are set in `.env`. The rest can go under `environment:` in
`docker-compose.yml`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `32500` / `0.0.0.0` | Where the server listens |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, thumbnails, caches |
| `MEDIA_ROOT` | home folder (`/media` in Docker) | Where the folder picker starts |
| `AUTO_LIBRARIES` | — | Libraries to set up from config: `Name:movie\|show:/path1,/path2;…`. Checked on every start, so new folders are added. |
| `MEDIA_LABELS` | — | Display names for container folders: `/media/movies=D:/Movies\|…` (set by Docker Compose) |
| `SCAN_INTERVAL` | `30` | Minutes between automatic rescans (`0` disables) |
| `TMDB_API_KEY` / `TMDB_TOKEN` | — | Enables online metadata (free key from themoviedb.org) |
| `TRANSCODE_PRESET` | `veryfast` | x264 preset used when video must be re-encoded |
| `YTDLP_PATH` | `yt-dlp` | Location of yt-dlp |
| `DOWNLOAD_CONCURRENCY` | `1` | Downloads that run at the same time |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Custom binary locations |

## Security notes

- Passwords are hashed with scrypt. Sessions use `HttpOnly`, `SameSite=Lax` cookies and last 30
  days. Repeated failed sign-ins from one address are rate-limited. Changing a password signs out
  your other devices.
- Non-admin users only see the libraries shared with them. Folder paths, the folder picker and
  server settings are admin-only.
- Marquee serves plain HTTP, which is fine on a home network. To reach it from the internet, put it
  behind an HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel, Tailscale…) rather than
  forwarding the port directly.
- On Linux hosts (not needed on Windows), the container runs as uid 999. Make sure that user can
  write to your YouTube folder (`chown 999 /path/to/youtube`).

## Keyboard shortcuts (player)

`Space`/`K` play/pause · `←`/`J` back 10 s · `→`/`L` forward 30 s · `↑`/`↓` volume · `M` mute ·
`F` fullscreen · `C` toggle subtitles · `Esc` close

## Architecture

```
server.js           HTTP server + REST API (node:http, no framework); route-level access control
lib/auth.js         users, scrypt passwords, cookie sessions, library permissions
lib/downloader.js   yt-dlp job queue (progress parsing, cancel/retry, self-update)
lib/parse.js        filename → title/year/show/season/episode, sidecar subs, local art
lib/scanner.js      folder walking, ffprobe, show grouping, TMDB enrichment
lib/media.js        ffprobe/ffmpeg: probe, thumbnails, direct-play check, live transcode, seek points
lib/library.js      per-user API shaping: hubs, continue watching / up next, search, watch state
lib/metadata.js     optional TMDB client
lib/subtitles.js    SRT→VTT, cue time-shifting
lib/store.js        JSON-file database with atomic writes
public/             single-page web client (vanilla JS): app.js (browse/play), manage.js (accounts, downloads)
Dockerfile, docker-compose.yml, *.bat   container image and Windows helpers
```

## Tests

```bash
npm test     # unit tests + integration tests that boot a real server
```

The integration tests need ffmpeg. The download test also needs yt-dlp; it is skipped when yt-dlp
isn't installed.

## Not yet supported

Music and photo libraries, hardware-accelerated transcoding, image-based subtitles (PGS/VobSub),
adaptive (HLS) streaming, and parental content ratings.

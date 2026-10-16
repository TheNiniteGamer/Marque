# Marquee

A small, self-hosted media server inspired by Plex. Point it at your movie and TV folders, and it
organizes them into a browsable library you can stream to any browser on your network. It picks up
where you left off and keeps track of what you've watched.

**Zero npm dependencies.** All you need is Node.js 18+ and `ffmpeg`/`ffprobe`.

## Features

| Plex-style feature | What Marquee does |
| --- | --- |
| **Libraries** | Movie and TV Show libraries, each backed by one or more folders. Add/edit/remove from the web UI with a built-in folder picker. |
| **Scanning** | Walks folders, probes new or changed files with `ffprobe`, removes deleted ones, and rescans periodically. If a folder is offline (e.g. an unplugged drive), its items and watch history are kept. |
| **Filename matching** | Understands `Movie (Year).ext`, scene names like `Movie.2019.1080p.BluRay.x264`, `Show/Season 01/Show - S01E02 - Title.ext`, `1x02`, multi-episode `S01E01-E02`, `Specials` folders, and year-in-folder names. |
| **Artwork & metadata** | Local `poster.jpg` / `folder.jpg` / `fanart.jpg` / `<name>-poster.jpg`. If there's no art, it grabs a frame from the video. Optionally pulls posters, backdrops, summaries, genres, ratings and episode titles from **TMDB**. |
| **Home hubs** | *Continue Watching* (movies in progress plus the next episode of each show you're watching) and *Recently Added* per library. |
| **Browsing** | Poster grids with sort (title, date added, year, rating, duration) and an *Unwatched* filter. Show pages have a season picker, episode list and an unwatched badge. |
| **Search** | Live search across movies, shows and episodes (press `/` to focus). |
| **Streaming** | **Direct Play** with HTTP range requests (instant seeking) when the browser supports the file. Otherwise it **transcodes on the fly** to fragmented MP4 with ffmpeg: H.264 video is stream-copied and only the audio is converted when possible. If direct play fails, it falls back to transcoding automatically. |
| **Player** | Custom controls: seek bar with hover time, ±10/30 s skip, volume, fullscreen, keyboard shortcuts, audio track selection, and an *Up Next* countdown between episodes. |
| **Subtitles** | Sidecar `.srt`/`.vtt` files (`Movie.en.srt`, `Movie.es.forced.srt`) and embedded text subtitle tracks, converted to WebVTT and kept in sync while seeking in a transcode. |
| **Watch state** | Progress is saved every 10 s. An item counts as watched at 90%. Resume or play from the start, and mark items, seasons or whole shows watched or unwatched. |
| **Download** | Download the original file from any item page. |

## Quick start

```bash
# requires node >= 18 and ffmpeg on PATH
npm start                 # → http://localhost:32500
```

Open the web UI, go to **Settings → Add library**, pick a type (Movies or TV Shows) and a folder.
The scan starts immediately.

No media handy? `npm run sample` generates a demo library in `./sample-media` with synthetic clips
that cover every playback path: a direct-play MP4, a direct-play WebM, an MKV that gets remuxed, and
an AVI that gets fully transcoded. It also includes sidecar and embedded subtitles and a two-season
show.

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
    Season 01/Breaking Bad - S01E02.mkv
```

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `32500` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to this machine) |
| `DATA_DIR` | `./data` | Database, thumbnails, cached artwork and subtitles |
| `SCAN_INTERVAL` | `30` | Minutes between automatic rescans (`0` disables) |
| `TMDB_API_KEY` / `TMDB_TOKEN` | — | Enable online metadata (free key from themoviedb.org) |
| `TRANSCODE_PRESET` | `veryfast` | x264 preset used when video must be re-encoded |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Custom binary locations |

## Keyboard shortcuts (player)

`Space`/`K` play/pause · `←`/`J` back 10 s · `→`/`L` forward 30 s · `↑`/`↓` volume · `M` mute ·
`F` fullscreen · `C` toggle subtitles · `Esc` close

## Architecture

```
server.js          HTTP server + REST API (node:http, no framework)
lib/parse.js       filename → title/year/show/season/episode, sidecar subs, local art
lib/scanner.js     folder walking, ffprobe, show grouping, TMDB enrichment
lib/media.js       ffprobe/ffmpeg: probe, thumbnails, direct-play check, live transcode, seek points
lib/library.js     API shaping: hubs, continue watching / up next, search, watch state
lib/metadata.js    optional TMDB client
lib/subtitles.js   SRT→VTT, cue time-shifting
lib/store.js       JSON-file database with atomic writes
public/            single-page web client (vanilla JS, hash routing)
```

When a transcode starts mid-file with stream-copied video, ffmpeg can only begin on a keyframe. The
client asks `/api/items/:id/seekpoint` where the stream will actually start and uses that as its
clock offset, so the timeline and subtitles stay accurate.

## Tests

```bash
npm test
```

## Limitations / next steps

- **No authentication.** Anyone who can reach the port can browse and stream your library and list
  folder names through the folder picker. Keep it on a trusted network, or bind to `127.0.0.1`
  behind a reverse proxy with auth.
- One user profile. Watch state is shared.
- No music or photo libraries, hardware-accelerated transcoding, image-based subtitles (PGS/VobSub),
  or bandwidth-adaptive (HLS) streaming yet.

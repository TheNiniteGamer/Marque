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
| `update-marquee.bat` | Gets the latest version from GitHub (works for `git clone` and ZIP installs), rebuilds with the newest ffmpeg and yt-dlp, and restarts. Your `.env`, users and libraries are kept. |
| `marquee-logs.bat` | Shows the server log, for troubleshooting |

All of them run `marquee.ps1`, which you can also use directly, e.g.
`powershell -ExecutionPolicy Bypass -File marquee.ps1 InstallHelper`.

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

You can also manage folders by hand in **Settings → Libraries → Edit** on a library, using
**＋ Add another folder** and **Browse…**. Folders you remove there stay removed, even if they're
still listed in `.env`.

### Other drives

To add folders from any drive in the web interface (instead of listing each folder in `.env`),
share the whole drive with Marquee once. In `.env` (if your `.env` is older than these settings,
running `start-marquee.bat` adds them at the end of it for you):

```ini
DRIVE_1=E:/
DRIVE_2=F:/
```

Run `start-marquee.bat` again. **Settings → Libraries → Add library → Browse…** then lists *E: drive* and
*F: drive* on the left, and you can pick any folder on them (or type a path like `E:/Movies`).
Marquee only reads from these drives. The picker shows how many videos a folder holds, counting
the folders inside it — a library always includes everything below the folder you pick, so
`TV/Kids/Bluey/Season 1/…` and `TV/Anime/Naruto/…` are found as the shows *Bluey* and *Naruto*.

**Changing other settings later:** edit `.env`, then run `start-marquee.bat` again.

### Watching away from home

Marquee is only reachable on your home network until you switch on one of these. Nothing is opened
to the internet unless you do.

**Tailscale (recommended, free).** This gives you a private HTTPS address that only your own
devices can use, with no router setup.
1. Create an account at [tailscale.com](https://tailscale.com). In the admin console, open
   **DNS** and turn on **HTTPS Certificates**.
2. Create an auth key under **Settings → Keys** and paste it into `.env` as `TS_AUTHKEY=…`.
3. Run `start-marquee.bat`. Marquee joins your tailnet as `marquee`.
4. Install the Tailscale app on your phone or laptop and sign in. Then open
   `https://marquee.<your-tailnet>.ts.net`. The exact address is in the Tailscale app under
   *Machines*, and in **Settings → Remote access** once you've used it. The Android app works with
   it too.

To let people **without** Tailscale in (e.g. family on their own devices), set
`TAILSCALE_PUBLIC=true`. This uses Tailscale Funnel, so anyone with the link can reach your sign-in
page. You may also need to allow Funnel in Tailscale's access controls.

**Cloudflare Tunnel (for your own domain).** In Cloudflare Zero Trust, create a tunnel and add a
public hostname pointing to `http://marquee:32500`. Paste the tunnel token into `.env` as
`CLOUDFLARE_TUNNEL_TOKEN=…`, then run `start-marquee.bat`.

Either way, the extra container starts just because its key is set in `.env`. To turn it off,
clear the key and run `start-marquee.bat` again.

### Backups

Marquee backs itself up every night at 03:00 into the `backups` folder next to
`docker-compose.yml`. You can change the folder with `BACKUP_DIR` in `.env`, and point it at
another drive or a synced folder (OneDrive/Dropbox) for extra safety.
- **What's in a backup:** users and passwords, watch history, My List, libraries, your edits and
  custom artwork, downloaded posters, and settings. Your media files are not included.
- **Format:** each backup is a `.tar.gz` you can open with 7-Zip.
- **Settings → Backups:** change the time, how many automatic backups to keep (default 7), back up
  now, download a backup, or restore one. You can restore from the list or by uploading a file,
  e.g. to move Marquee to a new PC.
- **Safety copy:** before restoring, Marquee saves a backup of how things are now, so a restore can
  be undone.
- **Kept forever:** backups you make yourself are never deleted automatically.
- **A second copy somewhere else:** *Settings → Backups → Also keep a copy somewhere else* copies
  every backup to another folder as well (another drive, a network share, or a OneDrive / Google
  Drive / Dropbox folder, which then copies it off the PC), keeping the newest 14 there by default.
  In Docker, share that folder's drive first (see *Other drives*). If a copy fails (a drive
  unplugged, a share offline), Settings and the health check say so.

### Graphics card (faster video conversion)

Videos your browser can't play as they are get converted while you watch. A graphics card does
this much faster than the CPU, and can handle several viewers at once.
1. In `.env`, set `GPU=nvidia` (an NVIDIA card on Windows or Linux), or `GPU=intel` / `GPU=amd`
   (built-in graphics, **Linux hosts only**: Docker Desktop on Windows can't pass these through).
2. Run `start-marquee.bat` again.
3. *Settings → Playback* shows which converter is in use, and why a card isn't used if it
   couldn't start. Marquee tests each card with a short encode at start-up, and falls back to the
   CPU on its own if the card fails during playback.

On Windows, NVIDIA needs Docker Desktop's WSL 2 backend (the default) and a current NVIDIA
driver; nothing needs to be installed inside WSL. Without Docker, ffmpeg needs to be built with
NVENC / VAAPI / QSV support. Set `HWACCEL=nvenc|vaapi|qsv|software` to force a choice.

### Casting to a TV

- **Chromecast / Google TV:** the cast button appears in the player in **Chrome or Edge**, when
  Marquee is opened as `http://localhost:32500` on the server PC or over HTTPS (Tailscale /
  Cloudflare). Google only allows casting from secure pages, so it doesn't appear on plain
  `http://192.168…` addresses.
- The TV fetches the video from Marquee itself, so it needs an address it can reach.
  `start-marquee.bat` passes this PC's network address automatically. If casting doesn't start,
  set it in *Settings → Playback*, e.g. `http://192.168.1.20:32500`. A Tailscale address only
  works for casting with `TAILSCALE_PUBLIC=true`, because the TV isn't on your tailnet.
- **AirPlay:** Safari on Mac, iPhone and iPad shows its AirPlay button in the player.
- Casting uses a signed link that lasts 12 hours and only opens that one video.

### Watching on a TV (Roku, Android TV, TV browsers)

- **Android TV / Google TV / Fire TV:** install `Marquee-TV.apk` (Account → *Watch on a TV* has the
  link; see [`androidtv/README.md`](androidtv/README.md)).
- **Roku:** add the channel in Roku's developer mode with `Marquee-Roku.zip` (same place; see
  [`roku/README.md`](roku/README.md)).
- **A TV's own web browser** works too: Marquee switches to TV mode by itself on most TVs.

**Signing in:** the TV shows a **code**. On your phone or computer, open
`http://YOUR-PC:32500/#/link` (or **Account → Watch on a TV**), type the code, and the TV signs in
as you a few seconds later. Nobody types a password with a remote (*Sign in with a password
instead* is there if you need it). Linked TVs are listed on that page, where you can unlink them.

### Updating

Marquee checks GitHub for new versions twice a day. Admins see a green dot on their avatar when an
update is available. **Settings → Server & updates** shows what's new, and has **Check now** and
**Update now** buttons.

Big releases are labelled **Significant update** in Settings → Server & updates, and listed in
[CHANGELOG.md](CHANGELOG.md). For maintainers: a commit is marked by an `Update-Type: significant`
line in its message, or a subject starting with `[Significant]`.

**Update now** needs the *update helper*, a small background task on the server PC. The app runs
inside Docker and can't rebuild itself, so the helper does it. The first time you run
`start-marquee.bat`, it asks whether to turn the helper on; answer **Y**.
- **What it is:** a Windows scheduled task named "Marquee Updater" that starts when you sign in.
- **What it does:** it waits until you press *Update now*, then downloads the new version,
  rebuilds and restarts Marquee. The web page shows progress and reloads by itself when the update
  is done.
- **Turning it off:** run `marquee.ps1 RemoveHelper`, or delete the task in Task Scheduler.
- **Without the helper:** run `update-marquee.bat` on the server PC. It does exactly the same thing.

The helper and the app talk only through the `control` folder next to `docker-compose.yml`. The app
never gets access to Docker itself.

## Features

| Feature | What Marquee does |
| --- | --- |
| **Look** | A red-and-black design: a top bar, a featured banner on the home page (with its trailer playing quietly when there is one), rows that scroll sideways (Continue Watching, My List, New in each library, collections, "Because you watched …", genres), wide cards with titles on the artwork, and a **More info** pop-up with episodes, extras and **More like this**. Works on phones (with a bar along the bottom) and in the Android app. |
| **TV apps** | A **Roku** channel and an **Android TV** app, signed in by typing the code the TV shows into your phone. Both have profiles; Android TV also has voice search and puts Continue Watching on the TV's home screen. TV mode in the web interface: bigger highlights, the remote's arrows move between titles, Back closes pop-ups. |
| **Hover previews** | On a computer, resting the pointer on a title opens a larger card playing its trailer quietly, or (without a trailer) a 30-second clip from the title itself that the server makes the first time it's wanted, with Play, My List and More info. The home page's banner plays one too. On/off in *Settings → Playback*. |
| **Accounts** | Sign-in screen, with an admin account created on first run. Admins add users, choose which libraries each one can see, and decide who can use the downloader. Each user has their own watch history, Continue Watching and resume points. Admins can **reset a password** (a temporary one they must change when they sign in) and **unlock** someone locked out by wrong passwords or PINs. |
| **Libraries** | Movie and TV Show libraries, each combining one or more folders, which can be on different drives. Everything inside the folders is found, including shows in folders of their own (`Kids/Bluey/…`). Add, edit and remove them in Settings with a built-in folder picker that lists your drives, accepts typed paths and shows how many videos a folder holds; whole drives can be shared with Docker (see *Other drives*). |
| **Scanning** | Probes new or changed files with `ffprobe`, removes deleted ones, and rescans periodically. If a drive is offline, its items and watch history are kept. |
| **Filename matching** | `Movie (Year).ext`, release-style names like `Movie.2019.1080p.BluRay.x264`, `Show/Season 01/Show - S01E02 - Title.ext`, `1x02`, `S01E01-E02`, Specials folders. |
| **Online metadata** | Posters, backgrounds, summaries, genres, ratings, cast and episode titles. TV shows use **TVmaze** (no key needed). Movies and TV can also use **TMDB**: paste a free API key in *Settings → Metadata & subtitles*. Pick the metadata language there too. New items are matched automatically. |
| **Fix match / refresh** | When a title is matched wrong: *⋯ → Fix match…*, search, and pick the right result from a list with posters. *Refresh metadata* and *Unmatch* are in the same menu. |
| **Edit anything** | Change the title, sort title, year, tagline, summary and genres of a movie, show or episode. Set a poster or background by **uploading an image**, pasting a URL, or choosing from the matched source's alternatives. Your edits always win: refreshes and rescans never overwrite them, and each field can be reset to automatic. |
| **Artwork** | Local `poster.jpg` / `fanart.jpg` / `<name>-poster.jpg`, online artwork, your own uploads, or a frame grabbed from the video. |
| **Browsing** | Home screen with Continue Watching, My List and Recently Added. Library grids with sort, genre filter, title filter, an Unwatched filter, adjustable poster size, an A–Z jump bar and **Shuffle**. Show pages with seasons, cast lists, clickable genres, and live search (press `/`). The scroll position is kept when you go back. |
| **My List & menus** | A **⋯** menu on every poster: play, mark watched/unwatched, add to **My List** (a per-user watchlist), remove from Continue Watching, and, for admins, edit / fix match / refresh. |
| **Streaming** | **Direct Play** with instant seeking when the browser supports the file. Otherwise ffmpeg converts it **on the fly**, copying the video when possible so only the audio is converted. Falls back automatically if direct play fails. |
| **Quality / adaptive streaming** | Pick **Original**, **Auto** or a fixed 1080p / 720p / 480p / 360p in the player. *Auto* uses HLS adaptive streaming, which switches quality to suit the connection. It is the default when you're away from home. Segments are made on demand, so seeking anywhere starts within seconds. |
| **Graphics card conversion** | NVIDIA (NVENC), Intel Quick Sync and Intel/AMD VAAPI, detected automatically, with fallback to the CPU. |
| **Skip intro, Up Next at the credits** | Theme songs and end credits are found automatically by comparing the audio of episodes in a season. A **Skip Intro** button appears during the intro (`S`), or turn on automatic skipping under *Account*. When the credits start, **Up Next** offers the next episode (with *Watch credits* to stay). Admins can fix either by hand: *⋯ → Edit intro & credits…*, or ✂ in the player. |
| **Seek preview thumbnails** | Pictures above the seek bar while you hover or drag. They're made the first time a video is opened (a few seconds to a minute or two for a film). |
| **Kids profiles & ratings** | Titles carry their maturity rating (PG-13, TV-14, 12A…, from TMDB for your country, or set by hand with *⋯ → Edit*), shown as a badge. Give a profile a limit in *Settings → Users* (and choose whether unrated titles show): anything above it disappears everywhere for that profile. |
| **Downloads on the phone** | The Android app saves movies and episodes to watch offline: the original file when the phone plays it, or a 1080p / 720p / 480p copy the server makes first. *Downloads* lists them; progress goes back to the server when you're online again. |
| **Personal touches** | Sound and subtitle languages are remembered per show; 👍 / 👎 on titles steers suggestions ("Because you liked …"); a **Top 10 in your house this week** row; cast photos and **actor pages**; who's in it shows when you pause. |
| **Requests** | Anyone can ask for a film or show (looked up on TMDB / TVmaze, or typed in) with a note; admins approve, decline or mark it added on the Requests page. It's marked as here by itself when it turns up, and whoever asked gets a notification. |
| **Notifications** | A bell with new episodes of shows you watch (or have on My List) and news about your requests; the phone app shows them as phone notifications. |
| **Health check** | Settings shows disk space, offline folders, backups (and whether they're copied off the PC), update and graphics-card problems at a glance; admins are notified when something turns bad. |
| **Skip Recap** | "Previously on…" recaps are found automatically and get a Skip Recap button. |
| **Night mode** | Clearer dialogue and quieter loud scenes, on every player (Account → Player, or ☾ in the player). |
| **Who's watching?** | Profiles for a shared TV or tablet: anyone who sets a PIN (*Account*) can be switched to with it, and admins can let children's accounts be picked without one. *Switch profile* is in the account menu; *Account → Ask “Who's watching?”* shows the picker when Marquee opens on that device. Five wrong PINs lock a profile for 10 minutes. |
| **Activity** | *Activity* (admins) shows who's watching what right now, on which device, whether at home or away, direct or converted (and on the graphics card or CPU), plus the server's CPU and memory use. |
| **Casting** | Chromecast / Google TV from Chrome and Edge, AirPlay from Safari. Includes subtitles, resume position and next episode. |
| **Watch together** | 👥 in the player makes a watch party and gives you a link. Everyone with an account who opens it stays in sync: play, pause, skipping and the next episode. |
| **Subtitles** | Sidecar `.srt`/`.vtt`, embedded text subtitles, and Blu-ray / DVD picture subtitles (PGS, VobSub), which the server draws into the video. Missing ones can be found on **OpenSubtitles.com** from the player (*Subtitles → Search online…*) once an admin adds a free API key in *Settings → Metadata & subtitles*. |
| **Quality limit away from home** | *Settings → Playback*: cap the quality for people watching through Tailscale, Cloudflare or from outside, so one viewer can't use up your upload. |
| **Collections** | Film series from TMDB (e.g. “The Matrix Collection”) are grouped automatically, and admins can make their own with *⋯ → Add to collection…* or by selecting titles (**☑ Select**). Collections are listed in separate **Movies, TV and YouTube** sections (worked out from their titles, or chosen with *Show under*). Each collection has an **order**: release date, **episode number in the title** (“Ep 12”, “S2E5”, “Part 3”…), title, date added, reversed, or **arranged by hand**. **⌕ Find series** turns videos like “Hardcore Survival Ep 1, Ep 2…” into collections. Movies in a collection show as the collection on the home page and in libraries; switch a library to *All titles* (or untick it under *Account*) to see every movie on its own. Admins can override anything: rename (TMDB ones too), add or remove titles, pick the cover (*⋯ → Use as the collection's cover*), hide TMDB collections, *Reset to TMDB*, and **⇅ Arrange** each section. |
| **Select several** | **☑ Select** in a library, collection, My List or search: click titles (Shift+click for a range, Ctrl+A for all), then add them to a collection or a new one, mark watched/unwatched, add to My List, add or remove a genre, or refresh metadata — all at once. |
| **Extras** | Trailers, featurettes and behind-the-scenes clips show on their movie or show page instead of in the library (see the folder layout below). |
| **New files appear by themselves** | Marquee notices files added, removed or renamed in your folders within about 15 seconds, including on Windows drives in Docker. Files still being copied are picked up once they're finished. |
| **Logs and housekeeping** | *Settings → Server & updates → Logs* shows recent warnings and errors with plain-language explanations. *Settings → Server & updates* shows the space caches use; unused cached files are cleaned up daily. The database is saved crash-safely (with a `.bak` copy) and restored from the newest backup if it's ever unreadable. |
| **Accurate matching** | Each match gets a score from the title (ignoring punctuation, “The”, “II” vs “2”, original-language titles), the year, and for movies the **running time** (so a 2-hour file isn't matched to the 90-minute film or remake with the same name). Poor matches are never applied. Doubtful ones are listed under *Settings → Libraries → Library problems → Matches that need a check*, with the best guesses as posters to pick from in one click, or *✓ It's right*. **Ids in names** match exactly: `Heat (1995) {tmdb-949}`, `[imdbid-tt0113277]`, or `{tvdb-81189}` on a show folder. **Re-check matches** looks up a whole library again with these rules (matches you picked or confirmed are kept). |
| **Library problems** | *Settings → Libraries → Library problems* lists offline folders, unreadable files, matches that need a check, titles with no online match, duplicates and missing episodes. |
| **Player** | Seek bar with hover time, skip, volume, **playback speed**, **picture-in-picture**, fullscreen, keyboard shortcuts, audio track choice, subtitles (sidecar `.srt`/`.vtt` or embedded), and an Up Next countdown. Autoplay and default subtitles can be set per browser under *Account*. |
| **YouTube downloader** | Paste a video or playlist link, pick a library and quality. Saves an MP4 that plays directly, the thumbnail as its poster, English subtitles when available, and the video's details: its title, description, upload date, channel, a link to the original and its chapters (shown as marks on the seek bar). It is never matched to the wrong movie. **Nothing is downloaded twice**: a link you already have is caught, with *Download again* to override. Admins can set **download hours** (e.g. overnight) and a **speed limit**. Failed downloads are **retried automatically** and continue where they stopped. **yt-dlp updates itself** daily, and you get a notice when a download finishes. |

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
  The Matrix (1999)/The Matrix (1999)-trailer.mkv          (an extra: also -featurette, -behindthescenes,
  The Matrix (1999)/Extras/Making of.mkv                     -deleted, -interview, -scene, -short; or folders
TV Shows/                                                     Extras, Trailers, Featurettes, Behind The Scenes…)
  Breaking Bad/
    poster.jpg
    Season 01/Breaking Bad - S01E01 - Pilot.mkv
    Featurettes/Inside the episode.mkv
```

For titles that are hard to find by name, add the database id in curly braces and it matches exactly:
`Movies/Heat (1995) {tmdb-949}/Heat.mkv`, `Heat (1995) [imdbid-tt0113277].mkv`, or a show folder
like `TV Shows/The Office (US) {tvdb-73244}/`. The id is found on the title's page at themoviedb.org,
imdb.com or thetvdb.com.

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
| `SCAN_INTERVAL` | `30` | Minutes between automatic rescans (`0` disables). While new files are noticed on their own (`WATCH_INTERVAL`), full rescans run at most every 6 hours. |
| `TMDB_API_KEY` / `TMDB_TOKEN` | — | TMDB key from the environment (easier: set it in *Settings → Metadata & subtitles*) |
| `METADATA_LANGUAGE` | `en-US` | Default metadata language (also settable in *Settings → Metadata & subtitles*) |
| `TVMAZE_DISABLED` | — | Set to `1` to stop using TVmaze |
| `TRANSCODE_PRESET` | `veryfast` | x264 preset used when video must be re-encoded |
| `HWACCEL` | `auto` | Video converter: `auto`, `software`, `nvenc`, `qsv`, `vaapi` (also in *Settings → Playback*) |
| `GPU` | — | `.env` only: `nvidia`, `intel` or `amd` passes the graphics card into Docker |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Graphics device for VAAPI / Quick Sync |
| `TRANSCODE_DIR` | system temp folder | Where adaptive-streaming segments are written while you watch |
| `HLS_MAX_SESSIONS` | `6` | Adaptive streams converted at the same time |
| `CAST_URL` | — | Address cast devices use to reach Marquee |
| `MARQUEE_NAME` | the PC's name | Shown by TVs and phones that find Marquee on the network |
| `INTRO_SCAN_SECONDS` | `600` | How much of each episode's start is searched for the intro |
| `WATCH_INTERVAL` | `15` | Seconds between checks for new or removed files (`0` turns this off; scans then run every `SCAN_INTERVAL`). On large or slow drives the checks space themselves out, waiting at least 10× as long as a check took. |
| `YTDLP_PATH` | `yt-dlp` | Location of yt-dlp |
| `DOWNLOAD_CONCURRENCY` | `1` | Downloads that run at the same time |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Custom binary locations |

## Security notes

- Passwords are hashed with scrypt. Sessions use `HttpOnly`, `SameSite=Lax` cookies and last 30
  days. Repeated failed sign-ins from one address are rate-limited. Changing a password signs out
  your other devices.
- Non-admin users only see the libraries shared with them. Folder paths, the folder picker and
  server settings are admin-only.
- Marquee serves plain HTTP, which is fine on a home network. To reach it from outside, use the
  built-in Tailscale or Cloudflare Tunnel options (see *Watching away from home*) or another HTTPS
  reverse proxy. Don't forward the port on your router.
- Behind a tunnel, Marquee uses the real visitor's address (from `X-Forwarded-For`, trusted only
  from local proxies) for sign-in rate limits. It marks cookies `Secure` and sends HSTS. The very
  first admin account can only be created from the home network or your own Tailscale devices.
  Set `TRUST_PROXY=0` if Marquee isn't behind a proxy you control.
- **Admin settings only at home** (Settings → Remote access): away from home, admins can still
  watch, but Settings, users and the other admin pages only answer on the home network, so a
  leaked admin password can't change anything from outside. Recommended once Marquee is reachable
  from outside.
- Changes are refused when a browser says they come from another site (`Sec-Fetch-Site`), on top
  of `SameSite=Lax` cookies. TVs put a media key (pictures and videos only) in addresses rather
  than their sign-in. Sign-ins are limited per address and per username; PINs lock after repeated
  wrong tries.
- The web pages send a Content-Security-Policy (only Marquee's own scripts, plus Google's Cast SDK,
  can run; no framing), and server error details stay in Settings → Server & updates → Logs rather than the browser.
  New passwords need at least 8 characters.
- Backups contain password hashes and your TMDB key: keep them somewhere private (that includes
  the second copy you may keep in a cloud folder).
- On Linux hosts (not needed on Windows), the container runs as uid 999. Make sure that user can
  write to your YouTube and backups folders (`chown 999 /path/to/youtube /path/to/backups`).

## Keyboard shortcuts

Press `?` anywhere for the full list.

- **Anywhere:** `/` search · `g` then `h` go home · `g` then `l` My List
- **Player:** `Space`/`K` play/pause · `←`/`J` back 10 s · `→`/`L` forward 30 s · `↑`/`↓` volume ·
  `M` mute · `F` fullscreen · `C` subtitles · `N` next episode · `<`/`>` speed ·
  `P` picture-in-picture · `S` skip intro · `Esc` close
- **TV remote (TV mode):** arrows move · OK opens · Back closes or goes back · in the player OK
  plays/pauses and the media keys work

## Architecture

```
server.js           HTTP server (node:http, no framework): shared helpers, the router with route-level access control, start-up
routes/             the REST API by area: auth.js (sign-in, profiles, users), library.js, playback.js, admin.js, downloads.js
lib/auth.js         users, scrypt passwords, cookie sessions, library permissions
lib/downloader.js   yt-dlp job queue (progress parsing, cancel/retry, self-update)
lib/parse.js        filename → title/year/show/season/episode, sidecar subs, local art
lib/scanner.js      folder walking, ffprobe, show grouping, TMDB enrichment
lib/media.js        ffprobe/ffmpeg: probe, thumbnails, direct-play check, live transcode, seek points
lib/hwaccel.js      encoder choice (NVENC / QSV / VAAPI / x264), start-up tests, fallback
lib/hls.js          adaptive streaming: VOD playlists, on-demand segment conversion per session
lib/requests.js     requests ("can we get …?"): asking, the admin's list, noticing when a title arrives
lib/notifications.js  each person's notifications (new episodes, requests, health)
lib/health.js       the health check (disk space, folders, backups, updates, errors)
lib/previews.js     preview clips for hovering over titles (made on first use, in the background)
lib/offline.js      copies for the phone app's downloads (MP4s made in the background, kept a week)
lib/ratings.js      maturity ratings as ages, and what each profile is allowed to see
lib/intro.js        intro and credits detection (Chromaprint audio fingerprints compared across a season)
lib/tokens.js       signed, expiring playback links for cast devices and native players
lib/watcher.js      notices folder changes (polls folder times; works on Docker bind mounts and network drives)
lib/collections.js  automatic (TMDB) and hand-made collections, order rules (episode numbers in titles), sections, series finder
lib/party.js        watch together: shared play state pushed to members over Server-Sent Events
lib/opensubtitles.js  subtitle search/download from OpenSubtitles.com
lib/problems.js     library health check (offline folders, duplicates, missing episodes…)
lib/trickplay.js    seek preview thumbnail sheets
lib/activity.js     "now playing" sessions for the Activity page
lib/library.js      per-user API shaping: hubs, continue watching / up next, search, watch state
lib/metadata.js     metadata providers (TMDB, TVmaze), image downloads
lib/matcher.js      matching, refresh/unmatch, user edits and custom artwork (edits > metadata > file name)
lib/subtitles.js    SRT→VTT, cue time-shifting
lib/store.js        JSON-file database with atomic writes
public/             single-page web client (vanilla JS): app.js (browse/play), manage.js (accounts, downloads),
                    fonts/ (Archivo and Figtree, SIL Open Font License),
                    extras.js (menus, edit/match dialogs, My List, settings panels, shortcuts), select.js (☑ Select and
                    bulk actions), cast.js (Google Cast), tv.js (TV mode: moving with a remote),
                    vendor/hls.js (Apache-2.0, for adaptive streaming in browsers without native HLS)
android/            the Android app (WebView + native player), built without Gradle
androidtv/          the Android TV app: android/'s code with a TV manifest and banner
roku/               the Roku channel (BrightScript / SceneGraph)
Dockerfile, docker-compose.yml, *.bat   container image and Windows helpers
```

## Tests

```bash
npm test     # unit tests + integration tests that boot a real server
```

The integration tests need ffmpeg. The download test also needs yt-dlp; it is skipped when yt-dlp
isn't installed.

## Not yet supported

Music and photo libraries. Hardware conversion, casting and the TV apps are tested here only against
ffmpeg, a simulated Cast SDK, the BrightScript compiler and Android's build tools (not on real TVs),
so please report problems with specific graphics cards or TVs.

# Marquee

Marquee is a home media server, inspired by Plex, for one family and a few close friends. Point it
at your film and TV folders and it turns them into a library with posters, summaries and cast, which
everyone in the house can watch on a browser, phone, Android TV box or Roku. Each person gets their
own account, watch history and Continue Watching, and there's a built-in YouTube downloader.

**What you get**

- A Netflix-style home screen, with rows for Continue Watching, My List, new arrivals, collections
  and "Because you watched…".
- Playback that just works on every device. Files are played as they are when the device can, and
  converted on the fly (on the graphics card, if you have one) when it can't.
- Apps for **Android phones**, **Android TV / Google TV / Fire TV** and **Roku**. TVs sign in with a
  code instead of a password.
- Family features: profiles with PINs, kids' rating limits, bedtime and daily screen time,
  requests ("can we get…?") that can go straight to Radarr and Sonarr, and watching together.
- Housekeeping that looks after itself: automatic matching, nightly backups, overnight conversions
  of awkward files, skip-intro markers, subtitles and one-click updates.

It runs in Docker on **Linux** or **Windows**. Nothing is reachable from outside your home unless
you switch it on.

## Getting started

### On Linux (Debian, Ubuntu…)

Follow **[docs/LINUX.md](docs/LINUX.md)**: install Docker, put your folders in `.env`, then run
`./marquee.sh start`. That guide also covers graphics cards, folder permissions and moving an
existing Windows install across.

### On Windows

1. **Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)** and start it once.
   Let it finish setting up (it may ask to turn on WSL 2 and restart).
2. **Get Marquee.** On GitHub, click **Code → Download ZIP** and extract it, or run
   `git clone https://github.com/TheNiniteGamer/Marque.git`.
3. **Double-click `start-marquee.bat`.** The first time, Notepad opens your settings file (`.env`).
   Point it at your folders, using forward slashes:
   ```ini
   MOVIES_DIR=D:/Movies
   TV_DIR=D:/TV Shows
   YOUTUBE_DIR=D:/YouTube
   ```
   Save and close Notepad. Marquee builds (a few minutes the first time), starts, and opens
   **http://localhost:32500**.
4. **Create your admin account** on the first screen. Your Movies, TV Shows and YouTube libraries are
   already set up and being scanned.

**Phones, TVs and other computers** open `http://YOUR-PC-NAME:32500`. If they can't connect, allow
Docker Desktop through Windows Firewall on private networks. Marquee starts again by itself whenever
Docker Desktop is running. To start Docker Desktop with Windows, turn on *Settings → General → Start
Docker Desktop when you sign in*.

### Starting, stopping and updating

| Windows | Linux | What it does |
| --- | --- | --- |
| `start-marquee.bat` | `./marquee.sh start` | Starts Marquee (and Docker Desktop on Windows), and opens the browser on Windows |
| `stop-marquee.bat` | `./marquee.sh stop` | Stops Marquee. Users, libraries and watch history are kept. |
| `update-marquee.bat` | `./marquee.sh update` | Gets the latest version (from a `git clone` or a ZIP install), rebuilds with the newest ffmpeg and yt-dlp, and restarts |
| `marquee-logs.bat` | `./marquee.sh logs` | Shows what the server is doing, for troubleshooting |

The `.bat` files run `marquee.ps1`, which you can also use directly, e.g.
`powershell -ExecutionPolicy Bypass -File marquee.ps1 InstallHelper`. To change a setting later,
edit `.env` and run the start script again. Settings added by newer versions are appended to your
`.env` for you, with an explanation of each.

## Setting it up

### Your folders

**One library, several drives.** In `.env`, remove the `#` in front of the extra slots and fill them
in. There are up to four film and four TV folders:

```ini
MOVIES_DIR=D:/Movies
MOVIES_DIR_2=E:/Movies
TV_DIR=D:/TV Shows
TV_DIR_2=E:/TV Shows
```

Run the start script again and the new folders join your existing library. Each folder is listed in
*Settings → Libraries* with how many files it has. If a drive is unplugged, its titles and their
watch history are kept, and the folder is marked *offline* until it's back.

**Whole drives, picked in the web page.** To choose folders in *Settings → Libraries → Browse…*
instead of listing each one in `.env`, share whole drives with Marquee once:

```ini
DRIVE_1=E:/
DRIVE_2=F:/
```

The folder picker then lists *E: drive* and *F: drive*, shows how many videos each folder holds, and
accepts typed paths like `E:/Movies`. A library includes everything below the folder you pick, so
`TV/Kids/Bluey/…` and `TV/Anime/Naruto/…` become the shows *Bluey* and *Naruto*. Marquee only writes
to these drives where you ask it to (converted copies, backup copies, subtitle files). Add
`DRIVES_ACCESS=ro` to make them read-only.

You can also add and remove folders on a library with **Edit** in *Settings → Libraries*. Folders
you remove there stay removed, even if `.env` still lists them.

### Watching away from home

Marquee only answers on your home network until you switch one of these on.

**Tailscale (recommended, free).** This gives your own devices a private, secure address, with no
router changes.
1. Create an account at [tailscale.com](https://tailscale.com). In the admin console, open **DNS**
   and turn on **HTTPS Certificates**.
2. Create an auth key under **Settings → Keys** and put it in `.env` as `TS_AUTHKEY=…`.
3. Run the start script. Marquee joins your Tailscale network as `marquee`.
4. Install the Tailscale app on your phone or laptop and sign in. Then open
   `https://marquee.<your-tailnet>.ts.net`. The exact address is in the Tailscale app and, once
   you've used it, in *Settings → Remote access*.

Already running Tailscale on the server PC itself (say, to share your whole home network)? That
works too: phones on Tailscale use the normal home address, and Marquee still counts them as away
from home.

To let people **without** Tailscale in, set `TAILSCALE_PUBLIC=true`. This uses Tailscale Funnel, so
anyone with the link can reach your sign-in page. You may need to allow Funnel in Tailscale's access
controls.

**Cloudflare Tunnel (your own domain).** In Cloudflare Zero Trust, create a tunnel with a public
hostname pointing to `http://marquee:32500`. Put its token in `.env` as
`CLOUDFLARE_TUNNEL_TOKEN=…`, then run the start script.

Either helper starts just because its key is in `.env`. Clear the key and run the start script
again to turn it off. Don't forward Marquee's port on your router.

### Radarr and Sonarr

Marquee can pass approved requests to [Radarr](https://radarr.video) (films) and
[Sonarr](https://sonarr.tv) (shows), which find and download them. When the file arrives, the
request is marked as here and whoever asked gets a notification. Works with Radarr 3–5 and Sonarr 3
and 4.

In **Settings → Radarr & Sonarr**:
1. **Connect.** If Radarr and Sonarr run as normal programs on the same PC, the addresses are
   `http://host.docker.internal:7878` and `http://host.docker.internal:8989`. Their API keys are in
   their own *Settings → General*.
2. **Quality profile.** The profile requests are added with. Each shows the biggest picture it lets
   in, and ones that allow 4K are flagged (those files are several times bigger). A 1080p profile is
   picked for you.
3. **Folder.** Radarr's or Sonarr's root folder for new downloads. It must be a folder one of
   Marquee's libraries uses, and on a drive shared with Docker, or downloads won't show up.
4. **Seasons (Sonarr).** What a show gets when its request goes straight through: the first season
   (the default), the latest season, new episodes from now on, or everything.
5. **Who can skip approval,** for films and shows separately. Their requests go straight through,
   as admins' do, and they can choose each time between **Download now** and **Add to requests**.
   Everyone else's wait for you. When you approve one, you can pick a different profile (and seasons),
   or *Approve only* to mark it approved without sending it.

The Requests page shows how each one is getting on: *Looking for a copy*, *Downloading · 45% · 20
min left*, *Not out yet (expected 2027-03-12)*, *7 of 62 episodes downloaded*. If Radarr or Sonarr
can't be reached, the request waits with a **Try again** button and admins are told.

- **Shows:** whoever asked hears when the first episodes arrive, and that it's all here once Sonarr
  has every episode it was asked for. *＋ More seasons* on a show's page asks for the rest, season
  by season.
- **Limits:** a free-space floor (requests that would skip approval wait for you when the download
  folder has less than 100 GB free, by default), a weekly allowance per person, and after how many
  days something not found is flagged (7 by default), with **Look again** and **Try another
  quality**.

### Graphics card

A graphics card converts video much faster than the processor, and copes with several viewers at
once.

1. In `.env`, set `GPU=nvidia` for an NVIDIA card (Windows or Linux), or `GPU=intel` / `GPU=amd` for
   Intel or AMD graphics, including Intel Arc cards (**Linux only**: Docker Desktop on Windows can
   only pass an NVIDIA card through, so on Windows these are skipped with a note). With two cards
   on Linux, e.g. NVIDIA for other programs and an Intel Arc for Marquee, set `GPU=nvidia,intel`,
   pick the Intel one in *Settings → Playback* and point `VAAPI_DEVICE` at it.
2. Run the start script again.
3. *Settings → Playback* shows which converter is in use, or why a card couldn't be used.

The card decodes and resizes the video as well as encoding it, so the processor stays almost free.
Marquee tests each card when it starts, falls back to the processor by itself if the card fails, and
tries the card again later. On Windows, NVIDIA needs only Docker Desktop's WSL 2 backend (the
default) and a current NVIDIA driver. `HWACCEL=nvdec|nvenc|vaapidec|vaapi|qsv|software` forces a
choice.

### Overnight conversions

DVD rips, 4K and HEVC files have to be converted every time a 1080p TV, a Roku or a browser plays
them. *Settings → Overnight conversions* makes a 1080p copy of each at night instead, so they play
as they are from then on.

- **It never gets in the way.** It pauses whenever anyone is watching anything, and carries on
  afterwards. It shows how long it has left, and admins can **Pause**, **Carry on** or **Stop for
  tonight** here or on the Activity page.
- **The copy is another version of the title.** Each device plays whichever version it can play as
  it is (a 4K TV still gets the original). Watch progress, skip-intro and subtitles are shared. The
  originals are never changed.
- **Which files:** DVD rips and older formats, 4K files, HEVC/AV1, and anything else the 1080p TVs
  can't play. Where only the sound or the file type was the trouble, the picture is copied rather
  than converted. Copies keep every sound track (as stereo) and text subtitles.
- **When and how much:** the hours it may run (01:00–07:00 by default; *Start now* runs it for six
  hours) and the space the copies may take (200 GB by default).
- **Where:** in the copies folder (`OPTIMIZED_DIR`, `./optimized` by default), **next to the
  originals** (in a hidden `.marquee-converted` folder that the library, Radarr, Sonarr and Plex all
  skip), or **a folder you pick** (on a shared drive). *Move them here* moves copies already made. A
  DVD film's copy is about 1–2 GB, and a 4K film's about 4–8 GB.

### Backups

Marquee backs itself up every night at 03:00, into the `backups` folder next to
`docker-compose.yml` (`BACKUP_DIR` in `.env` changes it).

- **What's in a backup:** users and passwords, watch history, My List, libraries, your edits and
  artwork, and settings. Not your media files. Each backup is a `.tar.gz` that 7-Zip can open.
- **Settings → Backups:** change the time and how many to keep (7 by default), back up now,
  download one, or restore one, from the list or by uploading it (e.g. to move to a new PC).
- **Safe to restore:** Marquee saves how things are first, so a restore can be undone, and damaged
  files are refused before anything changes. Backups you make yourself are never deleted
  automatically.
- **Checked:** each backup is read back as soon as it's written, so a full or failing drive shows up
  now, not on the day you need it.
- **A second copy elsewhere:** *Also keep a copy somewhere else* copies every backup to another
  drive, a network share or a OneDrive / Google Drive / Dropbox folder (the newest 14 by default).
  If that copy fails, Settings and the health check say so.

Backups contain password hashes and your keys, so keep them somewhere private.

### TVs and casting

- **Android TV / Google TV / Fire TV:** install `Marquee-TV.apk` (*Account → Watch on a TV* has the
  link; see [`androidtv/README.md`](androidtv/README.md)).
- **Roku:** add the channel in the Roku's developer mode with `Marquee-Roku.zip` (see
  [`roku/README.md`](roku/README.md)). After that, *Settings → Server & updates → Roku TVs* updates
  every Roku from Marquee.
- **A TV's own web browser** works too: Marquee switches to TV mode by itself.
- **Signing in:** the TV shows a code. On your phone, open **Account → Watch on a TV** (or
  `http://YOUR-PC:32500/#/link`) and type it in. The TV signs in as you a few seconds later.
  Linked TVs are listed on that page, where you can unlink them.
- **Chromecast / Google TV:** the cast button appears in the player in Chrome and Edge when Marquee
  is opened over HTTPS (Tailscale / Cloudflare) or as `http://localhost:32500` on the server. Google
  doesn't allow casting from plain `http://192.168…` addresses. The TV fetches the video from
  Marquee, so if casting doesn't start, set the server's address in *Settings → Playback*.
- **AirPlay:** Safari on a Mac, iPhone or iPad shows its AirPlay button in the player.

### Updating

Marquee checks for new versions twice a day. Admins see a green dot on their picture when one is
available, and **Settings → Server & updates** shows what's new, with **Check now** and **Update**.

**Updating doesn't interrupt anyone.** Pressing **Update** builds the new version while Marquee
keeps running, then restarts into it (about a minute) once nobody's watching: nobody playing, and
nobody paused for under 15 minutes. While it waits, the page says how many are watching and offers
**Restart now anyway**. If a restart does happen mid-film, every player shows "Reconnecting to
Marquee…" and carries on from the same moment. Tick **Install updates by itself at night** to have
them installed between 2 and 5 am, when nobody's watching. Big releases are marked **Significant
update** and listed in [CHANGELOG.md](CHANGELOG.md).

The **Update** button needs the *update helper*, a small background task on the server PC (the app
runs inside Docker and can't rebuild itself). The start script offers to turn it on the first time;
answer **Y**.
- **Windows:** a scheduled task, "Marquee Updater", that runs while you're signed in. Remove it with
  `marquee.ps1 RemoveHelper` or in Task Scheduler.
- **Linux:** a system service, `marquee-updater` (`./marquee.sh install-helper` / `remove-helper`).
- **Without it:** run the update script on the server PC. It does the same thing.

The helper and the app talk only through the `control` folder. The app never gets access to Docker.

## What it can do

### Watching

- **Plays as it is whenever it can.** Direct play with instant seeking when the device supports the
  file. MKVs with ordinary H.264 video keep their original picture (only the sound is converted),
  and HEVC plays unconverted in browsers that can decode it. Everything else is converted on the
  fly, and if one way of playing fails, Marquee falls back to another by itself.
- **Quality:** *Original*, *Auto* (adaptive, the default away from home) or a fixed 1080p / 720p /
  480p / 360p. Seeking anywhere starts within seconds. Admins can cap the quality for people away
  from home, so one viewer can't use up your upload.
- **HDR:** HDR10, HLG and Dolby Vision keep their colours when converted, instead of looking grey.
  Devices that show HDR themselves get the file as it is.
- **Skip Intro, Skip Recap and Up Next:** theme songs, recaps and end credits are found by comparing
  episodes' sound. Skipping can be automatic, and Up Next offers the next episode at the credits.
  Admins can adjust the markers by hand.
- **The player:** seek-bar thumbnails, playback speed, picture-in-picture, sound-track and subtitle
  choice, night mode (clearer dialogue, quieter loud scenes) and keyboard shortcuts. "Are you still
  watching?" appears after three episodes play by themselves.
- **Subtitles:** `.srt`/`.vtt` files, subtitles inside the file, and DVD / Blu-ray picture subtitles
  (drawn into the video). Missing ones can be found on OpenSubtitles.com from the player, or fetched
  automatically in each person's languages, once an admin adds a free API key.
- **Versions:** two copies of a film (say 4K and 1080p) are one title, and each device plays the copy
  it can play as it is. Discs ripped with MakeMKV become one film plus its extras.
- **Watch together:** 👥 in the player makes a link. Everyone who opens it stays in sync.
- **Phone downloads:** the Android app saves films and episodes for offline viewing, as the original
  file or a smaller copy the server makes. Progress goes back to the server once you're online.

### Finding something to watch

- **Home screen:** a featured banner (playing its trailer quietly), Continue Watching, My List, new in
  each library, collections, franchises, "Because you watched…", a **Top 10 in your house this
  week**, and **Coming soon** (new episodes and films on their way, from Sonarr and Radarr).
- **Hover previews:** resting the pointer on a title plays its trailer, or a short clip from the title.
- **Search** (press `/`) finds titles, actors ("tom hanks"), genres and moods ("funny"), years and
  decades ("90s comedy") and words from the story ("christmas"), and forgives spelling mistakes.
- **Libraries:** sorting, genre and title filters, unwatched only, card sizes, an A–Z bar and
  **Shuffle**. Actor pages, 👍 / 👎 to steer suggestions, and sound and subtitle choices remembered
  for each show.
- **Collections:** film series from TMDB are grouped automatically, and you can make your own, in
  any order you like (including by episode number in the title, "Ep 12", "Part 3"). **⌕ Find series**
  turns numbered videos into collections.
- **Franchises:** the Marvel Cinematic Universe, Star Wars, DC, the Wizarding World, Middle-earth,
  Star Trek, Pixar, Studio Ghibli and others are found automatically. Each page shows how many you've
  seen and what to watch next, in release or story order.

### The family

- **Accounts:** each person has their own history, My List and resume points, and sees only the
  libraries you share with them. Admins can reset passwords and unlock accounts.
- **Who's watching?** Profiles with pictures for a shared TV, each with an optional PIN. Children's
  profiles can be picked without one. Five wrong PINs lock a profile for 10 minutes.
- **Kids' ratings:** titles carry their age rating (PG-13, TV-14, 12A…). Give a profile a limit and
  anything above it disappears everywhere for them.
- **Screen time:** a bedtime (every night, or school nights only) and a daily limit per profile,
  enforced on every TV, phone and browser. What's playing stops with a message when time's up.
- **Requests:** anyone can ask for a film or show, or more seasons, with a note. Admins approve or
  decline, or Radarr and Sonarr take it from there (see above). It's marked as here when it turns up.
- **Notifications:** new episodes of shows you watch, and news about your requests. The phone app
  shows them as phone notifications.
- **The look:** a red-and-black design with an opening animation (any key skips it; *Account* turns
  it off; admins can upload their own sound), which works on phones, TVs and in the apps.

### Looking after the library

- **New files appear by themselves** within about 15 seconds, and files still being copied are
  picked up once finished. When Radarr or Sonarr renames a file or upgrades it to a better copy,
  its watch history, My List place and fixes follow it.
- **Matching:** posters, backgrounds, summaries, cast and episode titles from **TMDB** (with a free
  key), **TVmaze** (no key needed) and **TheTVDB** (where Sonarr gets its episode numbers). Matches
  are scored on the title, year and running time, so a remake isn't mistaken for the original, and
  doubtful ones are listed for a one-click check. An id in a file or folder name matches exactly:
  `Heat (1995) {tmdb-949}`.
- **Fixing things:** *⋯ → Fix match* to pick the right title, *Fix episode* for files named with the
  wrong numbers, *Episode numbering* for anime numbered straight through, and *Edit* to change any
  title, summary, genre, rating or artwork. Your edits always win over refreshes and rescans.
- **Artwork:** local `poster.jpg` / `fanart.jpg`, online artwork, your own uploads, or a frame from
  the video.
- **Extras:** trailers, featurettes and behind-the-scenes clips show on their film or show page
  rather than in the library.
- **☑ Select:** pick several titles and add them to a collection, mark them watched, add a genre or
  refresh them, all at once.
- **YouTube downloader:** paste a video or playlist link, pick a library and quality. It saves an
  MP4 with its thumbnail, subtitles, description and chapters, never downloads the same video twice,
  retries failed downloads, and can be limited to certain hours or a speed. Only download videos you
  have the right to save.

### Keeping an eye on it

- **Activity** (admins): who's watching what, on which device, whether it's being converted and why,
  with a **Stop** button; background work (overnight conversions, scans, subtitles); the last 24
  hours of viewing; and the server's processor and memory use.
- **Health check:** disk space, offline folders, backups, updates and graphics-card problems at a
  glance. Admins are notified when something goes wrong.
- **Library problems:** offline folders, unreadable files, doubtful matches, unmatched titles,
  duplicates and missing episodes.
- **Formats & space:** what the space goes on, and which titles each kind of device has to convert.
- **Logs and Speed:** recent warnings and errors in plain words, and how quickly Marquee has been
  answering, so "it feels slow" can be checked rather than guessed at.
- **A dashboard summary:** with `DASHBOARD_KEY` set, a wall dashboard such as Homepage can show
  who's watching, conversions, requests and library sizes.

## Folder layout

```
Movies/
  The Matrix (1999)/The Matrix (1999).mkv
  The Matrix (1999)/The Matrix (1999).en.srt
  The Matrix (1999)/poster.jpg
  The Matrix (1999)/The Matrix (1999)-trailer.mkv   (an extra; also -featurette, -behindthescenes,
  The Matrix (1999)/Extras/Making of.mkv              -deleted, -interview, -scene, -short, or folders
  Heat (1995).mp4                                     named Extras, Trailers, Featurettes…)
TV Shows/
  Breaking Bad/
    poster.jpg
    Season 01/Breaking Bad - S01E01 - Pilot.mkv
    Featurettes/Inside the episode.mkv
```

Release-style names (`Movie.2019.1080p.BluRay.x264`), `1x02`, double episodes (`S01E01-E02`) and
Specials folders are understood too. For titles that are hard to find by name, add the database id
in curly brackets: `Heat (1995) {tmdb-949}/`, `Heat (1995) [imdbid-tt0113277].mkv`, or a show
folder like `The Office (US) {tvdb-73244}/`. The id is on the title's page at themoviedb.org,
imdb.com or thetvdb.com.

## Settings reference

With Docker, the common settings go in `.env` (each is explained there). Others can be added under
`environment:` in `docker-compose.yml`.

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` / `HOST` | `32500` / `0.0.0.0` | Where the server listens (`MARQUEE_PORT` in `.env`) |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, thumbnails and caches |
| `MEDIA_ROOT` | home folder (`/media` in Docker) | Where the folder picker starts |
| `AUTO_LIBRARIES` | — | Libraries set up from config: `Name:movie\|show:/path1,/path2;…`. Checked at every start, so new folders are added. |
| `MEDIA_LABELS` | — | Your real folder names for the ones inside Docker (set by Docker Compose) |
| `SCAN_INTERVAL` | `30` | Minutes between full rescans (`0` turns them off). While new files are noticed by themselves, full rescans run at most every 6 hours. |
| `WATCH_INTERVAL` | `15` | Seconds between checks for new or removed files (`0` turns this off). On large or slow drives, checks space themselves out. |
| `SCAN_PROBES` | `3` | New files a scan looks at together (one while someone's watching) |
| `TMDB_API_KEY` / `TMDB_TOKEN` | — | TMDB key (easier to set in *Settings → Metadata & subtitles*) |
| `TVDB_API_KEY` / `TVDB_PIN` | — | TheTVDB project key and subscriber PIN (or in *Settings → Metadata*) |
| `METADATA_LANGUAGE` | `en-US` | Language for summaries and titles (also in Settings) |
| `TVMAZE_DISABLED` | — | `1` stops using TVmaze |
| `GPU` | — | `.env` only: `nvidia`, `intel`, `amd` or `nvidia,intel` passes the graphics card into Docker |
| `HWACCEL` | `auto` | Video converter: `auto`, `software`, `nvdec`, `nvenc`, `vaapidec`, `vaapi` or `qsv` (also in *Settings → Playback*) |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Intel/AMD graphics device (with two cards, `ls -l /dev/dri/by-path` shows which is which) |
| `TRANSCODE_PRESET` | `veryfast` | How hard the processor works when it converts video |
| `TRANSCODE_DIR` | system temp folder | Where streaming segments are written while you watch |
| `HLS_MAX_SESSIONS` | `6` | Videos converted at once. When all are in use, a newcomer is told the server is busy rather than stopping someone else. |
| `INTRO_SCAN_SECONDS` | `600` | How much of each episode's start is searched for the intro |
| `CAST_URL` | — | Address cast devices use to reach Marquee (the Windows script fills it in) |
| `MARQUEE_NAME` | the PC's name | Shown by TVs and phones that find Marquee on the network |
| `DASHBOARD_KEY` | — | Lets a wall dashboard read `/api/dashboard`, sent as an `X-Dashboard-Key` header. Off when empty. |
| `TRUST_PROXY` | on | `0` if Marquee isn't behind a proxy you control (see *Security*) |
| `YTDLP_PATH` / `DOWNLOAD_CONCURRENCY` | `yt-dlp` / `1` | The YouTube downloader, and how many downloads run at once |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Custom program locations |

## Security

- Passwords are hashed with scrypt, and new ones need at least 8 characters. Sessions use
  `HttpOnly`, `SameSite=Lax` cookies that last 30 days. Changing a password signs out your other
  devices.
- Sign-ins are limited per address and per username, and PINs lock after repeated wrong tries.
- People only see the libraries shared with them. Folder paths, the folder picker and server
  settings are for admins only. *Admin settings only at home* (*Settings → Remote access*) makes
  those pages answer only on the home network, so a leaked admin password can't change anything
  from outside.
- Marquee serves plain HTTP, which is fine at home. From outside, use Tailscale, Cloudflare Tunnel or
  another HTTPS proxy, and never forward the port on your router. Behind a tunnel, Marquee uses the
  real visitor's address for sign-in limits (trusted only from local proxies), marks cookies
  `Secure` and sends HSTS. The very first admin account can only be made from home or your own
  Tailscale devices.
- Changes are refused when a browser says they come from another site. TVs put a media key
  (pictures and videos only) in their addresses instead of their sign-in.
- Pages only run Marquee's own scripts (plus Google's Cast SDK) and can't be framed. Error details
  stay in *Settings → Server & updates → Logs*, not in the browser.
- On Linux the container runs as its own user, also in your group. `./marquee.sh check` makes sure
  it can write to your YouTube, backups and copies folders (see
  [docs/LINUX.md](docs/LINUX.md#folder-permissions)).

## Keyboard shortcuts

Press `?` anywhere for the full list.

- **Anywhere:** `/` search · `g` then `h` home · `g` then `l` My List
- **Player:** `Space`/`K` play or pause · `←`/`J` back 10 s · `→`/`L` forward 30 s · `↑`/`↓` volume ·
  `M` mute · `F` full screen · `C` subtitles · `N` next episode · `<`/`>` speed ·
  `P` picture-in-picture · `S` skip intro · `Esc` close
- **TV remote:** arrows move · OK opens · Back closes or goes back · in the player, OK plays or pauses
  and the media keys work

## For developers

### Running without Docker

Needs Node.js 22 and `ffmpeg` / `ffprobe` (and [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation)
for downloads). There are no npm packages to install.

```bash
npm start           # → http://localhost:32500
npm run sample      # a demo library in ./sample-media covering every way of playing
```

### Tests

```bash
npm test            # unit tests, plus integration tests that start a real server (need ffmpeg)
test/ui/run.sh      # the web app in a real browser (needs Docker)
```

The download test also needs yt-dlp, and is skipped without it. GitHub runs both on every change.

### How it's built

```
server.js           HTTP server (node:http, no framework): shared helpers, the router with access control, start-up
routes/             the API by area: auth.js (sign-in, profiles, users), library.js, playback.js, requests.js,
                    admin.js, downloads.js
lib/store.js        the database: one JSON file, written atomically, with recovery from backups
lib/auth.js         users, scrypt passwords, cookie sessions, library permissions
lib/tokens.js       signed, expiring playback links for cast devices and native players
lib/scanner.js      folder walking, ffprobe, show grouping; history follows renamed and replaced files
lib/watcher.js      notices folder changes (works on Docker folders and network drives)
lib/parse.js        file name → title / year / show / season / episode, sidecar subtitles, local art
lib/matcher.js      matching, refresh / unmatch, edits and custom artwork (edits > metadata > file name)
lib/metadata.js     TMDB, TVmaze and TheTVDB, image downloads
lib/library.js      what each person sees: home rows, Continue Watching / Up Next, watch state
lib/search.js       search: titles, cast, genres, years, story; spelling mistakes
lib/collections.js  automatic and hand-made collections, ordering, sections, the series finder, franchise pages
lib/franchises.js   the franchise and studio catalogue (MCU, Star Wars, Pixar…)
lib/media.js        ffprobe / ffmpeg: probing, thumbnails, direct-play checks, live conversion, seek points
lib/hls.js          adaptive streaming: playlists, segments converted on demand for each viewer
lib/keyframes.js    where each file's keyframes are (for streaming the original picture in segments)
lib/hwaccel.js      choosing the converter (NVIDIA / Intel / AMD / processor), start-up tests, fallback
lib/hdr.js          HDR detection and tone mapping
lib/picture.js      deinterlacing and square pixels (DVDs)
lib/optimize.js     overnight conversions (offered as versions, "<id>~o")
lib/offline.js      copies for the phone app's downloads
lib/intro.js        intro, recap and credits detection (audio fingerprints compared across a season)
lib/trickplay.js    seek-bar thumbnails          lib/previews.js   hover preview clips
lib/subtitles.js    SRT → VTT, timing shifts      lib/opensubtitles.js   OpenSubtitles.com
lib/autosubs.js     automatic subtitles in the family's languages
lib/requests.js     requests: asking, approving, sending to Radarr / Sonarr, noticing arrivals
lib/arr.js          Radarr and Sonarr: connecting, quality profiles, adding titles, download progress
lib/upcoming.js     Coming soon: Sonarr / Radarr calendars, next episodes from TMDB / TVmaze
lib/notifications.js  each person's notifications
lib/ratings.js      age ratings, and what each profile may see    lib/screentime.js   bedtime and daily limits
lib/party.js        watch together (play state shared over Server-Sent Events)
lib/activity.js     who's watching, for the Activity page
lib/downloader.js   the yt-dlp queue (progress, cancel / retry, self-update)
lib/backup.js       nightly backups, restoring, the second copy   lib/tar.js   reading and writing .tar.gz
lib/updates.js      update checks, and the update helper (through the control folder)
lib/rokus.js        finding Rokus and sending them the channel
lib/health.js       the health check       lib/problems.js   library problems     lib/report.js   Formats & space
lib/maintenance.js  daily clean-up of unused cached files    lib/logs.js   recent warnings and errors
lib/timings.js      the Speed report
public/             the web app (plain JavaScript, no build step; index.html loads the files in order and they
                    share one scope): core.js (templates, api, helpers), app.js (state, pages, router), cards.js,
                    detail.js, player.js, menus.js, collections.js, manage.js, requests.js, select.js,
                    settings*.js, cast.js, tv.js (TV mode), fonts/ (Archivo and Figtree, SIL Open Font Licence),
                    vendor/hls.js (Apache-2.0)
android/            the Android app (WebView plus a native player), built without Gradle
androidtv/          the Android TV app: android/'s code with a TV manifest and banner
roku/               the Roku channel (BrightScript / SceneGraph)
marquee.sh          the Linux control script     marquee.ps1, *.bat   the Windows ones
Dockerfile, docker-compose*.yml   the container image, and the graphics-card add-ons
```

## Not yet supported

Music and photo libraries. Graphics-card conversion is tested here on NVIDIA, and the TV apps on an
NVIDIA Shield and TCL Roku TVs, so please report problems with other cards or TVs.

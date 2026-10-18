# Changelog

Updates marked **Significant update** add major features or change how Marquee runs. Settings →
Updates highlights them, and it's worth making a backup (Settings → Backups → Back up now) before
installing one.

## 0.4.2

Behind-the-scenes improvements for reliability:

- **Safer database:** each save is forced onto the disk and the previous version kept as
  `db.json.bak`. If the database is ever unreadable (e.g. after a power cut), Marquee uses the
  previous copy, or restores the newest backup, instead of starting empty.
- **Smoother playback while busy:** scanning, thumbnails, seek previews and intro detection run at
  low priority, and intro detection waits while someone's video is being converted.
- **Docker logs can't fill the disk** (capped at 30 MB per container).
- **Automatic tidy-up:** cached files for videos that are gone are removed daily, and Settings →
  Server shows the space each cache uses (with *Clean up now*).
- **Settings → Logs:** recent warnings and errors, with a plain-language explanation and *Copy*.

## 0.4.1

- **Collections, your way:** admins can reorder the titles in any collection (drag and drop, or
  ▲ ▼), arrange the list of collections, pick a collection's cover, and override TMDB
  collections too: rename them, add or remove titles, hide them, or reset them to TMDB's version.
- **Collections on the home page and in libraries:** movies in a collection now appear as the
  collection's card, so adding a film to a collection brings the collection to Recently Added.
  Choose *All titles* in a library (or the setting under Account) to show every movie on its own.

## 0.4.0 — Significant update

- **Up Next at the credits:** end credits are found automatically, like intros, and the next
  episode is offered as soon as they start (*Watch credits* to stay). Leaving during the credits
  marks the episode as watched. Admins can correct the time in *⋯ → Edit intro & credits…*.
  Seasons already checked for intros are checked again once for credits after updating.
- **Seek preview thumbnails** above the seek bar, made the first time a video is opened.
- **Who's watching?** profiles with PINs for shared devices; admins can allow children's
  accounts without a PIN.
- **Activity page** for admins: who is watching what, how, and how busy the server is.
- **Android app 1.3.0:** Up Next at the credits, and reports to the Activity page.

## 0.3.0 — Significant update

- **Watch together:** 👥 in the player creates a watch party link. Everyone in it stays in sync:
  play, pause, skipping and moving on to the next episode.
- **Subtitles from OpenSubtitles.com:** *Subtitles → Search online…* in the player, or *⋯ → Find
  subtitles…*. An admin adds a free API key (and, optionally, an account for more downloads a day)
  in Settings → Metadata.
- **Blu-ray and DVD subtitles:** picture-based subtitles (PGS, VobSub) can now be chosen. The server
  draws them into the video while converting it, in the browser and in the Android app.
- **Quality limit away from home:** Settings → Transcoding can cap the quality for people
  watching through Tailscale, Cloudflare or from outside your network.
- **Collections:** film series from TMDB are grouped automatically (movies matched earlier are
  looked up in the background). Admins can make their own collections.
- **Extras:** trailers, featurettes and similar clips (`-trailer` files, or `Extras` / `Trailers` …
  folders) appear on their movie or show page instead of as separate movies.
- **New files appear by themselves** within about 15 seconds, without waiting for the next scan.
- **Edit intros by hand** when detection gets one wrong (*⋯ → Edit intro…*, or ✂ in the player).
- **Library problems** in Settings: offline folders, unreadable files, titles with no match,
  duplicates and missing episodes.
- **Android app 1.2.0:** picture subtitles, and respects the quality limit away from home.

## 0.2.0 — Significant update

Commits `8548090` and `1160e32`, October 2026.

- **Adaptive streaming (HLS):** a quality menu in the player with Original, Auto and fixed
  1080p / 720p / 480p / 360p. *Auto* adjusts to your connection and is the default away from home.
  Seeking anywhere starts within seconds.
- **Graphics card transcoding:** NVIDIA (NVENC), Intel Quick Sync and Intel/AMD VAAPI are detected
  automatically, with fallback to the CPU. To turn it on, set `GPU=nvidia` (or `intel` / `amd` on
  Linux) in `.env` and run `start-marquee.bat` again. The status is in Settings → Transcoding.
- **Skip intro:** theme songs are found by comparing the audio of episodes in each season. A
  **Skip Intro** button appears during the intro (keyboard: `S`). Turn on automatic skipping
  under Account.
- **Casting:** Chromecast / Google TV from Chrome and Edge, and AirPlay from Safari. Includes
  subtitles, resume position, progress sync and next episode. `start-marquee.bat` fills in the cast
  address automatically; it can be changed in Settings → Transcoding.
- **Android app 1.1.0:** a quality picker and a Skip Intro button. Download it from the Account
  page.
- **Signed playback links:** cast devices and native players get a link that lasts 12 hours and
  opens only one video, instead of the sign-in cookie.

**After updating:** the Docker image is rebuilt with graphics drivers, so this update takes a
little longer than usual. Intro detection runs in the background after the first library scan.

## 0.1.x

- Remote access with Tailscale or Cloudflare Tunnel, and nightly backups with restore (`add2cfc`).
- Android app, served by the Marquee server (`9391dba`, `6851f74`).
- Update checks and one-click updates (`0360458`).
- Metadata matching and editing, My List, and quality-of-life features (`7db6497`).
- Libraries spread across multiple drives (`99ace8e`).
- Accounts, multiple users, YouTube downloader, Docker for Windows (`997f931`).
- First version: a self-hosted, Plex-style media server (`e678261`).

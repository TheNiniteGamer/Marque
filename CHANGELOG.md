# Changelog

Updates marked **Significant update** add major features or change how Marquee runs. Settings →
Updates highlights them, and it's worth making a backup (Settings → Backups → Back up now) before
installing one.

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

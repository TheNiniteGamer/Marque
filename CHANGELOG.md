# Changelog

Updates marked **Significant update** add major features or change how Marquee runs. Settings →
Updates highlights them, and it's worth making a backup (Settings → Backups → Back up now) before
installing one.

## 0.7.9

- **TV mode:** the highlighted section in the top bar is a clean white pill instead of an outline
  that got cut off into brackets.
- **Android TV player:** nothing in the controls is cut off any more. The timeline's dot no longer
  gets clipped at either end, the rows grow with larger TV text sizes, and there's a little more
  room from the screen's edges. (Android TV app 1.2.1, phone app 1.6.1: use Account → *Check for
  updates* on the TV.)

## 0.7.8

**The Android apps update themselves.** From Android TV app 1.2.0 / phone app 1.6.0:
- When the app opens and your server has a newer version, it offers **Update** (or *Later*, which
  stops it asking about that version). **Account → This app → Check for updates** checks any time.
- *Update* downloads the new version from your server and Android asks you to confirm; you stay
  signed in. The first time, Android asks you to allow Marquee to install apps.
- Install 1.2.0 / 1.6.0 once the usual way (Account → *Watch on a TV*); after that, updates come
  through the app.

## 0.7.7

- **Android TV / Android player:** the empty dark box at the bottom of the picture is gone. It was
  the subtitle box, which showed its background even with no subtitle on screen; it now only
  appears while a subtitle line is showing. (Android TV app 1.1.1, phone app 1.5.1.)

## 0.7.6

**Android TV player redone** to work like the Roku one (Android TV app 1.1.0: install the new
`Marquee-TV.apk` from Account → *Watch on a TV* over the old one):
- **OK pauses and plays**; any key shows the title, a progress bar with the time left, and back
  10 s / play-pause / ahead 10 s centred under it. They hide after 5 seconds of playing.
- **Left / right scrub with preview pictures** (hold to speed up, let go to jump there).
- **Down** reaches **Episodes** (opens the show's page), **Audio & Subtitles** (a side panel with
  sound track, subtitles and quality) and **Next Episode**.
- **Skip Intro / Skip Credits** with OK or Up, a **Next Episode** countdown card at the credits
  (fading like the skip buttons when autoplay is off), "Are you still watching?" after three
  episodes in a row, and "You're watching" when paused for a while.
- The phone app (1.5.0) keeps its touch controls, now in Marquee's red.

## 0.7.5

- **TV remote and text boxes:** moving onto a text box (a library's *Filter…*, search, the TV
  code box…) with the arrows no longer pops up the on-screen keyboard. The box is highlighted;
  press **OK** to type, and the arrows carry on past it otherwise.

## 0.7.4

- **Home banner on TVs:** on short screens (the Android TV app and TV browsers show pages at about
  960×540) the title, details and buttons sit lower and smaller, so a long title no longer runs
  up under the top bar. Long titles get a smaller size and stop at two lines everywhere.
- The banner's title is no longer a stop when moving with the remote (Up from Play goes straight to
  the top bar).
- The **More info** pop-up on TVs has a shorter picture, so the summary and episodes start on screen.

## 0.7.3

**Setting up a TV finds Marquee for you.**
- The Roku channel (1.3.0) and the Android / Android TV apps (1.4.2 / 1.0.2) start looking for
  Marquee on your network as soon as they open, and list each server the moment it answers,
  with the PC's name: *Marquee on Living room PC · 192.168.1.20*. Pick it with the remote; typing
  the address is still there underneath. The Roku shows how far it has got and offers *Search
  again*; on Android TV the first server found gets the focus, so OK connects.
- The name shown is the PC's name, or `MARQUEE_NAME` in `.env` (e.g. `MARQUEE_NAME=Den PC`).

## 0.7.2

- **Skip Intro and Skip Credits fade away** after 10 seconds, and come back when you bring up the
  controls. Choose the time (5, 10, 15 or 30 seconds, or stay until the intro or credits end) in
  Account → **Player**.
- **Player settings follow your account:** *Play the next episode automatically*, *Skip intros
  automatically* and the fade time now apply on every device: web, the Android apps and Roku.
  (This browser's earlier choices are carried over the first time you sign in.)
- **Skip Credits** for films with detected end credits: it ends the film and counts it as watched.
- Roku (channel 1.2.0): play/pause and the 10-second skips are centred under the bar, with
  Episodes on the left and Audio & Subtitles / Next Episode on the right; autoplay off and
  automatic intro skipping now work there too. Android apps 1.4.1 / TV 1.0.1.

## 0.7.1

**Roku player redone** to work like the big streaming apps (channel 1.1.0: download it again from
Account → *Watch on a TV* and install it over the old one):
- **OK pauses and plays.** Controls appear on any key and hide by themselves: title at the top,
  a progress bar with the time left, and back 10 s / play / ahead 10 s.
- **Scrubbing with preview pictures:** left/right move through the video (hold to speed up),
  showing the picture at that point; release to jump there.
- **Episodes**, **Audio & Subtitles** (including Blu-ray/DVD picture subtitles, drawn in by the
  server, and other sound tracks) and **Next Episode** buttons under the bar.
- **Skip Intro** button, a **Next Episode** countdown card at the credits with *Watch Credits*,
  and "Are you still watching?" after three episodes in a row.
- Paused for a while, it shows what you're watching.
- Also fixed on the Roku home screen: the banner's buttons move with left/right, and pictures
  are no longer stretched.

## 0.7.0 — Significant update

**Marquee on your TV.**
- **Roku channel** (`roku/`): home rows, libraries, My List, search, details and episode lists,
  and a player that resumes, skips intros, offers subtitles and goes on to the next episode. Added
  in Roku's developer mode with `Marquee-Roku.zip` (Account → *Watch on a TV*).
- **Android TV app** (`androidtv/`, `Marquee-TV.apk`): shows up on the TV's home screen, works with
  the remote, and plays in Android's own player.
- **Linking with a code is how TVs sign in:** the TV shows a code; type it on your phone at
  `/#/link` (or Account → *Watch on a TV*) and the TV signs itself in. The password form is behind
  *Sign in with a password instead*. Linked TVs are listed on the Account page with *Unlink*.
- **TV mode** for the web interface, on by itself in the Android TV app and most TV browsers (or
  Account → *TV mode*): bigger highlights, the arrow keys move to the nearest title, OK opens,
  Back closes pop-ups and goes back to the title you came from.
- **Hover previews** on computers: rest the pointer on a title for a bigger card with its trailer
  playing quietly, Play, My List and More info.
- The phone app (1.4.0) also gets the Back button closing pop-ups first.

## 0.6.0 — Significant update

**A new look, in red and black.** Every page has changed; everything you could do before is still
there.
- **Top bar** instead of the side menu: Home, each library, Collections and My List, with search
  behind the magnifier and the account menu (Activity, Settings, Downloads…) on your picture. On
  phones the libraries are buttons along the top and Home, Search and My List sit at the bottom.
- **Home banner:** a featured title with *Play* and *More info*, a different one each day, with
  its trailer playing quietly behind it when it has one (sound button on the right).
- **Rows that scroll sideways** with arrows: Continue Watching (with the time left), My List,
  New in each library, your collections, "Because you watched …", and the biggest genres.
- **Wide cards with the title on the artwork,** red counts of unwatched episodes, and *NEW* /
  *NEW EPISODES* on titles added in the last week.
- **"More info" opens over the page** instead of a separate page: play or resume, My List, mark
  watched, the episode list with a season picker, trailers and extras, and **More like this**
  (titles sharing genres). Esc, the ✕ or clicking outside it closes it. Admin options are in its
  ⋯ menu; file details are under *File and playback details*.
- "Who's watching?", sign-in and settings pages restyled to match. The typefaces are included
  with Marquee, so it looks the same without internet access.

## 0.5.2

Faster and lighter:
- **Home page and TV libraries load much faster on big libraries.** With 500 shows of 40 episodes,
  the home page took about 11 seconds to prepare and the TV library 5 seconds; now about 0.06 and
  0.02 seconds. (Each show's episodes were found by looking through every file, hundreds of times.)
- **Far fewer disk writes while watching:** the playing position is saved within a minute instead
  of rewriting the whole database every 10 seconds per viewer (pausing and stopping still save
  straight away), and the backup copy of the database is made by renaming instead of copying.
- **Smaller downloads for browsers and phones:** library lists and the web app are compressed
  (a 3,000-movie list goes from about 900 KB to 35 KB), the web app isn't downloaded again on every
  visit, and posters are kept by the browser until they change.
- **Quieter drives:** the check for new files spaces itself out on large or slow drives (waiting
  at least 10 times as long as a check took), pauses while a scan runs, and full rescans run at most
  every 6 hours while it's on.
- Big library pages: typing in the filter redraws once you pause, and cards far off-screen aren't
  drawn until you scroll near them.

## 0.5.1

More accurate metadata:
- **No more wrong matches without a word:** each match is scored on the title, the year and (for
  movies) the running time. Poor matches are no longer applied — the title keeps its file name until
  you choose. Doubtful ones are applied but listed under **Settings → Library problems → Matches that
  need a check**, with the best guesses as posters: click the right one, or *✓ It's right*.
- **Running time** tells remakes and same-name films apart (The Lion King 1994 vs 2019).
- **Ids in names match exactly:** `Heat (1995) {tmdb-949}`, `[imdbid-tt0113277]`, or `{tvdb-73244}`
  on a show folder (Plex / Jellyfin naming).
- Titles are compared more sensibly: punctuation, "The", "&"/"and", accents and "II"/"2" don't
  matter, and original-language titles count.
- **Re-check matches** (Settings → Library problems) looks up a whole library again with the new
  rules, fixing old wrong matches. Matches you picked or confirmed are kept; anything doubtful is
  listed to check rather than changed.

## 0.5.0

Organising your library:
- **☑ Select:** pick several titles at once (click, Shift+click for a range, Ctrl+A for all) in a
  library, a collection, My List or search results, then add them to a collection (or make a new
  one from them), mark them watched or unwatched, add them to My List, add or remove a genre, or
  refresh their metadata. On the Collections page, admins can select collections to move them to
  another section, change how they're ordered, or hide/delete them.
- **Collection order rules:** order a collection by release date, **episode number in the title**
  ("Ep 12", "Episode 12", "S2E5", "Part 3", "#12", or a number at the end), title, or date added,
  reversed if you like, or arrange it by hand. New titles fall into place by the rule.
- **Movies, TV and YouTube collections are listed separately**, each section arranged on its own.
  Marquee works out where a collection belongs from its titles; admins can choose with *Show under*.
- **⌕ Find series** (Collections page): finds videos whose titles share a name before an episode
  number ("Hardcore Survival Ep 1", "… Ep 2") and turns them into collections ordered by episode.

Folders and drives:
- **Whole drives in the folder picker:** share a drive with Docker once (`DRIVE_1=E:/` in `.env`,
  read-only) and pick any folder on it in Settings → Libraries. The picker lists your drives and
  shared folders, accepts a typed path like `E:/Movies`, and shows how many videos a folder holds,
  including the folders inside it.
- **TV shows in folders of their own** are found properly, e.g. `TV/Kids/Bluey/Season 1/…`
  (these used to become one show called "Kids"). Shows set up like that are rebuilt on the next
  scan; watch history is kept, but fixes made by hand to those particular shows need redoing.
- Episodes named like `Show - 05 [1080p].mkv` get their episode number.
- **New settings reach your `.env`:** `.env` is only created once, so settings added by updates
  (like `DRIVE_1`) were missing from it. `start-marquee.bat` and updates now add any new settings
  to the end of your `.env`, with their explanations, without changing anything already in it.

## 0.4.3

YouTube downloader:
- **Nothing downloaded twice:** Marquee keeps a record of what it has downloaded. Pasting a link you
  already have says so (with *Download again* to override), and playlists skip videos you have.
- **Video details:** the description, upload date, channel, a link to the original and chapters
  are saved with each download and shown in Marquee. Chapters appear as marks on the seek bar.
  Downloaded videos are no longer matched to unrelated movies on TMDB. (Videos downloaded before
  this update don't have these details.)
- **Download hours and speed limit** (Downloads → Download settings, admins). Downloads added
  outside the hours wait; *Start now* overrides that for one.
- **yt-dlp keeps itself up to date** (once a day, when nothing is downloading).
- **Automatic retries:** failed downloads try again after 1 and 5 minutes (not for errors like
  "private video" or "removed"), and continue partly downloaded files.
- **"Downloaded: …" notice** when your download finishes, and a count on the Downloads link.
- Fixed: a download added in the first second after the server started could fail with "yt-dlp is
  not installed".

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

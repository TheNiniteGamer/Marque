# Changelog

Updates marked **Significant update** add major features or change how Marquee runs. Settings →
Updates highlights them, and it's worth making a backup (Settings → Backups → Back up now) before
installing one.

## 0.16.0

- **NVIDIA cards now decode too, not just encode.** With an NVIDIA card, the card also decodes and
  resizes the video before encoding it (NVDEC). That was the CPU's heaviest job, above all with
  4K HEVC, so converting now leaves the CPU almost free. Automatic picks it first; it's also in
  Settings → Playback → Video converter as "NVIDIA graphics card, decoding too", and the page lists
  which formats the card was seen decoding (H.264, HEVC, VP9, AV1 on an RTX 30 or later, MPEG-2, VC-1).
- HDR pictures are resized on the card and brought back for the colour mapping on the CPU, now at
  1080p or less instead of 4K.
- Videos the card can't decode (10-bit H.264, 4:2:2) and Blu-ray subtitles drawn into the picture
  are decoded on the CPU and still encoded on the card. If a stream fails to start, it's retried
  with the card only encoding, then with the CPU; repeated failures turn card decoding off (not the
  card) until the next check.
- Nothing to change in Docker: the NVIDIA setup already passes the card's video decoder through.

## 0.15.0

- **HDR films and shows keep their colours when converted.** HDR10 and HLG videos used to come
  out grey and washed out whenever the server converted them (a lower quality, a TV or browser
  that can't play the file, playing away from home). They're now tone-mapped to ordinary colours,
  with any graphics card too. Their thumbnails, seek previews and hover preview clips are
  tone-mapped as well. Players that show HDR themselves (a browser or TV playing the file as it
  is) are unchanged.
- Titles already in the library have their colours checked once in the background, a minute
  and a half after starting (a quick look at each file); pictures made from HDR ones before are
  made again.
- HDR titles show an **HDR10** or **HLG** tag next to their resolution. Settings → Playback says
  whether this server can tone-map (the Docker version can).
- Tone mapping takes extra CPU: on a 4-core PC, converting 4K HDR to 1080p ran at about 29 frames
  a second (a film needs 24). A graphics card still does the encoding, but this step runs on the CPU.

## 0.14.0

**Better playback of MKV and other formats.**
- **Web player: MKVs keep their original picture.** An MKV with H.264 video (the usual kind)
  now plays at Original quality without its picture being converted, in segments cut at the
  file's keyframes, so skipping around works like any other video and the server only converts
  the sound. The keyframes are found the first time a file is played (a few seconds; the next
  episode's are found meanwhile) and kept. Files with several sound tracks get the same treatment
  when you pick another track.
- **HEVC (x265) without converting**, in browsers that decode it themselves (Safari; Chrome and
  Edge on PCs whose graphics card can): MP4s play as they are, and an MKV's picture is sent as it
  is. If the browser can't manage it after all, the server converts it as before.
- **Roku channel 1.8: plays MKV files as they are** (H.264, and HEVC including 10-bit on models
  that support it), with AAC, Dolby Digital (Plus), MP3 or FLAC sound. When the Roku can't play
  the sound (DTS, say), it keeps the original picture and only the sound is converted. If a file
  doesn't play as it is, it switches to the converted stream instead of showing an error.
- **Android apps (phone 1.11.0, TV 1.6.0):** when a file's sound can't be played on the device,
  the picture is kept as it is too, instead of the whole video being converted.
- Activity shows "Original picture (not converted)" for these streams; Settings → Server lists
  the space the keyframe lists take (a few KB per title).
- The number of waiting requests in the profile menu is a small red badge at the end of the
  link (it ran into the word: "Requests2"); the same for the phone's Downloads count.

## 0.13.2

- **Android TV app 1.5.2 / phone app 1.10.2: MKV files that the TV can't play as they are now
  play.** When a file (often an MKV with HEVC 10-bit video or DTS / Dolby sound) can't be played
  as it is, the apps now use the server's adaptive stream at its best quality. Before, they used
  a single converted stream that Android's player often couldn't open, so the video stopped with
  "The server could not stream this video".

## 0.13.1

- **TV: Collections no longer gets stuck.** On a TV (the Android TV app, or TV mode in a browser),
  opening Collections left nothing highlighted, so the remote's arrows did nothing. It now starts
  on the first collection, like the other pages. (The admin-only Arrange button is hidden on TVs,
  like the other admin tools there.)
- **Android TV app 1.5.1 / phone app 1.10.1:** if the TV's web engine crashes or is closed to free
  memory, the app reopens at the home page instead of closing.

## 0.13.0

- **Updates wait until nobody's watching.** Pressing **Update** downloads and builds the new version
  while Marquee keeps running, then restarts into it once no one is playing anything (a player left
  paused for over 15 minutes doesn't count). The page shows how many are watching, with **Restart
  now anyway**; the dialog also offers **Update and restart now**.
- **Automatic updates at night (optional).** Settings → Server & updates → *Install updates by
  itself at night*: between 2 and 5 am, when there's an update and nobody's watching.
- **Players ride out a restart.** If Marquee restarts mid-film, the web player, the phone app
  (1.10.0), the Android TV app (1.5.0) and the Roku channel (1.7) show "Reconnecting to Marquee…",
  wait for up to a minute and a half, and carry on from the same moment instead of showing an error.
- The update helper now restarts itself when an update changes it. The helper already running on
  the server PC is the old one, though: it installs this update straight away, and waits for
  nobody watching from the next time it starts (sign out of Windows and back in, or restart the
  PC, once after updating).

## 0.12.0

- **Previews for every title.** Resting the pointer on a film or show (and the home page's banner)
  now plays a preview even without a trailer: a 30-second clip from a little way into the film, or
  from a show's first episode past its intro. Each clip is made the first time it's wanted (so it
  plays from the next hover on), small (480p, a few MB), in the background and never while
  someone is watching; unused ones are removed after two months. Switch it off under
  Settings → Playback → Previews.
- **Admins see where files are.** A film's pop-up shows its file's full path (with Copy) at the
  bottom; a show's has a **Files** box with its folder and every episode's file, size and quality,
  season by season.

## 0.11.0

**A calmer Settings, and a choice of what the home page shows.**
- Settings is now a set of pages with a menu on the left (a row of tabs on phones), in the style
  of Netflix's account pages: **Overview** (the health check, anything that needs you, and every
  area at a glance), **Libraries**, **Users**, **Home screen**, **Playback**, **Metadata &
  subtitles**, **Remote access**, **Backups** and **Server & updates**. Each page loads on its own
  and fits on about one screen; things already set up (the TMDB key, OpenSubtitles) show as
  "✓ connected · Change", and the longer explanations are behind "What's this?".
- **Home screen** (new): choose what everyone's home page shows: the banner, Top 10, My List, New
  in each library, "Because you watched / liked", and how many collection and genre rows.
- Links from notifications, the health check and the update badge open the right page.

## 0.10.2

**Admins can reset passwords and unlock people.**
- Settings → Users → **Reset password**: Marquee makes a temporary password for you to give them
  (or you set one). By default they choose their own the next time they sign in (Marquee lets them
  do nothing else until then), and they're signed out everywhere, TVs included. Their PIN can be
  removed too, if they've forgotten it.
- Someone locked out by too many wrong passwords or PINs shows **🔒 Locked** in the list, with an
  **Unlock** button that lets them straight back in (from the device they were using, too).

## 0.10.1

**Security fixes from a review of every part of the server.**
- Pages from other sites (even on the same PC, or a neighbouring address behind the same tunnel)
  can no longer make changes using your browser's sign-in.
- Ids such as `__proto__` in addresses could reach JavaScript's built-in objects; they're refused.
- The "reached from outside at" address on Settings → Remote access can only be set by signed-in
  visits through your own tunnel (it could be faked before).
- **Roku (1.6.0):** pictures and videos use a media key that only opens pictures and videos,
  instead of the TV's sign-in, so a logged address can't be used to sign in. (Older Roku builds
  keep working until updated.)
- The secret behind playback links is no longer in backups (e.g. the copy in a cloud folder), and
  is replaced after a restore, a password change or a deleted user.
- Limits: 20 failed sign-ins per username per 10 minutes (on top of the per-address limit), PINs
  locked for the rest of the day after 15 wrong tries, 10 phone-download copies waiting per person,
  20 OpenSubtitles downloads per person a day, 5 watch parties per person (with longer, unguessable
  links), and Activity can't be filled up with made-up players.
- Artwork from a URL can't point at the server itself (or "link-local" addresses), and stops
  reading at 15 MB. Actor photos are now really cached.

## 0.10.0 — Significant update

**Requests, notifications, and looking after itself.**
- **Requests.** "Ask for it" on the search page (or Requests in the menu): look a film or show up
  (TMDB / TVmaze) or type its name, with a note. Admins get a notification and a list (Requests in
  the menu; a count on Settings) to approve, decline or mark as added, with a note back. When the
  title turns up in a library it's marked as here by itself, and everyone who asked is told.
- **Notifications.** A bell at the top: new episodes of shows you watch (or have on My List), and
  what's happening with your requests. **Phone app (1.9.0):** they arrive as phone notifications
  too (it checks every half hour; Android 13+ asks permission once).
- **Backups off this PC.** Settings → Backups → *Also keep a copy somewhere else*: every backup is
  copied to another drive, a network share, or a OneDrive / Google Drive / Dropbox folder.
- **Health check** at the top of Settings: disk space, offline library folders, backups that
  stopped or aren't copied, a failed update, the graphics card being given up on, lots of errors.
  Admins get a notification when something turns bad.
- **Security.**
  - Fixed: one specially made web address could stop the server.
  - A Content-Security-Policy (only Marquee's own scripts can run), and server error details are
    kept out of the browser.
  - New passwords need 8 characters.
  - New option, Settings → Remote access → *Admin settings only at home*: away from home you can
    still watch, but the admin pages only work on your home network.

## 0.9.1

**Faster on big libraries, and better phone downloads.**
- Pages are much quicker on large libraries. Timed on 9,300 videos with 10 people and a year of
  history: the home page went from about 240 ms to 25 ms, search from 58 to 4 ms, show and movie
  pages from 70–90 to about 5 ms, collections from 21 to 3 ms.
- Copies for phone downloads no longer compete with someone watching: they wait (or pause) while
  the server is converting a video for playback, and carry on afterwards.
- **Phone app (1.8.1):** *Download season* on a show's page downloads every episode of the season
  not on the phone yet, at one size. **Download on Wi-Fi only** (on by default) is on the Downloads
  screen; downloads waiting for Wi-Fi say so.

## 0.9.0 — Significant update

**Twelve things the big streaming apps do.**
- **Kids profiles and maturity ratings.** Titles now have their rating (PG-13, TV-14, 12A…,
  fetched from TMDB for your country, or set with *⋯ → Edit*). In *Settings → Users*, give a
  profile a limit (*Little kids*, *Kids*, *Older kids*, *Teens*) and choose whether unrated titles
  show; anything above it is hidden everywhere: home, libraries, search, collections, My List,
  playback. Kids profiles have a KIDS label on the picker and by the logo. Ratings show as a small
  badge on titles.
- **Downloads in the phone app (1.8.0).** ⬇ on a movie or an episode saves it to the phone to
  watch without the internet: the original file when the phone plays it as it is, or a smaller
  copy (1080p / 720p / 480p) that the server makes first (kept on the server for a week).
  **Downloads** (in the bottom bar, the menu, and the "can't reach the server" page) shows what's
  saved and what's coming. Subtitles come too, the next episode plays if it's downloaded, and your
  place is sent to the server when you're back online.
- **Your languages, remembered per show.** Pick Japanese audio with English subtitles once and
  every episode of that show starts that way, on every device.
- **Continue Watching on the Android TV home screen (TV 1.4.0).** Your Continue Watching titles
  appear in the TV's own "Play next" row, with progress; pick one to play it.
- **Lock-screen and Bluetooth controls** on Android: play/pause, back/ahead 10 s and next episode
  from headphones, the notification and the lock screen.
- **Skip Recap.** "Previously on…" at the start of an episode is found automatically (it matches
  earlier episodes of the season), with a Skip Recap button.
- **Cast while paused, and actor pages.** Pause for a moment and the player lists who's in it.
  Cast lists now have photos; pick someone to see everything they're in on your server.
- **👍 / 👎.** Rate titles from their pop-up. Thumbs-down titles stop being suggested, and a
  "Because you liked …" row follows what you like.
- **Top 10 in your house this week**, a row with big numbers, from what everyone watched.
- **Night mode.** Clearer dialogue and quieter loud scenes: ☾ in the web player, *Sound* in the
  Android players' Audio & Subtitles, or Account → Player (the Roku follows that setting).
- **Voice search on Android TV.** The mic button by the search box (or the remote's search key);
  "Hey Google, search Marquee for …" works too.
- **Profiles on the Roku (1.5.0).** "Who's watching?" when the channel starts, and *Switch
  profile* in the menu, with a number pad for PINs.
- Fixed: changing quality or sound track mid-video could occasionally fail to start.

## 0.8.3

**One player design on every device.**
- **Phone app (1.7.0):** the player now looks and works like the Android TV and Roku ones: the
  title at the top, a red timeline with the time left (drag it to see preview pictures), back
  10 s / play-pause / ahead 10 s in the middle, **Episodes**, **Audio & Subtitles** (sound track,
  subtitles, quality and speed in one panel) and **Next Episode**, the Next Episode card at the
  credits and "You're watching" when paused. Tap the picture to show or hide the controls;
  picture-in-picture is at the top right.
- **Android TV (1.3.0):** the Audio & Subtitles panel also has Speed. Check for updates on the TV.
- **Roku (1.4.0):** highlighted buttons match the Android TV app: a white pill for words, a light
  circle behind play / skip, lined up with the timeline.

## 0.8.2

**Tidier TV screens, and lined-up cards.**
- TV mode: the MARQUEE logo is no longer a stop (Home does the same). Also gone from the TV, as
  they're for a mouse or for admins: a library's card-size slider, ☑ Select, ↻ Scan and A–Z bar,
  "See all" on home rows, and Find series / New collection. Genre links in a title's pop-up are
  skipped too.
- TV mode: Genre and Sort lists no longer change when you arrow onto them; OK opens them.
- TV mode: rows slide so the highlighted title always sits at the row's start (as on Netflix or
  Google TV), keeping the rows lined up, also at the end of a row.
- Everywhere: cards in library grids, search and My List no longer look cut off or shifted when
  highlighted or hovered: the highlight is a ring inside the picture there.

## 0.8.1

- **TV mode:** side-by-side choices (the fade time on the TV's Settings page, a library's
  *All / Unwatched*) are highlighted with a clean white block instead of an outline cut off into a
  bracket, and are a little bigger.

## 0.8.0

**A simple Settings page on TVs.** In TV mode (the Android TV app and TV browsers):
- The account menu has just **Settings**, *Switch profile*, *Switch server* (in the app) and
  *Sign out*.
- **Settings** has a few big switches: play the next episode automatically, skip intros
  automatically, subtitles on by default, and how soon Skip Intro / Skip Credits fade; plus who's
  signed in and the app's *Check for updates*.
- Passwords, PINs, linking TVs, libraries, users, downloads and activity stay on phones and
  computers; on a TV those pages say where to find them.
- The MARQUEE logo gets the same white highlight as the top bar's sections.

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

# Marquee for Roku

A Roku channel for Marquee, laid out like the Android TV app: the home rows, your libraries (with
sorting and filters), Collections and franchises, My List and search, title pages with their
extras, cast and "more like this", episode lists, requests ("Ask for it"), notifications and a few
settings, and a player that resumes where you left off, skips intros and goes on to the next
episode. Built with SceneGraph for 1080p (it scales down on HD Rokus).

It isn't in the Roku Channel Store, so it's added to your Roku in **developer mode** (free, no
account needed beyond the Roku one you already have). Each Roku can have one developer channel.

## Install

1. **Turn on developer mode.** With the Roku remote, press
   **Home ×3, Up ×2, Right, Left, Right, Left, Right**. Write down the address it shows
   (e.g. `http://192.168.1.50`), accept the agreement, and set a password. The Roku restarts.
2. **Get the channel:** `Marquee-Roku.zip` from Marquee → **Account** → *Watch on a TV*, or run
   `./package.sh` in this folder (makes `build/Marquee-Roku.zip`).
3. **Upload it:** on a computer on the same network, open the address from step 1, sign in as
   `rokudev` with your password, choose **Upload**, pick the zip and press **Install with zip**.
   Marquee opens on the TV, and stays in your channel list.

To update, upload the new zip the same way (it replaces the old one).

## Sign in

1. Marquee looks for servers on your network as soon as it opens (port 32500), listing each one
   as it answers, e.g. *Marquee on Living room PC · 192.168.1.20*. Pick yours. If it isn't found,
   choose *Search again* or *Type the server's address* (e.g. `192.168.1.20:32500`).
2. The TV shows a **code**. On your phone or computer, open Marquee → **Account** →
   **Watch on a TV**, type the code and press *Link TV*. The Roku signs in as you within a few
   seconds and stays signed in (unlink it on that page to sign it out).

**Who's watching?** When anyone else on the server has a profile (a PIN set on their Account page,
or one an admin lets be picked without a PIN), the channel starts by asking who's watching. A profile with a PIN asks for it
on a number pad. *Switch profile* is under your profile in the top bar.

**The top bar**, as in the web and Android TV apps: Home, each library, Collections and My List,
with the bell, Search and your profile on the right. Press **up** from the banner (or a page's top
row) to reach it, **left / right** to move along it and **OK** to open; the page you're on is in
bold. **Down** or **Back** returns to the page.

- **The bell** shows how many notifications you haven't seen (new episodes of your shows, requests
  that are here). Opening it lists them, newest first; choosing one opens the title it's about.
- **Your profile** opens a small menu: *Switch profile*, *My requests*, *Settings* and *Sign out*.
  Back or left closes it. The Roku only signs out when you choose *Sign out* there (or in Settings).
- **Collections**: franchises, then movie, TV and YouTube collections; choosing one lists its titles
  (a franchise also says how far through it you are and what's next).
- **Settings**: who's watching (Switch profile), playing the next episode automatically, skipping
  intros automatically, night mode, how long the Skip Intro / Skip Credits buttons stay up (all
  saved with your account, so your other devices follow them), turning subtitles on by default (for
  this Roku), the server (Switch server) and Sign out.

**A title's page**: a row of buttons (Play or Resume and From the start, Episodes, the version to
play when there's more than one, My List, Rate, Mark watched, More seasons for a show, Previous /
Next and All episodes for an episode), then rows of trailers & extras, the cast (choosing someone
lists their titles), the rest of its franchise and more like it. **More seasons** lists the show's
seasons that aren't all here yet: tick them with **OK**, then choose *Ask for these seasons*.

**Search** finds titles, episodes, actors, moods and years ("funny", "90s comedy") as on the web,
and says what it understood. On a voice remote you can say what you're looking for instead of
typing it (Rokus from the last few years).

**Requests**: in Search, *Not here? Ask for "…"* (above the results) looks the name up online
as a film or a TV show; choosing one asks for it (or opens it, if it's here already), and the last
line asks for it by name. *My requests* (under your profile) shows how each is getting on; one
that's here opens, and ✱ withdraws one still waiting (or stops following one you joined; whoever
runs the server sees everyone's, and ✱ removes them).

On the home page ✱ on the banner opens search; on the code screen it changes the server.

## Remote

- **Arrows** move, **OK** opens, **Back** goes back. When the channel starts, a short intro plays
  over the first screen; any key skips it.
- **✱** on a title in the rows and grids: *Details*, *Go to* the show (an episode), *Remove from
  Continue Watching*, *Add to / Remove from My List* and *Mark watched / unwatched*. On an episode
  in a show's list: *Details*, *Play from the start*, *Mark watched* and *Mark* the whole season
  watched (on the season names, just the season).
- **In a library**, up from the top row reaches its sorting and filters: *Sort* (title, date added,
  year, rating, length), *All titles / Unwatched* and a genre. Sorting and Unwatched are kept for
  each library on this Roku.
- **In the player** (laid out like the big streaming apps):
  - **OK** or **▶‖** pauses and plays. Any key shows the controls; they hide again after a few
    seconds.
  - **Left / right** scrub through the video with preview pictures (hold to go faster, release to
    jump there); **◀◀ / ▶▶** scrub faster; **↺** jumps back 10 s.
  - **Down** reaches the buttons: **Episodes** on the left, back 10 s / play-pause / ahead 10 s in
    the middle, **Audio & Subtitles** and **Next Episode** on the right.
  - **Skip Intro** appears during the intro, and **Skip Credits** in a film's end credits:
    **OK** (or **Up**) presses it. It fades after 10 seconds and comes back when you bring up the
    controls; the time (5–30 s, or "stay") is in **Settings** (and under Account → **Player** on
    the web), along with playing the next episode automatically and skipping intros automatically.
  - At the credits a **Next Episode** card counts down from 10 and starts it (or choose *Watch
    Credits*). With autoplay off, the card has no countdown and fades like the skip buttons. After
    three episodes in a row without touching the remote it asks whether you're still watching.
  - Paused for a while, the screen shows what you're watching. **Back** leaves (your place is
    saved).

## Notes

- Files the Roku can play as they are (MP4 with H.264, or HEVC on 4K models, and AAC/AC3/MP3 sound)
  play directly; everything else is converted by the server as it plays, like in a browser.
- Subtitles are in **Audio & Subtitles**. Text ones (SRT, ASS, embedded, downloaded) are shown by
  the Roku; picture ones (Blu-ray, DVD) are drawn into the video by the server. The language you
  pick is remembered for the next video.
- **Night mode** (Account → Player on the web) is done by the server, so with it on everything
  plays through the server's conversion.
- `fonts/Archivo-Black.ttf` is under the SIL Open Font License (`fonts/Archivo-OFL.txt`).
- The intro's sound is `sounds/intro.mp3`, the same as the web app's.

## Developing

The code is BrightScript + SceneGraph XML: `source/main.brs` starts `components/MainScene`, which
keeps a stack of screens (`components/screens/`). Screens ask to open another one by setting their
`navigate` field; only the screen on top may have the focus (MainScene gives it back if a hidden
one takes it). `IntroScreen` plays over the first screen at start. Shared pieces: `TopBar`,
`ButtonRow` (a row of buttons), `OptionsMenu` (the ✱ menus and other choices) and the helpers in
`components/common.brs`. Requests to the server run in `components/tasks/ApiTask` (with the device token
as `Authorization: Bearer`); pictures and video use `?at=<token>` in the address instead.
[BrighterScript](https://github.com/rokucommunity/brighterscript) checks it:
`npx bsc --rootDir . --createPackage false`.

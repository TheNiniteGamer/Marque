# Marquee for Roku

A Roku channel for Marquee: the home rows, your libraries, My List and search, the details and
episode lists, and a player that resumes where you left off, skips intros and goes on to the next
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

1. Marquee looks for the server on your network (port 32500). Pick it, or choose *Type the server's address*
   and enter it (e.g. `192.168.1.20:32500`).
2. The TV shows a **code**. On your phone or computer, open Marquee → **Account** →
   **Watch on a TV**, type the code and press *Link TV*. The Roku signs in as you within a few
   seconds and stays signed in (unlink it on that page to sign it out).

In the menu (press **left** on the home page) are Search, My List, each library and *Sign out*.
On the home page ✱ opens search; on the code screen it changes the server.

## Remote

- **Arrows** move, **OK** opens, **Back** goes back.
- **In the player** (laid out like the big streaming apps):
  - **OK** or **▶‖** pauses and plays. Any key shows the controls; they hide again after a few
    seconds.
  - **Left / right** scrub through the video with preview pictures (hold to go faster, release to
    jump there); **◀◀ / ▶▶** scrub faster; **↺** jumps back 10 s.
  - **Down** reaches the buttons: **Episodes** on the left, back 10 s / play-pause / ahead 10 s in
    the middle, **Audio & Subtitles** and **Next Episode** on the right.
  - **Skip Intro** appears during the intro, and **Skip Credits** in a film's end credits:
    **OK** (or **Up**) presses it. It fades after 10 seconds and comes back when you bring up the
    controls; the time (5–30 s, or "stay") is under Account → **Player** on the web, along with
    playing the next episode automatically and skipping intros automatically.
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
- Who's-watching profiles aren't on Roku yet: it uses the account the code was entered from.
- `fonts/Archivo-Black.ttf` is under the SIL Open Font License (`fonts/Archivo-OFL.txt`).

## Developing

The code is BrightScript + SceneGraph XML: `source/main.brs` starts `components/MainScene`, which
keeps a stack of screens (`components/screens/`). Screens ask to open another one by setting their
`navigate` field. Requests to the server run in `components/tasks/ApiTask` (with the device token
as `Authorization: Bearer`); pictures and video use `?at=<token>` in the address instead.
[BrighterScript](https://github.com/rokucommunity/brighterscript) checks it:
`npx bsc --rootDir . --createPackage false`.

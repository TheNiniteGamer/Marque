# Marquee for Android TV

The Marquee app for Android TV (and Google TV, NVIDIA Shield, Fire TV with sideloading). It is the
phone app's code (`../android`) with a TV manifest and banner: the Marquee interface in TV mode, moved
around with the remote, and videos in Android's own player.

## Install

The easiest way: on the TV, install a downloader app (e.g. *Downloader* by AFTVnews), allow it to
install apps, and open `http://YOUR-PC:32500/downloads/Marquee-TV.apk`. Or from a computer with
`adb`: `adb connect TV-IP && adb install Marquee-TV.apk`.

## Sign in

1. Open Marquee on the TV. It looks for servers on your network straight away and lists each one
   it finds, e.g. *Marquee on Living room PC · 192.168.1.20*: pick yours with the remote (or type
   its address underneath).
2. The sign-in page shows a **code**. On your phone or computer, open Marquee → **Account** →
   **Watch on a TV** and type the code. The TV signs in as you within a few seconds.

## Remote

- **Arrows** move between titles, **OK** opens one, **Back** closes pop-ups and goes back.
- **In the player** (laid out like the big streaming apps, and like Marquee's Roku channel):
  - **OK** or **▶‖** pauses and plays. Any key shows the title, a progress bar with the time
    left, and back 10 s / play-pause / ahead 10 s in the middle; they hide after a few seconds.
  - **Left / right** scrub with preview pictures (hold to go faster, let go to jump there);
    **◀◀ / ▶▶** scrub faster.
  - **Down** reaches the buttons: **Episodes** on the left, the middle three, and **Audio &
    Subtitles** (sound track, subtitles, quality) and **Next Episode** on the right.
  - **Skip Intro** / **Skip Credits**: **OK** (or **Up**) presses it; it fades after the time set
    in Account → Player.
  - At the credits a **Next Episode** card counts down from 10 (or choose *Watch Credits*); after
    three episodes in a row it asks whether you're still watching. Paused for a while, the screen
    shows what you're watching. **Back** leaves the player.

## Build

Same requirements as the phone app (Android SDK platform 34 + build-tools 34, JDK 17+):

```bash
ANDROID_HOME=/path/to/sdk ./build.sh      # -> build/Marquee-TV.apk
```

`public/downloads/Marquee-TV.apk` in the server is a copy of the latest build.

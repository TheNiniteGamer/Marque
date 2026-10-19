# Marquee for Android TV

The Marquee app for Android TV (and Google TV, NVIDIA Shield, Fire TV with sideloading). It is the
phone app's code (`../android`) with a TV manifest and banner: the Marquee interface in TV mode, moved
around with the remote, and videos in Android's own player.

## Install

The easiest way: on the TV, install a downloader app (e.g. *Downloader* by AFTVnews), allow it to
install apps, and open `http://YOUR-PC:32500/downloads/Marquee-TV.apk`. Or from a computer with
`adb`: `adb connect TV-IP && adb install Marquee-TV.apk`.

## Sign in

1. Open Marquee on the TV. It finds the server on your network (or type its address).
2. The sign-in page shows a **code**. On your phone or computer, open Marquee → **Account** →
   **Watch on a TV** and type the code. The TV signs in as you within a few seconds.

## Remote

- **Arrows** move between titles, **OK** opens one, **Back** closes pop-ups and goes back.
- In the player: **OK** plays/pauses, **left/right** jump back 10 s / ahead 30 s, **up/down** show
  the controls (then the arrows move between them), and the media keys work.

## Build

Same requirements as the phone app (Android SDK platform 34 + build-tools 34, JDK 17+):

```bash
ANDROID_HOME=/path/to/sdk ./build.sh      # -> build/Marquee-TV.apk
```

`public/downloads/Marquee-TV.apk` in the server is a copy of the latest build.

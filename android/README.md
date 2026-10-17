# Marquee for Android

A small Android app (Android 8.0+) for watching your Marquee server on a phone or tablet.

- **Connect:** finds Marquee servers on your Wi-Fi, or you can type an address such as `192.168.1.20`.
- **Everything else:** uses your server's own web interface, so every feature (My List, editing, downloads,
  settings) works, and it stays current when the server is updated.
- **Videos:** play in **Android's native player**. Files your phone can decode (MP4/MKV/WebM with
  H.264, HEVC, VP9…) play directly, with no work for the server. Anything else is converted by the
  server on the fly, and the app switches automatically if direct playback fails.
- **Player:** picture-in-picture, subtitles, audio-track choice, playback speed, resume, the next
  episode, and **Skip Intro**. Progress syncs with your account.
- **Quality:** Original, Auto (adaptive streaming, the default away from home) or a fixed
  1080p–360p, from the quality button in the player. The default and automatic intro skipping
  follow the choices on the web app's *Account* page.

## Install

Your Marquee server hosts the app. On your phone, open Marquee in the browser and go to
**Account → Get the Android app** (or open `http://YOUR-PC:32500/downloads/Marquee.apk`). Then open the
downloaded file. Android will ask you to allow installing apps from your browser; allow it once.

New versions install over the old one: every build is signed with the same sideload key
(`marquee-sideload.keystore`). That key is only for sideloading, not the Play Store.

## Build it yourself

The app uses only what ships with Android: no Gradle and no libraries. You need:
- a JDK (17 or newer),
- the Android SDK with **platform 34** and **build-tools 34.0.0**, both installed by Android Studio.

```bash
ANDROID_HOME=~/Android/Sdk ./build.sh     # -> build/Marquee.apk
./test.sh                                  # unit tests for the app's logic
cp build/Marquee.apk ../public/downloads/  # what the server offers for download
```

Note: the dex tool in build-tools 34 crashes on *inner* and *anonymous* classes compiled by Java 21.
The code therefore uses static nested classes and lambdas only. Keep it that way, or use build-tools 35+.

## How it fits together

| File | What it does |
| --- | --- |
| `ServerActivity` | Connect screen: type an address or scan the local /24 network for `GET :32500/api/health` |
| `MainActivity` | Web view of the server. `window.MarqueeAndroid` lets the page open the native player and switch servers |
| `PlayerActivity` | Native player (`VideoView`/`MediaPlayer`). Direct stream or server `/transcode`, subtitles drawn from the server's WebVTT, progress reported to `/api/items/:id/progress` |
| `PlaybackPlan` | Decides direct play vs. convert, using the phone's real decoders (`MediaCodecList`) |

# Marquee for Android

A small Android app (Android 8.0+) for watching your Marquee server on a phone or tablet.

- **Connect:** finds Marquee servers on your Wi-Fi, or you can type an address such as `192.168.1.20`.
- **Everything else:** uses your server's own web interface, so every feature (My List, editing, downloads,
  settings) works, and it stays current when the server is updated.
- **Videos:** play in **Android's native player**. Files your phone can decode (MP4/MKV/WebM with
  H.264, HEVC, VP9…) play directly, with no work for the server. Anything else is converted by the
  server on the fly, and the app switches automatically if direct playback fails.
- **Player:** the same as the Android TV app's (and the Roku channel's): the title at the top,
  a red timeline with the time left that you drag with preview pictures, back 10 s / play-pause /
  ahead 10 s in the middle, and **Episodes**, **Audio & Subtitles** (sound track, subtitles
  including Blu-ray / DVD picture ones drawn in by the server, quality and speed) and **Next
  Episode**. Tap the picture to show or hide the controls. Skip Intro / Skip Credits, a Next
  Episode countdown at the credits, resume, and picture-in-picture (the button at the top right,
  or leave the app while playing). Progress syncs with your account.
- **Downloads:** ⬇ on a movie or episode (or *Download season* on a show) saves it to watch
  without the internet (the original file, or a smaller copy the server makes). Downloads use
  Wi-Fi only unless you turn that off on the Downloads screen. **Downloads** in the bottom bar lists them; it opens
  from the "can't reach the server" page too. Your place is sent to the server once you're online.
- **Notifications:** new episodes of shows you watch and news about your requests, checked about
  every half hour (Android 13+ asks once whether that's OK).
- **Lock screen, headphones and Bluetooth:** play/pause, back/ahead 10 s and next episode.
- **Night mode:** *Sound* in Audio & Subtitles (Android 9+).
- **Quality:** Original, Auto (adaptive streaming, the default away from home) or a fixed
  1080p–360p, in Audio & Subtitles. The default follows the web app's *Account* page; autoplay,
  automatic intro skipping and the skip buttons' fade time follow Account → *Player*.

## Install

Your Marquee server hosts the app. On your phone, open Marquee in the browser and go to
**Account → Get the Android app** (or open `http://YOUR-PC:32500/downloads/Marquee.apk`). Then open the
downloaded file. Android will ask you to allow installing apps from your browser; allow it once.

New versions install over the old one. Builds are signed with a key kept **outside this
repository**, in `~/.config/marquee-signing` on the machine that builds them (the server PC). The
first key used to be in the repository, so it's public: since 1.16.0 (TV 1.11.0) the apps carry
Android's record of the hand-over from that key to the new one (`lineage.bin`), so phones and TVs
on Android 9 or newer take the update as normal and then refuse anything signed only with the old
key. (Android 8 only understands the old key.)

**Never lose that folder:** without it no build can update the installed apps; everyone would have
to uninstall and reinstall. It holds `release.p12` and `password` (the new key), `old-2026.keystore`
and `old-password` (the first key, still needed for Android 8), and `lineage.bin`. Keep a copy
somewhere safe away from the server (a password manager attachment, the off-site backup).

## Build it yourself

The app uses only what ships with Android: no Gradle and no libraries. You need:
- a JDK (17 or newer),
- the Android SDK with **platform 34** and **build-tools 34.0.0**, both installed by Android Studio.

Builds need the signing folder above (`MARQUEE_SIGNING` points elsewhere if it isn't in
`~/.config/marquee-signing`). On the server PC, without installing Java or the SDK, they run in
Docker (`build.Dockerfile`), with the SDK in `~/android-sdk`:

```bash
docker build -t marquee-android-build -f android/build.Dockerfile android
for app in android androidtv; do docker run --rm --user "$(id -u)" -e HOME=/tmp -e MARQUEE_SIGNING=/signing \
  -v "$PWD:/src" -v ~/android-sdk:/sdk -v ~/.config/marquee-signing:/signing:ro -w /src/$app marquee-android-build ./build.sh; done
```

Or with a JDK and the SDK installed:

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
| `PlayerControls` | The player's controls (`res/layout/activity_player.xml`), on phones by touch and on TVs by remote; sizes in `values/` and `values-television/dimens.xml` |
| `Updater` | Updates the app from the server's `/downloads/apps.json` |
| `PlaybackPlan` | Decides direct play vs. convert, using the phone's real decoders (`MediaCodecList`) |

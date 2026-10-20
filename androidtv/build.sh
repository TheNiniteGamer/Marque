#!/usr/bin/env bash
# Builds Marquee-TV.apk, the Android TV app, from the phone app's code (../android) with the TV
# manifest and banner from this folder. Needs the same as ../android/build.sh: the Android SDK
# (platform 34 + build-tools 34) and a JDK 17+.
#
#   ANDROID_HOME=/path/to/sdk ./build.sh        -> build/Marquee-TV.apk
set -euo pipefail
cd "$(dirname "$0")"
APP=../android

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -z "$SDK" ] && [ -f "$APP/local.properties" ] && SDK="$(sed -n 's/^sdk.dir=//p' "$APP/local.properties")"
[ -d "$SDK" ] || { echo "Set ANDROID_HOME to your Android SDK"; exit 1; }
BT="$SDK/build-tools/${BUILD_TOOLS:-34.0.0}"
JAR="$SDK/platforms/android-34/android.jar"
[ -x "$BT/aapt2" ] && [ -f "$JAR" ] || { echo "Need build-tools 34.0.0 and platform android-34 in $SDK"; exit 1; }

VERSION_NAME="${VERSION_NAME:-1.8.0}"
VERSION_CODE="${VERSION_CODE:-15}"
OUT=build
rm -rf "$OUT"; mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "• resources"
"$BT/aapt2" compile --dir "$APP/app/src/main/res" -o "$OUT/res/app.zip"
"$BT/aapt2" compile --dir res -o "$OUT/res/tv.zip"
# The code lives in app.marquee.client, so R goes there too; the app itself is app.marquee.tv.
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml --java "$OUT/gen" --custom-package app.marquee.client \
  --min-sdk-version 26 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -o "$OUT/app.unaligned.apk" "$OUT/res/app.zip" "$OUT/res/tv.zip"

echo "• compile"
status=0
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR:$BT/core-lambda-stubs.jar" -d "$OUT/classes" -encoding UTF-8 \
  $(find "$APP/app/src/main/java" "$OUT/gen" -name '*.java') > "$OUT/javac.log" 2>&1 || status=$?
grep -v "^Note:" "$OUT/javac.log" || true
[ "$status" -eq 0 ] || { echo "compile failed"; exit 1; }

echo "• dex"
"$BT/d8" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q ../app.unaligned.apk classes.dex)

echo "• sign"
"$BT/zipalign" -f -p 4 "$OUT/app.unaligned.apk" "$OUT/app.aligned.apk"
"$BT/apksigner" sign --ks "$APP/marquee-sideload.keystore" --ks-pass pass:marquee-sideload --key-pass pass:marquee-sideload \
  --ks-key-alias marquee --out "$OUT/Marquee-TV.apk" "$OUT/app.aligned.apk"
"$BT/apksigner" verify "$OUT/Marquee-TV.apk"
echo "Built $OUT/Marquee-TV.apk ($(du -h "$OUT/Marquee-TV.apk" | cut -f1))"
# The server offers it from /downloads, and the app updates itself from there.
node "$APP/publish.js" androidtv "$OUT/Marquee-TV.apk" "$VERSION_CODE" "$VERSION_NAME"

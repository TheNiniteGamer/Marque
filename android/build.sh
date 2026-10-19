#!/usr/bin/env bash
# Builds Marquee.apk with just the Android SDK (platform 34 + build-tools 34) and a JDK 17+.
# No Gradle and no third-party libraries: the app only uses what ships with Android.
#
#   ANDROID_HOME=/path/to/sdk ./build.sh        -> build/Marquee.apk
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -z "$SDK" ] && [ -f local.properties ] && SDK="$(sed -n 's/^sdk.dir=//p' local.properties)"
[ -d "$SDK" ] || { echo "Set ANDROID_HOME to your Android SDK"; exit 1; }
BT="$SDK/build-tools/${BUILD_TOOLS:-34.0.0}"
JAR="$SDK/platforms/android-34/android.jar"
[ -x "$BT/aapt2" ] && [ -f "$JAR" ] || { echo "Need build-tools 34.0.0 and platform android-34 in $SDK"; exit 1; }

VERSION_NAME="${VERSION_NAME:-1.8.0}"
VERSION_CODE="${VERSION_CODE:-13}"
OUT=build
rm -rf "$OUT"; mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "• resources"
"$BT/aapt2" compile --dir app/src/main/res -o "$OUT/res/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest app/src/main/AndroidManifest.xml --java "$OUT/gen" \
  --min-sdk-version 26 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -o "$OUT/app.unaligned.apk" "$OUT/res/res.zip"

echo "• compile"
# Compile against Android's own Java library (not the desktop JDK's), like the Android build tools do.
status=0
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR:$BT/core-lambda-stubs.jar" -d "$OUT/classes" -encoding UTF-8 \
  $(find app/src/main/java "$OUT/gen" -name '*.java') > "$OUT/javac.log" 2>&1 || status=$?
grep -v "^Note:" "$OUT/javac.log" || true
[ "$status" -eq 0 ] || { echo "compile failed"; exit 1; }

echo "• dex"
"$BT/d8" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q ../app.unaligned.apk classes.dex)

echo "• sign"
"$BT/zipalign" -f -p 4 "$OUT/app.unaligned.apk" "$OUT/app.aligned.apk"
"$BT/apksigner" sign --ks marquee-sideload.keystore --ks-pass pass:marquee-sideload --key-pass pass:marquee-sideload \
  --ks-key-alias marquee --out "$OUT/Marquee.apk" "$OUT/app.aligned.apk"
"$BT/apksigner" verify "$OUT/Marquee.apk"
echo "Built $OUT/Marquee.apk ($(du -h "$OUT/Marquee.apk" | cut -f1))"
# The server offers it from /downloads, and the app updates itself from there.
node publish.js android "$OUT/Marquee.apk" "$VERSION_CODE" "$VERSION_NAME"

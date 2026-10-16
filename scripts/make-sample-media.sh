#!/usr/bin/env bash
# Generates a small demo library (synthetic test patterns) so you can try Marquee without real media.
# Usage: scripts/make-sample-media.sh [output-dir]   (default: ./sample-media)
set -euo pipefail
OUT="${1:-sample-media}"
DUR="${DUR:-60}"
mkdir -p "$OUT/Movies" "$OUT/TV Shows"

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
# Sets SRC to ffmpeg input args: a labelled test pattern ($1) plus a sine tone ($2 Hz).
src() {
  SRC=(-f lavfi -i "testsrc2=size=1280x720:rate=24:duration=$DUR" -f lavfi -i "sine=frequency=$2:sample_rate=48000:duration=$DUR"
       -vf "drawtext=text='$1':fontsize=56:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h-120")
}

make_srt() { # $1 = file, $2 = label
  {
    for i in $(seq 0 5 $((DUR - 5))); do
      n=$((i / 5 + 1))
      printf '%d\n00:%02d:%02d,000 --> 00:%02d:%02d,500\n%s — line %d\n\n' "$n" $((i / 60)) $((i % 60)) $(((i + 4) / 60)) $(((i + 4) % 60)) "$2" "$n"
    done
  } > "$1"
}

echo "Creating sample movies…"
# 1. Browser-native MP4 (H.264 + AAC) in its own folder with a sidecar subtitle -> Direct Play
mkdir -p "$OUT/Movies/Big Buck Test (2008)"
src 'Big Buck Test' 440; ff "${SRC[@]}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "$OUT/Movies/Big Buck Test (2008)/Big Buck Test (2008).mp4"
make_srt "$OUT/Movies/Big Buck Test (2008)/Big Buck Test (2008).en.srt" "English subtitle"

# 2. MKV with H.264 + AC3 and an embedded subtitle track -> remux (video copied, audio transcoded)
make_srt "$OUT/tmp.srt" "Embedded subtitle"
src 'Scene Release' 523; ff -i "$OUT/tmp.srt" "${SRC[@]}" -map 1:v -map 2:a -map 0:s -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a ac3 -c:s srt \
  -metadata:s:s:0 language=eng -shortest "$OUT/Movies/The.Scene.Release.2019.1080p.BluRay.x264-GRP.mkv"
rm -f "$OUT/tmp.srt"

# 3. AVI with MPEG-4 Part 2 video + MP3 -> full transcode
src 'Old School Rip' 659; ff "${SRC[@]}" -c:v mpeg4 -q:v 5 -c:a libmp3lame -shortest "$OUT/Movies/Old School Rip (1999).avi"

# 4. WebM (VP9 + Opus) with a Spanish sidecar subtitle -> Direct Play
src 'Open Formats' 587; ff "${SRC[@]}" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 1M -c:a libopus -shortest "$OUT/Movies/Open Formats (2023).webm"
make_srt "$OUT/Movies/Open Formats (2023).es.srt" "Subtítulo en español"

echo "Creating a sample TV show…"
for s in 1 2; do
  mkdir -p "$OUT/TV Shows/Test Pattern Show (2021)/Season 0$s"
  for e in 1 2 3; do
    src "Test Pattern Show S0${s}E0${e}" $((300 + s * 100 + e * 20))
    ff "${SRC[@]}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest \
      "$OUT/TV Shows/Test Pattern Show (2021)/Season 0$s/Test Pattern Show - S0${s}E0${e} - Episode Title $e.mp4"
  done
done
src 'Another Show 1x01' 880; ff "${SRC[@]}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "$OUT/TV Shows/Another.Show.S01E01.720p.WEB-DL.mp4"

echo "Done. Add these folders as libraries in Marquee:"
echo "  Movies:   $(cd "$OUT/Movies" && pwd)"
echo "  TV Shows: $(cd "$OUT/TV Shows" && pwd)"

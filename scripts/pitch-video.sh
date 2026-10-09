#!/usr/bin/env bash
# The narrated pitch: slides (e2e-web/pitch/deck.html) and shots of the live site, cut from the narrated demo, with the
# same voice and word-by-word captions.
#
#   pip install kokoro-onnx==0.6.1 soundfile   # and the two model files in .kokoro/ (see scripts/narrate.py)
#   bash scripts/pitch-video.sh                 # the 90-second pitch: media/pitch-90s.mp4 (script e2e-web/pitch-90.json)
#   bash scripts/pitch-video.sh full            # the full pitch:      media/pitch-video.mp4 (script e2e-web/pitch.json)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-90}" = full ]; then
  LINES=e2e-web/pitch.json OUT=media/pitch VIDEO=media/pitch-video.mp4
else
  LINES=e2e-web/pitch-90.json OUT=media/pitch-90 VIDEO=media/pitch-90s.mp4
fi
SRC=media/narrated-demo.mp4
CLIPS=media/pitch/clips
mkdir -p "$CLIPS" "$OUT"

# Shots of the live site, by their time in the narrated demo. The demo's own caption sits at the bottom of each frame;
# the deck covers it with the pitch's caption, or crops it away (crop=1).
clip() { # name, crop, then start:end ranges joined in order
  local name=$1 crop=$2; shift 2
  local inputs=() parts="" i=0
  for r in "$@"; do
    inputs+=(-ss "${r%:*}" -to "${r#*:}" -i "$SRC")
    parts+="[$i:v]"
    i=$((i + 1))
  done
  local post="null"
  [ "$crop" = 1 ] && post="crop=1280:600:0:0"
  ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "${parts}concat=n=$i:v=1:a=0,$post[v]" -map "[v]" \
    -c:v libvpx-vp9 -crf 32 -b:v 0 -deadline realtime -cpu-used 8 -row-mt 1 -an "$CLIPS/$name.webm"
}
clip mandate 0 9:19.6
clip pilot 0 22:31
clip guard 1 31.2:39.8
clip live 0 52.3:60.2
clip rebalance 0 52.3:57 84:88
clip theater 0 60.4:67.3
clip trust 0 68:76.4 84:88
clip proof 0 123.2:136.8

python3 scripts/narrate.py --model .kokoro --lines "$LINES" --out "$OUT/narration"
rm -rf "$OUT/recording"
PITCH_LINES="$PWD/$LINES" PITCH_OUT="$PWD/$OUT" npx playwright test -c e2e-web/pitch-video.config.ts --output "$OUT/recording"
webm=$(find "$OUT/recording" -name '*.webm' | head -n 1)
python3 scripts/mix-narration.py --video "$webm" --timeline "$OUT/timeline.json" --narration "$OUT/narration" --out "$VIDEO"

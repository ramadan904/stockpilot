#!/usr/bin/env bash
# Record the captioned demo video against the local stack and write media/local-demo.mp4. (media/live-demo.mp4 is
# recorded on the live site by the Demo pilot workflow with `video: true`.)
#
#   bash scripts/video.sh   (PW_CHROMIUM=<path> if Playwright's own Chromium isn't installed)
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf e2e-web/test-results/video
npx playwright test -c e2e-web/video.config.ts --output e2e-web/test-results/video
webm=$(find e2e-web/test-results/video -name '*.webm' | head -n 1)
mkdir -p media
ffmpeg -y -loglevel error -i "$webm" -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart -an media/local-demo.mp4
echo "Wrote media/local-demo.mp4 ($(du -h media/local-demo.mp4 | cut -f1))"

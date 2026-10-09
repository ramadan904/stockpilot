#!/usr/bin/env python3
"""Lay the narration over the recorded video: each line's audio at the moment the recorder started saying it.

    python3 scripts/mix-narration.py --video VIDEO.webm --timeline e2e-web/test-results/narration-timeline.json \
        --narration media/narration --out media/narrated-demo.mp4

The recorder shows a red frame at the start (Narrator.syncMark); its time in the video ties the recorder's clock to
the video's, and the video is cut just after it, so the first thing on screen is the site.
"""

import argparse
import json
import re
import subprocess
from pathlib import Path

MARK_LEAD = 0.15  # the recorder notes the mark this long after painting it


def red_frames(video: str) -> list[float]:
    """Times of the frames that are the red sync mark (high V chroma, from ffmpeg's signalstats)."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-t", "30", "-i", video, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.VAVG", "-an", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    times, t = [], None
    for line in out.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"VAVG=([\d.]+)", line)
        if m and t is not None and float(m.group(1)) > 200:
            times.append(t)
    return times


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--narration", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    timeline = json.loads(Path(args.timeline).read_text())
    reds = red_frames(args.video)
    if not reds:
        raise SystemExit("No sync mark found in the video.")
    offset = reds[0] - (timeline["marker"] - MARK_LEAD)  # recorder time + offset = video time
    cut = reds[-1] + 0.08
    lines = [(l["id"], l["at"] + offset - cut) for l in timeline["lines"]]
    print(f"sync mark at {reds[0]:.2f}s, cutting at {cut:.2f}s, {len(lines)} lines")

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{cut:.3f}", "-i", args.video]
    filters, labels = [], []
    for i, (line_id, at) in enumerate(lines, start=1):
        cmd += ["-i", str(Path(args.narration) / f"{line_id}.wav")]
        ms = max(0, round(at * 1000))
        filters.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
        labels.append(f"[a{i}]")
    filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[voice]")
    cmd += [
        "-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[voice]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-shortest", "-movflags", "+faststart", args.out,
    ]
    subprocess.run(cmd, check=True)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

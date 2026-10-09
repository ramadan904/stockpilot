#!/usr/bin/env python3
"""Lay the narration over the recorded video: each line's audio at the moment the recorder started saying it.

    python3 scripts/mix-narration.py --video VIDEO.webm --timeline e2e-web/test-results/narration-timeline.json \
        --narration media/narration --out media/narrated-demo.mp4

The recorder shows a red frame at the start (Narrator.syncMark); its time in the video ties the recorder's clock to
the video's, and the video starts just after it. Silences longer than MAX_GAP (pages loading, transactions confirming)
become jump cuts, so the length follows the narration, not the chain.
"""

import argparse
import json
import re
import subprocess
from pathlib import Path

MARK_LEAD = 0.15  # the recorder notes the mark this long after painting it
LEAD, TAIL = 0.5, 1.0  # picture kept before a line starts and after it ends
MAX_GAP = 1.2  # a silent stretch longer than this (a page loading, a transaction confirming) becomes a jump cut


def keep_segments(spans: list[tuple[float, float]], end: float) -> list[tuple[float, float]]:
    """The parts of the video worth keeping: every line with a little picture either side; long silences cut short."""
    segs: list[list[float]] = []
    for start, stop in sorted(spans):
        s, e = max(0.0, start - LEAD), min(end, stop + TAIL)
        if segs and s - segs[-1][1] <= MAX_GAP:
            segs[-1][1] = max(segs[-1][1], e)
        else:
            segs.append([s, e])
    return [(s, e) for s, e in segs]


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
    durations = {k: v["duration"] for k, v in json.loads((Path(args.narration) / "timings.json").read_text()).items()}
    lines = [(l["id"], l["at"] + offset) for l in timeline["lines"]]
    length = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", args.video],
                                  capture_output=True, text=True, check=True).stdout.strip() or 0)
    segs = keep_segments([(at, at + durations[i]) for i, at in lines], length)
    segs[0] = (max(segs[0][0], cut), segs[0][1])

    def edited(t: float) -> float:
        """Where a moment of the recording lands in the edited video."""
        before = 0.0
        for s, e in segs:
            if t < e:
                return before + max(0.0, t - s)
            before += e - s
        return before

    total = sum(e - s for s, e in segs)
    print(f"sync mark at {reds[0]:.2f}s; {len(lines)} lines; {len(segs)} segments, {length - cut:.1f}s recorded -> {total:.1f}s edited")

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", args.video]
    filters = [f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{k}]" for k, (s, e) in enumerate(segs)]
    filters.append(f"{''.join(f'[v{k}]' for k in range(len(segs)))}concat=n={len(segs)}:v=1:a=0[video]")
    labels = []
    for i, (line_id, at) in enumerate(lines, start=1):
        cmd += ["-i", str(Path(args.narration) / f"{line_id}.wav")]
        ms = max(0, round(edited(at) * 1000))
        filters.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
        labels.append(f"[a{i}]")
    filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[voice]")
    cmd += [
        "-filter_complex", ";".join(filters), "-map", "[video]", "-map", "[voice]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-shortest", "-movflags", "+faststart", args.out,
    ]
    subprocess.run(cmd, check=True)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

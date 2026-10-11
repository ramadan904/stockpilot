#!/usr/bin/env python3
"""Turn a founder's own recording of a script into narration lines, in the same shape scripts/narrate.py writes.

    python3 scripts/voice-lines.py --audio TAKE.m4a --asr ASR.json --lines e2e-web/pitch-founder.json --out DIR

ASR.json holds a speech recognizer's output for TAKE ({"tokens": [...], "timestamps": [...]}, sub-word tokens where a
leading space starts a word, as sherpa-onnx gives them). Each word of the script is matched to the words heard, so a
misheard word still gets the time it was said; the captions show the script's words. Writes <out>/<id>.wav (that line
of the recording, cleaned up) and <out>/timings.json: {id: {"duration": s, "words": [[word, start, end], ...]}}.
"""

import argparse
import difflib
import json
import re
import subprocess
from pathlib import Path

LEAD, TAIL = 0.12, 0.25  # audio kept before a line's first word and after its last


def norm(word: str) -> str:
    return re.sub(r"[^a-z0-9]", "", word.lower())


def heard_words(asr: dict) -> list[tuple[str, float]]:
    """The recognizer's words with the time each starts."""
    words: list[list] = []
    for tok, t in zip(asr["tokens"], asr["timestamps"]):
        if tok.startswith(" ") or not words:
            words.append([tok.strip(), t])
        else:
            words[-1][0] += tok
    return [(w, t) for w, t in words if norm(w)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--asr", required=True)
    ap.add_argument("--lines", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    lines: dict[str, str] = json.loads(Path(args.lines).read_text())
    heard = heard_words(json.loads(Path(args.asr).read_text()))
    script = [(line_id, w) for line_id, text in lines.items() for w in text.split()]

    # Match script words to heard words; unmatched script words share the time between their matched neighbours.
    starts: list[float | None] = [None] * len(script)
    sm = difflib.SequenceMatcher(None, [norm(w) for _, w in script], [norm(w) for w, _ in heard], autojunk=False)
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            starts[block.a + k] = heard[block.b + k][1]
    for op, a0, a1, b0, b1 in sm.get_opcodes():
        if op == "replace" and a1 - a0 and b1 - b0:  # misheard words: spread them over what was heard there
            for k in range(a0, a1):
                starts[k] = heard[b0 + (k - a0) * (b1 - b0) // (a1 - a0)][1]
    known = [i for i, s in enumerate(starts) if s is not None]
    for i in range(len(starts)):
        if starts[i] is None:
            before = max((k for k in known if k < i), default=None)
            after = min((k for k in known if k > i), default=None)
            if before is None:
                starts[i] = starts[after]
            elif after is None:
                starts[i] = starts[before] + 0.3 * (i - before)
            else:
                starts[i] = starts[before] + (starts[after] - starts[before]) * (i - before) / (after - before)
    matched = sum(b.size for b in sm.get_matching_blocks())
    print(f"{matched} of {len(script)} script words matched what was heard")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ids = list(lines)
    timings = {}
    for n, line_id in enumerate(ids):
        idx = [i for i, (lid, _) in enumerate(script) if lid == line_id]
        first, last = idx[0], idx[-1]
        begin = max(0.0, starts[first] - LEAD)
        nxt = starts[last + 1] if last + 1 < len(script) else None
        last_end = (nxt - 0.15) if nxt is not None else starts[last] + 0.9
        end = last_end + TAIL if nxt is None else min(last_end + TAIL, nxt - LEAD)
        words = []
        for i in idx:
            w_end = (starts[i + 1] if i + 1 <= last else last_end) - begin
            words.append([script[i][1], round(starts[i] - begin, 3), round(w_end, 3)])
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{begin:.3f}", "-to", f"{end:.3f}", "-i", args.audio,
             "-af", "highpass=f=80,afftdn=nf=-30,afade=t=in:d=0.05", "-ac", "1", "-ar", "24000", str(out / f"{line_id}.wav")],
            check=True,
        )
        timings[line_id] = {"duration": round(end - begin, 3), "words": words}
        print(f"{line_id}: {begin:.2f}-{end:.2f}s")
    (out / "timings.json").write_text(json.dumps(timings, indent=1))


if __name__ == "__main__":
    main()

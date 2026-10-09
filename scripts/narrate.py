#!/usr/bin/env python3
"""Speak every line of the demo narration with Kokoro, an open neural text-to-speech model, and time each word.

    pip install kokoro-onnx soundfile
    # model files: https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
    python3 scripts/narrate.py --model DIR --lines e2e-web/narration.json --out media/narration

Writes <out>/<id>.wav for each line and <out>/timings.json: {id: {"duration": s, "words": [[word, start, end], ...]}}.
Each sentence is spoken separately (natural intonation), so sentence boundaries are exact; inside a sentence, word
times are spread by how long each word takes to say (letters, plus a beat for punctuation). The recorder highlights
each caption word at its time, so the voice and the words move together.
"""

import argparse
import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

SENTENCE_GAP = 0.32  # seconds of silence between sentences
VOICE_MIX = {"am_michael": 0.6, "am_fenrir": 0.4}  # a warm, clear male voice

# How a caption word is said: tickers letter by letter, names as people say them. The caption keeps the written form.
SAY = {
    "USDG": "U S D G", "TSLA": "Tesla", "AAPL": "Apple", "NVDA": "N V D A", "SPY": "S P Y", "AI": "A I",
    "StockPilot": "Stock Pilot", "StockPilot's": "Stock Pilot's", "onchain": "on chain", "EIP-712": "E I P 712",
    "MCP": "M C P", "PDF": "P D F", "CSV": "C S V", "USD": "U S D", "ETH": "eath", "FIFO": "fife oh", "API": "A P I",
}


def sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]


def spoken(word: str) -> str:
    """The word as the voice should say it, punctuation kept."""
    m = re.match(r"^([\"'(]*)(.*?)([\"'),.;:!?]*)$", word)
    lead, core, tail = m.groups() if m else ("", word, "")
    return lead + SAY.get(core, core) + tail


def word_weights(tokenizer, words: list[str]) -> list[float]:
    """How long each word takes to say: its phonemes, a floor, and a beat after a comma."""
    out = []
    for w in words:
        sound = re.sub(r"[^\w\s]", "", spoken(w)).strip()
        phones = len(re.sub(r"[ˈˌ\s]", "", tokenizer.phonemize(sound, "en-us"))) if sound else 0
        weight = max(2.0, phones)
        if w.endswith((",", ";", ":")):
            weight += 3.0
        out.append(weight)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="directory with kokoro-v1.0.onnx and voices-v1.0.bin")
    ap.add_argument("--lines", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speed", type=float, default=1.12)
    args = ap.parse_args()

    kokoro = Kokoro(f"{args.model}/kokoro-v1.0.onnx", f"{args.model}/voices-v1.0.bin")
    voice = sum(kokoro.get_voice_style(name) * share for name, share in VOICE_MIX.items())
    lines: dict[str, str] = json.loads(Path(args.lines).read_text())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    timings = {}
    for line_id, text in lines.items():
        chunks, words, t, rate = [], [], 0.0, 24_000
        for i, sentence in enumerate(sentences(text)):
            parts = sentence.split()
            audio, rate = kokoro.create(" ".join(spoken(w) for w in parts), voice=voice, speed=args.speed, lang="en-us")
            length = len(audio) / rate
            weights = word_weights(kokoro.tokenizer, parts)
            total = sum(weights)
            at = t
            for word, weight in zip(parts, weights):
                span = length * weight / total
                words.append([word, round(at, 3), round(at + span, 3)])
                at += span
            chunks.append(audio)
            t += length
            if i < len(sentences(text)) - 1:
                chunks.append(np.zeros(int(SENTENCE_GAP * rate), dtype=np.float32))
                t += SENTENCE_GAP
        sf.write(out / f"{line_id}.wav", np.concatenate(chunks), rate)
        timings[line_id] = {"duration": round(t, 3), "words": words}
        print(f"{line_id}: {t:.1f}s")
    (out / "timings.json").write_text(json.dumps(timings, indent=1))
    print(f"{len(timings)} lines, {sum(v['duration'] for v in timings.values()) / 60:.1f} minutes of narration")


if __name__ == "__main__":
    main()

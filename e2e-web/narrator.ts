// The narrated demo's voice track, as the browser sees it: each line's caption lights up word by word at the times
// scripts/narrate.py measured, while the scene's actions run underneath. Every line said is logged with the moment it
// started, and scripts/mix-narration.py lays the matching audio at exactly those moments.

import { readFileSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";

type Timing = { duration: number; words: [string, number, number][] };

export class Narrator {
  private readonly timings: Record<string, Timing>;
  private readonly t0 = Date.now();
  private readonly said: { id: string; at: number }[] = [];
  private marker = 0;

  constructor(
    private readonly page: Page,
    narrationDir: string,
  ) {
    this.timings = JSON.parse(readFileSync(`${narrationDir}/timings.json`, "utf8"));
  }

  private now() {
    return (Date.now() - this.t0) / 1000;
  }

  /** A red frame the mixer finds in the video, so the voice lines up with the picture to the frame. */
  async syncMark() {
    await this.page.evaluate(() => {
      const red = document.createElement("div");
      red.id = "sync-mark";
      Object.assign(red.style, { position: "fixed", inset: "0", background: "#ff0000", zIndex: "100000" });
      document.body.appendChild(red);
    });
    await this.page.waitForTimeout(150);
    this.marker = this.now();
    await this.page.waitForTimeout(450);
    await this.page.evaluate(() => document.getElementById("sync-mark")?.remove());
    await this.page.waitForTimeout(300);
  }

  /**
   * Say a line, its caption following the voice word by word, while `during` runs underneath. The action may run at
   * most `overrun` seconds past the voice; a slower one fails the scene, so the video never stalls on a slow chain.
   */
  async say(id: string, during?: () => Promise<unknown>, overrun = 8) {
    const t = this.timings[id];
    if (!t) throw new Error(`No narration for "${id}": run scripts/narrate.py`);
    this.said.push({ id, at: this.now() });
    await this.page.evaluate(showCaption, t.words);
    const speaking = this.page.waitForTimeout(t.duration * 1000 + 450);
    // Always let the line finish, even if the action under it fails, so two lines never overlap.
    const capped = during
      ? Promise.race([during(), new Promise((_, reject) => setTimeout(() => reject(new Error(`"${id}" ran past its line`)), (t.duration + overrun) * 1000))])
      : undefined;
    const [, action] = await Promise.allSettled([speaking, capped]);
    if (action.status === "rejected") throw action.reason;
  }

  /** Clear the caption (between scenes, or before a page load). */
  async quiet() {
    await this.page.evaluate(() => document.getElementById("narration")?.remove()).catch(() => {});
  }

  save(file: string) {
    writeFileSync(file, JSON.stringify({ marker: this.marker, lines: this.said }, null, 1));
  }
}

/** Runs in the page: the caption bar, one span per word, each lit as it is spoken. */
function showCaption(words: [string, number, number][]) {
  type W = Window & { __narrationTimers?: number[] };
  const w = window as W;
  for (const id of w.__narrationTimers ?? []) clearTimeout(id);
  w.__narrationTimers = [];
  if (!document.getElementById("narration-style")) {
    const style = document.createElement("style");
    style.id = "narration-style";
    style.textContent = `
      #narration { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 99999; max-width: 1080px;
        width: max-content; padding: 13px 24px; border-radius: 14px; background: rgba(5,8,12,.9); border: 1px solid rgba(45,212,191,.4);
        box-shadow: 0 12px 44px rgba(0,0,0,.55); font: 600 21px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; text-align: center;
        color: rgba(230,237,245,.42); text-wrap: balance; pointer-events: none; }
      body:has(.tour-panel) #narration { bottom: auto; top: 64px; }
      #narration { transition: opacity .3s; }
      #narration span { transition: color .12s, text-shadow .12s; }
      #narration span.said { color: #e6edf5; }
      #narration span.now { color: #5eead4; text-shadow: 0 0 14px rgba(45,212,191,.55); }`;
    document.head.appendChild(style);
  }
  document.getElementById("narration")?.remove();
  const bar = document.createElement("div");
  bar.id = "narration";
  const spans = words.map(([word], i) => {
    const s = document.createElement("span");
    s.textContent = word;
    bar.appendChild(s);
    if (i < words.length - 1) bar.appendChild(document.createTextNode(" "));
    return s;
  });
  document.body.appendChild(bar);
  words.forEach(([, start], i) => {
    w.__narrationTimers!.push(
      window.setTimeout(() => {
        spans.forEach((s, j) => (s.className = j < i ? "said" : j === i ? "now" : ""));
      }, start * 1000),
    );
  });
  const end = words.length ? words[words.length - 1][2] : 0;
  w.__narrationTimers.push(window.setTimeout(() => spans.forEach((s) => (s.className = "said")), end * 1000));
  // Gone shortly after the voice stops, so a caption never sits over the next scene in silence.
  w.__narrationTimers.push(window.setTimeout(() => (bar.style.opacity = "0"), end * 1000 + 500));
}

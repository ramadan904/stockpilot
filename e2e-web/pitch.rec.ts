// The narrated pitch: the slides in e2e-web/pitch/deck.html, with shots of the live site, each shown for one line of the
// script (e2e-web/pitch.json, or pitch-90.json for the 90-second cut) in the same voice and word-by-word captions as the
// demo. Each line shows the slide with its id. scripts/pitch-video.sh runs it all.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { test } from "@playwright/test";
import { Narrator } from "./narrator";

const OUT = process.env.PITCH_OUT ?? `${__dirname}/../media/pitch`;
const LINES: Record<string, string> = JSON.parse(readFileSync(process.env.PITCH_LINES ?? `${__dirname}/pitch.json`, "utf8"));

test("StockPilot, the pitch", async ({ page }) => {
  test.setTimeout(400_000);
  const timings = JSON.parse(readFileSync(`${OUT}/narration/timings.json`, "utf8"));
  await page.goto(pathToFileURL(`${__dirname}/pitch/deck.html`).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => (window as unknown as { ready: () => Promise<void> }).ready());

  const narr = new Narrator(page, `${OUT}/narration`);
  await narr.syncMark();
  for (const id of Object.keys(LINES)) {
    const { words, duration } = timings[id];
    await page.evaluate(([id, words, duration]) => (window as unknown as { play: (...a: unknown[]) => void }).play(id, words, duration), [id, words, duration] as const);
    await narr.say(id);
  }
  await page.waitForTimeout(1200);
  narr.save(`${OUT}/timeline.json`);
});

import { defineConfig, devices } from "@playwright/test";

// Records the narrated demo (e2e-web/narrated.rec.ts): the live site by default, or the local stack with
// NARRATE_TARGET=local for a rehearsal. scripts/mix-narration.py then lays the voice over the video.
const local = process.env.NARRATE_TARGET === "local";

export default defineConfig({
  testDir: ".",
  testMatch: /narrated\.rec\.ts$/,
  timeout: 1_500_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: local ? "http://localhost:5173" : (process.env.LIVE_URL ?? "https://stockpilot-six-virid.vercel.app"),
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "off",
    actionTimeout: 15_000, // a control that never becomes clickable skips its scene instead of stalling the video
    navigationTimeout: 60_000,
  },
  webServer: local ? { command: "../scripts/e2e-stack.sh", url: "http://localhost:5173", timeout: 180_000, reuseExistingServer: true } : undefined,
});

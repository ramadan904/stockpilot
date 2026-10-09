import { defineConfig, devices } from "@playwright/test";

// Records the narrated pitch (e2e-web/pitch.rec.ts); scripts/pitch-video.sh lays the voice over it.
export default defineConfig({
  testDir: ".",
  testMatch: /pitch\.rec\.ts$/,
  timeout: 400_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    launchOptions: {
      args: ["--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"],
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    },
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "off",
  },
});

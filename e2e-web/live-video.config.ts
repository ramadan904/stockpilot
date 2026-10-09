import { defineConfig, devices } from "@playwright/test";

// Records the demo video against the live site and the live chains (no local stack): the Demo pilot workflow runs it
// with `video: true`, right after the pilot flies, so prices are fresh. LIVE_URL picks another deployment.
export default defineConfig({
  testDir: ".",
  testMatch: /live\.rec\.ts$/,
  timeout: 420_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.LIVE_URL ?? "https://stockpilot-six-virid.vercel.app",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "off",
  },
});

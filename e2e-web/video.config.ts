import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// Records the captioned demo video: `npm run video` (then scripts/video.sh turns it into media/local-demo.mp4).
// Same local stack as the browser tests; only *.rec.ts files, so the normal test run never picks this up.
export default defineConfig({
  ...base,
  testMatch: /demo\.rec\.ts$/,
  timeout: 300_000,
  retries: 0,
  reporter: "list",
  use: {
    ...base.use,
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "off",
  },
});

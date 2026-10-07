import { defineConfig, devices } from "@playwright/test";

// Browser tests of the web app against a real local chain. `npm run e2e` starts the stack (scripts/e2e-stack.sh).
// PW_CHROMIUM points at an already installed Chromium when `npx playwright install` is not an option.
export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1, // the live tests share one chain
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    ...devices["Desktop Chrome"],
    viewport: { width: 1360, height: 1000 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: "../scripts/e2e-stack.sh",
    url: "http://localhost:5173",
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});

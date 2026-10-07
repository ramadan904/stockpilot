import { expect, test, type Page } from "@playwright/test";

// Phone width: every tab must fit without sideways page scrolling (tables may scroll inside their own boxes).
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function fits(page: Page, name: string) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  await page.screenshot({ path: `test-results/mobile-${name}.png`, fullPage: true });
  expect(scroll, `${name}: page is ${scroll}px wide on a ${width}px screen`).toBeLessThanOrEqual(width);
}

test("phone width: the simulator, backtest and a live vault fit the screen", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "NVDA up 15%" }).click();
  await page.getByRole("button", { name: "NVDA up 15%" }).click();
  await fits(page, "simulator");

  await page.getByRole("tab", { name: "Backtest" }).click();
  await expect(page.locator(".card").filter({ hasText: "What the pilot did" })).toBeVisible({ timeout: 30_000 });
  await fits(page, "backtest");

  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("button", { name: "Use local dev account" }).click();
  await page.getByRole("radio", { name: /Myself/ }).click();
  await page.getByRole("button", { name: "Fund at targets" }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  await expect(page.locator(".notice").filter({ hasText: "Deposit SPY: done." })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Pilot's next move")).toBeVisible({ timeout: 30_000 });
  await fits(page, "live");
});

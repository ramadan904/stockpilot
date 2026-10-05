import { expect, test, type Page } from "@playwright/test";

async function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("the 60-second tour walks the whole story", async ({ page }) => {
  const errors = await pageErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Take the 60-second tour" }).click();
  const panel = page.locator(".tour-panel");
  const titles: string[] = [];
  for (;;) {
    titles.push(await panel.locator("strong").innerText());
    const next = panel.getByRole("button", { name: "Next" });
    if ((await next.count()) === 0) break;
    await next.click();
  }
  expect(titles).toEqual(["This is your vault", "Markets move", "The pilot rebalances", "Now the pilot is hacked", "Weeks go by", "A report you can read", "Your turn"]);
  const log = page.locator('[data-tour="log"] .log li');
  await expect(log.filter({ hasText: /^Blocked/ })).toHaveCount(8);
  expect(await log.filter({ hasText: /^Trade/ }).count()).toBeGreaterThan(0);
  await expect(page.locator(".report strong").first()).toContainText("rebalancing trade");
  await panel.getByRole("button", { name: "Finish" }).click();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("in the simulator, a hacked pilot is blocked every time and the vault says why", async ({ page }) => {
  await page.goto("/");
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "NVDA up 15%" }).click();
  await page.getByRole("button", { name: "Run pilot", exact: true }).click();
  for (const b of await page.getByRole("button", { name: "Attempt" }).all()) await b.click();
  const log = page.locator('[data-tour="log"] .log li');
  await expect(log.filter({ hasText: "OutsideBand" })).toHaveCount(1);
  await expect(log.filter({ hasText: "SlippageExceeded" })).toHaveCount(1);
  await expect(log.filter({ hasText: "OwnableUnauthorizedAccount" })).toHaveCount(3);
  await expect(log.filter({ hasText: /^Allowed/ })).toHaveCount(0);
});

test("the backtest never proposes a trade the vault would reject", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Backtest" }).click();
  const tiles = page.locator(".card").filter({ hasText: "What the pilot did" });
  await expect(tiles).toContainText("Trades the vault would reject", { timeout: 30_000 });
  await expect(tiles.locator(".stat").filter({ hasText: "would reject" }).locator(".value")).toHaveText("0");
  await expect(page.locator("figure.chart svg path.line")).toHaveCount(2);
});

test("refining the draft in plain words lists exactly what changed", async ({ page }) => {
  await page.goto("/");
  const box = page.getByLabel("Adjust the mandate in your own words");
  await box.fill("less Tesla, more cash");
  await box.press("Enter");
  const changed = page.locator(".notice").filter({ hasText: "Changed:" });
  await expect(changed).toContainText("TSLA: 17.5% → 12.5%");
  await expect(changed).toContainText("USDG: 30% → 35%");
});

test("live: create a cash vault, let the pilot invest, pause, and withdraw everything", async ({ page }) => {
  const errors = await pageErrors(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("button", { name: "Use local dev account" }).click();
  await page.getByRole("button", { name: "Cash only" }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  await expect(page.getByText("Pilot's next move")).toContainText("Selling", { timeout: 60_000 });

  await page.getByRole("button", { name: "Run pilot (send planned trade)" }).click();
  const activity = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Activity" }) });
  await expect(activity.locator(".log li").first()).toContainText("Pilot sold", { timeout: 30_000 });

  await page.getByRole("button", { name: "Pause pilot" }).click();
  await expect(page.getByRole("button", { name: "Unpause" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Withdraw everything" }).click();
  await expect(page.locator(".stat").filter({ hasText: "Value" }).locator(".value")).toHaveText("$0.00", { timeout: 60_000 });
  expect(errors).toEqual([]);
});

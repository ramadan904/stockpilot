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

test("marketplace: list yourself as a pilot, then hire a listed pilot for a new vault", async ({ page }) => {
  const errors = await pageErrors(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("button", { name: "Use local dev account" }).click();

  const market = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Pilot marketplace" }) });
  await market.getByRole("button", { name: /List yourself as a pilot|Edit your listing/ }).click();
  await market.getByLabel("Name").fill("Patient rebalancer");
  await market.getByLabel("Link (website, repository or MCP endpoint)").fill("https://example.com/patient");
  await market.getByLabel("Fee you ask (% a year, max 2)").fill("0.75");
  await market.getByRole("button", { name: /List me|Save listing/ }).click();
  await expect(market.locator("tbody")).toContainText("Patient rebalancer (you)", { timeout: 30_000 });

  // The listing shows up in the pilot picker, with its ask and its track record read from the chain.
  const option = page.getByRole("radio", { name: /Patient rebalancer/ });
  await expect(option).toContainText("Asks 0.75% a year");
  await option.click();
  await expect(option).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /Myself/ })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("Pilot fee (% a year, max 2; 0 if you run the pilot yourself)")).toHaveValue("0.75");

  await page.getByRole("button", { name: "Cash only" }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  const pilotStat = page.locator(".stat").filter({ hasText: "Pilot" }).filter({ hasText: "a year" });
  await expect(pilotStat).toContainText("Patient rebalancer", { timeout: 60_000 });
  await expect(pilotStat).toContainText("0.75% a year");
  await expect(page.getByRole("radio", { name: /Patient rebalancer/ })).toContainText(/Flies [1-9]\d* vaults? worth/);
  expect(errors).toEqual([]);
});

test("inheritance: name an heir, go silent, and the heir takes over the vault", async ({ page }) => {
  const errors = await pageErrors(page);
  const HEIR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // local dev account 2
  await page.goto("/");
  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("button", { name: "Use local dev account" }).click();
  await page.getByRole("button", { name: "Cash only" }).click();
  await page.getByRole("radio", { name: /Myself/ }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  // Wait for the new vault to be funded and shown (earlier tests left other vaults on this account).
  await expect(page.locator(".notice").filter({ hasText: "Deposit USDG: done." })).toBeVisible({ timeout: 60_000 });
  const vaultAddress = await page.locator("[data-address]").first().getAttribute("data-address");

  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Inheritance" }) });
  await card.getByRole("button", { name: "Name an heir" }).click();
  await card.getByLabel("Heir's address").fill(HEIR);
  await card.getByLabel(/take over after this long/).selectOption("90");
  await card.getByRole("button", { name: "Save heir" }).click();
  await expect(card).toContainText("If the owner does nothing until", { timeout: 30_000 });
  await expect(card).toContainText("(90 days)");

  // Checking in restarts the clock; then the owner goes silent past the period.
  await card.getByRole("button", { name: /Skip ahead/ }).click();
  await expect(card.getByText("Heir can claim")).toBeVisible({ timeout: 30_000 });

  // The heir opens the vault by address and claims it.
  await page.getByRole("button", { name: "Switch to dev account 2" }).click();
  await page.getByLabel("Vault address").fill(vaultAddress!);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(card).toContainText("You are the heir", { timeout: 30_000 });
  await card.getByRole("button", { name: "Claim the vault" }).click();
  await expect(page.locator(".stat").filter({ hasText: "Your role" })).toContainText("Owner", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Withdraw everything" })).toBeVisible();
  const activity = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Activity" }) });
  await expect(activity).toContainText("inherited the vault from");
  expect(errors).toEqual([]);
});

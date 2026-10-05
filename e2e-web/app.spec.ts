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
  expect(titles).toEqual(["This is your vault", "Markets move", "The pilot rebalances", "Now the pilot is hacked", "Weeks go by", "Then the market crashes", "A report you can read", "Your turn"]);
  const log = page.locator('[data-tour="log"] .log li');
  await expect(log.filter({ hasText: /^Blocked/ })).toHaveCount(8);
  expect(await log.filter({ hasText: /^Trade/ }).count()).toBeGreaterThan(0);
  await expect(log.filter({ hasText: /^Guard.*Crash guard tripped/ })).toHaveCount(1);
  await expect(page.locator('[data-tour="guard"] .pill')).toHaveText("Defensive");
  await expect(page.locator(".report strong").first()).toContainText("rebalancing trade");
  await panel.getByRole("button", { name: "Finish" }).click();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("in the simulator, the crash guard trips on a crash and the pilot can only de-risk", async ({ page }) => {
  await page.goto("/");
  const guard = page.locator('[data-tour="guard"]');
  await guard.getByRole("button", { name: "Arm the crash guard" }).click();
  await expect(guard).toContainText("Armed. Peak");
  await page.getByRole("button", { name: "Market crash" }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Run pilot", exact: true }).click();
  const log = page.locator('[data-tour="log"] .log li');
  await expect(log.filter({ hasText: /^Guard/ })).toHaveCount(1);
  // Every trade after the crash sells stocks into the stablecoin.
  const trades = await log.filter({ hasText: /^Trade/ }).allInnerTexts();
  expect(trades.length).toBeGreaterThan(0);
  for (const t of trades) expect(t).toMatch(/for USDG/);
  await guard.getByRole("button", { name: "Back to normal targets" }).click();
  await expect(guard.locator(".pill")).toHaveText("Armed");
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
  await expect(page.locator(".card").filter({ hasText: "A typical path" }).locator("figure.chart svg path.line")).toHaveCount(2);
});

test("stress test: the draft mandate through five shaped crashes, with and without the crash guard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Backtest" }).click();
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Stress test before you sign" }) });
  await expect(card.locator("tbody tr")).toHaveCount(5);
  await expect(card.locator("tbody tr").filter({ hasText: "Long bear market" })).toContainText(/guard trips on day \d+/);
  await expect(card.locator("tbody tr").filter({ hasText: "Flash crash" })).toContainText("guard not tripped");
  await card.getByRole("button", { name: "Long bear market" }).click();
  await expect(card.locator("figcaption")).toContainText("Long bear market");
  await expect(card.locator("figure.chart svg path.line")).toHaveCount(3);
  // A looser guard trips later, or not at all.
  const before = await card.locator("tbody tr").filter({ hasText: "Tech wreck" }).textContent();
  await card.getByLabel("Crash guard trips at").selectOption("30");
  await expect(card.locator("tbody tr").filter({ hasText: "Tech wreck" })).not.toHaveText(before!);
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

test("taxes: a profitable sale shows up lot by lot and downloads as Form 8949-style CSV", async ({ page }) => {
  const errors = await pageErrors(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("button", { name: "Use local dev account" }).click();
  await page.getByRole("radio", { name: /Myself/ }).click();
  await page.getByRole("button", { name: "Fund at targets" }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  await expect(page.locator(".notice").filter({ hasText: "Deposit SPY: done." })).toBeVisible({ timeout: 90_000 }); // the last of five

  // NVDA rallies 40% on the local chain (the dev account deployed the feeds), and the pilot trims it at a gain.
  await movePrice("NVDA", 1.4);
  await page.reload();
  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("button", { name: "Use local dev account" }).click();
  await expect(page.getByText("Pilot's next move")).toContainText("Selling", { timeout: 30_000 });
  await page.getByRole("button", { name: "Run pilot (send planned trade)" }).click();
  const activity = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Activity" }) });
  await expect(activity.locator(".log li").first()).toContainText("Pilot sold", { timeout: 30_000 });

  // Performance, read from the chain: the vault against its deposits left untraded.
  const perf = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Performance", exact: true }) });
  await expect(perf.locator(".stat").filter({ hasText: "Pilot vs untraded" })).toBeVisible({ timeout: 30_000 });
  await expect(perf.locator("figure.chart svg path.line")).toHaveCount(2);

  const tax = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Taxes" }) });
  await tax.getByRole("button", { name: "Build tax report" }).click();
  const row = tax.locator("tbody tr").filter({ hasText: "NVDA" });
  await expect(row).toContainText("Short", { timeout: 30_000 });
  await expect(row.locator("td.num.up")).toHaveCount(1); // a gain
  const download = page.waitForEvent("download");
  await tax.getByRole("button", { name: /Download \d{4} CSV/ }).click();
  const csv = await (await download).createReadStream().then(async (s) => {
    let text = "";
    for await (const chunk of s) text += chunk;
    return text;
  });
  expect(csv.split("\n")[0]).toBe("Description,Date acquired,Date sold,Proceeds (USD),Cost basis (USD),Gain or loss (USD),Term,Basis source,Transaction");
  expect(csv).toMatch(/NVDA,\d{4}-\d\d-\d\d,\d{4}-\d\d-\d\d,[\d.]+,[\d.]+,[\d.]+,Short term,Onchain,0x[0-9a-f]{64}/);
  expect(errors).toEqual([]);
});

test("ask your vault: why the pilot sold, answered from onchain facts with a verified reason and a cited trade", async ({ page }) => {
  const errors = await pageErrors(page);
  const open = async () => {
    await page.getByRole("tab", { name: "Live (testnet)" }).click();
    await page.getByLabel("Network").selectOption("31337");
    await page.getByRole("button", { name: "Use local dev account" }).click();
  };
  await page.goto("/");
  await open();
  await page.getByRole("radio", { name: /Myself/ }).click();
  await page.getByRole("button", { name: "Fund at targets" }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  await expect(page.locator(".notice").filter({ hasText: "Deposit SPY: done." })).toBeVisible({ timeout: 90_000 });
  await movePrice("NVDA", 1.4);
  await page.reload();
  await open();
  await expect(page.getByText("Pilot's next move")).toContainText("Selling", { timeout: 30_000 });
  await page.getByRole("button", { name: "Run pilot (send planned trade)" }).click();
  const activity = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Activity" }) });
  await expect(activity.locator(".log li").first()).toContainText("Pilot sold", { timeout: 30_000 });

  const ask = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Ask your vault" }) });
  await ask.getByRole("button", { name: "Why did the pilot last trade?" }).click();
  const answer = ask.locator(".chat-a").last();
  await expect(answer).toContainText("NVDA", { timeout: 30_000 });
  await expect(answer).toContainText(/tx 0x[0-9a-f]{8}/); // the trade it relies on, checked against the vault's history
  if (!(await answer.textContent())!.includes("Claude")) await expect(answer).toContainText("matches the hash stored onchain");

  await ask.getByLabel("Your question").fill("What happens if I lose my keys?");
  await ask.getByRole("button", { name: "Ask" }).click();
  await expect(ask.locator(".chat-a")).toHaveCount(2, { timeout: 30_000 });
  await expect(ask.locator(".chat-a").last()).toContainText(/heir/i);
  expect(errors).toEqual([]);
});

test("crash guard: arm it, the market falls 40%, and the vault turns defensive so the pilot can only de-risk", async ({ page }) => {
  const errors = await pageErrors(page);
  const open = async () => {
    await page.getByRole("tab", { name: "Live (testnet)" }).click();
    await page.getByLabel("Network").selectOption("31337");
    await page.getByRole("button", { name: "Use local dev account" }).click();
  };
  await page.goto("/");
  await open();
  await page.getByRole("radio", { name: /Myself/ }).click();
  await page.getByRole("button", { name: "Fund at targets" }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  await expect(page.locator(".notice").filter({ hasText: "Deposit SPY: done." })).toBeVisible({ timeout: 90_000 });
  await movePrice("TSLA", 1); // fresh prices everywhere (earlier tests may have skipped time)

  const guard = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Crash guard" }) });
  await guard.getByRole("button", { name: "Arm the crash guard" }).click();
  await guard.getByLabel("Trip after a fall from the peak of").selectOption("20");
  await guard.getByRole("button", { name: "Save" }).click();
  await expect(guard.getByText("Armed")).toBeVisible({ timeout: 30_000 });
  await guard.getByRole("button", { name: "Check now" }).click();
  await expect(guard).toContainText("0.0% below the peak", { timeout: 30_000 });

  for (const s of ["TSLA", "AAPL", "NVDA", "SPY"]) await movePrice(s, 0.6);
  await page.reload();
  await open();
  await guard.getByRole("button", { name: "Check now" }).click();
  await expect(guard.getByText("Defensive", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Pilot's next move")).toContainText(/for USDG/, { timeout: 30_000 });
  const activity = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Activity" }) });
  await expect(activity).toContainText("Crash guard tripped");
  await guard.getByRole("button", { name: "Back to normal targets" }).click();
  await expect(guard.getByText("Armed")).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

async function movePrice(symbol: string, factor: number) {
  const { createWalletClient, createPublicClient, http, parseAbi } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { hardhat } = await import("viem/chains");
  const { readFileSync } = await import("node:fs");
  const d = JSON.parse(readFileSync(`${__dirname}/../deployments/localhost.json`, "utf8"));
  const abi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function setPrice(int256)"]);
  const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const pub = createPublicClient({ chain: hardhat, transport: http() });
  const wallet = createWalletClient({ account, chain: hardhat, transport: http() });
  // Every stock feed gets a fresh update (earlier tests may have skipped time ahead); `symbol` also moves by `factor`.
  for (const [s, feed] of Object.entries(d.feeds as Record<string, `0x${string}`>)) {
    if (s === "USDG") continue; // a fixed $1 feed
    const [, answer] = await pub.readContract({ address: feed, abi, functionName: "latestRoundData" });
    const next = s === symbol ? (answer * BigInt(Math.round(factor * 1000))) / 1000n : answer;
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: feed, abi, functionName: "setPrice", args: [next] }) });
  }
}

test("a shared link opens a vault read-only, without a wallet", async ({ page, context }) => {
  const errors = await pageErrors(page);
  // Create a vault as the owner, then copy its share link.
  await page.goto("/");
  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("button", { name: "Use local dev account" }).click();
  await page.getByRole("radio", { name: /Myself/ }).click();
  await page.getByRole("button", { name: "Cash only" }).click();
  await page.getByRole("button", { name: "Create and fund vault" }).click();
  await expect(page.locator(".notice").filter({ hasText: "Deposit USDG: done." })).toBeVisible({ timeout: 60_000 });
  const vault = await page.locator("[data-address]").first().getAttribute("data-address");

  // A visitor with no wallet follows the link.
  const visitor = await context.newPage();
  const visitorErrors = await pageErrors(visitor);
  await visitor.goto(`/?chain=31337&vault=${vault}`);
  await expect(visitor.getByText("Read-only view")).toBeVisible();
  await expect(visitor.locator("[data-address]")).toHaveAttribute("data-address", vault!);
  await expect(visitor.locator(".stat").filter({ hasText: "Your role" })).toContainText("Viewer");
  await expect(visitor.locator(".stat").filter({ hasText: "Value" }).first()).toContainText("$");
  await expect(visitor.getByRole("heading", { name: "Activity" })).toBeVisible();
  // Nothing that needs a signature is offered.
  await expect(visitor.getByRole("button", { name: "Withdraw everything" })).toHaveCount(0);
  await expect(visitor.getByRole("button", { name: "Run pilot (send planned trade)" })).toHaveCount(0);
  await expect(visitor.getByRole("button", { name: "Create and fund vault" })).toHaveCount(0);
  await expect(visitor.getByRole("heading", { name: "Controls" })).toHaveCount(0);
  // The visitor can still connect a wallet on top of the shared vault.
  await expect(visitor.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  expect(errors).toEqual([]);
  expect(visitorErrors).toEqual([]);
});

// The demo video, as a script: drives the real app against the local stack and lays captions over it. Recorded by
// `npm run video`. Every number and refusal on screen comes from the running contracts, not from the script.

import { execSync } from "node:child_process";
import { test, type Page, type Locator } from "@playwright/test";

const hardhat = (script: string, env: Record<string, string> = {}) =>
  execSync(`npx hardhat run ${script} --network localhost`, { env: { ...process.env, ...env }, stdio: "pipe" });

async function rpc(method: string, params: unknown[] = []) {
  await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

/** A caption bar along the bottom, kept across page loads. */
async function caption(page: Page, text: string, hold = 0) {
  await page.evaluate((t) => {
    let bar = document.getElementById("demo-caption");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "demo-caption";
      Object.assign(bar.style, {
        position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)", zIndex: "9999", maxWidth: "1040px",
        padding: "12px 22px", borderRadius: "12px", background: "rgba(5,8,12,0.88)", color: "#e6edf5", font: "600 20px/1.35 system-ui, sans-serif",
        textAlign: "center", boxShadow: "0 10px 40px rgba(0,0,0,.5)", border: "1px solid rgba(45,212,191,.35)", transition: "opacity .25s",
      } as Partial<CSSStyleDeclaration>);
      document.body.appendChild(bar);
    }
    bar.style.opacity = "0";
    setTimeout(() => {
      bar!.textContent = t;
      bar!.style.opacity = "1";
    }, 180);
  }, text);
  await page.waitForTimeout(400 + hold);
}

async function show(locator: Locator, pause = 900) {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await locator.page().waitForTimeout(pause);
}

test("StockPilot in about eighty seconds", async ({ page }) => {
  // Set the stage on the local chain: the demo vault earns its Verified Mandate (a day passes), and prices are fresh.
  hardhat("scripts/demo-credential.ts");
  await rpc("evm_increaseTime", [86_460]);
  await rpc("evm_mine");
  hardhat("scripts/demo-credential.ts");
  for (const symbol of ["TSLA", "AAPL", "NVDA", "SPY"]) hardhat("scripts/move-price.ts", { SYMBOL: symbol, PCT: "0" });

  await page.goto("/");
  await page.waitForTimeout(600);
  await caption(page, "StockPilot: an AI autopilot for tokenized stocks that can only trade inside the rules you sign.", 3200);
  await caption(page, "The light behind the page is your portfolio: one colour per asset, sized by its weight.", 2600);

  // The live vault, as a judge opens it: no wallet.
  await page.getByRole("tab", { name: "Live (testnet)" }).click();
  await page.getByLabel("Network").selectOption("31337");
  await page.getByRole("link", { name: "Open the demo vault" }).click();
  await page.getByText("Pilot's next move").waitFor({ timeout: 30_000 });
  await caption(page, "A live vault, read straight from the chain. No wallet needed. (Recorded on a local chain running the same contracts.)", 3200);
  await show(page.locator(".mood-lamp").first(), 600);
  await caption(page, "Its lamp shows how far it has drifted from the rules its owner signed.", 2400);

  const theater = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Attack Theater" }) });
  await show(theater);
  await caption(page, "Now suppose the pilot's key is stolen. Nine attacks, sent to the real contract from the pilot's own address.", 1200);
  await theater.getByRole("button", { name: "Simulate a compromised pilot" }).click();
  await page.getByTestId("theater-summary").waitFor({ timeout: 60_000 });
  await show(page.getByTestId("theater-summary"), 400);
  await caption(page, "The contract refuses every one, and says why. Nothing was signed or spent.", 3200);

  const credential = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Verified Mandate" }) });
  await show(credential);
  await caption(page, "A vault that keeps its rules earns a soulbound Verified Mandate, with its image and status fully onchain.", 3400);

  // Make it yours.
  await show(page.getByRole("button", { name: "Copy this mandate" }));
  await caption(page, "Like what you see? Copy its rules, never its funds.", 1600);
  await page.getByRole("button", { name: "Copy this mandate" }).click();
  await page.waitForTimeout(1200);
  await caption(page, "The copied mandate lands in the simulator: target weights, bands and limits, ready to try.", 2600);

  const vault = page.locator('[data-tour="vault"]');
  await show(vault, 500);
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "NVDA up 15%" }).click();
    await page.waitForTimeout(450);
  }
  await caption(page, "NVDA rallies. The vault drifts out of its band, and the lamp turns red.", 2400);
  await show(page.getByLabel("Why this trade"), 600);
  await caption(page, "Before it trades, the pilot shows its math: where each asset is, its band, and where the trade takes it.", 3000);
  await page.getByRole("button", { name: "Run pilot", exact: true }).click();
  await show(vault, 300);
  await caption(page, "The pilot rebalances, inside the rules.", 1800);
  const attacks = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Try to break it" }) });
  await show(attacks, 400);
  await attacks.getByRole("button", { name: "Attempt" }).nth(1).click();
  await caption(page, "Try to break it yourself: every attack is blocked, with the vault's own error.", 2600);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.getByRole("tab", { name: "Backtest" }).click();
  await caption(page, "Backtest the mandate over 200 simulated markets, in the background, against buying and holding.", 1200);
  await page.locator(".card").filter({ hasText: "What the pilot did" }).waitFor({ timeout: 60_000 });
  await show(page.locator(".card").filter({ hasText: "StockPilot against buy and hold" }), 400);
  await page.waitForTimeout(2200);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Strategy card" }).click();
  await caption(page, "Share any strategy or vault as a card.", 2600);
  await page.getByRole("dialog", { name: "Share card" }).getByRole("button", { name: "Close" }).click();
  await caption(page, "Live on Robinhood Chain testnet: stockpilot-six-virid.vercel.app", 3200);
});

// The narrated demo, under three minutes: every part of StockPilot, in order, with a voice (scripts/narrate.py) and captions that follow it
// word by word. Read-only scenes run on the live chains; owner scenes sign real testnet transactions through a test
// wallet (OWNER_KEY). A scene whose data or control isn't there is skipped and logged, never faked, and its line is
// left out of the voice track. NARRATE_TARGET=local runs the same script against the local stack, for rehearsal.
//
//   python3 scripts/narrate.py --model DIR --lines e2e-web/narration.json --out media/narration
//   OWNER_KEY=0x… npx playwright test -c e2e-web/narrated-video.config.ts
//   python3 scripts/mix-narration.py …   (the Demo pilot workflow does all three with `narrated: true`)

import { readFileSync } from "node:fs";
import { test, type Locator, type Page } from "@playwright/test";
import type { Hex } from "viem";
import { Narrator } from "./narrator";
import { injectWallet } from "./test-wallet";

const LOCAL = process.env.NARRATE_TARGET === "local";
const MAIN = LOCAL ? 31337 : 46630;
const SECOND = LOCAL ? 31337 : 421614;
const file = (net: string) => JSON.parse(readFileSync(`${__dirname}/../deployments/${net}.json`, "utf8"));
const main = file(LOCAL ? "localhost" : "robinhoodTestnet");
const second = file(LOCAL ? "localhost" : "arbitrumSepolia");
const RPCS = LOCAL
  ? { 31337: "http://127.0.0.1:8545" }
  : { 46630: process.env.ROBINHOOD_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com/rpc", 421614: process.env.ARBITRUM_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc" };
// Hardhat's first dev key on the local chain; a funded testnet key (never a real one) on the live chains.
const rawKey = (process.env.OWNER_KEY || (LOCAL ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" : "")).trim();
const OWNER_KEY = (rawKey && !rawKey.startsWith("0x") ? `0x${rawKey}` : rawKey) as Hex;
const NARRATION = process.env.NARRATION_DIR ?? `${__dirname}/../media/narration`;
const TIMELINE = process.env.NARRATION_TIMELINE ?? `${__dirname}/test-results/narration-timeline.json`;

const shown: string[] = [];
const skipped: string[] = [];

/** One scene: shown if its data and controls are there, skipped (and logged) if not. */
async function scene(name: string, body: () => Promise<void>) {
  try {
    await body();
    shown.push(name);
  } catch (e) {
    skipped.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
  }
}

const card = (page: Page, heading: string | RegExp) => page.locator(".card").filter({ has: page.getByRole("heading", { name: heading }) }).first();

async function show(locator: Locator, pause = 700) {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await locator.page().waitForTimeout(pause);
}

async function top(page: Page) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(500);
}

/** Wait for the app's "<label>: done." notice after a transaction. */
const done = (page: Page, label: string | RegExp, timeout = 90_000) =>
  page.locator(".notice").filter({ hasText: typeof label === "string" ? `${label}: done.` : label }).first().waitFor({ timeout });

test("StockPilot, narrated", async ({ page }) => {
  test.setTimeout(900_000);
  if (!OWNER_KEY) console.log("No OWNER_KEY: the owner scenes will be skipped.");
  else await injectWallet(page, OWNER_KEY, RPCS, MAIN);

  await page.goto("/");
  await page.waitForTimeout(800);
  const n = new Narrator(page, NARRATION);
  await n.syncMark();
  const beat = (ms = 600) => page.waitForTimeout(ms);

  // ── The idea, and the strategist ─────────────────────────────────────────────────────────────────────────────
  await n.say("intro", async () => {
    await beat(2600);
    await show(page.locator(".aura-key").first(), 1200);
  });
  await scene("draft", () =>
    n.say("draft", async () => {
      await show(page.getByLabel("Your investing goal"), 300);
      await page.locator(".chips .chip").first().click();
      await page.getByRole("button", { name: "Draft my mandate" }).click();
      await page.getByRole("button", { name: "Start from what I own" }).click();
      const paste = page.getByLabel("Paste your holdings");
      await paste.fill("AAPL  $11,500\nVOO   $11,000\nNVDA  $4,000\nCash  $3,000");
      await page.getByRole("button", { name: "Read pasted holdings" }).click();
      const table = page.getByRole("table", { name: "How your holdings map" });
      await table.waitFor({ timeout: 20_000 });
      await show(table, 1400);
      await page.getByRole("button", { name: "Use as my draft" }).click();
      await show(card(page, /Review the mandate/), 600);
    }),
  );
  await scene("tune", () =>
    n.say("tune", async () => {
      const box = page.getByLabel("Adjust the mandate in your own words");
      await box.fill("less Tesla, more cash");
      await box.press("Enter");
      const slider = page.getByLabel("TSLA target weight");
      await show(slider, 200);
      await slider.focus();
      for (let i = 0; i < 3; i++) await slider.press("ArrowLeft");
      await page.getByRole("button", { name: "Strategy card" }).click();
      await page.getByRole("dialog", { name: "Share card" }).waitFor();
      await beat(1300);
      await page.getByRole("dialog", { name: "Share card" }).getByRole("button", { name: "Close" }).click();
    }),
  );

  // ── Simulator ────────────────────────────────────────────────────────────────────────────────────────────────
  await page.getByRole("tab", { name: "Simulator" }).click();
  const vault = page.locator('[data-tour="vault"]');
  await scene("simulate", () =>
    n.say("simulate", async () => {
      await vault.getByRole("button", { name: "Reset at targets" }).click();
      await show(vault, 300);
      for (let i = 0; i < 3; i++) {
        await page.getByRole("button", { name: "NVDA up 15%" }).click();
        await beat(450);
      }
      await show(page.getByLabel("Why this trade"), 1500);
      await page.getByRole("button", { name: "Run pilot", exact: true }).click();
      await show(vault, 600);
    }),
  );
  await scene("break", () =>
    n.say("break", async () => {
      const attacks = card(page, "Try to break it");
      await show(attacks, 200);
      const buttons = attacks.getByRole("button", { name: "Attempt" });
      for (const i of [0, 3, 5]) {
        await buttons.nth(i).click();
        await beat(650);
      }
      const guard = page.locator('[data-tour="guard"]');
      await show(guard, 200);
      await guard.getByRole("button", { name: "Arm the crash guard" }).click();
      await page.getByRole("button", { name: "Market crash" }).click();
      await page.getByRole("button", { name: "Run pilot", exact: true }).click();
      await show(vault, 900);
      await guard.getByRole("button", { name: "Back to normal targets" }).click();
      await show(page.locator('[data-tour="log"]'), 700);
    }),
  );

  // ── Backtest ─────────────────────────────────────────────────────────────────────────────────────────────────
  await top(page);
  await page.getByRole("tab", { name: "Backtest" }).click();
  await scene("backtest", () =>
    n.say("backtest", async () => {
      await page.locator(".card").filter({ hasText: "What the pilot did" }).first().waitFor({ timeout: 60_000 });
      await show(page.locator(".card").filter({ hasText: "StockPilot against buy and hold" }).first(), 900);
      await page.getByLabel("Glide path").selectOption({ label: "To 70% cash by the end" });
      const after = card(page, "After tax");
      await show(after, 200);
      await after.getByRole("button", { name: "Compare after tax" }).click();
      const stress = card(page, "Stress test before you sign");
      await show(stress, 300);
      for (const s of ["Long bear market", "Tech wreck", "Flash crash"]) {
        await stress.getByRole("button", { name: s }).click();
        await beat(700);
      }
    }),
  );

  // ── Live: the demo vault on the main chain ───────────────────────────────────────────────────────────────────
  await n.quiet();
  await page.goto(`/?chain=${MAIN}&vault=${main.demoVault}`);
  const next = page.getByText("Pilot's next move");
  await next.waitFor({ timeout: 60_000 });
  await n.say("live", async () => {
    await show(card(page, /^Vault 0x/), 2200);
    await show(next, 1200);
  });
  await scene("theater", async () => {
    const theater = card(page, "Attack Theater");
    await show(theater, 200);
    await n.say("theater", async () => {
      await theater.getByRole("button", { name: /Simulate a compromised pilot|Run the attacks again/ }).click();
      await page.getByTestId("theater-summary").waitFor({ timeout: 60_000 });
      await show(page.getByTestId("theater-summary"), 300);
    });
  });
  await scene("trust", () =>
    n.say("trust", async () => {
      await show(card(page, "Verified Mandate"), 2600);
      await show(card(page, "Letters from the pilot"), 1500);
    }),
  );
  await scene("reports", () =>
    n.say("reports", async () => {
      const ask = card(page, "Ask your vault");
      await show(card(page, "Weekly report"), 900);
      await show(ask, 200);
      await ask.getByRole("button", { name: "Why did the pilot last trade?" }).click();
      await beat(1400);
      await show(card(page, "Statements"), 800);
      await show(card(page, "Taxes"), 800);
      await show(card(page, "Tax-aware pilot"), 600);
    }),
  );
  await scene("activity", async () => {
    const reason = card(page, "Activity").getByTestId("trade-reason").first();
    await reason.waitFor({ timeout: 20_000 });
    await n.say("activity", () => show(reason, 400));
  });

  // ── The second chain ─────────────────────────────────────────────────────────────────────────────────────────
  if (SECOND !== MAIN) {
    await n.quiet();
    await scene("arbitrum", async () => {
      await page.goto(`/?chain=${SECOND}&vault=${second.demoVault}`);
      await page.getByText("Pilot's next move").waitFor({ timeout: 60_000 });
      await n.say("arbitrum", () => show(card(page, /^Vault 0x/), 600));
    });
  }

  // ── The demo fund, and the marketplace ───────────────────────────────────────────────────────────────────────
  await n.quiet();
  await scene("fund", async () => {
    await page.goto(`/?chain=${MAIN}&vault=${main.demoFundVault}`);
    const fund = card(page, /^Fund/);
    await fund.waitFor({ timeout: 60_000 });
    await n.say("fund", async () => {
      await show(fund, 2400);
      await show(page.getByTestId("holders-vote"), 1800);
      await show(card(page, "Pilot marketplace"), 600);
    });
  });

  // ── As an owner: real transactions on the testnet ────────────────────────────────────────────────────────────
  if (OWNER_KEY) {
    await n.quiet();
    await page.goto("/");
    await page.getByRole("tab", { name: "Live (testnet)" }).click();
    await page.getByLabel("Network").selectOption(String(MAIN));
    let created = false;
    await scene("owner", () =>
      n.say("owner", async () => {
        const connect = page.getByRole("button", { name: "Connect wallet" });
        await show(connect, 200);
        await connect.click();
        const create = card(page, /Create a vault/);
        await create.waitFor({ timeout: 30_000 });
        await show(create, 200);
        const house = page.getByRole("radio", { name: /StockPilot House Pilot/ });
        await ((await house.count()) ? house : page.getByRole("radio", { name: /Myself/ })).click();
        await page.getByRole("button", { name: "Cash only" }).click();
        await page.getByRole("button", { name: "Create and fund vault" }).click();
        await done(page, /Deposit USDG: done\./, 120_000);
        await next.waitFor({ timeout: 60_000 });
        await show(card(page, /^Vault 0x/), 300);
        created = true;
      }, 120),
    );
    if (created) {
      await scene("controls", () =>
        n.say("controls", async () => {
          await show(card(page, "Controls"), 900);
          await page.getByRole("button", { name: "Review drafted mandate" }).click();
          const diff = card(page, "Review the new mandate");
          await show(diff, 1100);
          await diff.getByRole("button", { name: "Cancel" }).click();
          for (const [title, open] of [
            ["Recurring investment", "Set up recurring investment"],
            ["Glide path", ""],
            ["Crash guard", "Arm the crash guard"],
            ["Inheritance", "Name an heir"],
            ["Alerts", ""],
          ]) {
            const c = card(page, title);
            await show(c, 150);
            if (open) await c.getByRole("button", { name: open }).click();
            await beat(450);
          }
        }),
      );
    }
  }

  // ── The whole network ────────────────────────────────────────────────────────────────────────────────────────
  await n.quiet();
  await page.goto(`/?view=network&chain=${MAIN}`);
  await scene("network", async () => {
    await page.getByTestId("net-total").waitFor({ timeout: 60_000 });
    await n.say("network", async () => {
      await show(card(page, /StockPilot onchain/), 1600);
      const sky = page.locator(".constellation");
      await show(sky, 300);
      await sky.locator("svg").hover();
      const orb = sky.locator("a.orb").first();
      if (await orb.count()) await orb.hover({ force: true });
      await beat(1800);
      await show(card(page, "Latest trades, every vault"), 600);
    });
  });
  await scene("codecheck", async () => {
    const summary = page.getByTestId("code-summary");
    await summary.waitFor({ timeout: 60_000 });
    const text = await summary.innerText();
    const [matched, total] = (text.match(/(\d+) of (\d+)/) ?? []).slice(1).map(Number);
    if (!total || matched !== total) throw new Error(`code check reads "${text}"`);
    await n.say("codecheck", () => show(card(page, "Code check"), 600));
  });
  await top(page);
  await n.say("outro");
  await n.quiet();
  await beat(500);

  n.save(TIMELINE);
  console.log(`Scenes shown: ${shown.join(", ")}`);
  if (skipped.length) console.log(`Scenes skipped:\n  ${skipped.join("\n  ")}`);
});

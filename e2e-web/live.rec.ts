// The demo video, recorded on the live site against the live chains: Robinhood Chain testnet and Arbitrum Sepolia, real
// stock prices, the hourly pilot's real trades. Nothing is staged; a scene whose data isn't there yet is skipped and
// logged, so the video only ever shows what the chain holds. Recorded by the Demo pilot workflow (`video: true`).

import { readFileSync } from "node:fs";
import { test, type Locator, type Page } from "@playwright/test";

const ROBINHOOD = 46630;
const ARBITRUM = 421614;
const deployment = (net: string) => JSON.parse(readFileSync(`${__dirname}/../deployments/${net}.json`, "utf8"));
const rh = deployment("robinhoodTestnet");
const arb = deployment("arbitrumSepolia");

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

const shown: string[] = [];
const skipped: string[] = [];

/** One scene: shown if its data is on the chain, skipped (and logged) if not. */
async function scene(name: string, body: () => Promise<void>) {
  try {
    await body();
    shown.push(name);
  } catch (e) {
    skipped.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
  }
}

const card = (page: Page, heading: string | RegExp) => page.locator(".card").filter({ has: page.getByRole("heading", { name: heading }) });

test("StockPilot, live", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(800);
  await caption(page, "StockPilot: an AI autopilot for tokenized stocks that can only trade inside the rules you sign.", 3200);
  await caption(page, "Everything in this video is live: Robinhood Chain testnet and Arbitrum Sepolia, real stock prices, real trades.", 3200);

  // The Robinhood demo vault, as a judge opens it: no wallet.
  await page.goto(`/?chain=${ROBINHOOD}&vault=${rh.demoVault}`);
  await page.getByText("Pilot's next move").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await caption(page, "A live vault on Robinhood Chain, read straight from the chain. No wallet needed.", 3000);
  await scene("mood lamp", async () => {
    await show(page.locator(".mood-lamp").first(), 600);
    await caption(page, "Its lamp shows how far it has drifted from the rules its owner signed.", 2400);
  });
  await scene("next move", async () => {
    await show(page.getByText("Pilot's next move"), 600);
    await caption(page, "The pilot checks it every hour against real market prices, and trades only when the rules allow.", 3000);
  });

  await scene("attack theater", async () => {
    const theater = card(page, "Attack Theater");
    await show(theater);
    await caption(page, "Suppose the pilot's key is stolen. Nine attacks, sent to the live contract from the pilot's own address.", 1200);
    await theater.getByRole("button", { name: "Simulate a compromised pilot" }).click();
    await page.getByTestId("theater-summary").waitFor({ timeout: 60_000 });
    await show(page.getByTestId("theater-summary"), 400);
    await caption(page, "The contract refuses every one, and says why. Nothing was signed or spent.", 3200);
  });

  await scene("verified mandate", async () => {
    const credential = card(page, "Verified Mandate");
    await credential.waitFor({ timeout: 15_000 });
    await show(credential);
    await caption(page, "A vault that keeps its rules earns a soulbound Verified Mandate, with its image and status fully onchain.", 3400);
  });

  await scene("letters", async () => {
    const letters = card(page, "Letters from the pilot");
    await letters.getByText("Dear owner,").first().waitFor({ timeout: 30_000 });
    await show(letters);
    await caption(page, "Once a day the pilot writes to the owner, published onchain and signed by the key that trades.", 3400);
  });

  // Arbitrum: the same contracts, the same pilot, and today's trades with their reasons.
  await page.goto(`/?chain=${ARBITRUM}&vault=${arb.demoVault}`);
  await page.getByText("Pilot's next move").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await caption(page, "The same contracts on Arbitrum Sepolia, flown by the same pilot.", 2600);
  await scene("trade with its reason", async () => {
    const activity = card(page, "Activity");
    const reason = activity.getByTestId("trade-reason").first();
    await reason.waitFor({ timeout: 45_000 });
    await show(reason, 600);
    await caption(page, "Today's trade, made at real market prices. Its reason is published onchain and matches the hash the trade recorded.", 4000);
  });

  // Pool it: a fund many people own.
  await scene("fund", async () => {
    await page.goto(`/?chain=${ROBINHOOD}&vault=${rh.demoFundVault}`);
    const fund = card(page, /^Fund/);
    await fund.waitFor({ timeout: 60_000 });
    await show(fund, 600);
    await caption(page, "Or pool it. A fund is a vault many people own: buy in at its value, leave any time with your exact share of every holding.", 3800);
    await caption(page, "Its rules can never change. Holders can vote to fire the pilot, and anyone can try it free: $100 of shares, no gas.", 3800);
  });

  // The whole network, and proof the deployed code is this code.
  await page.goto(`/?view=network&chain=${ROBINHOOD}`);
  await scene("network", async () => {
    await page.getByTestId("net-total").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    const sky = page.locator(".constellation");
    if (await sky.count()) {
      await show(sky, 600);
      await sky.locator("svg").hover();
      await caption(page, "The whole network as a constellation: each star a pilot, its vaults in orbit, sized by value.", 3400);
    } else {
      await caption(page, "The whole network on one page, read from the chain.", 3000);
    }
  });
  await scene("code check", async () => {
    const summary = page.getByTestId("code-summary");
    await summary.waitFor({ timeout: 60_000 });
    await show(summary, 800);
    await caption(page, `Is the deployed code this code? Checked in your browser, instruction for instruction: ${await summary.innerText()}.`, 3600);
  });

  await caption(page, "StockPilot. Live on Robinhood Chain and Arbitrum: stockpilot-six-virid.vercel.app", 3400);
  console.log(`Scenes shown: ${shown.join(", ")}`);
  if (skipped.length) console.log(`Scenes skipped:\n  ${skipped.join("\n  ")}`);
});

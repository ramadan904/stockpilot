import hre from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { parseUnits, type Abi, type Address } from "viem";
import { readVault, sendTrade } from "../agent/chain";
import { plan } from "../agent/planner";
import { DEFAULT_LIMITS, deployStockPilot } from "./fixture";

// Random sequences against one fund: purchases in every asset by several holders, redemptions, share transfers,
// donations, price moves, pilot trades, the fee accruing and prices going stale. After every step, nobody has taken
// value from anyone else: a purchase never lowers the value of existing shares, a redemption pays exactly a
// pro-rata slice in kind (never more), and the books (supply, votes, the fund holding nothing itself) add up.

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a/b >= c/d, allowing a relative shortfall of `tolerance` (the fee accrued over the second between two blocks). */
const atLeast = (a: bigint, b: bigint, c: bigint, d: bigint, tolerance = 1_000_000_000n) => a * d * (tolerance + 1n) >= c * b * tolerance;

describe("fund invariants", () => {
  for (const seed of [21, 22, 23]) {
    it(`nobody takes value from other holders over 150 random actions (seed ${seed})`, async () => {
      const f = await deployStockPilot();
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      const wallets = await hre.viem.getWalletClients();
      const holders = wallets.slice(3, 7);
      const donor = wallets[7];

      const factory = await hre.viem.deployContract("PilotFundFactory", [f.factory.address]);
      // A 1% fee to the stranger, so fees accrue throughout.
      const cfg = { pilot: f.pilot.account.address, adapter: f.mm.address, assets: f.mandate, limits: DEFAULT_LIMITS, feeRecipient: f.stranger.account.address, feeBps: 100 };
      await factory.write.createFund(["Fuzz Fund", "FUZZ", cfg]);
      const [fundAddress] = await factory.read.funds();
      const fund = await hre.viem.getContractAt("PilotFund", fundAddress);
      const vault = await hre.viem.getContractAt("PilotVault", await fund.read.vault());
      const as = (w: (typeof wallets)[number]) => hre.viem.getContractAt("PilotFund", fundAddress, { client: { wallet: w } });
      const tokens = [f.usdg, f.tsla, f.aapl, f.nvda];
      const feeds = [f.tslaFeed, f.aaplFeed, f.nvdaFeed];
      const token = (t: (typeof tokens)[number], w: (typeof wallets)[number]) => hre.viem.getContractAt("MockERC20", t.address, { client: { wallet: w } });
      const nav = async () => (await vault.read.portfolio())[1];
      const vaultBalances = () => Promise.all(tokens.map((t) => t.read.balanceOf([vault.address])));
      const refresh = async () => {
        for (const feed of feeds) await feed.write.setPrice([(await feed.read.latestRoundData())[1]]);
      };
      const counts: Record<string, number> = {};
      const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
      let stale = false;

      for (let step = 0; step < 150; step++) {
        const roll = rand();
        const supply = await fund.read.totalSupply();
        // Stale if any feed is older than the mandate allows (a market move refreshes the feed it moves).
        const now = BigInt(await time.latest()) + 1n;
        stale = (await Promise.all(feeds.map((fd) => fd.read.latestRoundData()))).some(([, , , updatedAt]) => updatedAt + BigInt(DEFAULT_LIMITS.maxPriceAge) < now);

        if (roll < 0.3 || supply === 0n) {
          // A purchase, in any asset, of $5 to $3,000.
          const who = pick(holders);
          const t = pick(tokens);
          const i = tokens.indexOf(t);
          const usd = 5 + Math.floor(rand() * 2_995);
          const price = [1, 250, 200, 125][i]; // listing prices; the feeds may have moved, which only changes the size
          const amount = parseUnits((usd / price).toFixed(6), await t.read.decimals());
          await t.write.mint([who.account.address, amount]);
          await (await token(t, who)).write.approve([fundAddress, amount]);
          if (stale) {
            await expect((await as(who)).write.buy([t.address, amount, 0n])).to.be.rejectedWith("StalePrice");
            count("refused-stale");
            continue;
          }
          await vault.write.collectFee();
          const [nav0, s0] = [await nav(), await fund.read.totalSupply()];
          const mine0 = await fund.read.balanceOf([who.account.address]);
          const ok = await (await as(who)).write.buy([t.address, amount, 0n]).then(
            () => true,
            (e: Error) => {
              expect(e.message).to.match(/PurchaseTooSmall|TooFewShares/); // dust is refused, never mispriced
              return false;
            },
          );
          if (!ok) {
            count("refused-dust");
            continue;
          }
          const [nav1, s1] = [await nav(), await fund.read.totalSupply()];
          if (s0 > 0n) expect(atLeast(nav1, s1, nav0, s0), "a purchase lowered the value per share").to.equal(true);
          // The buyer gets no more than they paid for: their shares are worth at most the value they added.
          const got = (await fund.read.balanceOf([who.account.address])) - mine0;
          // (Allowing the fee for the second between collecting it and the purchase: about a billionth of the value.)
          expect(got * nav1 <= (nav1 - nav0 + nav0 / 1_000_000_000n + 1n) * s1, "a buyer got more than they paid for").to.equal(true);
          count("buy");
        } else if (roll < 0.5) {
          // A redemption of part or all of a holding.
          const who = pick(holders);
          const mine = await fund.read.balanceOf([who.account.address]);
          if (mine === 0n) continue;
          const n = rand() < 0.3 ? mine : (mine * BigInt(1 + Math.floor(rand() * 99))) / 100n || mine;
          await vault.write.collectFee(); // the fee owed so far is every holder's cost; settle it before measuring
          const before = await vaultBalances();
          const got0 = await Promise.all(tokens.map((t) => t.read.balanceOf([who.account.address])));
          await (await as(who)).write.redeem([n, who.account.address]); // works stale or not
          const got1 = await Promise.all(tokens.map((t) => t.read.balanceOf([who.account.address])));
          for (let i = 0; i < tokens.length; i++) {
            const received = got1[i] - got0[i];
            // Never more than a pro-rata slice of what was there, and short of it by no more than the fee and rounding.
            expect(received * supply <= before[i] * n, "a redemption paid more than its share").to.equal(true);
            expect(received + 1n >= (before[i] * n) / supply - (before[i] * n) / supply / 1_000_000n, "a redemption was short-changed").to.equal(true);
          }
          count(n === mine ? "redeem-all" : "redeem-part");
        } else if (roll < 0.58) {
          // Shares change hands; votes follow them.
          const [a, b] = [pick(holders), pick(holders)];
          const mine = await fund.read.balanceOf([a.account.address]);
          if (mine === 0n || a === b) continue;
          await (await as(a)).write.transfer([b.account.address, mine / 2n]);
          count("transfer");
        } else if (roll < 0.63) {
          // A gift straight into the vault: every share gains.
          const t = pick(tokens);
          const amount = parseUnits(String(1 + Math.floor(rand() * 500)), await t.read.decimals()) / ([1n, 250n, 200n, 125n][tokens.indexOf(t)] ?? 1n);
          if (amount === 0n || supply === 0n) continue;
          await t.write.mint([donor.account.address, amount]);
          await (await token(t, donor)).write.approve([vault.address, amount]);
          await vault.write.collectFee();
          const [nav0, s0] = [await nav(), await fund.read.totalSupply()];
          await (await hre.viem.getContractAt("PilotVault", vault.address, { client: { wallet: donor } })).write.deposit([t.address, amount]);
          expect(atLeast(await nav(), await fund.read.totalSupply(), nav0, s0), "a gift lowered the value per share").to.equal(true);
          count("donation");
        } else if (roll < 0.75) {
          // The market moves up to 20% either way.
          const feed = pick(feeds);
          const [, answer] = await feed.read.latestRoundData();
          await feed.write.setPrice([(answer * BigInt(800 + Math.floor(rand() * 400))) / 1000n]);
          count("price");
        } else if (roll < 0.88) {
          // The pilot trades, if its planner wants to and the vault allows it.
          if (stale) continue;
          const p = plan(await readVault(f.publicClient as never, vault.abi as Abi, vault.address));
          if (p.action !== "trade") continue;
          const ok = await sendTrade(f.publicClient as never, f.pilot as never, vault.abi as Abi, vault.address, p.trade).then(
            () => true,
            () => false,
          );
          count(ok ? "trade" : "trade-refused");
        } else {
          // Time passes; the fee accrues. Sometimes the feeds keep up, sometimes they go stale.
          const goStale = rand() < 0.3;
          const wait = 60 + Math.floor(rand() * 3 * 86_400);
          await time.increase(goStale ? Math.max(wait, DEFAULT_LIMITS.maxPriceAge + 1) : wait);
          if (!goStale) await refresh();
          count(goStale ? "time-stale" : "time");
        }

        // The books, after every step.
        const all = await Promise.all(holders.map((h) => fund.read.balanceOf([h.account.address])));
        expect(all.reduce((s, x) => s + x, 0n)).to.equal(await fund.read.totalSupply());
        for (const h of holders) expect(await fund.read.getVotes([h.account.address])).to.equal(await fund.read.balanceOf([h.account.address]));
        for (const t of tokens) expect(await t.read.balanceOf([fundAddress])).to.equal(0n); // the fund never keeps money
        expect(await fund.read.balanceOf([fundAddress])).to.equal(0n);
      }
      console.log(`      seed ${seed}: ${JSON.stringify(counts)}`);
      expect(counts.buy ?? 0).to.be.greaterThan(10);
      expect((counts["redeem-all"] ?? 0) + (counts["redeem-part"] ?? 0)).to.be.greaterThan(5);
    });
  }
});

import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, parseUnits, toHex, zeroAddress, type Address } from "viem";
import { readVault, sendTrade } from "../agent/chain";
import { plan } from "../agent/planner";
import { DEFAULT_LIMITS, deployStockPilot, px } from "./fixture";

const YEAR = 365n * 86_400n;
const MAX_FEE_BPS = 200n;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("vault invariants", () => {
  it("a frozen token can never block withdrawals, pauses or the fee on other assets", async () => {
    const f = await loadFixture(deployStockPilot);
    const fusd = await hre.viem.deployContract("FreezableERC20");
    const feed = await hre.viem.deployContract("FixedPriceFeed", ["FUSD / USD", 8, px(1)]);
    const mandate = [{ token: fusd.address, feed: feed.address, targetBps: 2500, bandBps: 500 }, ...f.mandate.slice(1)];
    await f.vault.write.setMandate([mandate, DEFAULT_LIMITS]);
    await fusd.write.mint([f.vault.address, parseUnits("2500", 6)]);
    await f.vault.write.setFee([f.stranger.account.address, 200]);
    await time.increase(Number(YEAR) / 4);

    await fusd.write.setFrozen([f.vault.address, true]); // the issuer freezes the vault
    await f.vault.write.collectFee(); // does not revert; FUSD's fee is skipped
    expect(await fusd.read.balanceOf([f.stranger.account.address])).to.equal(0n);
    expect((await f.aapl.read.balanceOf([f.stranger.account.address])) > 0n).to.equal(true);

    await time.increase(86_400);
    await f.vault.write.pause();
    await f.vault.write.withdraw([f.aapl.address, parseUnits("100", 18), f.owner.account.address]); // clamps to balance
    expect(await f.aapl.read.balanceOf([f.vault.address])).to.equal(0n);
    await expect(f.vault.write.withdraw([fusd.address, 1n, f.owner.account.address])).to.be.rejectedWith("AccountFrozen");
  });

  for (const seed of [11, 12, 13]) {
    it(`holds every invariant over 150 random actions by owner, pilot and strangers (seed ${seed})`, async () => {
      const f = await loadFixture(deployStockPilot);
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      const tokens = [f.usdg, f.tsla, f.aapl, f.nvda];
      const feeds = [f.tslaFeed, f.aaplFeed, f.nvdaFeed];
      const pilotAddr = f.pilot.account.address;
      const recipient = f.stranger.account.address;
      const owner = f.owner.account.address;
      const asStranger = await hre.viem.getContractAt("PilotVault", f.vault.address, { client: { wallet: f.stranger } });

      const pilotStart = await Promise.all(tokens.map((t) => t.read.balanceOf([pilotAddr])));
      const maxSeen = await Promise.all(tokens.map((t) => t.read.balanceOf([f.vault.address])));
      const received = tokens.map(() => 0n);
      const startTime = BigInt(await time.latest());
      const counts: Record<string, number> = {};

      const refresh = async () => {
        for (const feed of feeds) await feed.write.setPrice([(await feed.read.latestRoundData())[1]]);
      };

      for (let step = 0; step < 150; step++) {
        const recipientBefore = await Promise.all(tokens.map((t) => t.read.balanceOf([recipient])));
        const eventsBefore = (await f.vault.getEvents.Rebalanced({}, { fromBlock: 0n })).length;
        const wasPaused = await f.vault.read.paused();
        const action = pick(["price", "time", "plannedTrade", "randomTrade", "deposit", "withdraw", "setFee", "pauseToggle", "collect", "pilotOverreach"] as const);
        counts[action] = (counts[action] ?? 0) + 1;

        try {
          switch (action) {
            case "price": {
              const feed = pick(feeds);
              const [, answer] = await feed.read.latestRoundData();
              await feed.write.setPrice([(answer * BigInt(Math.round((0.85 + rand() * 0.3) * 1000))) / 1000n]);
              break;
            }
            case "time":
              await time.increase(Math.floor(rand() * 2 * 86_400));
              await refresh();
              break;
            case "plannedTrade": {
              const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
              if (p.action === "trade") await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
              break;
            }
            case "randomTrade": {
              const a = pick(tokens);
              let b = pick(tokens);
              while (b === a) b = pick(tokens);
              const bal = await a.read.balanceOf([f.vault.address]);
              await f.vaultAsPilot.write.rebalance([a.address, b.address, (bal * BigInt(1 + Math.floor(rand() * 300))) / 1000n + 1n, 0n, "0x", keccak256(toHex("fuzz"))]);
              break;
            }
            case "deposit": {
              const t = pick(tokens);
              const amount = t === f.usdg ? parseUnits(String(1 + Math.floor(rand() * 1000)), 6) : parseUnits(String(1 + Math.floor(rand() * 5)), 18);
              await t.write.mint([owner, amount]);
              await t.write.approve([f.vault.address, amount]);
              await f.vault.write.deposit([t.address, amount]);
              break;
            }
            case "withdraw": {
              const t = pick(tokens);
              const bal = await t.read.balanceOf([f.vault.address]);
              await f.vault.write.withdraw([t.address, (bal * BigInt(Math.floor(rand() * 500))) / 1000n, owner]);
              break;
            }
            case "setFee":
              await f.vault.write.setFee(rand() < 0.2 ? [zeroAddress, 0] : [recipient, Math.floor(rand() * 201)]);
              break;
            case "pauseToggle":
              await (wasPaused ? f.vault.write.unpause() : pick([f.vault, f.vaultAsPilot]).write.pause());
              break;
            case "collect":
              await asStranger.write.collectFee();
              break;
            case "pilotOverreach": {
              const attempt = pick([
                () => f.vaultAsPilot.write.withdraw([f.usdg.address, 1n, pilotAddr]),
                () => f.vaultAsPilot.write.setFee([pilotAddr, 200]),
                () => f.vaultAsPilot.write.setAdapter([pilotAddr]),
                () => f.vaultAsPilot.write.setMandate([f.mandate, { ...DEFAULT_LIMITS, maxTradeUsd: 10n ** 30n }]),
                () => f.vaultAsPilot.write.unpause(),
              ]);
              await expect(attempt()).to.be.rejectedWith("OwnableUnauthorizedAccount");
              break;
            }
          }
        } catch (e) {
          // Pilot trades may be legitimately rejected by the mandate; anything else is a real failure.
          if (!["randomTrade", "plannedTrade"].includes(action)) throw e;
        }

        // Invariant: the pilot is never paid by the vault.
        const pilotNow = await Promise.all(tokens.map((t) => t.read.balanceOf([pilotAddr])));
        pilotNow.forEach((b, i) => expect(b, `step ${step} ${action}: pilot gained`).to.equal(pilotStart[i]));

        // Invariant: no trade while paused.
        const eventsAfter = (await f.vault.getEvents.Rebalanced({}, { fromBlock: 0n })).length;
        if (wasPaused) expect(eventsAfter, `step ${step}: traded while paused`).to.equal(eventsBefore);

        // Invariant: the budget never exceeds the daily limit.
        expect((await f.vault.read.tradeBudget()) <= DEFAULT_LIMITS.dailyLimitUsd).to.equal(true);

        // Invariant: total fees on any token never exceed 2% a year of the most the vault ever held of it.
        const now = BigInt(await time.latest());
        for (let i = 0; i < tokens.length; i++) {
          const bal = await tokens[i].read.balanceOf([f.vault.address]);
          if (bal > maxSeen[i]) maxSeen[i] = bal;
          received[i] += (await tokens[i].read.balanceOf([recipient])) - recipientBefore[i];
          const bound = (maxSeen[i] * MAX_FEE_BPS * (now - startTime)) / (10_000n * YEAR) + 1n;
          expect(received[i] <= bound, `step ${step}: fee on token ${i} over the cap`).to.equal(true);
        }
      }

      // Invariant: the owner can always get everything out, paused or not.
      if (!(await f.vault.read.paused())) await f.vault.write.pause();
      for (const t of tokens) {
        await f.vault.write.withdraw([t.address, 2n ** 255n, owner]);
        expect(await t.read.balanceOf([f.vault.address])).to.equal(0n);
      }
      expect(Object.keys(counts).length, JSON.stringify(counts)).to.be.at.least(9);
    });
  }
});

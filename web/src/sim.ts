// An in-browser vault. Trades go through the same check() the pilot uses before sending real transactions, and
// test/model.test.ts proves that check() agrees with the deployed contract trade for trade. So what you see here is
// what the chain would do.

import { keccak256, toHex, zeroAddress, type Address } from "viem";
import { LISTINGS } from "../../agent/listings";
import type { Mandate } from "../../agent/mandate";
import { BPS, WAD, amountFor, check, valueOf, type AssetState, type Trade, type VaultState, type Verdict } from "../../agent/model";

export interface Sim {
  assets: AssetState[];
  limits: Mandate["limits"];
  now: bigint;
  lastTradeAt: bigint;
  day: bigint;
  spentToday: bigint;
  paused: boolean;
  /** Venue fee in bps; raise it to simulate a bad fill. */
  feeBps: number;
  /** While closed, stock feeds stop updating and go stale. */
  marketClosed: boolean;
}

const fakeAddress = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address;

/** Fund a fresh vault at the mandate's targets. */
export function createSim(mandate: Mandate, usd: number): Sim {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const assets = LISTINGS.map((l, i) => {
    const price = BigInt(Math.round(l.price * 1e6)) * 10n ** 12n;
    const target = mandate.assets[i];
    const usdWad = (BigInt(Math.round(usd * 100)) * WAD * BigInt(target.targetBps)) / BPS / 100n;
    return {
      token: fakeAddress(i),
      symbol: l.symbol,
      decimals: l.decimals,
      balance: amountFor(usdWad, price, l.decimals),
      price,
      priceUpdatedAt: now,
      targetBps: target.targetBps,
      bandBps: target.bandBps,
    };
  });
  return { assets, limits: mandate.limits, now, lastTradeAt: 0n, day: now / 86_400n, spentToday: 0n, paused: false, feeBps: 10, marketClosed: false };
}

export function vaultState(sim: Sim): VaultState {
  const spent = sim.now / 86_400n === sim.day ? sim.spentToday : 0n;
  const cap = sim.limits.dailyLimitUsd;
  return {
    address: zeroAddress,
    assets: sim.assets,
    limits: sim.limits,
    lastTradeAt: sim.lastTradeAt,
    remainingToday: spent >= cap ? 0n : cap - spent,
    paused: sim.paused,
    now: sim.now,
  };
}

/** Move one asset's price by `factor` (1.1 = +10%). Stablecoins don't move. */
export function movePrice(sim: Sim, symbol: string, factor: number): Sim {
  return {
    ...sim,
    assets: sim.assets.map((a) =>
      a.symbol !== symbol || isStable(a.symbol)
        ? a
        : { ...a, price: (a.price * BigInt(Math.round(factor * 1e6))) / 1_000_000n, priceUpdatedAt: sim.now },
    ),
  };
}

/** A random trading day: each stock moves by up to ±`vol`. */
export function randomDay(sim: Sim, vol = 0.08): Sim {
  let next = advance(sim, 86_400);
  for (const a of next.assets) if (!isStable(a.symbol)) next = movePrice(next, a.symbol, 1 + (Math.random() * 2 - 1) * vol);
  return next;
}

/** Let time pass. Open markets keep their feeds fresh; closed ones go stale. */
export function advance(sim: Sim, seconds: number): Sim {
  const now = sim.now + BigInt(seconds);
  return {
    ...sim,
    now,
    assets: sim.assets.map((a) => (sim.marketClosed && !isStable(a.symbol) ? a : { ...a, priceUpdatedAt: now })),
  };
}

/** What the venue pays, mirroring OracleMarketMaker.quote. */
export function quote(sim: Sim, trade: Trade) {
  const sell = sim.assets.find((a) => a.token === trade.tokenIn)!;
  const buy = sim.assets.find((a) => a.token === trade.tokenOut)!;
  const valueIn = valueOf(trade.amountIn, sell.price, sell.decimals);
  return amountFor((valueIn * (BPS - BigInt(sim.feeBps))) / BPS, buy.price, buy.decimals);
}

/** Submit a trade to the simulated vault: it runs only if the vault's rules accept it. */
export function rebalance(sim: Sim, trade: Trade, minAmountOut = 0n): { sim: Sim; verdict: Verdict; amountOut: bigint } {
  const amountOut = quote(sim, trade);
  const verdict = check(vaultState(sim), trade, amountOut, minAmountOut);
  if (!verdict.ok) return { sim, verdict, amountOut };
  const today = sim.now / 86_400n;
  const spent = today === sim.day ? sim.spentToday : 0n;
  return {
    verdict,
    amountOut,
    sim: {
      ...sim,
      day: today,
      spentToday: spent + verdict.valueIn,
      lastTradeAt: sim.now,
      assets: sim.assets.map((a) =>
        a.token === trade.tokenIn
          ? { ...a, balance: a.balance - trade.amountIn }
          : a.token === trade.tokenOut
            ? { ...a, balance: a.balance + amountOut }
            : a,
      ),
    },
  };
}

export function isStable(symbol: string) {
  return LISTINGS.some((l) => l.symbol === symbol && "stable" in l);
}

export const hashOf = (text: string) => keccak256(toHex(text));

/** The listed assets with the simulator's stand-in addresses, for building a mandate to simulate. */
export function simUniverse() {
  return LISTINGS.map((l, i) => ({ ...l, token: fakeAddress(i), feed: fakeAddress(100 + i), stable: "stable" in l }));
}

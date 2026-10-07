// A planned trade, explained with the numbers the vault will judge it by: for each side, its target, the band the
// vault enforces, the pilot's own trigger inside it, the weight now and the weight after the trade at the expected fill.

import { BPS, WAD, totalValue, valueOf, weightWad, type VaultState } from "./model";
import { DEFAULT_PLANNER, type PlannedTrade } from "./planner";

export interface Leg {
  side: "sell" | "buy";
  symbol: string;
  targetBps: number;
  bandBps: number;
  /** The pilot starts trading once drift passes this (its trigger, inside the band). */
  triggerBps: number;
  beforeBps: number;
  afterBps: number;
  valueUsd: bigint;
}

export interface Explanation {
  sell: Leg;
  buy: Leg;
  /** One line per side, in plain words with the band arithmetic. */
  lines: [string, string];
}

const pts = (bps: number) => `${(Math.abs(bps) / 100).toFixed(1)}`;
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const usd = (wad: bigint) => `$${(Number(wad / 10n ** 16n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toBps = (w: bigint) => Number((w * BPS + WAD / 2n) / WAD);

export function explainTrade(state: VaultState, trade: Pick<PlannedTrade, "tokenIn" | "tokenOut" | "amountIn" | "expectedAmountOut">, triggerFraction = DEFAULT_PLANNER.triggerFraction): Explanation {
  const sell = state.assets.find((a) => a.token === trade.tokenIn)!;
  const buy = state.assets.find((a) => a.token === trade.tokenOut)!;
  const total = totalValue(state.assets);
  const valueIn = valueOf(trade.amountIn, sell.price, sell.decimals);
  const valueOut = valueOf(trade.expectedAmountOut, buy.price, buy.decimals);
  const totalAfter = total - valueIn + valueOut;
  const leg = (side: Leg["side"], a: typeof sell, delta: bigint, value: bigint): Leg => {
    const v = valueOf(a.balance, a.price, a.decimals);
    return {
      side,
      symbol: a.symbol,
      targetBps: a.targetBps,
      bandBps: a.bandBps,
      triggerBps: Math.floor(a.bandBps * triggerFraction),
      beforeBps: toBps(weightWad(v, total)),
      afterBps: toBps(weightWad(v + delta, totalAfter)),
      valueUsd: value,
    };
  };
  const s = leg("sell", sell, -valueIn, valueIn);
  const b = leg("buy", buy, valueOut, valueOut);
  const describe = (l: Leg) => {
    const drift = l.beforeBps - l.targetBps;
    const where = Math.abs(drift) > l.bandBps ? "outside" : Math.abs(drift) > l.triggerBps ? "past the pilot's trigger, inside" : "inside";
    const verb = l.side === "sell" ? `Selling ${usd(l.valueUsd)} of ${l.symbol}` : `Buying ${usd(l.valueUsd)} of ${l.symbol}`;
    return (
      `${verb}: it is ${pct(l.beforeBps)}, ${pts(drift)} points ${drift >= 0 ? "over" : "under"} its ${pct(l.targetBps)} target, ` +
      `${where} its ±${pts(l.bandBps)}-point band. After the trade: ${pct(l.afterBps)}, ${pts(l.afterBps - l.targetBps)} points from target.`
    );
  };
  return { sell: s, buy: b, lines: [describe(s), describe(b)] };
}

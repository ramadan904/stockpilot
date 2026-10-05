// An exact, integer-for-integer model of the checks PilotVault.rebalance runs, so the pilot can tell before sending a
// transaction whether the vault will accept it. test/model.test.ts runs random trades against both and requires
// them to agree.

export const BPS = 10_000n;
export const WAD = 10n ** 18n;

export type Address = `0x${string}`;

export interface AssetState {
  token: Address;
  symbol: string;
  decimals: number;
  balance: bigint;
  /** USD price, 18 decimals. */
  price: bigint;
  priceUpdatedAt: bigint;
  targetBps: number;
  bandBps: number;
}

export interface Limits {
  maxTradeUsd: bigint;
  dailyLimitUsd: bigint;
  maxSlippageBps: number;
  maxPriceAge: number;
  cooldown: number;
}

export interface VaultState {
  address: Address;
  assets: AssetState[];
  limits: Limits;
  lastTradeAt: bigint;
  /** USD volume the pilot can still trade today, 18 decimals. */
  remainingToday: bigint;
  paused: boolean;
  /** Chain time the state was read at. */
  now: bigint;
}

export interface Trade {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}

export type Verdict =
  | { ok: true; valueIn: bigint; valueOut: bigint }
  | { ok: false; reason: string; detail?: string };

export const mulDiv = (x: bigint, y: bigint, d: bigint) => (x * y) / d;
export const valueOf = (amount: bigint, price: bigint, decimals: number) => mulDiv(amount, price, 10n ** BigInt(decimals));
export const amountFor = (usd: bigint, price: bigint, decimals: number) => mulDiv(usd, 10n ** BigInt(decimals), price);
const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

export function totalValue(assets: AssetState[]) {
  return assets.reduce((sum, a) => sum + valueOf(a.balance, a.price, a.decimals), 0n);
}

/** Weight as an 18-decimal fraction. */
export function weightWad(value: bigint, total: bigint) {
  return total === 0n ? 0n : mulDiv(value, WAD, total);
}

/** Same rule as PilotVault._checkBand. */
export function bandAllows(asset: AssetState, wBefore: bigint, wAfter: bigint) {
  const target = (BigInt(asset.targetBps) * WAD) / BPS;
  const band = (BigInt(asset.bandBps) * WAD) / BPS;
  if (absDiff(wAfter, target) <= band) return true;
  return wBefore >= target ? wAfter <= wBefore && wAfter >= target : wAfter >= wBefore && wAfter <= target;
}

/**
 * Would the vault accept selling `trade.amountIn` of `tokenIn` if the venue pays `amountOut` of `tokenOut`?
 * Checks run in the contract's order, so the first failing reason matches the custom error it would revert with.
 */
export function check(state: VaultState, trade: Trade, amountOut: bigint, minAmountOut = 0n): Verdict {
  if (state.paused) return { ok: false, reason: "EnforcedPause" };
  if (trade.tokenIn === trade.tokenOut) return { ok: false, reason: "SameAsset" };
  if (trade.amountIn === 0n) return { ok: false, reason: "ZeroAmount" };
  const { limits } = state;
  if (state.lastTradeAt !== 0n && state.now < state.lastTradeAt + BigInt(limits.cooldown)) {
    return { ok: false, reason: "CooldownActive" };
  }
  for (const a of state.assets) {
    if (state.now - a.priceUpdatedAt > BigInt(limits.maxPriceAge)) return { ok: false, reason: "StalePrice", detail: a.symbol };
  }
  const sell = state.assets.find((a) => eq(a.token, trade.tokenIn));
  const buy = state.assets.find((a) => eq(a.token, trade.tokenOut));
  if (!sell) return { ok: false, reason: "AssetNotInMandate", detail: trade.tokenIn };
  if (!buy) return { ok: false, reason: "AssetNotInMandate", detail: trade.tokenOut };

  const totalBefore = totalValue(state.assets);
  const valueIn = valueOf(trade.amountIn, sell.price, sell.decimals);
  if (valueIn > limits.maxTradeUsd) return { ok: false, reason: "TradeTooLarge" };
  if (valueIn > state.remainingToday) return { ok: false, reason: "DailyLimitExceeded" };
  if (trade.amountIn > sell.balance) return { ok: false, reason: "InsufficientBalance" };
  if (amountOut < minAmountOut) return { ok: false, reason: "InsufficientOutput" };

  const valueOut = valueOf(amountOut, buy.price, buy.decimals);
  if (valueOut * BPS < valueIn * (BPS - BigInt(limits.maxSlippageBps))) return { ok: false, reason: "SlippageExceeded" };

  const sellBefore = valueOf(sell.balance, sell.price, sell.decimals);
  const buyBefore = valueOf(buy.balance, buy.price, buy.decimals);
  const sellAfter = valueOf(sell.balance - trade.amountIn, sell.price, sell.decimals);
  const buyAfter = valueOf(buy.balance + amountOut, buy.price, buy.decimals);
  const totalAfter = totalBefore + sellAfter + buyAfter - sellBefore - buyBefore;
  for (const [asset, before, after] of [
    [sell, sellBefore, sellAfter],
    [buy, buyBefore, buyAfter],
  ] as const) {
    if (!bandAllows(asset, weightWad(before, totalBefore), weightWad(after, totalAfter))) {
      return { ok: false, reason: "OutsideBand", detail: asset.symbol };
    }
  }
  return { ok: true, valueIn, valueOut };
}

export function eq(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

// Attack Theater: what a compromised pilot (or a stranger) would try against a live vault, as calls the real
// contract can be asked to judge without anyone signing or spending anything. Each attack is simulated with eth_call
// from the attacker's own address; the answer is the contract's own revert, read from the chain it lives on.

import { BaseError, ContractFunctionRevertedError, zeroAddress, type Address, type Hex } from "viem";
import type { AssetState } from "./model";
import { valueOf } from "./model";

/** An address nobody holds a key to, standing in for "someone else". */
export const STRANGER: Address = "0x000000000000000000000000000000000000bad0";
/** A token that is in no mandate. */
export const FOREIGN_TOKEN: Address = "0x000000000000000000000000000000000000bad1";
const NO_ROUTE: Hex = "0x";
const RATIONALE: Hex = `0x${"00".repeat(32)}`;

export interface LiveAttack {
  name: string;
  /** What the attacker is trying, in plain words. */
  desc: string;
  /** Who sends it: the vault's own pilot, or a stranger. */
  from: Address;
  as: "pilot" | "stranger";
  functionName: "rebalance" | "withdraw" | "setPilot" | "setAdapter" | "setFee" | "claimInheritance";
  args: readonly unknown[];
}

/** The attacks to stage against a vault, built from its live holdings. Trade attacks come from the pilot's address. */
export function liveAttacks(v: { assets: AssetState[]; pilot: Address; stableSymbol?: string }): LiveAttack[] {
  const pilot = v.pilot === zeroAddress ? STRANGER : v.pilot;
  const stable = v.assets.find((a) => a.symbol === (v.stableSymbol ?? "USDG")) ?? v.assets[0];
  const risky = v.assets.filter((a) => a !== stable);
  const byValue = [...risky].sort((a, b) => Number(valueOf(b.balance, b.price, b.decimals) - valueOf(a.balance, a.price, a.decimals)));
  const largest = byValue[0] ?? stable;
  const target = risky.find((a) => a.symbol === "TSLA") ?? byValue[byValue.length - 1] ?? largest;
  const some = (a: AssetState, num: bigint, den: bigint) => {
    const x = (a.balance * num) / den;
    return x > 0n ? x : 1n;
  };
  const trade = (tokenIn: Address, tokenOut: Address, amountIn: bigint) => [tokenIn, tokenOut, amountIn, 0n, NO_ROUTE, RATIONALE] as const;
  return [
    {
      name: `Pile into ${target.symbol}`,
      desc: `Sell 90% of the ${stable.symbol} for ${target.symbol}, the most volatile stock, and accept any price.`,
      from: pilot,
      as: "pilot",
      functionName: "rebalance",
      args: trade(stable.token, target.token, some(stable, 9n, 10n)),
    },
    {
      name: `Dump all of ${largest.symbol}`,
      desc: `Sell the vault's whole ${largest.symbol} position in one go.`,
      from: pilot,
      as: "pilot",
      functionName: "rebalance",
      args: trade(largest.token, stable.token, some(largest, 1n, 1n)),
    },
    {
      name: "Buy a token outside the mandate",
      desc: "Swap into a token the owner never approved, say the attacker's own.",
      from: pilot,
      as: "pilot",
      functionName: "rebalance",
      args: trade(stable.token, FOREIGN_TOKEN, some(stable, 1n, 100n)),
    },
    {
      name: "Withdraw to its own wallet",
      desc: `Send the vault's ${largest.symbol} to the pilot's address.`,
      from: pilot,
      as: "pilot",
      functionName: "withdraw",
      args: [largest.token, some(largest, 1n, 1n), pilot],
    },
    {
      name: "Hand the vault to another pilot",
      desc: "Name a new pilot the attacker controls.",
      from: pilot,
      as: "pilot",
      functionName: "setPilot",
      args: [STRANGER],
    },
    {
      name: "Route trades through its own venue",
      desc: "Point the vault at a trading venue the attacker runs, to fill trades at a bad price.",
      from: pilot,
      as: "pilot",
      functionName: "setAdapter",
      args: [STRANGER],
    },
    {
      name: "Pay itself a 20% fee",
      desc: "Set a management fee of 20% a year, paid to the pilot.",
      from: pilot,
      as: "pilot",
      functionName: "setFee",
      args: [pilot, 2000],
    },
    {
      name: "A stranger trades",
      desc: "Someone who is not the pilot tries to move the vault's money.",
      from: STRANGER,
      as: "stranger",
      functionName: "rebalance",
      args: trade(stable.token, target.token, some(stable, 1n, 100n)),
    },
    {
      name: "A stranger claims the vault",
      desc: "Someone who is not the heir claims ownership, as if the owner had gone silent.",
      from: STRANGER,
      as: "stranger",
      functionName: "claimInheritance",
      args: [],
    },
  ];
}

const WHY: Record<string, string> = {
  OwnableUnauthorizedAccount: "Only the owner can do this. The pilot's key can't, however it is used.",
  NotPilot: "Only the vault's named pilot may trade.",
  NotHeir: "Only the heir the owner named can claim, and only after the owner has been silent for the whole period.",
  OutsideBand: "The trade would push an asset outside the band the owner signed.",
  TradeTooLarge: "Bigger than the largest single trade the mandate allows.",
  DailyLimitExceeded: "More than the pilot may trade in 24 hours.",
  AssetNotInMandate: "That token isn't in the mandate, so the vault won't touch it.",
  StalePrice: "The oracle price is too old, so the vault won't trade on it at all (markets closed, or the price feed is behind).",
  InvalidPrice: "The oracle price is invalid, so the vault won't trade on it.",
  CooldownActive: "Too soon after the last trade.",
  EnforcedPause: "The vault is paused: nothing trades until the owner resumes it.",
  SlippageExceeded: "The fill was too far below the oracle price.",
  InsufficientOutput: "The venue returned less than the minimum.",
  NoAdapter: "The vault has no trading venue set.",
  ZeroAmount: "Nothing to trade.",
  SameAsset: "Selling an asset for itself.",
};

/** The contract's refusal in plain words; unknown errors are still a refusal. */
export function explainRevert(errorName: string | undefined): string {
  return (errorName && WHY[errorName]) ?? "Refused by the contract.";
}

/**
 * The name of the error a call reverted with, or null if it did not revert with one. Nodes return the revert data,
 * which decodes against the vault's ABI; some development nodes only describe it in the message.
 */
export function revertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return r.data.errorName;
  }
  const text = [e instanceof BaseError ? e.details : "", (e as Error)?.message ?? "", String((e as { cause?: unknown })?.cause ?? "")].join(" ");
  return text.match(/custom error '(\w+)\(/)?.[1] ?? text.match(/reverted with reason string '([^']+)'/)?.[1] ?? null;
}


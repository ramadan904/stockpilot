// Tax lots for a vault, from its onchain history: what was acquired when and for how much, what was sold, and the
// realized gain on each sale, lot by lot (first in, first out), split into short and long term the way a broker's
// 1099-B and Form 8949 do. Exact integer arithmetic: USD with 18 decimals, token amounts in base units.
//
// Not tax advice. Assumptions are stated in `ASSUMPTIONS` and shown wherever the report is.

import { parseAbiItem, type Address, type Hash, type PublicClient, type Abi } from "viem";
import { WAD } from "./model";

export const ASSUMPTIONS = [
  "Lots are matched first in, first out (FIFO), per vault.",
  "A trade sells one asset and buys another at the value received, priced by the vault's oracles at the time.",
  "Stocks deposited into the vault are given a cost basis equal to their market value on deposit; if you know what you originally paid, use that instead.",
  "Withdrawals move your own assets and are not sales; their lots leave the vault with their basis.",
  "The management fee, paid in kind, is treated as a sale at market value plus an investment expense.",
  "Holding periods over one year are long term. Stablecoins are treated as cash.",
];

export const YEAR_SECONDS = 365 * 86_400;

export type TaxEvent =
  | { kind: "deposit"; time: number; tx: Hash; token: Address; amount: bigint; priceUsd: bigint | null }
  | { kind: "withdraw"; time: number; tx: Hash; token: Address; amount: bigint }
  | { kind: "trade"; time: number; tx: Hash; tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint; valueInUsd: bigint; valueOutUsd: bigint }
  | { kind: "fee"; time: number; tx: Hash; token: Address; amount: bigint; priceUsd: bigint | null };

export interface AssetInfo {
  symbol: string;
  decimals: number;
  /** Stablecoins are cash: no lots, no gains. */
  cash: boolean;
}

export interface Lot {
  token: Address;
  amount: bigint;
  basisUsd: bigint;
  acquired: number;
  /** False when the basis had to be assumed (no price available at deposit). */
  basisKnown: boolean;
}

export interface Sale {
  token: Address;
  symbol: string;
  amount: bigint;
  acquired: number;
  sold: number;
  proceedsUsd: bigint;
  basisUsd: bigint;
  gainUsd: bigint;
  term: "short" | "long";
  /** "trade" or "fee" (the fee paid in kind). */
  via: "trade" | "fee";
  basisKnown: boolean;
  tx: Hash;
}

export interface YearSummary {
  year: number;
  shortTermUsd: bigint;
  longTermUsd: bigint;
  proceedsUsd: bigint;
  feesUsd: bigint;
  sales: number;
}

export interface TaxReport {
  sales: Sale[];
  open: Lot[];
  years: YearSummary[];
  /** Lots that left with a withdrawal, with their basis, so the owner can carry it on. */
  withdrawn: (Lot & { withdrawnAt: number; tx: Hash })[];
  warnings: string[];
}

const key = (a: string) => a.toLowerCase();

/** Consume `amount` of `token` from the front of its lots. Returns the pieces taken, each with its share of basis. */
function take(lots: Lot[], amount: bigint): { pieces: Lot[]; short: bigint } {
  const pieces: Lot[] = [];
  let left = amount;
  while (left > 0n && lots.length) {
    const lot = lots[0];
    if (lot.amount <= left) {
      pieces.push(lot);
      left -= lot.amount;
      lots.shift();
    } else {
      const basis = (lot.basisUsd * left) / lot.amount;
      pieces.push({ ...lot, amount: left, basisUsd: basis });
      lot.amount -= left;
      lot.basisUsd -= basis;
      left = 0n;
    }
  }
  return { pieces, short: left };
}

/** Split `total` across pieces in proportion to their amounts; the last piece takes the rounding remainder. */
function split(total: bigint, pieces: Lot[], amount: bigint) {
  let given = 0n;
  return pieces.map((p, i) => {
    const share = i === pieces.length - 1 ? total - given : (total * p.amount) / amount;
    given += share;
    return share;
  });
}

const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();

/** The report for one vault. `events` in chain order. */
export function taxReport(events: TaxEvent[], assets: Map<string, AssetInfo>): TaxReport {
  const lots = new Map<string, Lot[]>();
  const sales: Sale[] = [];
  const withdrawn: TaxReport["withdrawn"] = [];
  const warnings = new Set<string>();
  const fees = new Map<number, bigint>();
  const info = (t: Address) => assets.get(key(t)) ?? { symbol: `${t.slice(0, 6)}…`, decimals: 18, cash: false };
  const lotsOf = (t: Address) => {
    if (!lots.has(key(t))) lots.set(key(t), []);
    return lots.get(key(t))!;
  };

  const acquire = (token: Address, amount: bigint, basisUsd: bigint, time: number, basisKnown: boolean) => {
    if (info(token).cash || amount === 0n) return;
    lotsOf(token).push({ token, amount, basisUsd, acquired: time, basisKnown });
  };

  const dispose = (token: Address, amount: bigint, proceedsUsd: bigint, time: number, via: Sale["via"], tx: Hash) => {
    const a = info(token);
    if (a.cash || amount === 0n) return;
    const { pieces, short } = take(lotsOf(token), amount);
    if (short > 0n) {
      // More sold than the history explains (tokens sent in by plain transfer): treat the rest as zero-basis.
      warnings.add(`${a.symbol}: some units sold had no recorded acquisition (sent in by plain transfer?); their basis is taken as zero.`);
      pieces.push({ token, amount: short, basisUsd: 0n, acquired: time, basisKnown: false });
    }
    const proceeds = split(proceedsUsd, pieces, amount);
    pieces.forEach((p, i) => {
      sales.push({
        token,
        symbol: a.symbol,
        amount: p.amount,
        acquired: p.acquired,
        sold: time,
        proceedsUsd: proceeds[i],
        basisUsd: p.basisUsd,
        gainUsd: proceeds[i] - p.basisUsd,
        term: time - p.acquired > YEAR_SECONDS ? "long" : "short",
        via,
        basisKnown: p.basisKnown,
        tx,
      });
    });
  };

  for (const e of events) {
    switch (e.kind) {
      case "deposit": {
        const a = info(e.token);
        if (e.priceUsd === null && !a.cash) warnings.add(`${a.symbol}: no price at a deposit; its basis is taken as zero until you enter it.`);
        acquire(e.token, e.amount, e.priceUsd === null ? 0n : (e.amount * e.priceUsd) / 10n ** BigInt(a.decimals), e.time, e.priceUsd !== null);
        break;
      }
      case "trade":
        dispose(e.tokenIn, e.amountIn, e.valueOutUsd, e.time, "trade", e.tx);
        acquire(e.tokenOut, e.amountOut, e.valueOutUsd, e.time, true);
        break;
      case "fee": {
        const a = info(e.token);
        const value = e.priceUsd === null ? 0n : (e.amount * e.priceUsd) / 10n ** BigInt(a.decimals);
        fees.set(yearOf(e.time), (fees.get(yearOf(e.time)) ?? 0n) + value);
        dispose(e.token, e.amount, value, e.time, "fee", e.tx);
        break;
      }
      case "withdraw": {
        if (info(e.token).cash) break;
        const { pieces } = take(lotsOf(e.token), e.amount);
        for (const p of pieces) withdrawn.push({ ...p, withdrawnAt: e.time, tx: e.tx });
        break;
      }
    }
  }

  const byYear = new Map<number, YearSummary>();
  const year = (y: number) => {
    if (!byYear.has(y)) byYear.set(y, { year: y, shortTermUsd: 0n, longTermUsd: 0n, proceedsUsd: 0n, feesUsd: 0n, sales: 0 });
    return byYear.get(y)!;
  };
  for (const s of sales) {
    const y = year(yearOf(s.sold));
    if (s.term === "long") y.longTermUsd += s.gainUsd;
    else y.shortTermUsd += s.gainUsd;
    y.proceedsUsd += s.proceedsUsd;
    y.sales++;
  }
  for (const [y, v] of fees) year(y).feesUsd += v;

  return {
    sales,
    open: [...lots.values()].flat(),
    years: [...byYear.values()].sort((a, b) => a.year - b.year),
    withdrawn,
    warnings: [...warnings],
  };
}

/** Open lots now worth less than their basis: candidates for tax-loss harvesting. */
export function harvestable(open: Lot[], priceOf: (token: Address) => bigint | undefined, assets: Map<string, AssetInfo>, minLossUsd = WAD) {
  return open
    .map((l) => {
      const price = priceOf(l.token);
      const a = assets.get(key(l.token));
      if (price === undefined || !a) return null;
      const value = (l.amount * price) / 10n ** BigInt(a.decimals);
      return { ...l, symbol: a.symbol, valueUsd: value, lossUsd: l.basisUsd - value };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && x.basisKnown && x.lossUsd >= minLossUsd)
    .sort((a, b) => (b.lossUsd > a.lossUsd ? 1 : -1));
}

// ---------------------------------------------------------------------------------------------------------------
// Export

const usd = (wad: bigint) => {
  const neg = wad < 0n;
  const cents = ((neg ? -wad : wad) + 5n * 10n ** 15n) / 10n ** 16n;
  return `${neg ? "-" : ""}${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};
const units = (amount: bigint, decimals: number) => {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Form 8949-style rows: one per lot sold, in the year given (or all years). */
export function salesCsv(report: TaxReport, assets: Map<string, AssetInfo>, year?: number) {
  const header = ["Description", "Date acquired", "Date sold", "Proceeds (USD)", "Cost basis (USD)", "Gain or loss (USD)", "Term", "Basis source", "Transaction"];
  const rows = report.sales
    .filter((s) => year === undefined || yearOf(s.sold) === year)
    .map((s) => [
      `${units(s.amount, assets.get(key(s.token))?.decimals ?? 18)} ${s.symbol}${s.via === "fee" ? " (management fee paid in kind)" : ""}`,
      day(s.acquired),
      day(s.sold),
      usd(s.proceedsUsd),
      usd(s.basisUsd),
      usd(s.gainUsd),
      s.term === "long" ? "Long term" : "Short term",
      s.basisKnown ? "Onchain" : "Assumed zero; enter your basis",
      s.tx,
    ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export { usd as formatUsdExact, units as formatUnitsExact };

// ---------------------------------------------------------------------------------------------------------------
// Reading the chain

type Reader = Pick<PublicClient, "getLogs" | "getBlock" | "readContract">;

const EVENTS = {
  deposited: parseAbiItem("event Deposited(address indexed from, address indexed token, uint256 amount)"),
  withdrawn: parseAbiItem("event Withdrawn(address indexed to, address indexed token, uint256 amount)"),
  rebalanced: parseAbiItem(
    "event Rebalanced(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 valueInUsd, uint256 valueOutUsd, bytes32 indexed rationale)",
  ),
  fee: parseAbiItem("event FeeCollected(address indexed recipient, address indexed token, uint256 amount)"),
};

/** Every taxable or basis-moving event of a vault, in chain order, with block times and prices where needed. */
export async function readTaxEvents(client: Reader, vaultAbi: Abi, vault: Address, fromBlock = 0n): Promise<TaxEvent[]> {
  const [deps, wds, trades, fees] = await Promise.all([
    client.getLogs({ address: vault, event: EVENTS.deposited, fromBlock }),
    client.getLogs({ address: vault, event: EVENTS.withdrawn, fromBlock }),
    client.getLogs({ address: vault, event: EVENTS.rebalanced, fromBlock }),
    client.getLogs({ address: vault, event: EVENTS.fee, fromBlock }),
  ]);
  const all = [...deps, ...wds, ...trades, ...fees].sort((a, b) =>
    a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1,
  );
  const blocks = [...new Set(all.map((l) => l.blockNumber!))];
  const times = new Map(await Promise.all(blocks.map(async (b) => [b, Number((await client.getBlock({ blockNumber: b })).timestamp)] as const)));

  // Prices at a block, from the vault's own portfolio view (the same oracles the vault trades on).
  type Holding = { token: Address; priceUsd: bigint };
  const pricesAt = new Map<bigint, Promise<Map<string, bigint> | null>>();
  const priceAt = (block: bigint, token: Address) => {
    if (!pricesAt.has(block))
      pricesAt.set(
        block,
        (client.readContract({ address: vault, abi: vaultAbi, functionName: "portfolio", blockNumber: block }) as Promise<readonly [Holding[], bigint]>)
          .then(([h]) => new Map(h.map((x) => [key(x.token), x.priceUsd])))
          .catch(() => null),
      );
    return pricesAt.get(block)!.then((m) => m?.get(key(token)) ?? null);
  };

  const out: TaxEvent[] = [];
  for (const l of all) {
    const time = times.get(l.blockNumber!)!;
    const tx = l.transactionHash!;
    const a = l.args as Record<string, unknown>;
    switch (l.eventName) {
      case "Deposited":
        out.push({ kind: "deposit", time, tx, token: a.token as Address, amount: a.amount as bigint, priceUsd: await priceAt(l.blockNumber!, a.token as Address) });
        break;
      case "Withdrawn":
        out.push({ kind: "withdraw", time, tx, token: a.token as Address, amount: a.amount as bigint });
        break;
      case "Rebalanced":
        out.push({
          kind: "trade",
          time,
          tx,
          tokenIn: a.tokenIn as Address,
          tokenOut: a.tokenOut as Address,
          amountIn: a.amountIn as bigint,
          amountOut: a.amountOut as bigint,
          valueInUsd: a.valueInUsd as bigint,
          valueOutUsd: a.valueOutUsd as bigint,
        });
        break;
      case "FeeCollected":
        out.push({ kind: "fee", time, tx, token: a.token as Address, amount: a.amount as bigint, priceUsd: await priceAt(l.blockNumber!, a.token as Address) });
        break;
    }
  }
  return out;
}

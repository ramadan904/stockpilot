// A broker-style statement for one period, built entirely from the chain: opening and closing value, money in and
// out, fees, what markets and trading did, closing holdings, every event, and realized gains. Every figure names the
// block it was read at, so anyone can check it with an explorer.

import { parseAbiItem, type Abi, type Address, type Hash, type PublicClient } from "viem";
import { taxReport, type AssetInfo, type TaxEvent } from "./tax";

type Reader = Pick<PublicClient, "getLogs" | "getBlock" | "getBlockNumber" | "readContract">;
type Holding = { token: Address; balance: bigint; priceUsd: bigint; valueUsd: bigint; weightBps: bigint; targetBps: number };

export interface StatementLine {
  time: number;
  tx: Hash;
  kind: "deposit" | "withdrawal" | "trade" | "fee";
  text: string;
  /** USD value at the time (18 decimals). */
  valueUsd: bigint;
}

export interface Statement {
  from: { block: bigint; time: number };
  to: { block: bigint; time: number };
  openingUsd: bigint;
  closingUsd: bigint;
  depositsUsd: bigint;
  withdrawalsUsd: bigint;
  feesUsd: bigint;
  /** What prices and trading did, before fees: so opening + deposits - withdrawals - fees + this = closing. */
  marketAndTradingUsd: bigint;
  holdings: { symbol: string; balance: bigint; decimals: number; priceUsd: bigint; valueUsd: bigint; weightBps: number; targetBps: number }[];
  lines: StatementLine[];
  trades: number;
  realized: { shortTermUsd: bigint; longTermUsd: bigint };
}

/** The last block at or before `time` (binary search over block timestamps). */
export async function blockAt(client: Pick<PublicClient, "getBlock" | "getBlockNumber">, time: number): Promise<{ block: bigint; time: number }> {
  // The latest block itself, not getBlockNumber(): viem caches that for a few seconds in the browser, and a stale head
  // would cut off the newest blocks.
  const head = (await client.getBlock({ blockTag: "latest" })).number;
  const ts = async (b: bigint) => Number((await client.getBlock({ blockNumber: b })).timestamp);
  if ((await ts(0n)) > time) return { block: 0n, time: await ts(0n) };
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await ts(mid)) <= time) lo = mid;
    else hi = mid - 1n;
  }
  return { block: lo, time: await ts(lo) };
}

const EV = {
  deposited: parseAbiItem("event Deposited(address indexed from, address indexed token, uint256 amount)"),
  withdrawn: parseAbiItem("event Withdrawn(address indexed to, address indexed token, uint256 amount)"),
  rebalanced: parseAbiItem(
    "event Rebalanced(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 valueInUsd, uint256 valueOutUsd, bytes32 indexed rationale)",
  ),
  fee: parseAbiItem("event FeeCollected(address indexed recipient, address indexed token, uint256 amount)"),
};

/**
 * The statement for (fromTime, toTime]. `assets` maps lower-case token addresses to symbol and decimals; `taxEvents` is
 * the vault's whole history (agent/tax.ts readTaxEvents), so lots opened before the period are matched correctly.
 */
export async function buildStatement(
  client: Reader,
  vaultAbi: Abi,
  vault: Address,
  assets: Map<string, AssetInfo>,
  fromTime: number,
  toTime: number,
  taxEvents: TaxEvent[],
): Promise<Statement> {
  const [from, to] = await Promise.all([blockAt(client, fromTime), blockAt(client, toTime)]);
  const portfolioAt = (block: bigint) =>
    (client.readContract({ address: vault, abi: vaultAbi, functionName: "portfolio", blockNumber: block }) as Promise<readonly [Holding[], bigint]>).catch(
      () => [[], 0n] as const,
    );
  const [[, opening], [closingHoldings, closing]] = await Promise.all([portfolioAt(from.block), portfolioAt(to.block)]);

  const range = { address: vault, fromBlock: from.block + 1n, toBlock: to.block };
  const [deps, wds, trades, fees] = to.block > from.block
    ? await Promise.all([client.getLogs({ ...range, event: EV.deposited }), client.getLogs({ ...range, event: EV.withdrawn }), client.getLogs({ ...range, event: EV.rebalanced }), client.getLogs({ ...range, event: EV.fee })])
    : [[], [], [], []];

  const info = (t: Address) => assets.get(t.toLowerCase()) ?? { symbol: `${t.slice(0, 6)}…`, decimals: 18, cash: false };
  const prices = new Map<bigint, Promise<Map<string, bigint>>>();
  const priceAt = (block: bigint, token: Address) => {
    if (!prices.has(block)) prices.set(block, portfolioAt(block).then(([h]) => new Map(h.map((x) => [x.token.toLowerCase(), x.priceUsd]))));
    return prices.get(block)!.then((m) => m.get(token.toLowerCase()) ?? 0n);
  };
  const worth = async (block: bigint, token: Address, amount: bigint) => (amount * (await priceAt(block, token))) / 10n ** BigInt(info(token).decimals);
  const units = (token: Address, amount: bigint) => {
    const d = info(token).decimals;
    const n = Number(amount) / 10 ** d;
    return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 })} ${info(token).symbol}`;
  };
  const blockTimes = new Map<bigint, Promise<number>>();
  const timeOf = (b: bigint) => {
    if (!blockTimes.has(b)) blockTimes.set(b, client.getBlock({ blockNumber: b }).then((x) => Number(x.timestamp)));
    return blockTimes.get(b)!;
  };

  const lines: StatementLine[] = [];
  let depositsUsd = 0n;
  let withdrawalsUsd = 0n;
  let feesUsd = 0n;
  for (const l of deps) {
    const v = await worth(l.blockNumber!, l.args.token!, l.args.amount!);
    depositsUsd += v;
    lines.push({ time: await timeOf(l.blockNumber!), tx: l.transactionHash!, kind: "deposit", text: `Deposit of ${units(l.args.token!, l.args.amount!)}`, valueUsd: v });
  }
  for (const l of wds) {
    const v = await worth(l.blockNumber!, l.args.token!, l.args.amount!);
    withdrawalsUsd += v;
    lines.push({ time: await timeOf(l.blockNumber!), tx: l.transactionHash!, kind: "withdrawal", text: `Withdrawal of ${units(l.args.token!, l.args.amount!)}`, valueUsd: v });
  }
  for (const l of fees) {
    const v = await worth(l.blockNumber!, l.args.token!, l.args.amount!);
    feesUsd += v;
    lines.push({ time: await timeOf(l.blockNumber!), tx: l.transactionHash!, kind: "fee", text: `Management fee: ${units(l.args.token!, l.args.amount!)}`, valueUsd: v });
  }
  for (const l of trades) {
    lines.push({
      time: await timeOf(l.blockNumber!),
      tx: l.transactionHash!,
      kind: "trade",
      text: `Sold ${units(l.args.tokenIn!, l.args.amountIn!)} for ${units(l.args.tokenOut!, l.args.amountOut!)} (reason hash ${l.args.rationale!.slice(0, 10)}…)`,
      valueUsd: l.args.valueInUsd!,
    });
  }
  lines.sort((a, b) => a.time - b.time);

  // Realized gains on sales inside the period, with lots matched over the whole history.
  const realized = { shortTermUsd: 0n, longTermUsd: 0n };
  for (const s of taxReport(taxEvents, assets).sales) {
    if (s.sold <= from.time || s.sold > to.time) continue;
    if (s.term === "long") realized.longTermUsd += s.gainUsd;
    else realized.shortTermUsd += s.gainUsd;
  }

  return {
    from,
    to,
    openingUsd: opening,
    closingUsd: closing,
    depositsUsd,
    withdrawalsUsd,
    feesUsd,
    marketAndTradingUsd: closing - opening - depositsUsd + withdrawalsUsd + feesUsd,
    holdings: closingHoldings.map((h) => ({
      symbol: info(h.token).symbol,
      balance: h.balance,
      decimals: info(h.token).decimals,
      priceUsd: h.priceUsd,
      valueUsd: h.valueUsd,
      weightBps: Number(h.weightBps),
      targetBps: Number(h.targetBps),
    })),
    lines,
    trades: trades.length,
    realized,
  };
}

/** Calendar months (UTC) from `firstTime` to `nowTime`, newest first, as [start, end] unix seconds. */
export function monthsBetween(firstTime: number, nowTime: number): { label: string; start: number; end: number }[] {
  const out: { label: string; start: number; end: number }[] = [];
  const d = new Date(firstTime * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (;;) {
    const start = Date.UTC(y, m, 1) / 1000;
    if (start > nowTime) break;
    const end = Date.UTC(y, m + 1, 1) / 1000;
    out.push({ label: new Date(start * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }), start, end: Math.min(end, nowTime) });
    m++;
    if (m === 12) [y, m] = [y + 1, 0];
  }
  return out.reverse();
}

// How has a live vault done, and what did the pilot add? Read from the chain at sampled blocks: the vault's actual
// value, and the value of "your deposits, never traded", i.e. the same deposits and withdrawals in the same token units
// with no trades and no fee, at the same oracle prices. The gap between the two is what the pilot (and its fee) added
// or cost, and money moving in or out cannot distort it.

import { parseAbiItem, type Abi, type Address, type PublicClient } from "viem";

export interface PerformancePoint {
  block: bigint;
  time: number;
  /** The vault's value at the block's oracle prices (18 decimals). */
  valueUsd: bigint;
  /** Deposits minus withdrawals up to the block, in token units, never traded, at the same prices. */
  untradedUsd: bigint;
  /** Deposits minus withdrawals up to the block, each valued when it happened. */
  netDepositedUsd: bigint;
}

type Reader = Pick<PublicClient, "getLogs" | "getBlock" | "getBlockNumber" | "readContract">;
type Holding = { token: Address; priceUsd: bigint; valueUsd: bigint };

const deposited = parseAbiItem("event Deposited(address indexed from, address indexed token, uint256 amount)");
const withdrawn = parseAbiItem("event Withdrawn(address indexed to, address indexed token, uint256 amount)");

/** Evenly spaced blocks from `from` to `to`, both included, at most `n` of them. */
export function sampleBlocks(from: bigint, to: bigint, n: number): bigint[] {
  if (to <= from || n < 2) return [to];
  const span = to - from;
  const out = new Set<bigint>();
  for (let i = 0; i < n; i++) out.add(from + (span * BigInt(i)) / BigInt(n - 1));
  return [...out];
}

/** Points for a chart, oldest first. `decimals` maps lower-case token addresses to their decimals. */
export async function vaultPerformance(client: Reader, vaultAbi: Abi, vault: Address, decimals: Map<string, number>, samples = 30, fromBlock = 0n): Promise<PerformancePoint[]> {
  const [deps, wds, head] = await Promise.all([
    client.getLogs({ address: vault, event: deposited, fromBlock }),
    client.getLogs({ address: vault, event: withdrawn, fromBlock }),
    client.getBlockNumber(),
  ]);
  type Flow = { block: bigint; index: number; token: string; signed: bigint };
  const flows: Flow[] = [
    ...deps.map((l) => ({ block: l.blockNumber!, index: l.logIndex!, token: l.args.token!.toLowerCase(), signed: l.args.amount! })),
    ...wds.map((l) => ({ block: l.blockNumber!, index: l.logIndex!, token: l.args.token!.toLowerCase(), signed: -l.args.amount! })),
  ].sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
  if (flows.length === 0) return [];

  const prices = new Map<bigint, Promise<{ byToken: Map<string, bigint>; total: bigint } | null>>();
  const at = (block: bigint) => {
    if (!prices.has(block))
      prices.set(
        block,
        (client.readContract({ address: vault, abi: vaultAbi, functionName: "portfolio", blockNumber: block }) as Promise<readonly [Holding[], bigint]>)
          .then(([h, total]) => ({ byToken: new Map(h.map((x) => [x.token.toLowerCase(), x.priceUsd])), total }))
          .catch(() => null),
      );
    return prices.get(block)!;
  };
  const worth = (token: string, amount: bigint, price: bigint | undefined) => (price === undefined ? 0n : (amount * price) / 10n ** BigInt(decimals.get(token) ?? 18));

  // Each flow valued when it happened.
  const flowValues = await Promise.all(flows.map(async (f) => worth(f.token, f.signed < 0n ? -f.signed : f.signed, (await at(f.block))?.byToken.get(f.token))));

  const blocks = sampleBlocks(flows[0].block, head, samples);
  const points: PerformancePoint[] = [];
  for (let i = 0; i < blocks.length; i += 8) {
    const chunk = await Promise.all(
      blocks.slice(i, i + 8).map(async (b) => {
        const [p, blk] = await Promise.all([at(b), client.getBlock({ blockNumber: b })]);
        if (!p) return null;
        const units = new Map<string, bigint>();
        let net = 0n;
        flows.forEach((f, k) => {
          if (f.block > b) return;
          units.set(f.token, (units.get(f.token) ?? 0n) + f.signed);
          net += f.signed < 0n ? -flowValues[k] : flowValues[k];
        });
        let untraded = 0n;
        for (const [token, u] of units) if (u > 0n) untraded += worth(token, u, p.byToken.get(token));
        return { block: b, time: Number(blk.timestamp), valueUsd: p.total, untradedUsd: untraded, netDepositedUsd: net };
      }),
    );
    for (const c of chunk) if (c) points.push(c);
  }
  return points;
}

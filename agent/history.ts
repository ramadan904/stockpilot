// Reading a vault's whole history from a public RPC: find where to start (the block the deployment went out in, by
// timestamp, when the deployment file predates recording it), and read logs over that range, splitting it when the
// node refuses a range that large.

import type { PublicClient } from "viem";

type BlockReader = Pick<PublicClient, "getBlockNumber" | "getBlock">;

/**
 * The last block at or before `timestamp` (seconds). Each round reads `fanout` blocks at once (one round trip when the
 * transport batches) and keeps the slice between the last early block and the first late one: about
 * log(head) / log(fanout + 1) rounds, so a chain of ten million blocks takes eight.
 */
export async function blockAtOrBefore(client: BlockReader, timestamp: number, fanout = 8): Promise<bigint> {
  const ts = BigInt(Math.floor(timestamp));
  const time = async (n: bigint) => (await client.getBlock({ blockNumber: n })).timestamp;
  const head = await client.getBlockNumber();
  const [first, last] = await Promise.all([time(0n), time(head)]);
  if (last <= ts) return head;
  if (first > ts) return 0n;
  // Invariant: block lo is at or before ts; block hi is after it.
  let lo = 0n;
  let hi = head;
  while (hi - lo > 1n) {
    const step = (hi - lo) / BigInt(fanout + 1) || 1n;
    const probes: bigint[] = [];
    for (let n = lo + step; n < hi && probes.length < fanout; n += step) probes.push(n);
    const times = await Promise.all(probes.map(time));
    let nextLo = lo;
    let nextHi = hi;
    for (let i = 0; i < probes.length; i++) {
      if (times[i] <= ts) nextLo = probes[i];
      else {
        nextHi = probes[i];
        break;
      }
    }
    lo = nextLo;
    hi = nextHi;
  }
  return lo;
}

/**
 * Read logs over [from, to]. Public nodes cap how many blocks or results one query may span, and say so with an
 * error; on any error the range is halved and both halves read, down to a single block, so a cap of any size is
 * found without knowing it in advance. A node that is simply down still fails, once the range can't shrink.
 */
export async function logsInRange<T>(read: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  if (to < from) return [];
  try {
    return await read(from, to);
  } catch (e) {
    if (to === from) throw e;
    const mid = from + (to - from) / 2n;
    const left = await logsInRange(read, from, mid);
    const right = await logsInRange(read, mid + 1n, to);
    return [...left, ...right];
  }
}

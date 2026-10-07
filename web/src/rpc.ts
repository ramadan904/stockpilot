// How the app talks to a chain's public RPC. A vault page asks for dozens of values at once; sent one request each,
// a public endpoint slows them down or rate-limits them. Batched, they travel in a few requests. A node that rejects
// batches falls back to plain requests rather than failing.

import { fallback, http, type Chain, type PublicClient } from "viem";
import { blockAtOrBefore } from "../../agent/history";
import { deploymentFor } from "./chains";

export const rpcTransport = () => fallback([http(undefined, { batch: { batchSize: 40, wait: 16 } }), http()]);

const pending = new Map<string, Promise<bigint>>();
const LOCAL = 31337;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: found again next visit
  }
}

/**
 * The first block worth reading for this chain's vaults: the block the deployment went out in, so a vault's whole
 * life is read rather than only recent blocks. Deployment files record it; older ones only record the time, so the
 * block is found by timestamp once and remembered in this browser.
 */
export function historyStart(client: Pick<PublicClient, "getBlockNumber" | "getBlock"> & { chain?: Chain }): Promise<bigint> {
  const chainId = client.chain?.id;
  const d = chainId === undefined ? undefined : deploymentFor(chainId);
  if (!d || chainId === LOCAL) return Promise.resolve(0n);
  if (d.startBlock !== undefined) return Promise.resolve(BigInt(d.startBlock));
  if (!d.deployedAt) return Promise.resolve(0n);
  const key = `stockpilot.startBlock.${chainId}.${d.factory.toLowerCase()}`;
  const known = remembered(key);
  if (known) return Promise.resolve(BigInt(known));
  let found = pending.get(key);
  if (!found) {
    // An hour's margin: the file is written as the deploy finishes, after its first transactions.
    found = blockAtOrBefore(client, Date.parse(d.deployedAt) / 1000 - 3_600).then((b) => {
      remember(key, b.toString());
      return b;
    });
    found.catch(() => pending.delete(key));
    pending.set(key, found);
  }
  return found;
}

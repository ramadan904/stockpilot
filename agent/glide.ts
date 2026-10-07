// Glide paths, as the vault runs them: each asset's target moves in a straight line from where it stood when the
// owner set the path to the owner's end target, then stays there, like a target-date fund that de-risks toward a
// date. The vault enforces it (`PilotVault.setGlidePath`); these functions reproduce its arithmetic exactly, so the app
// and the backtest show the same targets the vault will judge trades by.

import type { Abi, Address, PublicClient } from "viem";

export interface GlidePath {
  /** Unix seconds. */
  start: number;
  end: number;
  /** Targets in bps, mandate order. */
  from: number[];
  to: number[];
}

/** The targets in force at `now`, exactly `PilotVault._base`: rounded toward where each target started. */
export function glidedTargets(mandate: number[], g: GlidePath | null, now: number): number[] {
  if (!g) return mandate;
  if (now >= g.end) return g.to;
  const done = BigInt(now - g.start);
  const span = BigInt(g.end - g.start);
  return g.from.map((f, i) => {
    const t = g.to[i];
    return t >= f ? f + Number((BigInt(t - f) * done) / span) : f - Number((BigInt(f - t) * done) / span);
  });
}

/**
 * End targets that put `safeIndex` at `safeBps` and scale every other asset in proportion to `current`, summing to
 * exactly 100% (the vault accepts nothing else): largest remainders get the leftover basis points.
 */
export function glideEndTargets(current: number[], safeIndex: number, safeBps: number): number[] {
  const rest = 10_000 - safeBps;
  const othersNow = current.reduce((s, t, i) => (i === safeIndex ? s : s + t), 0);
  if (othersNow === 0) return current.map((_, i) => (i === safeIndex ? 10_000 : 0));
  const exact = current.map((t, i) => (i === safeIndex ? safeBps : (t * rest) / othersNow));
  const out = exact.map(Math.floor);
  let left = 10_000 - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).filter((x) => x.i !== safeIndex).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

/** Fraction of the way along, 0 to 1. */
export function glideProgress(g: GlidePath, now: number) {
  return Math.min(1, Math.max(0, (now - g.start) / (g.end - g.start)));
}

/** The vault's glide path, or null when none is set. `tokens` in mandate order. */
export async function readGlide(client: Pick<PublicClient, "readContract">, abi: Abi, vault: Address, tokens: Address[]): Promise<GlidePath | null> {
  const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: vault, abi, functionName, args } as never) as Promise<unknown>;
  const end = Number(await read("glideEnd"));
  if (end === 0) return null;
  const [start, legs] = await Promise.all([read("glideStart"), Promise.all(tokens.map((t) => read("glide", [t]) as Promise<readonly [number, number]>))]);
  return { start: Number(start), end, from: legs.map((l) => Number(l[0])), to: legs.map((l) => Number(l[1])) };
}

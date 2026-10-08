// Where each vault goes in the network's constellation: every pilot is a star, the vaults it flies orbit it, and vaults
// without a pilot drift on an outer ring. Pure geometry, so the picture is the same for every visitor and testable.

export type StarMood = "calm" | "drifting" | "outside" | "paused";

export interface StarVault {
  vault: string;
  pilot: string | null;
  valueUsd: number;
  fund: boolean;
  mood: StarMood;
  /** What it holds, as shares of its value (summing to 1), by asset symbol. */
  slices: { symbol: string; share: number }[];
  /** Traded in the last day. */
  recent: boolean;
}

export interface Hub {
  pilot: string;
  x: number;
  y: number;
  vaults: number;
  valueUsd: number;
}

export interface Placed extends StarVault {
  x: number;
  y: number;
  r: number;
  /** Index into hubs, or -1 for the outer ring. */
  hub: number;
}

/** At most this many pilots get a star of their own; the vaults of any others join the outer ring. */
export const MAX_HUBS = 6;

/** The mood of a vault from its holdings: worst drift against its band, as the vault's own lamp shows it. */
export function starMood(holdings: { weightBps: number; targetBps: number; bandBps: number }[], paused: boolean, triggerFraction = 0.5): StarMood {
  if (paused) return "paused";
  let worst = 0;
  for (const h of holdings) if (h.bandBps > 0) worst = Math.max(worst, Math.abs(h.weightBps - h.targetBps) / h.bandBps);
  return worst > 1 ? "outside" : worst > triggerFraction ? "drifting" : "calm";
}

export function layoutConstellation(vaults: StarVault[], size: { width: number; height: number }): { hubs: Hub[]; placed: Placed[] } {
  const { width: w, height: h } = size;
  const cx = w / 2;
  const cy = h / 2;
  const short = Math.min(w, h);

  // Pilots by the value they fly, largest first.
  const byPilot = new Map<string, StarVault[]>();
  for (const v of vaults) if (v.pilot) byPilot.set(v.pilot, [...(byPilot.get(v.pilot) ?? []), v]);
  const ranked = [...byPilot.entries()].sort((a, b) => sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0]));
  const starred = ranked.slice(0, MAX_HUBS);
  const n = starred.length;
  const hubs: Hub[] = starred.map(([pilot, vs], i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    const [x, y] = n === 1 ? [cx, cy] : [cx + w * 0.28 * Math.cos(angle), cy + h * 0.26 * Math.sin(angle)];
    return { pilot, x, y, vaults: vs.length, valueUsd: sum(vs) };
  });

  const max = Math.max(1, ...vaults.map((v) => v.valueUsd));
  const radius = (v: StarVault) => 5 + 15 * Math.sqrt(Math.max(0, v.valueUsd) / max);
  const placed: Placed[] = [];

  starred.forEach(([, vs], hi) => {
    const hub = hubs[hi];
    const sorted = [...vs].sort((a, b) => b.valueUsd - a.valueUsd || a.vault.localeCompare(b.vault));
    // Up to 10 on the inner orbit, the rest further out, so orbs never pile up.
    const inner = sorted.slice(0, 10);
    const outer = sorted.slice(10);
    const base = n === 1 ? short * 0.22 : short * 0.12;
    const ring = (list: StarVault[], orbit: number, phase: number) =>
      list.forEach((v, k) => {
        const angle = phase + (2 * Math.PI * k) / list.length;
        placed.push({ ...v, x: hub.x + orbit * Math.cos(angle), y: hub.y + orbit * Math.sin(angle), r: radius(v), hub: hi });
      });
    ring(inner, base, hi * 0.7);
    ring(outer, base * 1.55, hi * 0.7 + 0.3);
  });

  const loose = vaults.filter((v) => !v.pilot || !hubs.some((hb) => hb.pilot === v.pilot)).sort((a, b) => a.vault.localeCompare(b.vault));
  loose.forEach((v, k) => {
    const angle = Math.PI / 6 + (2 * Math.PI * k) / Math.max(loose.length, 1);
    placed.push({ ...v, x: cx + w * 0.46 * Math.cos(angle), y: cy + h * 0.44 * Math.sin(angle), r: radius(v), hub: -1 });
  });
  return { hubs, placed };
}

const sum = (vs: StarVault[]) => vs.reduce((s, v) => s + v.valueUsd, 0);

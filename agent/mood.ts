// The vault's state as light: one mood for its status lamp, and the shape of the aurora behind a draft. Pure, so the
// colours on screen always say the same thing the numbers do.

import type { Drift } from "./planner";

export type Mood = "calm" | "drifting" | "outside" | "defensive" | "paused";

export interface MoodReading {
  mood: Mood;
  /** Short label for the lamp. */
  label: string;
  /** Worst drift as a share of its band: 0 on target, 1 at a band edge (capped at 1.5). Drives how bright it glows. */
  intensity: number;
}

/** Paused outranks everything (nothing trades); then defensive targets; then the worst drift against its band. */
export function vaultMood(drift: Drift[], flags: { paused?: boolean; defensive?: boolean } = {}): MoodReading {
  const worst = drift.reduce((m, d) => Math.max(m, d.bandBps > 0 ? Math.abs(d.driftBps) / d.bandBps : 0), 0);
  const intensity = Math.min(1.5, Math.round(worst * 100) / 100);
  if (flags.paused) return { mood: "paused", label: "Paused", intensity: 0 };
  if (flags.defensive) return { mood: "defensive", label: "Defensive", intensity };
  if (drift.some((d) => d.outOfBand)) return { mood: "outside", label: "Outside a band", intensity };
  if (drift.some((d) => d.triggered)) return { mood: "drifting", label: "Drifting", intensity };
  return { mood: "calm", label: "On target", intensity };
}

export interface AuraLight {
  symbol: string;
  /** Palette slot, 1-based, from the asset's place in the listing: an asset keeps its colour whatever else changes. */
  slot: number;
  /** Diameter as a share of the hero's width. */
  size: number;
  /** Centre, as shares of the hero's width and height. */
  x: number;
  y: number;
}

// Fixed homes, one per slot, spread so neighbours in the listing don't overlap.
const HOMES: [number, number][] = [
  [0.12, 0.3],
  [0.82, 0.22],
  [0.5, 0.85],
  [0.32, 0.1],
  [0.95, 0.75],
];

/**
 * One light per held asset, its area proportional to its weight. Assets at 0% give no light; an asset outside the
 * first five listings gives none either, since the palette has five validated slots.
 */
export function auraLights(weights: { symbol: string; percent: number }[], listing: readonly { symbol: string }[]): AuraLight[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w.percent), 0);
  if (total <= 0) return [];
  return weights
    .map((w) => ({ w, i: listing.findIndex((l) => l.symbol === w.symbol) }))
    .filter(({ w, i }) => w.percent > 0 && i >= 0 && i < HOMES.length)
    .sort((a, b) => a.i - b.i)
    .map(({ w, i }) => ({
      symbol: w.symbol,
      slot: i + 1,
      size: Math.round((0.22 + 0.5 * Math.sqrt(w.percent / total)) * 1000) / 1000,
      x: HOMES[i][0],
      y: HOMES[i][1],
    }));
}

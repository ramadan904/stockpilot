// Light that means something: the aurora behind the page is the draft's own allocation, the vault's lamp glows with
// its drift, and the contract's "no" lands as a shield flash. Every effect stills under prefers-reduced-motion.

import { useEffect, useState, type CSSProperties } from "react";
import { auraLights, type MoodReading } from "../../agent/mood";
import { LISTINGS } from "../../agent/listings";

const cssVars = (vars: Record<string, string | number>) => vars as CSSProperties;

/** One soft light per held asset, in its palette colour, its area matching its weight. Decorative: the key says what it is. */
export function Aura({ weights }: { weights: { symbol: string; percent: number }[] }) {
  const lights = auraLights(weights, LISTINGS);
  return (
    <div className="aura" aria-hidden>
      {lights.map((l) => (
        <span
          key={l.symbol}
          className="aura-light"
          style={cssVars({ "--c": `var(--series-${l.slot})`, "--size": `${l.size * 100}%`, "--x": `${l.x * 100}%`, "--y": `${l.y * 100}%`, "--i": l.slot })}
        />
      ))}
    </div>
  );
}

/** What the colours behind the hero are: each asset's swatch and weight, in listing order. */
export function AuraKey({ weights }: { weights: { symbol: string; percent: number }[] }) {
  const lights = auraLights(weights, LISTINGS);
  if (!lights.length) return null;
  const pct = (s: string) => weights.find((w) => w.symbol === s)?.percent ?? 0;
  return (
    <p className="aura-key small">
      <span className="muted">The light behind this page is your draft:</span>
      {lights.map((l) => (
        <span key={l.symbol} className="aura-chip">
          <span className="aura-dot" style={cssVars({ "--c": `var(--series-${l.slot})` })} />
          {l.symbol} {Math.round(pct(l.symbol))}%
        </span>
      ))}
    </p>
  );
}

/** The vault's status lamp: colour from its mood, glow from how far the worst asset has drifted toward its band. */
export function MoodLamp({ reading }: { reading: MoodReading }) {
  return (
    <span className={`mood-lamp mood-${reading.mood}`} role="status" style={cssVars({ "--glow": reading.intensity })} title={`Worst drift: ${Math.round(reading.intensity * 100)}% of its band`}>
      <span className="mood-bulb" aria-hidden />
      {reading.label}
    </span>
  );
}

export type Flash = { kind: "blocked" | "trade"; id: number };

/** A one-shot overlay: a red shield ripple when the contract refuses, a green sweep when a trade goes through. */
export function FlashLayer({ flash }: { flash: Flash | null }) {
  const [shown, setShown] = useState<Flash | null>(null);
  useEffect(() => {
    if (!flash) return;
    setShown(flash);
    // A timer, not animationend: with reduced motion there is no animation to end.
    const t = setTimeout(() => setShown((s) => (s?.id === flash.id ? null : s)), flash.kind === "blocked" ? 1_400 : 900);
    return () => clearTimeout(t);
  }, [flash?.id]);
  if (!shown) return null;
  return (
    <div key={shown.id} className={`flash flash-${shown.kind}`} aria-hidden>
      {shown.kind === "blocked" && <span className="flash-stamp">Blocked by the vault</span>}
    </div>
  );
}

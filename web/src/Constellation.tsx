// The network as a constellation: each pilot a star, the vaults it flies in orbit around it, each vault an orb sized by
// its value and ringed with its holdings in their palette colours, glowing with its mood. Funds wear a dashed halo
// (many owners); a vault that traded today pulses. Hover for details, click to open the vault. Stills for readers who
// ask for reduced motion.

import { useMemo, useState, type CSSProperties } from "react";
import { layoutConstellation, type Placed, type StarVault } from "../../agent/constellation";
import { LISTINGS } from "../../agent/listings";

const W = 800;
const H = 480;

const slotOf = (symbol: string) => {
  const i = LISTINGS.findIndex((l) => l.symbol === symbol);
  return i < 0 ? 5 : i + 1;
};

const MOOD_LABEL = { calm: "on target", drifting: "drifting", outside: "outside a band", paused: "paused" } as const;

/** An arc of the ring around an orb, from `a0` to `a1` (fractions of a turn, from the top). */
function arc(x: number, y: number, r: number, a0: number, a1: number) {
  const p = (a: number) => [x + r * Math.sin(2 * Math.PI * a), y - r * Math.cos(2 * Math.PI * a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(Math.min(a1, a0 + 0.9999));
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function money(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// A fixed field of faint background stars, the same on every render.
const DUST = Array.from({ length: 70 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  return { x: r(1) * W, y: r(2) * H, s: 0.4 + r(3) * 1.1, o: 0.15 + r(4) * 0.45 };
});

export function Constellation({ stars, pilotNames, chainId }: { stars: StarVault[]; pilotNames: Record<string, string>; chainId: number }) {
  const { hubs, placed } = useMemo(() => layoutConstellation(stars, { width: W, height: H }), [stars]);
  const [hover, setHover] = useState<Placed | null>(null);
  if (stars.length === 0) return null;
  const name = (pilot: string | null) => (pilot ? (pilotNames[pilot] ?? `${pilot.slice(0, 6)}…${pilot.slice(-4)}`) : "no pilot");
  const describe = (p: Placed) =>
    `${p.fund ? "Fund vault" : "Vault"} ${p.vault.slice(0, 6)}…${p.vault.slice(-4)}: ${money(p.valueUsd)}, ${MOOD_LABEL[p.mood]}, flown by ${name(p.pilot)}${p.recent ? ", traded today" : ""}. ${p.slices
      .map((s) => `${s.symbol} ${Math.round(s.share * 100)}%`)
      .join(", ")}.`;

  return (
    <figure className="constellation" aria-label="The network as a constellation">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${hubs.length} pilot${hubs.length === 1 ? "" : "s"} and ${placed.length} vaults`}>
        <defs>
          <radialGradient id="sky" cx="50%" cy="45%" r="70%">
            <stop offset="0%" stopColor="#0f1d2e" />
            <stop offset="100%" stopColor="#05080c" />
          </radialGradient>
          <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width={W} height={H} rx="14" fill="url(#sky)" />
        {DUST.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.s} fill="#cfe3ff" opacity={d.o} />
        ))}

        {hubs.map((hub, hi) => {
          const mine = placed.filter((p) => p.hub === hi);
          return (
            <g key={hub.pilot}>
              {/* The orbit turns slowly around its star; tethers show who flies what. */}
              <g className="orbit" style={{ transformOrigin: `${hub.x}px ${hub.y}px`, "--spin": `${140 + hi * 35}s` } as CSSProperties}>
                {mine.map((p) => (
                  <line key={`t-${p.vault}`} x1={hub.x} y1={hub.y} x2={p.x} y2={p.y} className="tether" />
                ))}
                {mine.map((p) => (
                  <Orb key={p.vault} p={p} chainId={chainId} label={describe(p)} onHover={setHover} />
                ))}
              </g>
              <g className="hub" filter="url(#glow)">
                <path d={star(hub.x, hub.y, 11, 4)} className="hub-star" />
              </g>
            </g>
          );
        })}
        {placed
          .filter((p) => p.hub === -1)
          .map((p) => (
            <Orb key={p.vault} p={p} chainId={chainId} label={describe(p)} onHover={setHover} />
          ))}
        {/* Names last, so they sit above every orbit. */}
        {hubs.map((hub) => (
          <g key={`label-${hub.pilot}`}>
            <text x={hub.x} y={hub.y + 26} className="hub-label" textAnchor="middle">
              {name(hub.pilot)}
            </text>
            <text x={hub.x} y={hub.y + 40} className="hub-sub" textAnchor="middle">
              {hub.vaults} vault{hub.vaults === 1 ? "" : "s"} · {money(hub.valueUsd)}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="small muted" aria-live="polite">
        {hover ? describe(hover) : "Each star is a pilot; its vaults orbit it, sized by value, ringed by what they hold, glowing with their mood. A dashed halo marks a fund; a pulse, a trade today. Click one to open it."}
      </figcaption>
    </figure>
  );
}

function Orb({ p, chainId, label, onHover }: { p: Placed; chainId: number; label: string; onHover: (p: Placed | null) => void }) {
  let at = 0;
  return (
    <a
      href={`?chain=${chainId}&vault=${p.vault}`}
      aria-label={label}
      className={`orb mood-${p.mood}`}
      onMouseEnter={() => onHover(p)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(p)}
      onBlur={() => onHover(null)}
    >
      <title>{label}</title>
      {p.recent && <circle cx={p.x} cy={p.y} r={p.r + 4} className="orb-pulse" style={{ transformOrigin: `${p.x}px ${p.y}px` }} />}
      <circle cx={p.x} cy={p.y} r={p.r} className="orb-core" filter="url(#glow)" />
      {p.slices.map((s) => {
        const d = arc(p.x, p.y, p.r + 3, at, at + s.share);
        at += s.share;
        return <path key={s.symbol} d={d} className="orb-ring" style={{ stroke: `var(--series-${slotOf(s.symbol)})` }} />;
      })}
      {p.fund && <circle cx={p.x} cy={p.y} r={p.r + 7.5} className="orb-fund" />}
    </a>
  );
}

/** A four-pointed star. */
function star(x: number, y: number, outer: number, inner: number) {
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 4) * i - Math.PI / 2;
    pts.push(`${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M ${pts.join(" L ")} Z`;
}

// A strategy or vault as a shareable card: 1200x630 (the size social sites preview), drawn as plain SVG so it can be
// downloaded as is or turned into a PNG in the browser. The aurora is the allocation itself, as on the app's hero.

import { auraLights } from "./mood";
import type { Mood } from "./mood";

export interface PosterInput {
  /** Small caps line above the title, e.g. "STRATEGY · BALANCED" or "LIVE VAULT · ROBINHOOD CHAIN TESTNET". */
  kicker: string;
  title: string;
  summary?: string;
  allocations: { symbol: string; percent: number }[];
  /** Short rule lines, e.g. "Drift band ±5 pts". The first four are drawn. */
  rules: string[];
  status?: { label: string; mood: Mood };
  /** Where to find it, without the scheme, e.g. "stockpilot-six-virid.vercel.app". */
  site: string;
}

export const POSTER = { width: 1200, height: 630 } as const;

// The card is always dark, so the light reads as light. These mirror the dark-theme tokens in web/src/styles.css.
const C = {
  bg: "#0b1016",
  surface: "#121922",
  border: "#253141",
  text: "#e6edf5",
  muted: "#8b9bb0",
  accent: "#2dd4bf",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
  mood: { calm: "#2dd4bf", drifting: "#fbbf24", defensive: "#fbbf24", outside: "#f87171", paused: "#8b9bb0" } as Record<Mood, string>,
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Greedy word wrap to at most `lines` lines of about `width` characters, with an ellipsis when it runs over. */
export function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].length > width ? `${words[i].slice(0, width - 1)}…` : words[i];
    const next = line ? `${line} ${w}` : w;
    if (next.length <= width) {
      line = next;
      continue;
    }
    out.push(line);
    line = w;
    if (out.length === lines) {
      out[lines - 1] = `${out[lines - 1].replace(/[\s,.;:]+$/, "")}…`;
      return out;
    }
  }
  if (line) out.push(line);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1]}…`;
  }
  return out;
}

const slotColor = (symbol: string, lights: ReturnType<typeof auraLights>) => {
  const l = lights.find((x) => x.symbol === symbol);
  return l ? C.series[l.slot - 1] : C.muted;
};

export function posterSvg(p: PosterInput, listing: readonly { symbol: string }[]): string {
  const { width: W, height: H } = POSTER;
  const lights = auraLights(p.allocations, listing);
  const held = p.allocations.filter((a) => a.percent > 0);
  const maxPct = Math.max(1, ...held.map((a) => a.percent));
  const t = (s: string) => escapeXml(s);

  const aura = lights
    .map(
      (l, i) =>
        `<radialGradient id="g${i}"><stop offset="0" stop-color="${C.series[l.slot - 1]}" stop-opacity="0.9"/><stop offset="0.62" stop-color="${C.series[l.slot - 1]}" stop-opacity="0"/></radialGradient>` +
        `<circle cx="${Math.round(l.x * W)}" cy="${Math.round(l.y * H)}" r="${Math.round((l.size * W) / 2)}" fill="url(#g${i})" opacity="0.55" filter="url(#soft)"/>`,
    )
    .join("");

  const summary = wrap(p.summary ?? "", 46, 3)
    .map((line, i) => `<text x="64" y="${262 + i * 34}" font-size="24" fill="${C.muted}">${t(line)}</text>`)
    .join("");

  const rowH = Math.min(64, 360 / Math.max(1, held.length));
  const bars = held
    .map((a, i) => {
      const y = 150 + i * rowH;
      const w = Math.max(6, Math.round((a.percent / maxPct) * 240));
      const color = slotColor(a.symbol, lights);
      return (
        `<text x="720" y="${y + 22}" font-size="22" font-weight="700" fill="${C.text}">${t(a.symbol)}</text>` +
        `<rect x="820" y="${y + 6}" width="240" height="20" rx="10" fill="${C.surface}" stroke="${C.border}"/>` +
        `<rect x="820" y="${y + 6}" width="${w}" height="20" rx="10" fill="${color}" filter="url(#glow)"/>` +
        `<text x="1136" y="${y + 22}" font-size="20" font-weight="600" fill="${C.text}" text-anchor="end" font-variant-numeric="tabular-nums">${t(`${round1(a.percent)}%`)}</text>`
      );
    })
    .join("");

  const status = p.status
    ? (() => {
        const color = C.mood[p.status.mood];
        const label = t(p.status.label);
        const pw = 44 + p.status.label.length * 11;
        return (
          `<rect x="64" y="378" width="${pw}" height="36" rx="18" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-opacity="0.5"/>` +
          `<circle cx="86" cy="396" r="6" fill="${color}" filter="url(#glow)"/>` +
          `<text x="100" y="403" font-size="18" font-weight="600" fill="${C.text}">${label}</text>`
        );
      })()
    : "";

  const rules = p.rules
    .slice(0, 4)
    .map((r, i) => `<text x="64" y="${474 + i * 30}" font-size="20" fill="${C.text}"><tspan fill="${C.accent}">✓ </tspan>${t(r)}</text>`)
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
    `<defs><filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>`,
    `<filter id="glow" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    `<linearGradient id="edge" x1="0" x2="1"><stop offset="0" stop-color="${C.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${C.accent}"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>`,
    aura,
    `<rect x="0" y="0" width="${W}" height="3" fill="url(#edge)"/>`,
    `<text x="64" y="104" font-size="18" font-weight="700" letter-spacing="3" fill="${C.accent}">${t(p.kicker.toUpperCase())}</text>`,
    ...wrap(p.title, 24, 2).map((line, i) => `<text x="64" y="${168 + i * 56}" font-size="50" font-weight="800" fill="${C.text}">${t(line)}</text>`),
    summary,
    status,
    `<text x="720" y="118" font-size="16" font-weight="700" letter-spacing="2" fill="${C.muted}">ALLOCATION</text>`,
    bars,
    rules,
    `<g transform="translate(720 560)"><rect width="30" height="30" rx="7" fill="${C.accent}"/><path d="M6 21l6-6 4 4 8-9" stroke="${C.bg}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<text x="42" y="22" font-size="22" font-weight="800" fill="${C.text}">StockPilot</text></g>`,
    `<text x="1136" y="582" font-size="18" fill="${C.muted}" text-anchor="end">${t(p.site)}</text>`,
    `</svg>`,
  ].join("");
}

const round1 = (n: number) => (Math.round(n * 10) / 10).toString();

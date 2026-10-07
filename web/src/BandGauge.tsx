// The band math of a planned trade, drawn: for each side, the target, the band the vault enforces (shaded), the pilot's
// trigger inside it (dashed), where the weight is now (hollow dot) and where the trade takes it (filled dot).

import { useId } from "react";
import type { Explanation, Leg } from "../../agent/explain";

const W = 320;
const H = 58;
const PAD = 14;
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

function Gauge({ leg, line }: { leg: Leg; line: string }) {
  const off = (bps: number) => Math.abs(bps - leg.targetBps);
  const span = Math.max(leg.bandBps * 1.6, off(leg.beforeBps) * 1.25, off(leg.afterBps) * 1.25, 100);
  const lo = Math.max(0, leg.targetBps - span);
  const hi = Math.min(10_000, leg.targetBps + span);
  const x = (bps: number) => PAD + ((Math.min(hi, Math.max(lo, bps)) - lo) / (hi - lo)) * (W - 2 * PAD);
  const y = 30;
  const [now, after] = [x(leg.beforeBps), x(leg.afterBps)];
  const arrow = `bandviz-arrow-${useId().replace(/:/g, "")}`;
  return (
    <figure className="bandviz">
      <figcaption className="small">
        <strong>{leg.side === "sell" ? "Sell" : "Buy"} {leg.symbol}</strong> <span className="muted">{line.split(": ").slice(1).join(": ")}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={line} className="bandviz-svg">
        <line x1={PAD} x2={W - PAD} y1={y} y2={y} className="bandviz-track" />
        <rect x={x(leg.targetBps - leg.bandBps)} y={y - 9} width={x(leg.targetBps + leg.bandBps) - x(leg.targetBps - leg.bandBps)} height={18} rx={4} className="bandviz-band" />
        {[-1, 1].map((s) => (
          <line key={s} x1={x(leg.targetBps + s * leg.triggerBps)} x2={x(leg.targetBps + s * leg.triggerBps)} y1={y - 9} y2={y + 9} className="bandviz-trigger" />
        ))}
        <line x1={x(leg.targetBps)} x2={x(leg.targetBps)} y1={y - 13} y2={y + 13} className="bandviz-target" />
        <text x={x(leg.targetBps)} y={y - 16} textAnchor="middle" className="bandviz-label">
          target {pct(leg.targetBps)}
        </text>
        <text x={x(leg.targetBps - leg.bandBps)} y={y + 22} textAnchor="middle" className="bandviz-label muted">
          {pct(leg.targetBps - leg.bandBps)}
        </text>
        <text x={x(leg.targetBps + leg.bandBps)} y={y + 22} textAnchor="middle" className="bandviz-label muted">
          {pct(leg.targetBps + leg.bandBps)}
        </text>
        {Math.abs(after - now) > 9 && <line x1={now} x2={after + (after > now ? -6 : 6)} y1={y} y2={y} className="bandviz-move" markerEnd={`url(#${arrow})`} />}
        <defs>
          <marker id={arrow} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 z" className="bandviz-arrowhead" />
          </marker>
        </defs>
        <circle cx={now} cy={y} r={5} className="bandviz-now" />
        <circle cx={after} cy={y} r={5} className="bandviz-after" />
      </svg>
    </figure>
  );
}

export function TradeExplainer({ explanation }: { explanation: Explanation }) {
  return (
    <div className="explainer" aria-label="Why this trade">
      <Gauge leg={explanation.sell} line={explanation.lines[0]} />
      <Gauge leg={explanation.buy} line={explanation.lines[1]} />
      <p className="muted small bandviz-legend">
        <span className="dot now" /> now <span className="dot after" /> after the trade · shaded: the band the vault enforces · dashed: where the pilot starts trading
      </p>
    </div>
  );
}

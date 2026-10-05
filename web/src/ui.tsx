import type { ReactNode } from "react";
import { WAD, valueOf, type AssetState } from "../../agent/model";
import type { Drift } from "../../agent/planner";

export function usd(wad: bigint, cents = true) {
  const n = Number(wad / 10n ** 14n) / 10_000;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

export const pct = (bps: number, digits = 1) => `${(bps / 100).toFixed(digits)}%`;

export function price(a: AssetState) {
  return usd(a.price);
}

export function valueUsd(a: AssetState) {
  return valueOf(a.balance, a.price, a.decimals);
}

export function totalUsd(assets: AssetState[]) {
  return assets.reduce((t, a) => t + valueUsd(a), 0n);
}

export function Card(props: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; tour?: string }) {
  return (
    <section className={`card ${props.className ?? ""}`} data-tour={props.tour}>
      {(props.title || props.aside) && (
        <header className="card-head">
          {props.title && <h3>{props.title}</h3>}
          {props.aside}
        </header>
      )}
      {props.children}
    </section>
  );
}

/**
 * One asset's weight against its target and band. The shaded region is what the vault allows; the inner region is
 * where the pilot leaves it alone.
 */
export function BandGauge({ d, scaleBps }: { d: Drift; scaleBps: number }) {
  const x = (bps: number) => `${Math.max(0, Math.min(100, (bps / scaleBps) * 100))}%`;
  const lo = d.targetBps - d.bandBps;
  const state = d.outOfBand ? "out" : d.triggered ? "warn" : "ok";
  return (
    <div className="gauge" role="img" aria-label={`weight ${pct(d.weightBps)}, target ${pct(d.targetBps)} ± ${pct(d.bandBps)}`}>
      <div className="gauge-band" style={{ left: x(lo), width: `calc(${x(d.targetBps + d.bandBps)} - ${x(lo)})` }} />
      <div
        className="gauge-trigger"
        style={{ left: x(d.targetBps - d.bandBps / 2), width: `calc(${x(d.targetBps + d.bandBps / 2)} - ${x(d.targetBps - d.bandBps / 2)})` }}
      />
      <div className="gauge-target" style={{ left: x(d.targetBps) }} />
      <div className={`gauge-dot ${state}`} style={{ left: x(d.weightBps) }} />
    </div>
  );
}

export function StatusPill({ d }: { d: Drift }) {
  if (d.outOfBand) return <span className="pill out">outside band</span>;
  if (d.triggered) return <span className="pill warn">drifting</span>;
  return <span className="pill ok">on target</span>;
}

export function HoldingsTable({ assets, drift }: { assets: AssetState[]; drift: Drift[] }) {
  const scale = Math.max(5000, ...drift.map((d) => Math.max(d.weightBps, d.targetBps + d.bandBps) + 500));
  return (
    <table className="holdings">
      <thead>
        <tr>
          <th>Asset</th>
          <th className="num">Price</th>
          <th className="num">Value</th>
          <th className="num">Weight</th>
          <th className="gauge-col">Target ± band</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {assets.map((a, i) => (
          <tr key={a.token}>
            <td className="sym">{a.symbol}</td>
            <td className="num">{price(a)}</td>
            <td className="num">{usd(valueUsd(a))}</td>
            <td className="num">
              {pct(drift[i].weightBps)}
              <span className="muted"> / {pct(drift[i].targetBps)}</span>
            </td>
            <td className="gauge-col">
              <BandGauge d={drift[i]} scaleBps={scale} />
            </td>
            <td>
              <StatusPill d={drift[i]} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const ONE_USD = WAD;

import { useEffect, useState } from "react";
import { LISTINGS } from "../../agent/listings";
import type { Mandate } from "../../agent/mandate";
import { DEFAULT_MODELS, backtest, modelsFor, type BacktestResult, type Percentiles } from "../../agent/backtest";
import { LineChart, compactUsd } from "./LineChart";
import { Card } from "./ui";
import { StressTest } from "./StressTest";

const money = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pctf = (v: number) => `${v.toFixed(1)}%`;

export function Backtest({ mandate, usdSize }: { mandate: Mandate; usdSize: number }) {
  const [years, setYears] = useState(1);
  const [feePct, setFeePct] = useState(0.5);
  const [seed, setSeed] = useState(1);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(true);
    // Let the "Running" state paint before the (roughly one second) computation.
    const t = setTimeout(() => {
      setResult(backtest({ assets: modelsFor(LISTINGS), mandate, startUsd: usdSize, days: 252 * years, paths: 200, seed, venueFeeBps: 10, feeBps: Math.round(feePct * 100) }));
      setBusy(false);
    }, 30);
    return () => clearTimeout(t);
  }, [mandate, usdSize, years, feePct, seed]);

  return (
    <div className="stack">
      <Card title={<><span className="step">3</span>Backtest the mandate</>} aside={busy ? <span className="pill info">Running 200 paths…</span> : null}>
        <p className="small" style={{ marginTop: 0 }}>
          The pilot's real planner and the vault's real rules, flown over 200 simulated markets and compared with buying the same portfolio and
          never touching it.
        </p>
        <div className="row">
          <label className="field" style={{ width: 140 }}>
            Horizon
            <select value={years} onChange={(e) => setYears(Number(e.target.value))}>
              <option value={1}>1 year</option>
              <option value={3}>3 years</option>
              <option value={5}>5 years</option>
            </select>
          </label>
          <label className="field" style={{ width: 160 }}>
            Pilot fee (% a year)
            <input type="number" min={0} max={2} step={0.25} value={feePct} onChange={(e) => setFeePct(Math.min(2, Math.max(0, Number(e.target.value))))} />
          </label>
          <button className="btn" style={{ alignSelf: "end" }} onClick={() => setSeed((s) => s + 1)} disabled={busy}>
            New random markets
          </button>
        </div>
      </Card>

      {result && (
        <div className="grid-2">
          <Card title="StockPilot against buy and hold">
            <div className="table-scroll">
              <table className="holdings">
                <thead>
                  <tr>
                    <th />
                    <th className="num">StockPilot</th>
                    <th className="num">Buy and hold</th>
                  </tr>
                </thead>
                <tbody>
                  <Row label="Ending value, typical (median)" a={result.pilot.finalValue.p50} b={result.hold.finalValue.p50} f={money} />
                  <Row label="Ending value, bad year (5th percentile)" a={result.pilot.finalValue.p5} b={result.hold.finalValue.p5} f={money} />
                  <Row label="Ending value, good year (95th percentile)" a={result.pilot.finalValue.p95} b={result.hold.finalValue.p95} f={money} />
                  <Row label="Deepest fall from a peak, typical" a={result.pilot.maxDrawdownPct.p50} b={result.hold.maxDrawdownPct.p50} f={pctf} lowerIsBetter />
                  <Row label="Deepest fall from a peak, bad case" a={result.pilot.maxDrawdownPct.p95} b={result.hold.maxDrawdownPct.p95} f={pctf} lowerIsBetter />
                  <Row label="Volatility (a year)" a={result.pilot.volatilityPct.p50} b={result.hold.volatilityPct.p50} f={pctf} lowerIsBetter />
                  <Row label="Most in one stock, bad case" a={result.pilot.maxConcentrationPct.p95} b={result.hold.maxConcentrationPct.p95} f={pctf} lowerIsBetter />
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Bold marks the better of the two. StockPilot ended ahead in {result.pilotWinsPct.toFixed(0)}% of the simulated markets. Rebalancing is mainly about control, not about
              beating the market: it keeps any one stock from taking over your portfolio.
            </p>
          </Card>

          <div className="stack">
            <Card title="What the pilot did">
              <div className="stats" style={{ marginBottom: 0 }}>
                <Tile label="Trades a year" value={result.tradesPerYear.toFixed(1)} />
                <Tile label="Traded a year" value={money(result.volumeUsdPerYear)} />
                <Tile label="Fees paid a year" value={money(result.feesUsdPerYear)} />
                <Tile label="Trades the vault would reject" value={String(result.rejected)} />
              </div>
            </Card>
            <Card>
              <LineChart
                title="A typical path (median outcome)"
                series={[
                  { name: "StockPilot", values: result.medianPath.pilot },
                  { name: "Buy and hold", values: result.medianPath.hold },
                ]}
                xLabel={(i) => (i === 0 ? "Start" : `Day ${i}`)}
                format={compactUsd}
                height={240}
              />
            </Card>
          </div>
        </div>
      )}

      <StressTest mandate={mandate} usdSize={usdSize} />

      <Card title="Assumptions">
        <p className="small muted" style={{ margin: 0 }}>
          Prices follow correlated random walks with illustrative yearly volatilities (
          {LISTINGS.filter((l) => !("stable" in l))
            .map((l) => `${l.symbol} ${Math.round((DEFAULT_MODELS[l.symbol]?.vol ?? 0.3) * 100)}%`)
            .join(", ")}
          ), the same 7% drift for every stock, and a 0.1% cost per trade. They are not forecasts, and past or simulated results say nothing about
          future returns. Not financial advice.
        </p>
      </Card>
    </div>
  );
}

function Row(props: { label: string; a: number; b: number; f: (v: number) => string; lowerIsBetter?: boolean }) {
  const better = props.lowerIsBetter ? props.a < props.b : props.a > props.b;
  return (
    <tr>
      <td>{props.label}</td>
      <td className="num">{better ? <strong>{props.f(props.a)}</strong> : props.f(props.a)}</td>
      <td className="num">{!better && Math.abs(props.a - props.b) > 1e-9 ? <strong>{props.f(props.b)}</strong> : props.f(props.b)}</td>
    </tr>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export type { Percentiles };

import { useEffect, useState } from "react";
import { LISTINGS } from "../../agent/listings";
import type { Mandate } from "../../agent/mandate";
import { DEFAULT_MODELS, modelsFor, type BacktestResult, type Percentiles, type TaxBacktestResult } from "../../agent/backtest";
import { LineChart, compactUsd } from "./LineChart";
import { glideEndTargets } from "../../agent/glide";
import { Card } from "./ui";
import { StressTest } from "./StressTest";
import { progressLabel, useComputeJob } from "./compute";

const money = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pctf = (v: number) => `${v.toFixed(1)}%`;

export function Backtest({ mandate, usdSize }: { mandate: Mandate; usdSize: number }) {
  const [years, setYears] = useState(1);
  const [feePct, setFeePct] = useState(0.5);
  const [seed, setSeed] = useState(1);
  const [glidePct, setGlidePct] = useState(0);
  // Off the main thread: the page keeps responding while 200 markets fly, and a new setting cancels the old run.
  const job = useComputeJob<BacktestResult>();
  const { result, busy } = job;

  useEffect(() => {
    const safe = LISTINGS.findIndex((l) => "stable" in l);
    const targets = mandate.assets.map((a) => a.targetBps);
    const glideTo = glidePct > 0 && safe >= 0 && glidePct * 100 > targets[safe] ? glideEndTargets(targets, safe, glidePct * 100) : undefined;
    job.run({ kind: "backtest", options: { assets: modelsFor(LISTINGS), mandate, startUsd: usdSize, days: 252 * years, paths: 200, seed, venueFeeBps: 10, feeBps: Math.round(feePct * 100), glideTo } });
  }, [mandate, usdSize, years, feePct, seed, glidePct]);

  return (
    <div className="stack">
      <Card title={<><span className="step">3</span>Backtest the mandate</>} aside={busy ? <span className="pill info">Running: {progressLabel(job.done, job.total)}</span> : null}>
        <p className="small" style={{ marginTop: 0 }}>
          The pilot's real planner and the vault's real rules, flown over 200 simulated markets and compared with buying the same portfolio and
          never touching it.
        </p>
        {busy && <progress className="run-progress" max={job.total || 1} value={job.done} aria-label="Backtest progress" />}
        {job.error && <p className="notice bad">The backtest stopped: {job.error}</p>}
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
          <label className="field" style={{ width: 220 }}>
            Glide path
            <select value={glidePct} onChange={(e) => setGlidePct(Number(e.target.value))}>
              <option value={0}>None: fixed targets</option>
              {[50, 70, 90]
                .filter((p) => p * 100 > (mandate.assets[LISTINGS.findIndex((l) => "stable" in l)]?.targetBps ?? 10_000))
                .map((p) => (
                  <option key={p} value={p}>
                    To {p}% cash by the end
                  </option>
                ))}
            </select>
          </label>
          <button className="btn" style={{ alignSelf: "end" }} onClick={() => setSeed((s) => s + 1)} disabled={busy}>
            New random markets
          </button>
        </div>
      </Card>

      {result && (
        <div className={`grid-2 ${busy ? "stale" : ""}`} aria-busy={busy}>
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

      <AfterTax mandate={mandate} usdSize={usdSize} years={years} feePct={feePct} seed={seed} />

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

/** The plain pilot and the tax-aware one over the same markets, before and after tax. Run on demand: a few seconds. */
function AfterTax(props: { mandate: Mandate; usdSize: number; years: number; feePct: number; seed: number }) {
  const [shortPct, setShortPct] = useState(35);
  const [longPct, setLongPct] = useState(15);
  const [budget, setBudget] = useState("0");
  const job = useComputeJob<TaxBacktestResult>();
  const { result, busy } = job;
  useEffect(() => job.reset(), [props.mandate, props.usdSize, props.years, props.feePct, props.seed]);

  function run() {
    const gainBudgetUsd = budget.trim() === "" ? undefined : Math.max(0, Number(budget));
    job.run({
      kind: "tax",
      options: { assets: modelsFor(LISTINGS), mandate: props.mandate, startUsd: props.usdSize, days: 252 * props.years, paths: 100, seed: props.seed, venueFeeBps: 10, feeBps: Math.round(props.feePct * 100) },
      rates: { shortTermRateBps: Math.round(shortPct * 100), longTermRateBps: Math.round(longPct * 100), deferDays: 0, gainBudgetUsd },
    });
  }

  const bps = (v: number) => `${(v / 100).toFixed(1)} pts`;
  return (
    <Card title="After tax" aside={busy ? <span className="pill info">Running: {progressLabel(job.done, job.total, "paths, twice")}</span> : <span className="muted small">estimates, not tax advice</span>}>
      <p className="small" style={{ marginTop: 0 }}>
        Rebalancing sells winners, and selling is taxable. The tax-aware pilot flies the same mandate over the same markets, choosing among the trades that
        still rebalance the one that costs the least tax, and keeping within a yearly budget for net gains unless an asset leaves its band.
      </p>
      <div className="row">
        <label className="field" style={{ width: 150 }}>
          Short-term rate (%)
          <input type="number" min={0} max={60} value={shortPct} onChange={(e) => setShortPct(Math.min(100, Math.max(0, Number(e.target.value))))} />
        </label>
        <label className="field" style={{ width: 150 }}>
          Long-term rate (%)
          <input type="number" min={0} max={40} value={longPct} onChange={(e) => setLongPct(Math.min(100, Math.max(0, Number(e.target.value))))} />
        </label>
        <label className="field" style={{ width: 200 }}>
          Gains budget ($ a year, blank: none)
          <input type="number" min={0} step={100} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <button className="btn primary" style={{ alignSelf: "end" }} disabled={busy} onClick={run}>
          {busy ? "Running…" : "Compare after tax"}
        </button>
      </div>
      {result && (
        <>
          <div className="table-scroll">
            <table className="holdings" aria-label="After-tax comparison">
              <thead>
                <tr>
                  <th />
                  <th className="num">Plain pilot</th>
                  <th className="num">Tax-aware pilot</th>
                  <th className="num">Buy and hold</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Tax due along the way, typical</td>
                  <td className="num">{money(result.plain.taxAlongTheWayUsd)}</td>
                  <td className="num">{better(result.aware.taxAlongTheWayUsd < result.plain.taxAlongTheWayUsd, money(result.aware.taxAlongTheWayUsd))}</td>
                  <td className="num">{money(0)}</td>
                </tr>
                <tr>
                  <td>After tax, if sold at the end, typical</td>
                  <td className="num">{money(result.plain.afterTaxFinalUsd)}</td>
                  <td className="num">{better(result.aware.afterTaxFinalUsd > result.plain.afterTaxFinalUsd, money(result.aware.afterTaxFinalUsd))}</td>
                  <td className="num">{money(result.hold.afterTaxFinalUsd)}</td>
                </tr>
                <tr>
                  <td>Trades a year</td>
                  <td className="num">{result.plain.tradesPerYear.toFixed(1)}</td>
                  <td className="num">{result.aware.tradesPerYear.toFixed(1)}</td>
                  <td className="num">0</td>
                </tr>
                <tr>
                  <td>Largest drift from target, bad case</td>
                  <td className="num">{bps(result.plain.maxDriftBpsP95)}</td>
                  <td className="num">{bps(result.aware.maxDriftBpsP95)}</td>
                  <td className="num">–</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Over the same markets, the tax-aware pilot paid less tax along the way in {result.savedPathsPct.toFixed(0)}% of them and more in{" "}
            {result.costlierPathsPct.toFixed(0)}%, {result.savedUsd >= 0 ? `saving ${money(result.savedUsd)}` : `costing ${money(-result.savedUsd)}`} on average.
            The price of a gains budget is drift: assets wander further from target, up to their bands, before the pilot sells. Trades the vault would
            reject: {result.rejected}. Gains net within each year and losses carry forward; wash-sale adjustments are left out, which can only flatter
            the plain pilot.
          </p>
        </>
      )}
    </Card>
  );
}

const better = (yes: boolean, text: string) => (yes ? <strong>{text}</strong> : text);

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

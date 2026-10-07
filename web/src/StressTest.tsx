// Stress test the drafted mandate before signing: stylized crashes, flown three ways with the real planner and rules.

import { useMemo, useState } from "react";
import { LISTINGS } from "../../agent/listings";
import type { Mandate } from "../../agent/mandate";
import { modelsFor, safeTargetChoices } from "../../agent/backtest";
import { SCENARIOS, stressTest, type StressResult } from "../../agent/stress";
import { LineChart, compactUsd } from "./LineChart";
import { Card } from "./ui";

const money = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (v: number) => `${v.toFixed(1)}%`;

export function StressTest({ mandate, usdSize }: { mandate: Mandate; usdSize: number }) {
  const safeIndex = Math.max(0, LISTINGS.findIndex((l) => "stable" in l));
  const safeNow = mandate.assets[safeIndex].targetBps / 100;
  const [drawdown, setDrawdown] = useState(15);
  const choices = safeTargetChoices(safeNow);
  const [picked, setSafeTarget] = useState<number | null>(choices.fallback);
  const safeTarget = picked !== null && choices.options.includes(picked) ? picked : choices.fallback;
  const [selected, setSelected] = useState(SCENARIOS[0].id);

  const results = useMemo<StressResult[]>(
    () =>
      SCENARIOS.map((s) =>
        // With the stablecoin already at 100% there is nothing to de-risk: the guard is simply off.
        stressTest({ assets: modelsFor(LISTINGS), mandate, startUsd: usdSize, guard: { safeIndex, safeTargetBps: (safeTarget ?? safeNow) * 100, drawdownBps: safeTarget === null ? 0 : drawdown * 100 } }, s),
      ),
    [mandate, usdSize, safeIndex, safeTarget, drawdown],
  );
  const r = results.find((x) => x.scenario.id === selected) ?? results[0];
  const stable = LISTINGS[safeIndex].symbol;

  return (
    <Card title="Stress test before you sign" aside={<span className="muted small">stylized scenarios, not history</span>}>
      <p className="small" style={{ marginTop: 0 }}>
        Your draft mandate through five shaped markets, three ways: left alone, flown by the pilot, and flown with the crash guard armed (past a{" "}
        {drawdown}% fall from the peak, {stable} goes to {safeTarget ?? 100}%). Same planner and same rules as the vault.
      </p>
      <div className="row">
        <label className="field" style={{ width: 170 }}>
          Crash guard trips at
          <select value={drawdown} onChange={(e) => setDrawdown(Number(e.target.value))}>
            {[10, 15, 20, 25, 30].map((d) => (
              <option key={d} value={d}>
                a {d}% fall
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ width: 170 }}>
          Then {stable} at
          <select value={safeTarget ?? ""} disabled={safeTarget === null} onChange={(e) => setSafeTarget(Number(e.target.value))}>
            {choices.options.map((t) => (
              <option key={t} value={t}>
                {t}%
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-scroll">
        <table className="holdings stress-table">
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="num">Left alone</th>
              <th className="num">Pilot</th>
              <th className="num">Pilot + guard</th>
            </tr>
          </thead>
          <tbody>
            {results.map((x) => {
              const best = Math.min(x.hold.maxDrawdownPct, x.pilot.maxDrawdownPct, x.guarded.maxDrawdownPct);
              const cell = (o: StressResult["hold"]) => (
                <td className="num">
                  <div>{money(o.finalUsd)}</div>
                  <div className="muted small">{o.maxDrawdownPct === best ? <strong>−{pct(o.maxDrawdownPct)}</strong> : `−${pct(o.maxDrawdownPct)}`} worst</div>
                </td>
              );
              return (
                <tr key={x.scenario.id} aria-selected={x.scenario.id === r.scenario.id} className={x.scenario.id === r.scenario.id ? "row-selected" : undefined}>
                  <td>
                    <button className="linkish" onClick={() => setSelected(x.scenario.id)}>
                      {x.scenario.name}
                    </button>
                    <div className="muted small">{x.guarded.defensiveDay === null ? "guard not tripped" : `guard trips on day ${x.guarded.defensiveDay}`}</div>
                  </td>
                  {cell(x.hold)}
                  {cell(x.pilot)}
                  {cell(x.guarded)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">Ending value, and the deepest fall from a peak along the way (bold: the smallest of the three).</p>

      <LineChart
        title={`${r.scenario.name}: ${r.scenario.description}`}
        series={[
          { name: "Left alone", values: r.hold.values },
          { name: "Pilot", values: r.pilot.values },
          { name: "Pilot + guard", values: r.guarded.values },
        ]}
        xLabel={(i) => (i === 0 ? "Start" : `Day ${i}`)}
        format={compactUsd}
        height={240}
      />
      <p className="muted small" style={{ marginBottom: 0 }}>
        The guard trades protection for missed rebounds: it cuts the fall in a long bear market, but after a fast V-shaped recovery it can end
        behind, because it de-risked near the bottom and only you can lift it. Stocks follow each scenario's market path by their own sensitivity, with a
        little noise; the scenarios are shapes chosen to test the rules, not historical prices or forecasts. Not financial advice.
      </p>
    </Card>
  );
}

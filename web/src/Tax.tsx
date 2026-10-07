// The owner's tax report: realized gains lot by lot, open lots, loss-harvesting candidates, and a CSV for the
// accountant. Everything is computed in the browser from the vault's onchain history.

import { useMemo, useState } from "react";
import { formatUnits, type Abi, type Address, type PublicClient } from "viem";
import { LISTINGS } from "../../agent/listings";
import type { AssetState } from "../../agent/model";
import { ASSUMPTIONS, harvestable, readTaxEvents, salesCsv, taxReport, type AssetInfo, type TaxReport } from "../../agent/tax";
import { Card, usd } from "./ui";

const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const signed = (wad: bigint) => (wad < 0n ? `−${usd(-wad)}` : usd(wad));
const tone = (wad: bigint) => (wad < 0n ? "down" : wad > 0n ? "up" : "");

export function TaxCard({ client, vault, abi, assets }: { client: PublicClient; vault: Address; abi: Abi; assets: AssetState[] }) {
  const [report, setReport] = useState<TaxReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);

  const info = useMemo(
    () =>
      new Map<string, AssetInfo>(
        assets.map((a) => [a.token.toLowerCase(), { symbol: a.symbol, decimals: a.decimals, cash: LISTINGS.some((l) => l.symbol === a.symbol && "stable" in l) }]),
      ),
    [assets],
  );

  async function build() {
    setLoading(true);
    setError(null);
    try {
      const head = await client.getBlockNumber();
      const events = await readTaxEvents(client, abi, vault, head > 500_000n ? head - 500_000n : 0n);
      const r = taxReport(events, info);
      setReport(r);
      setYear(r.years.at(-1)?.year ?? new Date().getUTCFullYear());
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setLoading(false);
    }
  }

  const summary = report?.years.find((y) => y.year === year);
  const sales = (report?.sales ?? []).filter((s) => new Date(s.sold * 1000).getUTCFullYear() === year);
  const prices = new Map(assets.map((a) => [a.token.toLowerCase(), a.price]));
  const harvest = report ? harvestable(report.open, (t) => prices.get(t.toLowerCase()), info) : [];
  const unrealized = (report?.open ?? []).reduce((t, l) => {
    const a = info.get(l.token.toLowerCase());
    const p = prices.get(l.token.toLowerCase());
    return a && p !== undefined ? t + (l.amount * p) / 10n ** BigInt(a.decimals) - l.basisUsd : t;
  }, 0n);

  function download() {
    if (!report || year === null) return;
    const blob = new Blob([salesCsv(report, info, year)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `stockpilot-${vault.slice(0, 8)}-${year}-gains.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card title="Taxes" aside={report && report.years.length > 0 ? (
      <select aria-label="Tax year" style={{ width: "auto", minWidth: 90 }} value={year ?? ""} onChange={(e) => setYear(Number(e.target.value))}>
        {report.years.map((y) => <option key={y.year} value={y.year}>{y.year}</option>)}
      </select>
    ) : <span className="muted small">not tax advice</span>}>
      {!report ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            Realized gains and losses lot by lot (first in, first out), short and long term, with a CSV in the shape of Form 8949, all rebuilt from
            this vault's onchain history: deposits priced by its oracles, every trade, the fee.
          </p>
          <button className="btn" disabled={loading} onClick={build}>
            {loading ? "Reading the chain…" : "Build tax report"}
          </button>
          {error && <p className="notice bad">{error}</p>}
        </>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="label">Short-term gain</div>
              <div className={`value ${tone(summary?.shortTermUsd ?? 0n)}`}>{signed(summary?.shortTermUsd ?? 0n)}</div>
            </div>
            <div className="stat">
              <div className="label">Long-term gain</div>
              <div className={`value ${tone(summary?.longTermUsd ?? 0n)}`}>{signed(summary?.longTermUsd ?? 0n)}</div>
            </div>
            <div className="stat">
              <div className="label">Fees paid</div>
              <div className="value">{usd(summary?.feesUsd ?? 0n)}</div>
            </div>
            <div className="stat">
              <div className="label">Unrealized, open lots</div>
              <div className={`value ${tone(unrealized)}`}>{signed(unrealized)}</div>
            </div>
          </div>

          {sales.length === 0 ? (
            <p className="muted small">No sales in {year}. Buying is not taxable; the first sale of a stock is.</p>
          ) : (
            <div className="table-scroll">
              <table className="holdings">
                <thead>
                  <tr>
                    <th>Sold</th>
                    <th>Asset</th>
                    <th className="num">Proceeds</th>
                    <th className="num">Basis</th>
                    <th className="num">Gain</th>
                    <th>Term</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((s, i) => (
                    <tr key={`${s.tx}-${i}`}>
                      <td>{day(s.sold)}</td>
                      <td>
                        {Number(formatUnits(s.amount, info.get(s.token.toLowerCase())?.decimals ?? 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} {s.symbol}
                        {s.via === "fee" && <span className="muted small"> fee</span>}
                        {!s.basisKnown && <span className="pill warn" style={{ marginLeft: 6 }}>basis?</span>}
                      </td>
                      <td className="num">{usd(s.proceedsUsd)}</td>
                      <td className="num">{usd(s.basisUsd)}</td>
                      <td className={`num ${tone(s.gainUsd)}`}>{signed(s.gainUsd)}</td>
                      <td>{s.term === "long" ? "Long" : "Short"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {harvest.length > 0 && (
            <p className="notice small">
              Loss-harvesting candidates: {harvest.slice(0, 3).map((h) => `${h.symbol} lot from ${day(h.acquired)} is ${usd(h.lossUsd)} under its basis`).join("; ")}.
              Selling would realize the loss; mind wash-sale rules if you buy it back within 30 days.
            </p>
          )}
          {report.warnings.map((w) => (
            <p key={w} className="notice warn small">{w}</p>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={sales.length === 0} onClick={download}>
              Download {year} CSV
            </button>
            <button className="btn" onClick={build}>
              Refresh
            </button>
          </div>
          <details className="small muted" style={{ marginTop: 10 }}>
            <summary>How this is computed (not tax advice)</summary>
            <ul>
              {ASSUMPTIONS.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Card>
  );
}

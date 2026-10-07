// Monthly statements, like a broker's, built from the chain and printable (or saved as PDF from the print dialog).

import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Abi, type Address, type PublicClient } from "viem";
import { LISTINGS } from "../../agent/listings";
import type { VaultState } from "../../agent/model";
import { buildStatement, monthsBetween, type Statement } from "../../agent/statement";
import { readTaxEvents, type AssetInfo } from "../../agent/tax";
import { Card, usd } from "./ui";

const date = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const signed = (wad: bigint) => (wad < 0n ? `−${usd(-wad)}` : usd(wad));
const minus = (wad: bigint) => (wad === 0n ? usd(0n) : `−${usd(wad)}`);

export function StatementCard(props: { client: PublicClient; vault: Address; abi: Abi; state: VaultState; owner: Address; chainName: string }) {
  const { client, vault, abi, state, owner, chainName } = props;
  const [first, setFirst] = useState<number | null>(null);
  const [month, setMonth] = useState(0);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const info = useMemo(
    () => new Map<string, AssetInfo>(state.assets.map((a) => [a.token.toLowerCase(), { symbol: a.symbol, decimals: a.decimals, cash: LISTINGS.some((l) => l.symbol === a.symbol && "stable" in l) }])),
    [state.assets],
  );

  useEffect(() => {
    // The vault's first activity bounds the months on offer.
    readTaxEvents(client, abi, vault)
      .then((ev) => setFirst(ev[0]?.time ?? Number(state.now)))
      .catch(() => setFirst(Number(state.now)));
  }, [client, abi, vault, state.now]);

  const months = first === null ? [] : monthsBetween(first, Number(state.now));
  const period = months[month];

  async function build() {
    if (!period) return;
    setBusy(true);
    setError(null);
    try {
      const events = await readTaxEvents(client, abi, vault);
      setStatement(await buildStatement(client, abi, vault, info, period.start - 1, period.end, events));
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  function print() {
    document.body.classList.add("printing-statement");
    window.addEventListener("afterprint", () => document.body.classList.remove("printing-statement"), { once: true });
    window.print();
  }

  return (
    <Card title="Statements" aside={<span className="muted small">built from the chain</span>}>
      <div className="row">
        <label className="field" style={{ width: 200 }}>
          Month
          <select value={month} onChange={(e) => (setMonth(Number(e.target.value)), setStatement(null))}>
            {months.map((m, i) => (
              <option key={m.label} value={i}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" style={{ alignSelf: "end" }} disabled={busy || !period} onClick={build}>
          {busy ? "Reading the chain…" : "Open statement"}
        </button>
        {statement && (
          <button className="btn primary" style={{ alignSelf: "end" }} onClick={print}>
            Print / Save as PDF
          </button>
        )}
      </div>
      {error && <p className="notice bad">{error}</p>}

      {statement && period && (
        <section className="statement-sheet" aria-label={`Statement for ${period.label}`}>
          <header className="statement-head">
            <div>
              <strong>StockPilot vault statement</strong>
              <div className="small">{period.label}</div>
            </div>
            <div className="small statement-meta">
              <div>
                Vault <span className="mono">{vault}</span>
              </div>
              <div>
                Owner <span className="mono">{owner}</span>
              </div>
              <div>
                {chainName} · blocks {statement.from.block.toString()} to {statement.to.block.toString()} · {date(statement.from.time)} to {date(statement.to.time)}
              </div>
            </div>
          </header>

          <h4>Account summary</h4>
          <table className="holdings statement-summary">
            <tbody>
              <tr><td>Opening value</td><td className="num">{usd(statement.openingUsd)}</td></tr>
              <tr><td>Deposits</td><td className="num">{usd(statement.depositsUsd)}</td></tr>
              <tr><td>Withdrawals</td><td className="num">{minus(statement.withdrawalsUsd)}</td></tr>
              <tr><td>Management fees</td><td className="num">{minus(statement.feesUsd)}</td></tr>
              <tr><td>Markets and trading</td><td className="num">{signed(statement.marketAndTradingUsd)}</td></tr>
              <tr className="statement-total"><td>Closing value</td><td className="num">{usd(statement.closingUsd)}</td></tr>
              <tr><td>Realized gains (short / long term)</td><td className="num">{signed(statement.realized.shortTermUsd)} / {signed(statement.realized.longTermUsd)}</td></tr>
            </tbody>
          </table>

          <h4>Holdings at close</h4>
          <table className="holdings">
            <thead>
              <tr><th>Asset</th><th className="num">Quantity</th><th className="num">Price</th><th className="num">Value</th><th className="num">Weight</th><th className="num">Target</th></tr>
            </thead>
            <tbody>
              {statement.holdings.map((h) => (
                <tr key={h.symbol}>
                  <td>{h.symbol}</td>
                  <td className="num">{Number(formatUnits(h.balance, h.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                  <td className="num">{usd(h.priceUsd)}</td>
                  <td className="num">{usd(h.valueUsd)}</td>
                  <td className="num">{(h.weightBps / 100).toFixed(1)}%</td>
                  <td className="num">{(h.targetBps / 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>Activity ({statement.lines.length})</h4>
          {statement.lines.length === 0 ? (
            <p className="muted small">No deposits, withdrawals, trades or fees this period.</p>
          ) : (
            <table className="holdings">
              <thead>
                <tr><th>Date</th><th>What</th><th className="num">Value</th><th>Transaction</th></tr>
              </thead>
              <tbody>
                {statement.lines.map((l, i) => (
                  <tr key={`${l.tx}-${i}`}>
                    <td>{date(l.time)}</td>
                    <td>{l.text}</td>
                    <td className="num">{usd(l.valueUsd)}</td>
                    <td className="mono small">{l.tx.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>Rules in force at close</h4>
          <p className="small" style={{ margin: 0 }}>
            At most {usd(state.limits.maxTradeUsd, false)} per trade and {usd(state.limits.dailyLimitUsd, false)} per 24 hours; {state.limits.maxSlippageBps / 100}% max
            slippage at oracle prices; {Math.round(state.limits.cooldown / 60)} minutes between trades; no trading on prices older than{" "}
            {Math.round(state.limits.maxPriceAge / 60)} minutes. Targets and bands as above, enforced by the vault contract.
          </p>
          <p className="muted small statement-foot">
            Every figure is read from the chain at the blocks shown, at the vault's own oracle prices; each transaction can be checked in an explorer.
            Realized gains match lots first in, first out over the vault's whole history. Not tax advice.
          </p>
        </section>
      )}
    </Card>
  );
}

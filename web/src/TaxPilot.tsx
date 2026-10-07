// The tax-aware pilot, for one vault: what the next rebalance would realize with and without tax awareness, this
// year's gains against the owner's budget, and the owner's signed preferences for the hosted pilot.

import { useState } from "react";
import type { Abi, Address, PublicClient, WalletClient } from "viem";
import type { VaultState } from "../../agent/model";
import { plan, taxSummary, type Plan } from "../../agent/planner";
import { estimateSale, taxPolicyFor, taxPreferencesMessage, type TaxPolicy, type TaxPreferences, type UnsignedTaxPreferences } from "../../agent/taxaware";
import { Card, usd } from "./ui";

type Preview = { plain: Plan; aware: Plan; policy: TaxPolicy };

export function TaxPilotCard(props: { client: PublicClient; wallet: WalletClient | null; vault: Address; abi: Abi; state: VaultState; chainId: number; isOwner: boolean }) {
  const { client, wallet, vault, abi, state, chainId, isOwner } = props;
  const [enabled, setEnabled] = useState(true);
  const [shortPct, setShortPct] = useState(35);
  const [longPct, setLongPct] = useState(15);
  const [budget, setBudget] = useState("0");
  const [wait, setWait] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const [signed, setSigned] = useState<TaxPreferences | null>(null);

  const budgetUsd = budget.trim() === "" ? null : Math.max(0, Math.floor(Number(budget)));
  const prefs = { shortTermRateBps: Math.round(shortPct * 100), longTermRateBps: Math.round(longPct * 100), gainBudgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null, deferDays: wait };

  async function run() {
    setBusy(true);
    setStatus(null);
    try {
      const policy = await taxPolicyFor(client, abi, state, prefs);
      setPreview({ plain: plan(state), aware: plan(state, undefined, policy), policy });
    } catch (e) {
      setStatus({ tone: "bad", text: (e as Error).message.split("\n")[0] });
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!wallet?.account) return;
    setStatus(null);
    const unsigned: UnsignedTaxPreferences = { kind: "tax-preferences", vault, chainId, enabled, ...prefs, issuedAt: Math.floor(Date.now() / 1000) };
    try {
      setStatus({ tone: "info", text: "Sign the message in your wallet. It costs nothing and sends no transaction." });
      const signature = await wallet.signMessage({ account: wallet.account, message: taxPreferencesMessage(unsigned) });
      const doc = { ...unsigned, signature };
      setSigned(doc);
      const res = await fetch("/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) }).catch(() => null);
      const body = res ? await res.json().catch(() => ({})) : {};
      if (res?.ok && body.forwarded) setStatus({ tone: "info", text: enabled ? "Saved. Your hosted pilot is now tax-aware on this vault." : "Saved. Your hosted pilot is no longer tax-aware on this vault." });
      else if (res?.ok) setStatus({ tone: "info", text: "Signature verified. This deployment has no store yet: send the preferences below to your pilot's operator." });
      else setStatus({ tone: "bad", text: body.error ?? "The pilot service is not reachable here. Send the preferences below to your pilot's operator." });
    } catch (e) {
      setStatus({ tone: "bad", text: (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message });
    }
  }

  const describe = (p: Plan, policy: TaxPolicy) => {
    if (p.action === "hold") return p.reason;
    const sell = state.assets.find((a) => a.token === p.trade.tokenIn)!;
    const buy = state.assets.find((a) => a.token === p.trade.tokenOut)!;
    const est = estimateSale(policy, sell.token, p.trade.amountIn, sell.price, sell.decimals, Number(state.now));
    return `Sell ${usd(p.trade.valueUsd)} of ${sell.symbol} for ${buy.symbol}. ${taxSummary(est, policy)}`;
  };

  return (
    <Card title="Tax-aware pilot" aside={<span className="muted small">estimates, not tax advice</span>}>
      <p className="small" style={{ marginTop: 0 }}>
        The vault sells lots first in, first out, so the pilot can know what a sale realizes before making it. Tax-aware, it sells what costs the least
        tax among the trades that still rebalance, avoids buying back what it just sold at a loss, and keeps within your yearly gains budget. A band always
        wins: anything outside it is traded back whatever the tax.
      </p>
      <div className="guardrails" style={{ marginTop: 0 }}>
        <label className="field">
          Short-term rate (%)
          <input type="number" min={0} max={60} step={1} value={shortPct} onChange={(e) => setShortPct(Math.min(100, Math.max(0, Number(e.target.value))))} />
        </label>
        <label className="field">
          Long-term rate (%)
          <input type="number" min={0} max={40} step={1} value={longPct} onChange={(e) => setLongPct(Math.min(100, Math.max(0, Number(e.target.value))))} />
        </label>
        <label className="field">
          Yearly gains budget ($, blank for none)
          <input type="number" min={0} step={100} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label className="field">
          Wait for long-term rates
          <select value={wait} onChange={(e) => setWait(Number(e.target.value))}>
            <option value={0}>No</option>
            <option value={30}>Up to 30 days</option>
          </select>
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" disabled={busy} onClick={run}>
          {busy ? "Reading the chain…" : "Preview the next rebalance"}
        </button>
        {isOwner && wallet && (
          <>
            <label className="row small">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On for my hosted pilot
            </label>
            <button className="btn primary" onClick={sign}>
              Sign preferences
            </button>
          </>
        )}
      </div>

      {preview && (
        <div className="tax-preview" aria-label="Next rebalance">
          <div className="small">
            Realized this year: <strong>{usd(preview.policy.realizedThisYearUsd ?? 0n)}</strong>
            {preview.policy.gainBudgetUsd !== undefined && <> of a {usd(preview.policy.gainBudgetUsd)} budget</>}
          </div>
          <table className="holdings">
            <tbody>
              <tr>
                <td>Plain pilot</td>
                <td>{describe(preview.plain, preview.policy)}</td>
              </tr>
              <tr>
                <td>Tax-aware</td>
                <td>{describe(preview.aware, preview.policy)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {status && <p className={`notice ${status.tone === "bad" ? "bad" : ""}`}>{status.text}</p>}
      {signed && (
        <details className="small">
          <summary>Signed preferences</summary>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(signed, null, 2)}
          </pre>
        </details>
      )}
    </Card>
  );
}

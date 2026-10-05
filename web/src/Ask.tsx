// "Ask your vault": questions in plain words, answered from facts this page reads from the chain. Every cited
// transaction is checked against the vault's history; trade reasons count only when they match the onchain hash.

import { useState } from "react";
import { formatUnits, type Abi, type Address, type Hash, type PublicClient } from "viem";
import type { AskResult, VaultFacts } from "../../agent/ask";
import { LISTINGS } from "../../agent/listings";
import { available, type VaultState } from "../../agent/model";
import { plan } from "../../agent/planner";
import { readTaxEvents, taxReport, type AssetInfo } from "../../agent/tax";
import { loadActivity } from "./Activity";
import { explorerTx } from "./chains";
import { Card, totalUsd, valueUsd } from "./ui";

const REASON_KEY = (hash: string) => `stockpilot:reason:${hash.toLowerCase()}`;

/** Remember the pilot's written reason for a trade sent from this browser, so it can be explained later. */
export function rememberReason(rationaleHash: string, rationale: string) {
  try {
    localStorage.setItem(REASON_KEY(rationaleHash), rationale);
  } catch {
    // storage unavailable: the trade is still explained from the numbers
  }
}

function recalledReason(hash: string) {
  try {
    return localStorage.getItem(REASON_KEY(hash));
  } catch {
    return null;
  }
}

const usdNum = (wad: bigint) => Number(wad / 10n ** 12n) / 1e6;
const iso = (t?: number) => (t ? new Date(t * 1000).toISOString() : "unknown");

async function gatherFacts(p: {
  client: PublicClient;
  vault: Address;
  abi: Abi;
  chainName: string;
  state: VaultState;
  owner: Address;
  pilot: Address;
  pilotName: string | null;
  feeBps: number;
}): Promise<VaultFacts> {
  const { client, vault, abi, state } = p;
  const total = totalUsd(state.assets);
  const now = Number(state.now);
  const head = await client.getBlockNumber();
  const [activity, tradeLogs, heir, period, claimableAt, taxEvents] = await Promise.all([
    loadActivity(client, vault, abi, state.assets, p.owner, p.pilot),
    client.getContractEvents({ address: vault, abi, eventName: "Rebalanced", fromBlock: head > 50_000n ? head - 50_000n : 0n }),
    client.readContract({ address: vault, abi, functionName: "heir" }) as Promise<Address>,
    client.readContract({ address: vault, abi, functionName: "inactivityPeriod" }) as Promise<number>,
    client.readContract({ address: vault, abi, functionName: "inheritanceClaimableAt" }) as Promise<bigint>,
    readTaxEvents(client, abi, vault, head > 500_000n ? head - 500_000n : 0n).catch(() => null),
  ]);
  const sym = (t: unknown) => state.assets.find((a) => a.token.toLowerCase() === String(t).toLowerCase())?.symbol ?? String(t).slice(0, 8);
  const times = new Map(activity.entries.map((e) => [e.tx.toLowerCase(), e.time]));

  const info = new Map<string, AssetInfo>(state.assets.map((a) => [a.token.toLowerCase(), { symbol: a.symbol, decimals: a.decimals, cash: LISTINGS.some((l) => l.symbol === a.symbol && "stable" in l) }]));
  let taxes: VaultFacts["taxes"] = null;
  if (taxEvents) {
    const r = taxReport(taxEvents, info);
    const year = new Date(now * 1000).getUTCFullYear();
    const y = r.years.find((x) => x.year === year);
    const unrealized = r.open.reduce((t, l) => {
      const a = state.assets.find((x) => x.token.toLowerCase() === l.token.toLowerCase());
      return a ? t + (l.amount * a.price) / 10n ** BigInt(a.decimals) - l.basisUsd : t;
    }, 0n);
    taxes = { year, shortTermGainUsd: usdNum(y?.shortTermUsd ?? 0n), longTermGainUsd: usdNum(y?.longTermUsd ?? 0n), feesPaidUsd: usdNum(y?.feesUsd ?? 0n), unrealizedGainUsd: usdNum(unrealized) };
  }
  const p2 = plan(state);
  const hasHeir = !/^0x0+$/.test(heir);

  return {
    vault,
    chain: p.chainName,
    asOf: iso(now),
    status: {
      paused: state.paused,
      totalUsd: usdNum(total),
      pilot: p.pilot,
      pilotName: p.pilotName,
      feePercentPerYear: p.feeBps / 100,
      nextMove: p2.action === "trade" ? p2.trade.rationale : p2.reason,
    },
    holdings: state.assets.map((a) => ({
      symbol: a.symbol,
      valueUsd: usdNum(valueUsd(a)),
      weightPct: total === 0n ? 0 : Number((valueUsd(a) * 10_000n) / total) / 100,
      targetPct: a.targetBps / 100,
      bandPct: a.bandBps / 100,
      priceUsd: Number(formatUnits(a.price, 18)),
      priceAgeMinutes: Math.max(0, Math.round((now - Number(a.priceUpdatedAt)) / 60)),
    })),
    limits: {
      maxTradeUsd: usdNum(state.limits.maxTradeUsd),
      dailyLimitUsd: usdNum(state.limits.dailyLimitUsd),
      budgetLeftUsd: usdNum(available(state)),
      maxSlippagePct: state.limits.maxSlippageBps / 100,
      cooldownMinutes: Math.round(state.limits.cooldown / 60),
      maxPriceAgeMinutes: Math.round(state.limits.maxPriceAge / 60),
    },
    trades: tradeLogs
      .slice(-40)
      .reverse()
      .map((l) => {
        const a = (l as unknown as { args: Record<string, unknown> }).args;
        const hash = String(a.rationale);
        return {
          tx: l.transactionHash as Hash,
          time: iso(times.get(l.transactionHash!.toLowerCase())),
          sold: sym(a.tokenIn),
          bought: sym(a.tokenOut),
          valueUsd: usdNum(a.valueInUsd as bigint),
          rationaleHash: hash,
          rationale: recalledReason(hash),
        };
      }),
    events: activity.entries
      .filter((e) => e.kind !== "trade")
      .slice(0, 40)
      .map((e) => ({ tx: e.tx, time: iso(e.time), text: e.text.slice(0, 300) })),
    taxes,
    inheritance: {
      heir: hasHeir ? heir : null,
      periodDays: Number(period) / 86_400,
      heirCanClaimFrom: hasHeir ? iso(Number(claimableAt)) : null,
    },
  };
}

const SUGGESTIONS = ["Why did the pilot last trade?", "How much can the pilot trade today?", "What are my realized gains this year?", "What happens if I lose my keys?"];

type Turn = { question: string; result?: AskResult; error?: string };

export function AskCard(props: {
  client: PublicClient;
  vault: Address;
  abi: Abi;
  chainId: number;
  chainName: string;
  state: VaultState;
  owner: Address;
  pilot: Address;
  pilotName: string | null;
  feeBps: number;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true);
    setQuestion("");
    const history = turns.filter((t) => t.result).map((t) => ({ question: t.question, answer: t.result!.answer }));
    setTurns((ts) => [...ts, { question: q }]);
    try {
      // Fresh facts for every question: the vault may have traded since the last one.
      const facts = await gatherFacts(props);
      const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q, facts, history }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, result: json as AskResult } : t)));
    } catch (e) {
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, error: (e as Error).message.split("\n")[0] } : t)));
    } finally {
      setBusy(false);
    }
  }

  const last = turns.at(-1)?.result;
  const chips = last?.followUps.length ? last.followUps : SUGGESTIONS;

  return (
    <Card title="Ask your vault" aside={<span className="muted small">answers only from onchain facts</span>}>
      {turns.length > 0 && (
        <div className="chat" aria-live="polite">
          {turns.map((t, i) => (
            <div key={i} className="chat-turn">
              <p className="chat-q">{t.question}</p>
              {t.error ? (
                <p className="notice bad small">{t.error}</p>
              ) : !t.result ? (
                <p className="muted small">Reading the chain…</p>
              ) : (
                <div className="chat-a">
                  <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{t.result.answer}</p>
                  <p className="muted small" style={{ margin: "6px 0 0" }}>
                    {t.result.source === "claude" ? "Claude, from your vault's facts" : "Answered from your vault's facts (no AI)"}
                    {t.result.citations.map((c) => (
                      <span key={c}>
                        {" · "}
                        {explorerTx(props.chainId, c) ? (
                          <a href={explorerTx(props.chainId, c)} target="_blank" rel="noreferrer" className="mono">
                            tx {c.slice(0, 10)}…
                          </a>
                        ) : (
                          <span className="mono" title={c}>
                            tx {c.slice(0, 10)}…
                          </span>
                        )}
                      </span>
                    ))}
                  </p>
                  {t.result.dropped.length > 0 && (
                    <p className="notice warn small">
                      Removed {t.result.dropped.length} cited transaction{t.result.dropped.length === 1 ? "" : "s"} that {t.result.dropped.length === 1 ? "is" : "are"} not in this vault's history.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="chips" style={{ marginTop: turns.length ? 10 : 0 }}>
        {chips.map((c) => (
          <button key={c} className="chip" disabled={busy} onClick={() => ask(c)}>
            {c}
          </button>
        ))}
      </div>
      <form
        className="row"
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          type="text"
          aria-label="Your question"
          placeholder="Why did you sell NVDA? Am I within my limits?"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button className="btn primary" disabled={busy || !question.trim()}>
          Ask
        </button>
      </form>
    </Card>
  );
}


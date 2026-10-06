import { encodeStrategy } from "../../agent/share";
import { useState } from "react";
import type { Proposal } from "../../agent/mandate";
import { LISTINGS } from "../../agent/listings";
import { Card, pct, usd } from "./ui";
import type { Draft } from "./App";

const EXAMPLES = [
  "I'm 30 and believe in AI and big tech for the long run. I can handle swings but want some cash on hand.",
  "I'm retiring in three years. Keep it steady and protect what I have.",
  "Mostly the S&P 500, a little Apple, nothing too wild.",
  "Aggressive growth. I won't touch this money for a decade.",
];

export function Strategist(props: {
  draft: Draft | null;
  onDraft: (goal: string, usd: number) => Promise<void>;
  onEdit: (p: Proposal) => void;
  onRefine: (instruction: string) => Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const [goal, setGoal] = useState(EXAMPLES[0]);
  const [size, setSize] = useState(10_000);
  const { draft } = props;

  return (
    <div className="grid-2">
      <Card title={<><span className="step">1</span>Describe your goal</>}>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={1000} aria-label="Your investing goal" />
        <div className="chips">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => setGoal(ex)}>
              {ex.length > 46 ? `${ex.slice(0, 44)}…` : ex}
            </button>
          ))}
        </div>
        <div className="row">
          <label className="field" style={{ width: 160 }}>
            Portfolio size (USD)
            <input type="number" min={100} step={100} value={size} onChange={(e) => setSize(Math.max(100, Number(e.target.value)))} />
          </label>
          <button className="btn primary" style={{ alignSelf: "end" }} disabled={props.busy || !goal.trim()} onClick={() => props.onDraft(goal, size)}>
            {props.busy ? "Drafting…" : "Draft my mandate"}
          </button>
        </div>
        {props.error && <p className="notice bad">{props.error}</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Claude drafts the allocation and guardrails. It never sees your keys and never moves funds: you review the draft and sign it
          yourself. Not financial advice.
        </p>
      </Card>

      <Card
        title={<><span className="step">2</span>Review the mandate</>}
        aside={
          draft && (
            <span className="row" style={{ gap: 6 }}>
              <ShareStrategy draft={draft} />
              <span className={`pill ${draft.source === "preset" ? "warn" : "info"}`}>
                {draft.source === "claude" ? "Drafted by Claude" : draft.source === "shared" ? "Shared strategy" : "Offline preset"}
              </span>
            </span>
          )
        }
      >
        {!draft ? (
          <p className="muted">Your draft appears here: target weights, how far each may drift, and how much the pilot may trade.</p>
        ) : (
          <MandateEditor draft={draft} onEdit={props.onEdit} onRefine={props.onRefine} />
        )}
      </Card>
    </div>
  );
}

function MandateEditor({ draft, onEdit, onRefine }: { draft: Draft; onEdit: (p: Proposal) => void; onRefine: (instruction: string) => Promise<void> }) {
  const [instruction, setInstruction] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const submitRefine = async () => {
    if (!instruction.trim()) return;
    setRefining(true);
    setRefineError(null);
    try {
      await onRefine(instruction);
      setInstruction("");
    } catch (e) {
      setRefineError((e as Error).message);
    }
    setRefining(false);
  };
  const p = draft.proposal;
  const sum = p.allocations.reduce((s, a) => s + a.weight_percent, 0);
  const setWeight = (symbol: string, w: number) =>
    onEdit({ ...p, allocations: p.allocations.map((a) => (a.symbol === symbol ? { ...a, weight_percent: w } : a)) });
  const limits = draft.mandate.limits;

  return (
    <>
      <p style={{ marginTop: 0 }}>{p.summary}</p>
      <div className="row" style={{ marginBottom: 12, flexWrap: "nowrap" }}>
        <input
          type="text"
          placeholder='Adjust in your own words, e.g. "less Tesla, more cash"'
          aria-label="Adjust the mandate in your own words"
          value={instruction}
          maxLength={300}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitRefine()}
        />
        <button className="btn" disabled={refining || !instruction.trim()} onClick={submitRefine}>
          {refining ? "Adjusting…" : "Adjust"}
        </button>
      </div>
      {refineError && <p className="notice bad">{refineError}</p>}
      {draft.changes && draft.changes.length > 0 && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <strong className="small">Changed:</strong>
          <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {draft.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="alloc">
        {LISTINGS.map((l, i) => {
          const a = p.allocations.find((x) => x.symbol.toUpperCase() === l.symbol);
          const w = a?.weight_percent ?? 0;
          return (
            <div className="alloc-row" key={l.symbol}>
              <strong>{l.symbol}</strong>
              <input
                type="range"
                min={0}
                max={100}
                step={0.5}
                value={w}
                aria-label={`${l.symbol} target weight`}
                onChange={(e) => setWeight(l.symbol, Number(e.target.value))}
              />
              <span className="num">{pct(draft.mandate.assets[i].targetBps)}</span>
              {a?.reason && <span className="reason">{a.reason}</span>}
            </div>
          );
        })}
      </div>
      {Math.abs(sum - 100) > 0.01 && <p className="notice warn">Weights add up to {sum.toFixed(1)}%; they are scaled to 100%.</p>}
      <div className="guardrails">
        <label className="field">
          Drift band (± points)
          <input type="number" min={1} max={20} step={0.5} value={p.band_percent} onChange={(e) => onEdit({ ...p, band_percent: Number(e.target.value) })} />
        </label>
        <label className="field">
          Max per trade (% of portfolio)
          <input type="number" min={1} max={50} value={p.max_trade_percent} onChange={(e) => onEdit({ ...p, max_trade_percent: Number(e.target.value) })} />
        </label>
        <label className="field">
          Max per day (% of portfolio)
          <input
            type="number"
            min={1}
            max={100}
            value={p.daily_turnover_percent}
            onChange={(e) => onEdit({ ...p, daily_turnover_percent: Number(e.target.value) })}
          />
        </label>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Enforced onchain: at most {usd(limits.maxTradeUsd, false)} per trade and {usd(limits.dailyLimitUsd, false)} per day, {limits.maxSlippageBps / 100}% max
        slippage against oracle prices, {limits.cooldown / 60} minutes between trades, no trading on prices older than {limits.maxPriceAge / 60} minutes.
      </p>
      {draft.adjustments.length > 0 && (
        <details className="small muted">
          <summary>{draft.adjustments.length} automatic fix(es) to the draft</summary>
          <ul>
            {draft.adjustments.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** Copies a link that opens this draft for anyone: the allocation and guardrails only, no addresses or keys. */
function ShareStrategy({ draft }: { draft: Draft }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn small"
      title="A link that opens this strategy for anyone to simulate, stress-test or copy into their own vault"
      onClick={() => {
        const link = `${window.location.origin}${window.location.pathname}?strategy=${encodeStrategy(draft.proposal)}`;
        navigator.clipboard?.writeText(link).then(
          () => setCopied(true),
          () => window.prompt("Copy this link", link),
        );
        setTimeout(() => setCopied(false), 2_000);
      }}
    >
      {copied ? "Link copied" : "Share strategy"}
    </button>
  );
}

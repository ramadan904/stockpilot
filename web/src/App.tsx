import { useMemo, useState } from "react";
import { diffProposals, presetFor, refineOffline, toMandate, type Mandate, type Proposal, type Strategy } from "../../agent/mandate";
import { decodeStrategy } from "../../agent/share";
import { LISTINGS } from "../../agent/listings";
import { Backtest } from "./Backtest";
import { Aura, AuraKey } from "./Glow";
import { Live } from "./Live";
import { Simulator } from "./Simulator";
import { simUniverse } from "./sim";
import { Strategist } from "./Strategist";
import { Network } from "./Network";

export interface Draft {
  proposal: Proposal;
  source: Strategy["source"];
  /** The mandate in the simulator's units; Live rebuilds it with the chain's addresses. */
  mandate: Mandate;
  adjustments: string[];
  usd: number;
  /** What the last refinement changed, in plain words. */
  changes?: string[];
}

const FIRST_GOAL = "I'm 30 and believe in AI and big tech for the long run. I can handle swings but want some cash on hand.";

function makeDraft(proposal: Proposal, source: Strategy["source"], usd: number, changes?: string[]): Draft {
  const { mandate, adjustments } = toMandate(proposal, simUniverse(), usd);
  return { proposal, source, mandate, adjustments, usd, changes };
}

/** Ask the server to revise the draft; fall back to offline phrase parsing if it is unreachable. */
async function requestRefine(proposal: Proposal, instruction: string, usd: number): Promise<{ proposal: Proposal; source: Strategy["source"]; changes: string[] }> {
  let res: Response | null = null;
  try {
    res = await fetch("/api/refine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposal, instruction, usd }) });
  } catch {
    res = null;
  }
  if (res && res.status !== 404) {
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }
  const next = refineOffline(proposal, instruction);
  if (!next) throw new Error('Offline, I understand phrases like "less TSLA", "more cash", "NVDA to 10%", "no AAPL" or "safer".');
  return { proposal: next, source: "preset", changes: diffProposals(proposal, next) };
}

/** Ask the server's strategist; fall back to the offline preset if it is unreachable. */
async function requestDraft(goal: string, usd: number): Promise<{ proposal: Proposal; source: Strategy["source"]; note?: string }> {
  try {
    const res = await fetch("/api/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal, usd }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  } catch (e) {
    return {
      proposal: presetFor(goal, [...LISTINGS]),
      source: "preset",
      note: `The strategist is unavailable (${(e as Error).message}); using an offline preset.`,
    };
  }
}

export function App() {
  // A shared vault link (?chain=…&vault=…) opens straight on the Live tab; ?view=network on the Network tab.
  const [tab, setTab] = useState<"sim" | "backtest" | "live" | "network">(() => {
    const q = new URLSearchParams(window.location.search);
    return q.get("vault") ? "live" : q.get("view") === "network" ? "network" : "sim";
  });
  const [tourRequest, setTourRequest] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(() => {
    // A shared strategy link (?strategy=…) opens with that draft, ready to simulate, stress-test or sign.
    const shared = new URLSearchParams(window.location.search).get("strategy");
    const proposal = shared ? decodeStrategy(shared, LISTINGS) : null;
    return proposal ? makeDraft(proposal, "shared", 10_000) : makeDraft(presetFor(FIRST_GOAL, [...LISTINGS]), "preset", 10_000);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDraft(goal: string, usd: number) {
    setBusy(true);
    setError(null);
    const r = await requestDraft(goal, usd);
    if (r.note) setError(r.note);
    setDraft(makeDraft(r.proposal, r.source, usd));
    setBusy(false);
  }

  const mandate = useMemo(() => draft?.mandate, [draft]);
  const weights = useMemo(() => (draft?.proposal.allocations ?? []).map((a) => ({ symbol: a.symbol, percent: a.weight_percent })), [draft]);

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              <svg width="18" height="18" viewBox="0 0 32 32">
                <path d="M5 23l7-7 5 5 10-11" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            StockPilot
          </div>
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "sim"} onClick={() => setTab("sim")}>
              Simulator
            </button>
            <button role="tab" aria-selected={tab === "backtest"} onClick={() => setTab("backtest")}>
              Backtest
            </button>
            <button role="tab" aria-selected={tab === "live"} onClick={() => setTab("live")}>
              Live (testnet)
            </button>
            <button role="tab" aria-selected={tab === "network"} onClick={() => setTab("network")}>
              Network
            </button>
          </nav>
        </div>
      </header>

      <div className="wrap">
        <div className="hero">
          <Aura weights={weights} />
          <h1>An AI autopilot for your tokenized stocks that can only trade inside the rules you sign.</h1>
          <p>
            Describe what you want in plain words. Claude drafts a mandate: target weights, how far they may drift, how much can trade. You sign it into
            a vault you own. A pilot keeps the portfolio on target, and the vault contract rejects any trade that breaks your rules.
          </p>
          <ul className="hero-points">
            <li>Your keys, your vault: withdraw any time</li>
            <li>Pilot can't withdraw or change the rules</li>
            <li>Every trade checked onchain against oracle prices</li>
          </ul>
          <button
            className="btn primary"
            style={{ marginTop: 18 }}
            onClick={() => {
              setTab("sim");
              setTourRequest((r) => r + 1);
            }}
          >
            Take the 60-second tour
          </button>
          <AuraKey weights={weights} />
        </div>

        <main>
          {tab !== "network" && (
            <Strategist
              draft={draft}
              busy={busy}
              error={error}
              onDraft={onDraft}
              onImport={(proposal, usd) => setDraft(makeDraft(proposal, "imported", usd))}
              onEdit={(p) => draft && setDraft(makeDraft(p, draft.source, draft.usd))}
              onRefine={async (instruction) => {
                if (!draft) return;
                const r = await requestRefine(draft.proposal, instruction, draft.usd);
                setDraft(makeDraft(r.proposal, r.source, draft.usd, r.changes));
              }}
            />
          )}
          {tab === "sim" && mandate && draft && <Simulator mandate={mandate} usdSize={draft.usd} tourRequest={tourRequest} />}
          {tab === "backtest" && mandate && draft && <Backtest mandate={mandate} usdSize={draft.usd} />}
          {tab === "network" && <Network />}
          {tab === "live" && (
            <Live
              draft={draft}
              onCopy={(proposal) => {
                // Copy-trading by mandate: the vault's rules become this draft, ready to simulate, adjust and sign.
                setDraft(makeDraft(proposal, "copied", draft?.usd ?? 10_000));
                setTab("sim");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          )}
        </main>
      </div>

      <footer>
        <div className="wrap spread">
          <span>StockPilot · built for Crypto World's Fair · testnet software, unaudited, not financial advice</span>
          <a href="https://github.com/ramadan904/stockpilot" target="_blank" rel="noreferrer">
            Source
          </a>
        </div>
      </footer>
    </>
  );
}

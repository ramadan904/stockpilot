import { useEffect, useMemo, useRef, useState } from "react";
import type { Mandate } from "../../agent/mandate";
import { amountFor, available, type AssetState, type Trade } from "../../agent/model";
import { drift, plan } from "../../agent/planner";
import { advance, createSim, hashOf, isStable, movePrice, randomDay, rebalance, vaultState, type Sim } from "./sim";
import { Card, HoldingsTable, totalUsd, usd, valueUsd } from "./ui";
import { ReportCard, holdingsFacts, valueFacts } from "./Report";
import type { ReportFacts } from "../../agent/report";

interface LogEntry {
  id: number;
  kind: "trade" | "hold" | "blocked" | "allowed" | "market" | "owner";
  text: string;
  hash?: string;
  trade?: ReportFacts["trades"][number];
  blocked?: ReportFacts["blocked"][number];
}

const LABEL: Record<LogEntry["kind"], [string, string]> = {
  trade: ["Trade", "ok"],
  hold: ["Hold", "info"],
  blocked: ["Blocked", "bad"],
  allowed: ["Allowed", "warn"],
  market: ["Market", "warn"],
  owner: ["Owner", "info"],
};

export function Simulator({ mandate, usdSize }: { mandate: Mandate; usdSize: number }) {
  const [sim, setSim] = useState<Sim>(() => createSim(mandate, usdSize));
  const [log, setLog] = useState<LogEntry[]>([]);
  const [auto, setAuto] = useState(false);
  const start = useRef(totalUsd(sim.assets));
  const startPrices = useRef<Record<string, bigint>>(Object.fromEntries(sim.assets.map((a) => [a.symbol, a.price])));
  const nextId = useRef(0);
  const simRef = useRef(sim);
  simRef.current = sim;

  // A new mandate means a new vault.
  useEffect(() => {
    const fresh = createSim(mandate, usdSize);
    setSim(fresh);
    start.current = totalUsd(fresh.assets);
    startPrices.current = Object.fromEntries(fresh.assets.map((a) => [a.symbol, a.price]));
    setLog([]);
    setAuto(false);
  }, [mandate, usdSize]);

  const push = (kind: LogEntry["kind"], text: string, hash?: string, extra: Partial<LogEntry> = {}) =>
    setLog((l) => [{ id: nextId.current++, kind, text, hash, ...extra }, ...l].slice(0, 200));

  const d = useMemo(() => drift(vaultState(sim)), [sim]);
  const state = vaultState(sim);
  const total = totalUsd(sim.assets);
  const change = Number(((total - start.current) * 10_000n) / (start.current || 1n)) / 100;

  /** One pilot decision: let the cooldown pass, then plan and trade if the plan says so. */
  function pilotTick(from: Sim, quiet = false): Sim {
    const s = advance(from, from.limits.cooldown);
    const p = plan(vaultState(s));
    if (p.action === "hold") {
      if (!quiet) push("hold", p.reason);
      return s;
    }
    const { sim: next, verdict } = rebalance(s, p.trade, p.trade.minAmountOut);
    if (!verdict.ok) {
      push("blocked", `The vault rejected the pilot's own trade: ${verdict.reason}. (This would be a planner bug.)`);
      return s;
    }
    const sym = (t: string) => s.assets.find((a) => a.token === t)!.symbol;
    push("trade", p.trade.rationale, hashOf(p.trade.rationale), {
      trade: { sold: sym(p.trade.tokenIn), bought: sym(p.trade.tokenOut), valueUsd: Number(p.trade.valueUsd / 10n ** 16n) / 100, reason: p.trade.rationale },
    });
    return next;
  }

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => {
      let s = advance(simRef.current, 3_600);
      for (const a of s.assets) if (!isStable(a.symbol)) s = movePrice(s, a.symbol, 1 + (Math.random() * 2 - 1) * 0.035);
      setSim(pilotTick(s, true));
    }, 1_200);
    return () => clearInterval(t);
  }, [auto]);

  const market = (symbol: string, factor: number) => {
    setSim((s) => movePrice(s, symbol, factor));
    push("market", `${symbol} ${factor > 1 ? "+" : ""}${Math.round((factor - 1) * 100)}%`);
  };

  const attacks = useMemo(() => buildAttacks(sim), [sim]);

  return (
    <div className="grid-2">
      <div className="stack">
        <Card
          title={<><span className="step">3</span>Your vault (simulated)</>}
          aside={
            <button className="btn small" onClick={() => setSim(createSim(mandate, usdSize))}>
              Reset
            </button>
          }
        >
          <div className="stats">
            <Stat label="Portfolio value" value={usd(total)} />
            <Stat label="Since start" value={`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`} tone={change >= 0 ? "up" : "down"} />
            <Stat label="Pilot can trade now (24h budget)" value={usd(available(state), false)} />
            <Stat label="Vault" value={sim.paused ? "Paused" : sim.marketClosed ? "Market closed" : "Active"} />
          </div>
          <div className="table-scroll">
            <HoldingsTable assets={sim.assets} drift={d} />
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Shaded: the band the vault enforces. Darker: where the pilot leaves things alone. Line: target.
          </p>
        </Card>

        <ReportCard
          title="Session report"
          facts={() => {
            const st = vaultState(sim);
            return {
              period: "this session",
              valueStartUsd: Number(start.current / 10n ** 16n) / 100,
              valueNowUsd: valueFacts(st),
              paused: sim.paused,
              budgetLeftUsd: Number(available(st) / 10n ** 16n) / 100,
              feeBps: 0,
              holdings: holdingsFacts(st, startPrices.current),
              trades: log.filter((e) => e.trade).map((e) => e.trade!).reverse().slice(0, 50),
              blocked: log.filter((e) => e.blocked).map((e) => e.blocked!).slice(0, 20),
            };
          }}
        />

        <Card title="Pilot log" aside={<span className="muted small">Each trade commits keccak256(reason) onchain</span>}>
          {log.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Move the market, then run the pilot.
            </p>
          ) : (
            <ul className="log">
              {log.map((e) => (
                <li key={e.id}>
                  <span className={`pill ${LABEL[e.kind][1]}`}>{LABEL[e.kind][0]}</span>
                  <span>{e.text}</span>
                  {e.hash && <span className="hash">{e.hash}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="stack">
        <Card title="Move the market">
          <div className="market-grid">
            {sim.assets
              .filter((a) => !isStable(a.symbol))
              .map((a) => (
                <div className="market-asset" key={a.symbol}>
                  <strong>{a.symbol}</strong>
                  <span className="row" style={{ gap: 4 }}>
                    <button className="btn small" aria-label={`${a.symbol} down 15%`} onClick={() => market(a.symbol, 0.85)}>
                      −15%
                    </button>
                    <button className="btn small" aria-label={`${a.symbol} up 15%`} onClick={() => market(a.symbol, 1.15)}>
                      +15%
                    </button>
                  </span>
                </div>
              ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={() => {
                setSim(randomDay(sim));
                push("market", "A volatile trading day passes.");
              }}
            >
              Random day
            </button>
            <button
              className="btn"
              onClick={() => {
                setSim((s) => ({ ...s, marketClosed: !s.marketClosed }));
                push("market", sim.marketClosed ? "Markets reopen; feeds update again." : "Markets close; stock prices stop updating.");
              }}
            >
              {sim.marketClosed ? "Open market" : "Close market"}
            </button>
          </div>
        </Card>

        <Card title="Pilot" aside={<span className="muted small">deterministic planner</span>}>
          <div className="row">
            <button className="btn primary" disabled={auto} onClick={() => setSim(pilotTick(sim))}>
              Run pilot
            </button>
            <button className="btn" onClick={() => setAuto((a) => !a)}>
              {auto ? "Stop autopilot" : "Autopilot (live market)"}
            </button>
          </div>
          <p className="muted small">
            Trades when an asset drifts halfway to its band edge, pairing the most overweight asset with the most underweight one. Checks every
            trade against the vault's rules before sending it.
          </p>
          <div className="spread" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <span className="small">Owner controls</span>
            <button
              className={`btn small ${sim.paused ? "" : "danger"}`}
              onClick={() => {
                setSim((s) => ({ ...s, paused: !s.paused }));
                push("owner", sim.paused ? "Owner unpaused the vault." : "Owner paused the vault. Withdrawals still work.");
              }}
            >
              {sim.paused ? "Unpause" : "Pause vault"}
            </button>
          </div>
        </Card>

        <Card title="Try to break it" aside={<span className="muted small">a rogue or hacked pilot</span>}>
          {attacks.map((a) => (
            <div className="attack" key={a.name}>
              <strong className="small">{a.name}</strong>
              <button
                className="btn small"
                onClick={() => {
                  const r = a.run(sim);
                  push(r.ok ? "allowed" : "blocked", `${a.name}: ${r.text}`, undefined, r.ok ? {} : { blocked: { attempt: a.name, reason: r.text } });
                }}
              >
                Attempt
              </button>
              <span className="desc">{a.desc}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

interface Attack {
  name: string;
  desc: string;
  run: (sim: Sim) => { ok: boolean; text: string };
}

function buildAttacks(sim: Sim): Attack[] {
  const byValue = [...sim.assets].sort((a, b) => (valueUsd(b) > valueUsd(a) ? 1 : -1));
  const stocks = sim.assets.filter((a) => !isStable(a.symbol));
  const hottest = [...stocks].sort((a, b) => (valueUsd(b) > valueUsd(a) ? 1 : -1))[0];
  const source = byValue.find((a) => a.symbol !== hottest.symbol)!;
  const chunk = (a: AssetState, wad: bigint) => {
    const amt = amountFor(wad, a.price, a.decimals);
    return amt > a.balance ? a.balance : amt;
  };
  const tryTrade = (s: Sim, trade: Trade): { ok: boolean; text: string } => {
    const { verdict } = rebalance(s, trade);
    return verdict.ok
      ? { ok: true, text: `allowed, because it stays inside your bands and limits (${usd(verdict.valueIn)}).` }
      : { ok: false, text: `rejected with ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}.` };
  };
  const owner = (fn: string) => ({ ok: false, text: `rejected with OwnableUnauthorizedAccount: only the owner can call ${fn}.` });
  const ready = (s: Sim) => advance(s, s.limits.cooldown);

  return [
    {
      name: `Pile into ${hottest.symbol}`,
      desc: `Sell ${usd(sim.limits.maxTradeUsd, false)} of ${source.symbol} for ${hottest.symbol}, your largest stock.`,
      run: (s) => tryTrade(ready(s), { tokenIn: source.token, tokenOut: hottest.token, amountIn: chunk(source, s.limits.maxTradeUsd) }),
    },
    {
      name: "Dump a whole position",
      desc: `Sell all of ${byValue[0].symbol} in one trade.`,
      run: (s) => tryTrade(ready(s), { tokenIn: byValue[0].token, tokenOut: hottest.token === byValue[0].token ? source.token : hottest.token, amountIn: byValue[0].balance }),
    },
    {
      name: "Accept a terrible fill",
      desc: "Trade through a venue paying 5% under the oracle price, e.g. to a colluding market maker.",
      run: (s) => tryTrade({ ...ready(s), venueFeeBps: 500 }, { tokenIn: source.token, tokenOut: hottest.token, amountIn: chunk(source, s.limits.maxTradeUsd / 10n) }),
    },
    {
      name: "Trade on a stale price",
      desc: "Markets are closed for two hours; trade on the last price anyway.",
      run: (s) => tryTrade(advance({ ...s, marketClosed: true }, 7_200), { tokenIn: source.token, tokenOut: hottest.token, amountIn: chunk(source, s.limits.maxTradeUsd / 10n) }),
    },
    {
      name: "Trade twice in a row",
      desc: "Fire a second trade without waiting for the cooldown.",
      run: (s) => {
        const first = rebalance(ready(s), { tokenIn: source.token, tokenOut: hottest.token, amountIn: chunk(source, s.limits.maxTradeUsd / 20n) });
        if (!first.verdict.ok) return { ok: false, text: `first trade already rejected with ${first.verdict.reason}.` };
        return tryTrade(first.sim, { tokenIn: source.token, tokenOut: hottest.token, amountIn: chunk(source, s.limits.maxTradeUsd / 20n) });
      },
    },
    { name: "Withdraw to its own wallet", desc: "Move funds out of the vault.", run: () => owner("withdraw()") },
    { name: "Rewrite the mandate", desc: "Widen its own limits.", run: () => owner("setMandate()") },
    { name: "Swap in its own venue", desc: "Route trades through a contract it controls.", run: () => owner("setAdapter()") },
  ];
}

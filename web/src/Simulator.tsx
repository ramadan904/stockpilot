import { useEffect, useMemo, useRef, useState } from "react";
import type { Mandate } from "../../agent/mandate";
import { amountFor, available, type AssetState, type Trade } from "../../agent/model";
import { drift, plan } from "../../agent/planner";
import { safeTargetChoices } from "../../agent/backtest";
import { advance, armGuard, createSim, hashOf, isStable, liftDefensive, movePrice, pokeGuard, randomDay, rebalance, vaultState, type Sim } from "./sim";
import { Card, HoldingsTable, totalUsd, usd, valueUsd } from "./ui";
import { ReportCard, holdingsFacts, valueFacts } from "./Report";
import { LineChart, compactUsd } from "./LineChart";
import type { ReportFacts } from "../../agent/report";

interface LogEntry {
  id: number;
  kind: "trade" | "hold" | "blocked" | "allowed" | "market" | "owner" | "guard";
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
  guard: ["Guard", "bad"],
};

interface Point {
  t: bigint;
  pilot: number;
  hold: number;
}

export function Simulator({ mandate, usdSize, tourRequest = 0 }: { mandate: Mandate; usdSize: number; tourRequest?: number }) {
  const [sim, setSim] = useState<Sim>(() => createSim(mandate, usdSize));
  const [history, setHistory] = useState<Point[]>([]);
  // Buy-and-hold benchmark: the vault's starting balances, never traded.
  const holdBalances = useRef<bigint[]>(sim.assets.map((a) => a.balance));
  const startTime = useRef(sim.now);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [auto, setAuto] = useState(false);
  const start = useRef(totalUsd(sim.assets));
  const startPrices = useRef<Record<string, bigint>>(Object.fromEntries(sim.assets.map((a) => [a.symbol, a.price])));
  const nextId = useRef(0);
  const simRef = useRef(sim);
  simRef.current = sim;

  function reset(cash = false) {
    const fresh = createSim(mandate, usdSize, cash);
    setSim(fresh);
    start.current = totalUsd(fresh.assets);
    startPrices.current = Object.fromEntries(fresh.assets.map((a) => [a.symbol, a.price]));
    holdBalances.current = fresh.assets.map((a) => a.balance);
    startTime.current = fresh.now;
    setHistory([]);
    setLog(cash ? [{ id: nextId.current++, kind: "owner", text: "Vault funded with cash only. Run the pilot (or autopilot) to watch it invest, within its 24-hour budget." }] : []);
    setAuto(false);
  }

  // A new mandate means a new vault.
  useEffect(() => reset(), [mandate, usdSize]);

  // Record value over time for the chart: the pilot's vault against the same start, left alone.
  useEffect(() => {
    const pilot = Number(totalUsd(sim.assets) / 10n ** 14n) / 10_000;
    const hold = Number(totalUsd(sim.assets.map((a, i) => ({ ...a, balance: holdBalances.current[i] ?? 0n }))) / 10n ** 14n) / 10_000;
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last && last.pilot === pilot && last.hold === hold) return h;
      return [...h, { t: sim.now, pilot, hold }].slice(-500);
    });
  }, [sim]);

  const push = (kind: LogEntry["kind"], text: string, hash?: string, extra: Partial<LogEntry> = {}) =>
    setLog((l) => [{ id: nextId.current++, kind, text, hash, ...extra }, ...l].slice(0, 200));

  const d = useMemo(() => drift(vaultState(sim)), [sim]);
  const state = vaultState(sim);
  const total = totalUsd(sim.assets);
  const change = Number(((total - start.current) * 10_000n) / (start.current || 1n)) / 100;

  /** One pilot decision: let the cooldown pass, then plan and trade if the plan says so. */
  function pilotTick(from: Sim, quiet = false): Sim {
    // Like the hosted fleet: check the crash guard first, then plan against the targets in force.
    const poked = pokeGuard(advance(from, from.limits.cooldown));
    if (poked.tripped) push("guard", "Crash guard tripped: the vault fell past its limit from the peak. Defensive targets are in force; the pilot can only de-risk.");
    const s = poked.sim;
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
  const stableIndex = Math.max(0, sim.assets.findIndex((a) => isStable(a.symbol)));
  // A defensive target the vault would accept: above the stablecoin's own target (none when it is already 100%).
  const guardTarget = safeTargetChoices(sim.normalTargets[stableIndex] / 100).fallback;
  const peakFall = sim.peakUsd > 0n && total < sim.peakUsd ? Number(((sim.peakUsd - total) * 10_000n) / sim.peakUsd) / 100 : 0;

  // ---- Guided tour: drives this simulator through the whole story, one captioned step at a time. ----
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [reportTrigger, setReportTrigger] = useState(0);
  const tour: { target: string; title: string; text: string; run?: () => void }[] = [
    {
      target: "vault",
      title: "This is your vault",
      text: "It holds tokenized stocks and a stablecoin at the targets in your mandate. You own it: only you can withdraw or change the rules.",
    },
    {
      target: "vault",
      title: "Markets move",
      text: "NVIDIA rallies 45% and Tesla falls 30%. Your portfolio drifts: the red and amber dots are now off target.",
      run: () => {
        setSim(movePrice(movePrice(sim, "NVDA", 1.45), "TSLA", 0.7));
        push("market", "NVDA +45%, TSLA -30%");
      },
    },
    {
      target: "log",
      title: "The pilot rebalances",
      text: "It sells some of what ran up and buys what fell, back toward your targets. Each trade comes with a reason, and the reason's hash is stored onchain.",
      run: () => {
        let s = sim;
        for (let i = 0; i < 3; i++) s = pilotTick(s, true);
        setSim(s);
      },
    },
    {
      target: "log",
      title: "Now the pilot is hacked",
      text: "It tries everything: pile into one stock, dump a position, take a terrible price, trade on a stale price, withdraw the money, rewrite the rules. The vault contract rejects every attempt.",
      run: () => {
        for (const a of attacks) {
          const r = a.run(sim);
          push(r.ok ? "allowed" : "blocked", `${a.name}: ${r.text}`, undefined, r.ok ? {} : { blocked: { attempt: a.name, reason: r.text } });
        }
      },
    },
    {
      target: "chart",
      title: "Weeks go by",
      text: "The market keeps moving and the pilot keeps the portfolio near target. The chart compares your vault with leaving the same start untouched.",
      run: () => {
        let s = sim;
        for (let i = 0; i < 12; i++) s = pilotTick(randomDay(s, 0.05), true);
        setSim(s);
      },
    },
    {
      target: "guard",
      title: "Then the market crashes",
      text: `You armed the crash guard: past a 20% fall from the peak, the vault switches to ${guardTarget ?? 100}% cash. Every stock falls 35%; the guard trips, and the contract now lets the pilot only de-risk. Only you can lift it.`,
      run: () => {
        let s = pokeGuard(armGuard(sim, { safeIndex: stableIndex, safeTargetBps: (guardTarget ?? 100) * 100, drawdownBps: 2_000 })).sim;
        for (const a of s.assets) if (!isStable(a.symbol)) s = movePrice(s, a.symbol, 0.65);
        push("market", "Market crash: every stock −35%");
        for (let i = 0; i < 3; i++) s = pilotTick(s, true);
        setSim(s);
      },
    },
    {
      target: "report",
      title: "A report you can read",
      text: "Claude writes a plain-English summary from numbers computed onchain. It never invents figures.",
      run: () => setReportTrigger((t) => t + 1),
    },
    {
      target: "vault",
      title: "Your turn",
      text: "Describe your own goal at the top, try the Backtest tab, or connect a wallet in Live to run a real vault on testnet.",
    },
  ];

  function goTo(i: number) {
    tour[i].run?.();
    setTourStep(i);
  }

  useEffect(() => {
    if (tourRequest === 0) return;
    reset();
    setAuto(false);
    setTourStep(0);
  }, [tourRequest]);

  useEffect(() => {
    document.querySelectorAll(".tour-focus").forEach((el) => el.classList.remove("tour-focus"));
    if (tourStep === null) return;
    const el = document.querySelector(`[data-tour="${tour[tourStep].target}"]`);
    if (el) {
      el.classList.add("tour-focus");
      // Just below the sticky header, so the caption panel at the bottom does not cover it.
      const header = (document.querySelector(".topbar") as HTMLElement | null)?.offsetHeight ?? 60;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - header - 16, behavior: "smooth" });
    }
  }, [tourStep, history.length > 1]);

  useEffect(() => {
    document.body.classList.toggle("touring", tourStep !== null);
    return () => document.body.classList.remove("touring");
  }, [tourStep !== null]);

  return (
    <div className="grid-2">
      <div className="stack">
        <Card
          tour="vault"
          title={<><span className="step">3</span>Your vault (simulated)</>}
          aside={
            <span className="row" style={{ gap: 6 }}>
              <button className="btn small" onClick={() => reset()}>
                Reset at targets
              </button>
              <button className="btn small" onClick={() => reset(true)}>
                Start in cash
              </button>
            </span>
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
          <p className="muted small">
            Shaded: the band the vault enforces. Darker: where the pilot leaves things alone. Line: target.
          </p>
          {history.length > 1 && (
            <div data-tour="chart">
            <LineChart
              title="Portfolio value"
              series={[
                { name: "StockPilot", values: history.map((p) => p.pilot) },
                { name: "Buy and hold", values: history.map((p) => p.hold) },
              ]}
              xLabel={(i) => elapsed(history[i].t - startTime.current)}
              format={(v) => compactUsd(v)}
              height={220}
            />
            </div>
          )}
        </Card>

        <ReportCard
          tour="report"
          trigger={reportTrigger}
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

        <Card tour="log" title="Pilot log" aside={<span className="muted small">Each trade commits keccak256(reason) onchain</span>}>
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
        <Card
          tour="guard"
          title="Crash guard"
          aside={sim.defensive ? <span className="pill bad">Defensive</span> : sim.guard ? <span className="pill ok">Armed</span> : <span className="pill warn">Off</span>}
        >
          {!sim.guard && guardTarget === null ? (
            <p className="small muted" style={{ margin: 0 }}>
              This mandate already holds only the stablecoin, so there is nothing for a crash guard to de-risk.
            </p>
          ) : !sim.guard ? (
            <>
              <p className="small" style={{ marginTop: 0 }}>
                A stop-loss for the whole portfolio, enforced by the vault: past a 20% fall from the peak, {sim.assets[stableIndex].symbol} goes to {guardTarget}% and the
                pilot can only de-risk until you lift it.
              </p>
              <button
                className="btn"
                onClick={() => {
                  setSim(pokeGuard(armGuard(sim, { safeIndex: stableIndex, safeTargetBps: (guardTarget ?? 100) * 100, drawdownBps: 2_000 })).sim);
                  push("owner", `Crash guard armed: past a 20% fall from the peak, the stablecoin goes to ${guardTarget}%.`);
                }}
              >
                Arm the crash guard
              </button>
            </>
          ) : (
            <>
              <p className="small" style={{ marginTop: 0 }}>
                {sim.defensive
                  ? `Tripped: defensive targets in force (${sim.assets[stableIndex].symbol} at ${sim.guard.safeTargetBps / 100}%). The pilot can only move toward them.`
                  : `Armed. Peak ${usd(sim.peakUsd, false)}; now ${peakFall.toFixed(1)}% below it; trips past 20%.`}
              </p>
              <div className="row">
                {sim.defensive && (
                  <button
                    className="btn"
                    onClick={() => {
                      setSim(liftDefensive(sim));
                      push("owner", "Back to normal targets.");
                    }}
                  >
                    Back to normal targets
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() => {
                    setSim(armGuard(sim, null));
                    push("owner", "Crash guard turned off.");
                  }}
                >
                  Turn off
                </button>
              </div>
            </>
          )}
        </Card>

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
                let s = sim;
                for (const a of s.assets) if (!isStable(a.symbol)) s = movePrice(s, a.symbol, 0.65);
                setSim(s);
                push("market", "Market crash: every stock −35%");
              }}
            >
              Market crash
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
      {tourStep !== null && (
        <div className="tour-panel" role="dialog" aria-label="Guided tour">
          <div className="spread">
            <span className="muted small">
              Tour · {tourStep + 1} of {tour.length}
            </span>
            <button className="btn small" onClick={() => setTourStep(null)}>
              Exit
            </button>
          </div>
          <strong>{tour[tourStep].title}</strong>
          <p>{tour[tourStep].text}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {tourStep < tour.length - 1 ? (
              <button className="btn primary" onClick={() => goTo(tourStep + 1)}>
                Next
              </button>
            ) : (
              <button className="btn primary" onClick={() => setTourStep(null)}>
                Finish
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function elapsed(seconds: bigint) {
  const s = Number(seconds);
  if (s <= 0) return "Start";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  return d > 0 ? `+${d}d ${h}h` : `+${h}h ${Math.floor((s % 3_600) / 60)}m`;
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

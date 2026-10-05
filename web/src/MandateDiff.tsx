import type { Mandate } from "../../agent/mandate";
import type { VaultState } from "../../agent/model";
import { Card, pct, usd } from "./ui";

export interface DiffRow {
  label: string;
  now: string;
  next: string;
  changed: boolean;
}

/** Side by side: the mandate the vault enforces now, and the one about to be signed. */
export function mandateDiff(state: VaultState, next: Mandate, symbolOf: (token: string) => string): { rows: DiffRow[]; dropped: string[] } {
  const rows: DiffRow[] = [];
  const nowBy = new Map(state.assets.map((a) => [a.token.toLowerCase(), a]));
  const nextBy = new Map(next.assets.map((a) => [a.token.toLowerCase(), a]));
  const tokens = [...new Set([...nowBy.keys(), ...nextBy.keys()])];
  const fmt = (a?: { targetBps: number; bandBps: number }) => (a ? `${pct(a.targetBps)} ± ${pct(a.bandBps)}` : "not in mandate");
  for (const t of tokens) {
    const [a, b] = [nowBy.get(t), nextBy.get(t)];
    rows.push({ label: symbolOf(t), now: fmt(a), next: fmt(b), changed: fmt(a) !== fmt(b) });
  }
  const lim = (label: string, a: string, b: string) => rows.push({ label, now: a, next: b, changed: a !== b });
  lim("Max per trade", usd(state.limits.maxTradeUsd, false), usd(next.limits.maxTradeUsd, false));
  lim("Max per 24 hours", usd(state.limits.dailyLimitUsd, false), usd(next.limits.dailyLimitUsd, false));
  lim("Max slippage", pct(state.limits.maxSlippageBps), pct(next.limits.maxSlippageBps));
  lim("Max price age", `${state.limits.maxPriceAge / 60} min`, `${next.limits.maxPriceAge / 60} min`);
  lim("Cooldown", `${state.limits.cooldown / 60} min`, `${next.limits.cooldown / 60} min`);
  const dropped = [...nowBy.keys()].filter((t) => !nextBy.has(t) && nowBy.get(t)!.balance > 0n).map(symbolOf);
  return { rows, dropped };
}

export function MandateDiffCard(props: { state: VaultState; next: Mandate; symbolOf: (token: string) => string; onSign: () => void; onCancel: () => void }) {
  const { rows, dropped } = mandateDiff(props.state, props.next, props.symbolOf);
  const changes = rows.filter((r) => r.changed).length;
  return (
    <Card title="Review the new mandate" aside={<span className={`pill ${changes ? "warn" : "ok"}`}>{changes ? `${changes} change${changes === 1 ? "" : "s"}` : "No changes"}</span>}>
      <div className="table-scroll">
        <table className="holdings">
          <thead>
            <tr>
              <th />
              <th className="num">Now</th>
              <th className="num">After signing</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num muted">{r.now}</td>
                <td className="num">{r.changed ? <strong>{r.next}</strong> : r.next}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dropped.length > 0 && (
        <p className="notice warn">
          {dropped.join(", ")} will leave the mandate while the vault still holds some. It stays in the vault, unpriced and untouchable by the pilot,
          until you withdraw it or list it again.
        </p>
      )}
      <p className="muted small">The pilot's trade budget carries over: changing the mandate never resets it.</p>
      <div className="row">
        <button className="btn primary" disabled={changes === 0} onClick={props.onSign}>
          Sign the new mandate
        </button>
        <button className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

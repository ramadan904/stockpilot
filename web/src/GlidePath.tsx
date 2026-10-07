// The glide path: the vault de-risks on a schedule the owner sets, like a target-date fund. The vault itself moves the
// targets, so neither the pilot nor a forgetful owner can skip a step.

import { useEffect, useState } from "react";
import type { Address, Chain, Hash, PublicClient, WalletClient } from "viem";
import { glideEndTargets, glideProgress, glidedTargets, readGlide, type GlidePath } from "../../agent/glide";
import type { VaultState } from "../../agent/model";
import { pilotVaultAbi } from "./abi";
import { Card } from "./ui";

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const date = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export function GlidePathCard(props: {
  client: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  vault: Address;
  state: VaultState;
  isOwner: boolean;
  canWrite: boolean;
  send: (label: string, write: () => Promise<Hash>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => () => void;
}) {
  const { client, wallet, chain, vault, state, isOwner, canWrite, send, run } = props;
  const now = Number(state.now);
  const tokens = state.assets.map((a) => a.token);
  const [glide, setGlide] = useState<GlidePath | null>(null);
  const [mandate, setMandate] = useState<number[] | null>(null);
  const [guard, setGuard] = useState<{ safe: Address; safeTargetBps: number } | null>(null);
  const [tick, setTick] = useState(0);
  const stable = state.assets.find((a) => /USD/.test(a.symbol)) ?? state.assets[0];
  const [safe, setSafe] = useState<Address>(stable.token);
  const [endPct, setEndPct] = useState(70);
  const [endDay, setEndDay] = useState(isoDay(now + 10 * 365 * 86_400));

  useEffect(() => {
    (async () => {
      const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: vault, abi: pilotVaultAbi, functionName, args } as never) as Promise<unknown>;
      const [g, assets, drawdown, safeAsset, safeTargetBps] = await Promise.all([
        readGlide(client, pilotVaultAbi as never, vault, tokens),
        Promise.all(tokens.map((t) => read("assets", [t]) as Promise<readonly unknown[]>)),
        read("drawdownBps"),
        read("safeAsset"),
        read("safeTargetBps"),
      ]);
      setGlide(g);
      setMandate(assets.map((a) => Number(a[3])));
      setGuard(Number(drawdown) > 0 ? { safe: safeAsset as Address, safeTargetBps: Number(safeTargetBps) } : null);
    })().catch(() => setMandate(null));
  }, [client, vault, tick, tokens.join()]);

  if (!mandate) return null;
  if (!glide && !isOwner) return null;

  const base = glidedTargets(mandate, glide, now);
  const safeIndex = Math.max(0, tokens.findIndex((t) => t === safe));
  const end = Math.floor(Date.parse(`${endDay}T00:00:00Z`) / 1000);
  const endBps = Math.round(Math.min(100, Math.max(0, endPct)) * 100);
  const to = glideEndTargets(base, safeIndex, endBps);
  const years = (end - now) / (365 * 86_400);
  const perYear = years > 0 ? Math.abs(to[safeIndex] - base[safeIndex]) / years : 0;
  const guardIndex = guard ? tokens.findIndex((t) => t.toLowerCase() === guard.safe.toLowerCase()) : -1;
  const guardConflict = guard && guardIndex >= 0 && Math.max(base[guardIndex], to[guardIndex]) >= guard.safeTargetBps;
  const invalid = !Number.isFinite(end) || end <= now ? "Pick an end date in the future." : guardConflict ? `Your crash guard moves ${state.assets[guardIndex].symbol} to ${pct(guard!.safeTargetBps)} in a crash; a path that takes it to ${pct(to[guardIndex])} would make that meaningless. Raise the guard's target first, or end lower.` : null;

  const write = (label: string, args: readonly unknown[]) =>
    run(async () => {
      await send(label, () => wallet.writeContract({ account: wallet.account!, chain, address: vault, abi: pilotVaultAbi, functionName: "setGlidePath", args } as never));
      setTick((t) => t + 1);
    });

  return (
    <Card
      title="Glide path"
      aside={glide ? <span className="pill info">{now >= glide.end ? "Arrived" : `${Math.round(glideProgress(glide, now) * 100)}% of the way`}</span> : <span className="muted small">target-date de-risking</span>}
    >
      <p className="small" style={{ marginTop: 0 }}>
        Like a target-date fund: the vault moves its own targets a little every second toward the mix you want by a date, say more cash as retirement
        nears. The pilot rebalances toward wherever the path has reached, inside the same bands and limits, and the crash guard still works on top.
      </p>

      {glide && (
        <>
          <div className="table-scroll">
            <table className="holdings" aria-label="Glide path">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">{date(glide.start)}</th>
                  <th className="num">Now</th>
                  <th className="num">{date(glide.end)}</th>
                </tr>
              </thead>
              <tbody>
                {state.assets.map((a, i) => (
                  <tr key={a.token}>
                    <td>{a.symbol}</td>
                    <td className="num">{pct(glide.from[i])}</td>
                    <td className="num">
                      <strong>{pct(base[i])}</strong>
                    </td>
                    <td className="num">{pct(glide.to[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isOwner && canWrite && (
            <button className="btn" onClick={write("Stop the glide path", [[], 0n])}>
              Stop the glide path
            </button>
          )}
        </>
      )}

      {isOwner && canWrite && (
        <div style={{ marginTop: glide ? 14 : 0 }}>
          <div className="row">
            <label className="field" style={{ width: 130 }}>
              Move
              <select value={safe} onChange={(e) => setSafe(e.target.value as Address)}>
                {state.assets.map((a) => (
                  <option key={a.token} value={a.token}>
                    {a.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ width: 110 }}>
              To (%)
              <input type="number" min={0} max={100} step={5} value={endPct} onChange={(e) => setEndPct(Number(e.target.value))} />
            </label>
            <label className="field" style={{ width: 170 }}>
              By
              <input type="date" value={endDay} onChange={(e) => setEndDay(e.target.value)} />
            </label>
            <button className="btn primary" style={{ alignSelf: "end" }} disabled={invalid !== null} onClick={write(glide ? "Replace the glide path" : "Set the glide path", [to, BigInt(end)])}>
              {glide ? "Replace the glide path" : "Set the glide path"}
            </button>
          </div>
          {invalid ? (
            <p className="notice warn small">{invalid}</p>
          ) : (
            <p className="muted small" data-testid="glide-preview">
              By {date(end)}: {state.assets.map((a, i) => `${a.symbol} ${pct(to[i])}`).join(", ")}. About {(perYear / 100).toFixed(1)} points a year move{" "}
              {to[safeIndex] >= base[safeIndex] ? "into" : "out of"} {state.assets[safeIndex].symbol}, starting from today's targets. Signing a new mandate ends the path.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

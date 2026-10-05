// The crash guard: a drawdown circuit breaker the vault enforces. Past the set fall from its recorded peak, the vault
// switches to defensive targets and the pilot can only de-risk until the owner lifts it.

import { useEffect, useState } from "react";
import type { Address, Chain, Hash, PublicClient, WalletClient } from "viem";
import type { VaultState } from "../../agent/model";
import { pilotVaultAbi } from "./abi";
import { Card, totalUsd, usd } from "./ui";

interface Guard {
  safeAsset: Address;
  safeTargetBps: number;
  drawdownBps: number;
  defensive: boolean;
  peakUsd: bigint;
}

const ZERO = /^0x0+$/;

export function CrashGuardCard(props: {
  client: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  vault: Address;
  state: VaultState;
  isOwner: boolean;
  /** False in a read-only view. */
  canWrite: boolean;
  send: (label: string, write: () => Promise<Hash>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => () => void;
}) {
  const { client, wallet, chain, vault, state, isOwner, canWrite, send, run } = props;
  const [guard, setGuard] = useState<Guard | null>(null);
  const [editing, setEditing] = useState(false);
  const stable = state.assets.find((a) => /USD/.test(a.symbol)) ?? state.assets[0];
  const [safe, setSafe] = useState<Address>(stable.token);
  const [drawdown, setDrawdown] = useState(20);
  const [safeTarget, setSafeTarget] = useState(Math.min(90, Math.max(stable.targetBps / 100 + 10, 70)));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    (async () => {
      const read = <T,>(functionName: "safeAsset" | "safeTargetBps" | "drawdownBps" | "defensive" | "peakValueUsd") =>
        client.readContract({ address: vault, abi: pilotVaultAbi, functionName }) as Promise<T>;
      const [safeAsset, safeTargetBps, drawdownBps, defensive, peakUsd] = await Promise.all([
        read<Address>("safeAsset"),
        read<number>("safeTargetBps"),
        read<number>("drawdownBps"),
        read<boolean>("defensive"),
        read<bigint>("peakValueUsd"),
      ]);
      setGuard({ safeAsset, safeTargetBps: Number(safeTargetBps), drawdownBps: Number(drawdownBps), defensive, peakUsd });
    })().catch(() => setGuard(null));
  }, [client, vault, tick]);

  if (!guard) return null;
  const armed = guard.drawdownBps > 0;
  if (!armed && !isOwner) return null;

  const write = (label: string, functionName: "setCrashGuard" | "exitDefensive" | "poke", args: readonly unknown[] = []) =>
    run(async () => {
      await send(label, () => wallet.writeContract({ account: wallet.account!, chain, address: vault, abi: pilotVaultAbi, functionName, args } as never));
      setEditing(false);
      setTick((t) => t + 1);
    });

  const total = totalUsd(state.assets);
  const safeSymbol = state.assets.find((a) => a.token.toLowerCase() === guard.safeAsset.toLowerCase())?.symbol ?? "the safe asset";
  const fall = guard.peakUsd > 0n && total < guard.peakUsd ? Number(((guard.peakUsd - total) * 10_000n) / guard.peakUsd) / 100 : 0;
  const trigger = guard.drawdownBps / 100;
  const safeAsset = state.assets.find((a) => a.token === safe) ?? stable;

  return (
    <Card
      title="Crash guard"
      aside={
        guard.defensive ? <span className="pill bad">Defensive</span> : armed ? <span className="pill ok">Armed</span> : <span className="pill warn">Off</span>
      }
    >
      {guard.defensive ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            The vault fell more than {trigger}% below its {usd(guard.peakUsd, false)} peak, so it switched to defensive targets: {safeSymbol} at{" "}
            {guard.safeTargetBps / 100}%, everything else scaled down. The pilot can only move toward these targets until you lift it.
          </p>
          {isOwner && (
            <button className="btn" onClick={write("Back to normal targets", "exitDefensive")}>
              Back to normal targets
            </button>
          )}
        </>
      ) : armed && !editing ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            If the vault falls more than {trigger}% below its recorded peak{guard.peakUsd > 0n ? ` (${usd(guard.peakUsd, false)})` : ""}, {safeSymbol} goes to{" "}
            {guard.safeTargetBps / 100}% and the pilot can only de-risk. Anyone can trigger it once due, and a trade attempted past the drop is judged on the
            defensive targets, so the pilot cannot ignore it.
          </p>
          <div className="clock" role="progressbar" aria-label="Drawdown" aria-valuemin={0} aria-valuemax={trigger} aria-valuenow={fall}>
            <div className="clock-fill" style={{ width: `${Math.min(100, (fall / trigger) * 100)}%` }} data-tone={fall / trigger > 0.75 ? "bad" : fall / trigger > 0.4 ? "warn" : "ok"} />
          </div>
          <p className="muted small">
            {guard.peakUsd === 0n ? "No peak recorded yet." : `Now ${usd(total, false)}, ${fall.toFixed(1)}% below the peak; trips at ${trigger}%.`}
          </p>
          <div className="row">
            {canWrite && (
              <button className="btn" onClick={write("Check the guard", "poke")}>
                Check now
              </button>
            )}
            {isOwner && (
              <>
                <button className="btn" onClick={() => setEditing(true)}>
                  Change
                </button>
                <button className="btn danger" onClick={write("Turn off crash guard", "setCrashGuard", ["0x0000000000000000000000000000000000000000", 0, 0])}>
                  Turn off
                </button>
              </>
            )}
          </div>
        </>
      ) : !editing ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            A stop-loss for the whole portfolio, enforced by the contract: if the vault falls a set amount below its peak, it moves to a defensive mix,
            mostly {stable.symbol}, and the pilot can only de-risk until you say otherwise.
          </p>
          <button className="btn" onClick={() => setEditing(true)}>
            Arm the crash guard
          </button>
        </>
      ) : null}

      {editing && isOwner && (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <label className="field">
            Trip after a fall from the peak of
            <select value={drawdown} onChange={(e) => setDrawdown(Number(e.target.value))}>
              {[10, 15, 20, 25, 30, 40].map((d) => (
                <option key={d} value={d}>
                  {d}%
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Then hold mostly
            <select value={safe} onChange={(e) => setSafe(e.target.value as Address)}>
              {state.assets.map((a) => (
                <option key={a.token} value={a.token}>
                  {a.symbol}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            At this weight (now {safeAsset.targetBps / 100}%)
            <select value={safeTarget} onChange={(e) => setSafeTarget(Number(e.target.value))}>
              {[50, 60, 70, 80, 90, 100].filter((t) => t > safeAsset.targetBps / 100).map((t) => (
                <option key={t} value={t}>
                  {t}%
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button className="btn primary" onClick={write("Arm crash guard", "setCrashGuard", [safe, safeTarget * 100, drawdown * 100])}>
              Save
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

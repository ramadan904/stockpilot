// Inheritance for a self-custodied portfolio: the owner names an heir and an inactivity period; any owner action
// restarts the clock; after a full period of silence the heir can take the vault over. Enforced by the contract.

import { useEffect, useState } from "react";
import { isAddress, type Address, type Chain, type Hash, type PublicClient, type WalletClient } from "viem";
import { hardhat } from "viem/chains";
import { pilotVaultAbi } from "./abi";
import { Card } from "./ui";

const DAY = 86_400;
const PERIODS = [30, 90, 180, 365, 730];

interface Status {
  heir: Address;
  period: number;
  lastActivity: number;
  claimableAt: number;
  now: number;
}

const ZERO = /^0x0+$/;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const date = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function InheritanceCard(props: {
  client: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  vault: Address;
  me: Address;
  isOwner: boolean;
  send: (label: string, write: () => Promise<Hash>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => () => void;
}) {
  const { client, wallet, chain, vault, me, isOwner, send, run } = props;
  const [status, setStatus] = useState<Status | null>(null);
  const [editing, setEditing] = useState(false);
  const [heir, setHeir] = useState("");
  const [days, setDays] = useState(180);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    (async () => {
      const read = <T,>(functionName: "heir" | "inactivityPeriod" | "lastOwnerActivity" | "inheritanceClaimableAt") =>
        client.readContract({ address: vault, abi: pilotVaultAbi, functionName }) as Promise<T>;
      const [h, period, last, at, block] = await Promise.all([
        read<Address>("heir"),
        read<number>("inactivityPeriod"),
        read<bigint>("lastOwnerActivity"),
        read<bigint>("inheritanceClaimableAt"),
        client.getBlock(),
      ]);
      setStatus({ heir: h, period: Number(period), lastActivity: Number(last), claimableAt: Number(at), now: Number(block.timestamp) });
    })().catch(() => setStatus(null));
  }, [client, vault, tick]);

  if (!status) return null;
  const hasHeir = !ZERO.test(status.heir);
  const isHeir = hasHeir && status.heir.toLowerCase() === me.toLowerCase();
  if (!isOwner && !isHeir && !hasHeir) return null;

  const write = (label: string, functionName: "setHeir" | "checkIn" | "claimInheritance", args: readonly unknown[] = []) =>
    run(async () => {
      await send(label, () => wallet.writeContract({ account: wallet.account!, chain, address: vault, abi: pilotVaultAbi, functionName, args } as never));
      setEditing(false);
      setTick((t) => t + 1);
    });

  const left = status.claimableAt - status.now;
  const elapsed = hasHeir ? Math.min(1, Math.max(0, (status.now - status.lastActivity) / status.period)) : 0;
  const claimable = hasHeir && left <= 0;
  const local = chain.id === hardhat.id;

  const skip = (d: number) =>
    run(async () => {
      // Local chain only: move time forward so the whole flow can be tried in a minute.
      await client.request({ method: "evm_increaseTime", params: [d * DAY] } as never);
      await client.request({ method: "evm_mine", params: [] } as never);
      setTick((t) => t + 1);
    });

  return (
    <Card
      title="Inheritance"
      aside={
        hasHeir ? (
          <span className={`pill ${claimable ? "bad" : elapsed > 0.8 ? "warn" : "ok"}`}>{claimable ? "Heir can claim" : "Heir named"}</span>
        ) : (
          <span className="pill warn">No heir</span>
        )
      }
    >
      {!hasHeir && isOwner && !editing && (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            A brokerage account can name a beneficiary. A wallet can't: if you lose your keys or die, these stocks are gone. Name an heir, and
            if you do nothing with this vault for a period you choose, they can take it over. Any action of yours restarts the clock, and the
            pilot keeps managing the portfolio in the meantime.
          </p>
          <button className="btn" onClick={() => setEditing(true)}>
            Name an heir
          </button>
        </>
      )}

      {hasHeir && (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            {isHeir ? "You are the heir. " : <>Heir: <span className="mono">{short(status.heir)}</span>. </>}
            {claimable
              ? isHeir
                ? "The owner has been inactive for the whole period: you can take over the vault now."
                : `The owner has been inactive for ${status.period / DAY} days: the heir can take over now.`
              : `If the owner does nothing until ${date(status.claimableAt)} (${Math.ceil(left / DAY)} days), ${isHeir ? "you" : "the heir"} can take over.`}
          </p>
          <div className="clock" role="progressbar" aria-label="Inactivity clock" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(elapsed * 100)}>
            <div className="clock-fill" style={{ width: `${elapsed * 100}%` }} data-tone={claimable ? "bad" : elapsed > 0.8 ? "warn" : "ok"} />
          </div>
          <p className="muted small">
            Last owner activity {date(status.lastActivity)} · period {status.period / DAY} days
          </p>
          <div className="row">
            {isOwner && (
              <>
                <button className="btn primary" onClick={write("Check in", "checkIn")}>
                  I'm here: restart the clock
                </button>
                <button className="btn" onClick={() => (setHeir(status.heir), setDays(status.period / DAY), setEditing(true))}>
                  Change
                </button>
                <button className="btn danger" onClick={write("Remove heir", "setHeir", ["0x0000000000000000000000000000000000000000", 0])}>
                  Remove heir
                </button>
              </>
            )}
            {isHeir && (
              <button className="btn primary" disabled={!claimable} onClick={write("Claim inheritance", "claimInheritance")}>
                Claim the vault
              </button>
            )}
          </div>
        </>
      )}

      {editing && isOwner && (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <label className="field">
            Heir's address
            <input type="text" value={heir} onChange={(e) => setHeir(e.target.value.trim())} spellCheck={false} placeholder="0x…" />
          </label>
          <label className="field">
            They can take over after this long without any action from you
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {PERIODS.map((d) => (
                <option key={d} value={d}>
                  {d < 365 ? `${d} days` : `${d / 365} year${d === 365 ? "" : "s"}`}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              className="btn primary"
              disabled={!isAddress(heir) || heir.toLowerCase() === me.toLowerCase()}
              onClick={write("Name heir", "setHeir", [heir, days * DAY])}
            >
              Save heir
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {local && hasHeir && !claimable && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Local chain:{" "}
          <button className="btn small" onClick={skip(Math.ceil(left / DAY) + 1)}>
            Skip ahead {Math.ceil(left / DAY) + 1} days
          </button>
        </p>
      )}
    </Card>
  );
}

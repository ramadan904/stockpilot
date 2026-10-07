import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Abi, type Address, type Hash, type PublicClient } from "viem";
import type { AssetState } from "../../agent/model";
import { explorerTx } from "./chains";
import { Card, usd } from "./ui";

type Kind = "trade" | "money" | "control";

const sessionBaseline = new Map<string, bigint>();
export interface Entry {
  key: string;
  block: bigint;
  tx: Hash;
  kind: Kind;
  text: string;
  detail?: string;
  time?: number;
}

const FILTERS: [Kind | "all", string][] = [
  ["all", "All"],
  ["trade", "Trades"],
  ["money", "Money in and out"],
  ["control", "Settings"],
];

/** Everything that happened to a vault, newest first: trades, deposits, withdrawals, fees and every setting change. */
export function ActivityFeed(props: { client: PublicClient; vault: Address; abi: Abi; chainId: number; assets: AssetState[]; owner: Address; pilot: Address }) {
  const { client, vault, abi, chainId, assets, owner, pilot } = props;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const seenKey = `stockpilot:seen:${chainId}:${vault.toLowerCase()}`;
  // "New" means new since the previous page visit, so the baseline is read once per page load, not per render.
  const [seenBlock] = useState<bigint>(() => {
    if (!sessionBaseline.has(seenKey)) {
      let stored = 0n;
      try {
        stored = BigInt(localStorage.getItem(seenKey) ?? "0");
      } catch {
        // storage unavailable: no markers
      }
      sessionBaseline.set(seenKey, stored);
    }
    return sessionBaseline.get(seenKey)!;
  });

  useEffect(() => {
    (async () => {
      const { head, entries: list } = await loadActivity(client, vault, abi, assets, owner, pilot);
      setEntries(list);
      try {
        localStorage.setItem(seenKey, head.toString());
      } catch {
        // Private mode or storage disabled: the "new" markers just won't persist.
      }
    })().catch((e) => setError((e as Error).message.split("\n")[0]));
  }, [client, vault, abi, assets, owner, pilot, seenKey]);

  const shown = useMemo(() => (entries ?? []).filter((e) => filter === "all" || e.kind === filter), [entries, filter]);
  const fresh = (entries ?? []).filter((e) => seenBlock > 0n && e.block > seenBlock).length;

  return (
    <Card title="Activity" aside={fresh > 0 ? <span className="pill info">{fresh} new since your last visit</span> : <span className="muted small">newest first</span>}>
      <div className="chips" style={{ marginTop: 0 }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} className="chip" aria-pressed={filter === k} style={filter === k ? { borderStyle: "solid", color: "var(--text)", borderColor: "var(--accent)" } : undefined} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      {error && <p className="notice bad">{error}</p>}
      {!entries ? (
        <p className="muted" style={{ margin: 0 }}>
          Loading…
        </p>
      ) : shown.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing here yet.
        </p>
      ) : (
        <ul className="log">
          {shown.map((e) => {
            const url = explorerTx(chainId, e.tx);
            return (
              <li key={e.key}>
                <span className={`pill ${e.kind === "trade" ? "ok" : e.kind === "money" ? "info" : "warn"}`}>{e.kind === "trade" ? "Trade" : e.kind === "money" ? "Funds" : "Setting"}</span>
                <span>
                  {seenBlock > 0n && e.block > seenBlock && <strong>New · </strong>}
                  {e.text}{" "}
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  )}
                </span>
                <span className="hash">
                  {e.time ? new Date(e.time * 1000).toLocaleString() : `block ${e.block}`}
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** The vault's history as plain sentences, newest first; the most recent 40 carry their block time. */
export async function loadActivity(client: PublicClient, vault: Address, abi: Abi, assets: AssetState[], owner: Address, pilot: Address) {
  const head = await client.getBlockNumber();
  const logs = await client.getContractEvents({ address: vault, abi, fromBlock: head > 50_000n ? head - 50_000n : 0n });
  const list = logs.map((l, i) => describe(l as unknown as RawLog, i, assets, owner, pilot)).filter((e): e is Entry => e !== null).reverse();
  // Timestamps for the most recent blocks only, to keep this to a handful of requests.
  const blocks = [...new Set(list.slice(0, 40).map((e) => e.block))];
  const times = new Map(await Promise.all(blocks.map(async (b) => [b, Number((await client.getBlock({ blockNumber: b })).timestamp)] as const)));
  return { head, entries: list.map((e) => ({ ...e, time: times.get(e.block) })) };
}

interface RawLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hash;
  logIndex: number;
}

function describe(l: RawLog, i: number, assets: AssetState[], owner: Address, pilot: Address): Entry | null {
  const a = l.args;
  const asset = (t: unknown) => assets.find((x) => x.token.toLowerCase() === String(t).toLowerCase());
  const sym = (t: unknown) => asset(t)?.symbol ?? short(String(t));
  const amount = (t: unknown, v: unknown) => {
    const x = asset(t);
    if (!x) return `${String(v)} units of ${short(String(t))}`;
    const n = Number(formatUnits(v as bigint, x.decimals));
    const shown = n !== 0 && Math.abs(n) < 0.01 ? n.toLocaleString("en-US", { maximumSignificantDigits: 3 }) : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return `${shown} ${x.symbol}`;
  };
  const who = (addr: unknown) => {
    const s = String(addr).toLowerCase();
    return s === owner.toLowerCase() ? "you" : s === pilot.toLowerCase() ? "the pilot" : short(String(addr));
  };
  const base = { key: `${l.transactionHash}-${l.logIndex ?? i}`, block: l.blockNumber, tx: l.transactionHash };
  switch (l.eventName) {
    case "Rebalanced":
      return { ...base, kind: "trade", text: `Pilot sold ${usd(a.valueInUsd as bigint)} of ${sym(a.tokenIn)} for ${sym(a.tokenOut)}`, detail: `reason hash ${String(a.rationale).slice(0, 18)}…` };
    case "Deposited":
      return { ...base, kind: "money", text: `Deposit of ${amount(a.token, a.amount)} from ${who(a.from)}` };
    case "Withdrawn":
      return { ...base, kind: "money", text: `Withdrawal of ${amount(a.token, a.amount)} to ${who(a.to)}` };
    case "FeeCollected":
      return { ...base, kind: "money", text: `Pilot fee paid: ${amount(a.token, a.amount)}` };
    case "FeeSet":
      return { ...base, kind: "control", text: Number(a.feeBps) === 0 ? "Pilot fee cancelled" : `Pilot fee set to ${(Number(a.feeBps) / 100).toFixed(2)}% a year, paid to ${who(a.recipient)}` };
    case "MandateSet":
      return { ...base, kind: "control", text: `Mandate version ${a.version} signed` };
    case "PilotSet":
      return { ...base, kind: "control", text: /^0x0+$/.test(String(a.pilot)) ? "Pilot revoked" : `Pilot set to ${short(String(a.pilot))}` };
    case "AdapterSet":
      return { ...base, kind: "control", text: /^0x0+$/.test(String(a.adapter)) ? "Trading venue removed: no trades possible" : `Trading venue set to ${short(String(a.adapter))}` };
    case "Paused":
      return { ...base, kind: "control", text: `Vault paused by ${who(a.account)}` };
    case "Unpaused":
      return { ...base, kind: "control", text: `Vault unpaused by ${who(a.account)}` };
    case "HeirSet":
      return {
        ...base,
        kind: "control",
        text: /^0x0+$/.test(String(a.heir)) ? "Heir removed" : `Heir set: ${short(String(a.heir))} may take over after ${Number(a.inactivityPeriod) / 86_400} days without any owner action`,
      };
    case "OwnerCheckedIn":
      return { ...base, kind: "control", text: "Owner checked in: the inheritance clock restarted" };
    case "InheritanceClaimed":
      return { ...base, kind: "control", text: `${short(String(a.heir))} inherited the vault from ${short(String(a.previousOwner))}` };
    case "CrashGuardSet":
      return {
        ...base,
        kind: "control",
        text: /^0x0+$/.test(String(a.safeAsset)) ? "Crash guard turned off" : `Crash guard armed: past a ${Number(a.drawdownBps) / 100}% fall, ${sym(a.safeAsset)} goes to ${Number(a.safeTargetBps) / 100}%`,
      };
    case "DefensiveModeEntered":
      return { ...base, kind: "control", text: `Crash guard tripped: ${usd(a.valueUsd as bigint)} against a ${usd(a.peakUsd as bigint)} peak; defensive targets in force` };
    case "DefensiveModeExited":
      return { ...base, kind: "control", text: "Back to normal targets" };
    case "RecurringDepositSet":
      return {
        ...base,
        kind: "control",
        text: /^0x0+$/.test(String(a.token)) ? "Recurring investment stopped" : `Recurring investment set: ${amount(a.token, a.amount)} every ${Math.round(Number(a.interval) / 86_400)} days`,
      };
    case "RecurringDepositPulled":
      return { ...base, kind: "money", text: `Recurring investment pulled: ${amount(a.token, a.amount)}` };
    case "OwnershipTransferStarted":
      return { ...base, kind: "control", text: `Ownership transfer to ${short(String(a.newOwner))} started` };
    case "OwnershipTransferred":
      return /^0x0+$/.test(String(a.previousOwner)) ? null : { ...base, kind: "control", text: `Ownership moved to ${short(String(a.newOwner))}` };
    default:
      return null;
  }
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

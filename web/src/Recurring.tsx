// Recurring investment: a set amount from the owner's wallet into the vault on a schedule, for the pilot to invest.

import { useEffect, useState } from "react";
import { formatUnits, parseUnits, zeroAddress, type Address, type Chain, type Hash, type PublicClient, type WalletClient } from "viem";
import type { AssetState } from "../../agent/model";
import { mockErc20Abi, pilotVaultAbi } from "./abi";
import { Card } from "./ui";

const DAY = 86_400;
const SCHEDULES: [string, number][] = [
  ["Every week", 7 * DAY],
  ["Every two weeks", 14 * DAY],
  ["Every month", 30 * DAY],
];
const PERIODS_APPROVED = 12;

interface Plan {
  token: Address;
  amount: bigint;
  interval: number;
  nextAt: number;
  allowance: bigint;
  now: number;
}

export function RecurringCard(props: {
  client: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  vault: Address;
  owner: Address;
  assets: AssetState[];
  isOwner: boolean;
  canWrite: boolean;
  send: (label: string, write: () => Promise<Hash>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => () => void;
}) {
  const { client, wallet, chain, vault, owner, assets, isOwner, canWrite, send, run } = props;
  const cash = assets.find((a) => /USD/.test(a.symbol)) ?? assets[0];
  const [plan, setPlan] = useState<Plan | null>(null);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(100);
  const [interval, setInterval_] = useState(SCHEDULES[0][1]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    (async () => {
      const read = <T,>(functionName: "recurringToken" | "recurringAmount" | "recurringInterval" | "recurringNextAt") =>
        client.readContract({ address: vault, abi: pilotVaultAbi, functionName }) as Promise<T>;
      const [token, amt, iv, next, block] = await Promise.all([read<Address>("recurringToken"), read<bigint>("recurringAmount"), read<number>("recurringInterval"), read<bigint>("recurringNextAt"), client.getBlock()]);
      const allowance = amt > 0n ? ((await client.readContract({ address: token, abi: mockErc20Abi, functionName: "allowance", args: [owner, vault] })) as bigint) : 0n;
      setPlan({ token, amount: amt, interval: Number(iv), nextAt: Number(next), allowance, now: Number(block.timestamp) });
    })().catch(() => setPlan(null));
  }, [client, vault, owner, tick]);

  if (!plan) return null;
  const on = plan.amount > 0n;
  if (!on && !isOwner) return null;
  const asset = assets.find((a) => a.token.toLowerCase() === plan.token.toLowerCase()) ?? cash;
  const fmt = (x: bigint) => `${Number(formatUnits(x, asset.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${asset.symbol}`;
  const due = on && plan.now >= plan.nextAt;
  const periodsLeft = on ? Number(plan.allowance / plan.amount) : 0;
  const every = SCHEDULES.find(([, s]) => s === plan.interval)?.[0].toLowerCase() ?? `every ${Math.round(plan.interval / DAY)} days`;
  const date = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  const act = (label: string, fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      setEditing(false);
      setTick((t) => t + 1);
    });
  const vaultWrite = (functionName: "setRecurringDeposit" | "pullRecurringDeposit", args: readonly unknown[] = []) =>
    wallet.writeContract({ account: wallet.account!, chain, address: vault, abi: pilotVaultAbi, functionName, args } as never);

  return (
    <Card title="Recurring investment" aside={on ? <span className="pill ok">{due ? "Due now" : "On"}</span> : <span className="pill warn">Off</span>}>
      {on && !editing ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            {fmt(plan.amount)} {every} from {isOwner ? "your" : "the owner's"} wallet into the vault; the pilot invests it inside the mandate. {due ? "Due now." : `Next on ${date(plan.nextAt)}.`}{" "}
            {periodsLeft > 0 ? `Approved for ${periodsLeft} more.` : "The approval has run out: no more pulls until it is renewed."}
          </p>
          <div className="row">
            {due && canWrite && periodsLeft > 0 && (
              <button className="btn primary" onClick={act("Pull", () => send("Pull recurring investment", () => vaultWrite("pullRecurringDeposit")))}>
                Pull now
              </button>
            )}
            {isOwner && (
              <>
                <button className="btn" onClick={() => (setAmount(Number(formatUnits(plan.amount, asset.decimals))), setInterval_(plan.interval), setEditing(true))}>
                  Change
                </button>
                <button className="btn danger" onClick={act("Stop", () => send("Stop recurring investment", () => vaultWrite("setRecurringDeposit", [zeroAddress, 0n, 0])))}>
                  Stop
                </button>
              </>
            )}
          </div>
        </>
      ) : !editing ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            Invest a set amount on a schedule, like a brokerage's recurring buy. The vault can only pull your set amount, at most once per period, and
            never more than you approve. Pulls don't count as you checking in, so they never keep an heir waiting.
          </p>
          <button className="btn" onClick={() => setEditing(true)}>
            Set up recurring investment
          </button>
        </>
      ) : null}

      {editing && isOwner && (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <div className="row">
            <label className="field" style={{ width: 150 }}>
              Amount ({cash.symbol})
              <input type="number" min={1} step={10} value={amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value)))} />
            </label>
            <label className="field" style={{ width: 170 }}>
              How often
              <select value={interval} onChange={(e) => setInterval_(Number(e.target.value))}>
                {SCHEDULES.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Two signatures: approve the vault for {PERIODS_APPROVED} pulls ({(amount * PERIODS_APPROVED).toLocaleString("en-US")} {cash.symbol}), then set the schedule.
          </p>
          <div className="row">
            <button
              className="btn primary"
              onClick={act("Recurring", async () => {
                const each = parseUnits(String(amount), cash.decimals);
                await send(`Approve ${cash.symbol}`, () =>
                  wallet.writeContract({ account: wallet.account!, chain, address: cash.token, abi: mockErc20Abi, functionName: "approve", args: [vault, each * BigInt(PERIODS_APPROVED)] }),
                );
                await send("Set recurring investment", () => vaultWrite("setRecurringDeposit", [cash.token, each, interval]));
              })}
            >
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

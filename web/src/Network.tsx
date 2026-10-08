// The whole StockPilot deployment on one page, read from the chain as it stands: the money under mandate and what it
// is invested in, every vault, fund, pilot, letter and credential, and the latest trades across all vaults, each one
// checked by its vault's contract. Nothing here comes from a server.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPublicClient, type Address, type Hash, type PublicClient } from "viem";
import { logsInRange } from "../../agent/history";
import { LISTINGS } from "../../agent/listings";
import { mandateCredentialAbi, pilotFundFactoryAbi, pilotJournalAbi, pilotRegistryAbi, pilotVaultAbi, pilotVaultFactoryAbi } from "./abi";
import { CHAINS, deploymentFor, explorerTx, type Deployment } from "./chains";
import { historyStart, rpcTransport } from "./rpc";
import { Card, usd } from "./ui";

/** Vaults read for the totals, newest first; enough for any testnet, and a bound on what one page load asks for. */
const MAX_VAULTS = 200;
const REFRESH_MS = 60_000;

interface Trade {
  vault: Address;
  tx: Hash;
  sold: string;
  bought: string;
  valueUsd: bigint;
  at: number;
}

interface NetworkData {
  vaults: number;
  read: number;
  paused: number;
  totalUsd: bigint;
  bySymbol: { symbol: string; usd: bigint }[];
  trades: number;
  volumeUsd: bigint;
  latest: Trade[];
  funds: number | null;
  pilots: number | null;
  letters: number | null;
  credentials: number | null;
  now: number;
  block: bigint;
}

async function readNetwork(client: PublicClient, d: Deployment): Promise<NetworkData> {
  const count = Number(await client.readContract({ address: d.factory, abi: pilotVaultFactoryAbi, functionName: "vaultCount" }));
  const n = Math.min(count, MAX_VAULTS);
  const vaults = (await Promise.all(
    Array.from({ length: n }, (_, i) => client.readContract({ address: d.factory, abi: pilotVaultFactoryAbi, functionName: "vaultAt", args: [BigInt(count - 1 - i)] })),
  )) as Address[];

  const symbolOf = new Map(Object.entries(d.tokens).map(([s, a]) => [a.toLowerCase(), s]));
  const [portfolios, paused] = await Promise.all([
    Promise.all(vaults.map((v) => client.readContract({ address: v, abi: pilotVaultAbi, functionName: "portfolio" }).catch(() => null))),
    Promise.all(vaults.map((v) => client.readContract({ address: v, abi: pilotVaultAbi, functionName: "paused" }).catch(() => false))),
  ]);
  const by = new Map<string, bigint>();
  let totalUsd = 0n;
  for (const p of portfolios) {
    if (!p) continue;
    const [holdings, total] = p as unknown as [{ token: Address; valueUsd: bigint }[], bigint];
    totalUsd += total;
    for (const h of holdings) {
      const s = symbolOf.get(h.token.toLowerCase()) ?? "Other";
      by.set(s, (by.get(s) ?? 0n) + h.valueUsd);
    }
  }

  const [headBlock, start] = await Promise.all([client.getBlock({ blockTag: "latest" }), historyStart(client)]);
  const head = headBlock.number;
  const events = <T,>(address: Address | Address[], abi: unknown, eventName: string) =>
    logsInRange((fromBlock, toBlock) => client.getContractEvents({ address, abi, eventName, fromBlock, toBlock } as never) as Promise<T[]>, start, head);

  type Log = { blockNumber: bigint | null; transactionHash: Hash | null; address: Address; args: Record<string, unknown> };
  const [trades, letters, credentials, funds, pilots] = await Promise.all([
    vaults.length ? events<Log>(vaults, pilotVaultAbi, "Rebalanced") : Promise.resolve([] as Log[]),
    d.journal ? events<Log>(d.journal, pilotJournalAbi, "Letter").then((l) => l.length) : null,
    d.credential ? events<Log>(d.credential, mandateCredentialAbi, "Issued").then((l) => l.length) : null,
    d.funds ? client.readContract({ address: d.funds, abi: pilotFundFactoryAbi, functionName: "fundCount" }).then(Number) : null,
    d.registry ? client.readContract({ address: d.registry, abi: pilotRegistryAbi, functionName: "pilotCount" }).then(Number) : null,
  ]);

  const recent = trades.slice(-8).reverse();
  const times = new Map<bigint, number>();
  await Promise.all(
    [...new Set(recent.map((t) => t.blockNumber!))].map(async (b) => times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp))),
  );
  const sym = (a: unknown) => symbolOf.get(String(a).toLowerCase()) ?? `${String(a).slice(0, 6)}…`;

  return {
    vaults: count,
    read: n,
    paused: paused.filter(Boolean).length,
    totalUsd,
    bySymbol: [...by.entries()].map(([symbol, v]) => ({ symbol, usd: v })).filter((x) => x.usd > 0n).sort((a, b) => (b.usd > a.usd ? 1 : -1)),
    trades: trades.length,
    volumeUsd: trades.reduce((s, t) => s + (t.args.valueInUsd as bigint), 0n),
    latest: recent.map((t) => ({
      vault: t.address,
      tx: t.transactionHash!,
      sold: sym(t.args.tokenIn),
      bought: sym(t.args.tokenOut),
      valueUsd: t.args.valueInUsd as bigint,
      at: times.get(t.blockNumber!) ?? 0,
    })),
    funds,
    pilots,
    letters,
    credentials,
    now: Number(headBlock.timestamp),
    block: head,
  };
}

function ago(seconds: number) {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 5_400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

const slotOf = (symbol: string) => {
  const i = LISTINGS.findIndex((l) => l.symbol === symbol);
  return i < 0 ? 0 : i + 1;
};

export function Network() {
  const deployed = CHAINS.filter((c) => deploymentFor(c.id));
  const asked = Number(new URLSearchParams(window.location.search).get("chain"));
  const [chainId, setChainId] = useState(() => (deployed.find((c) => c.id === asked) ?? deployed[0])?.id ?? CHAINS[0].id);
  const chain = CHAINS.find((c) => c.id === chainId)!;
  const deployment = deploymentFor(chainId);
  const client = useMemo(() => createPublicClient({ chain, transport: rpcTransport() }) as PublicClient, [chain]);
  const [data, setData] = useState<NetworkData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!deployment) return;
    let live = true;
    setError(null);
    readNetwork(client, deployment)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message.split("\n")[0] : String(e)));
    const timer = setTimeout(() => setTick((t) => t + 1), REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, deployment, tick]);

  const stat = (label: string, value: string, note?: string, testid?: string) => (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" data-testid={testid}>
        {value}
      </div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );

  return (
    <div className="stack">
      <Card
        title={<>StockPilot onchain <span className="pulse-dot" aria-hidden /></>}
        aside={<span className="muted small">read from the chain{data ? ` at block ${data.block.toLocaleString("en-US")}` : ""}, refreshed every minute</span>}
      >
        <div className="row" style={{ marginBottom: 10 }}>
          <label className="field" style={{ width: 240 }}>
            Network
            <select
              value={chainId}
              onChange={(e) => {
                setData(null);
                setChainId(Number(e.target.value));
              }}
            >
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id} disabled={!deploymentFor(c.id)}>
                  {c.name}
                  {deploymentFor(c.id) ? "" : " (not deployed yet)"}
                </option>
              ))}
            </select>
          </label>
          <button className="btn small" style={{ alignSelf: "end", marginBottom: 6 }} onClick={() => setTick((t) => t + 1)}>
            Refresh
          </button>
        </div>
        {error && <p className="notice bad">Could not read {chain.name}: {error}</p>}
        {!deployment ? (
          <p className="muted">StockPilot is not deployed on {chain.name} in this build.</p>
        ) : !data ? (
          !error && <p className="muted">Reading every vault on {chain.name}…</p>
        ) : (
          <>
            <div className="stats">
              {stat("Under mandate", usd(data.totalUsd, false), `${data.vaults} vault${data.vaults === 1 ? "" : "s"}${data.paused ? `, ${data.paused} paused` : ""}`, "net-total")}
              {stat("Trades", data.trades.toLocaleString("en-US"), `${usd(data.volumeUsd, false)} traded, each checked onchain`, "net-trades")}
              {data.funds !== null && stat("Funds", String(data.funds), "pooled vaults, open to anyone", "net-funds")}
              {data.pilots !== null && stat("Pilots listed", String(data.pilots), "in the marketplace", "net-pilots")}
              {data.letters !== null && stat("Letters", String(data.letters), "published by pilots", "net-letters")}
              {data.credentials !== null && stat("Verified Mandates", String(data.credentials), "soulbound credentials", "net-credentials")}
            </div>
            {data.read < data.vaults && <p className="muted small">Totals cover the newest {data.read} vaults.</p>}
            {data.bySymbol.length > 0 && (
              <>
                <div className="net-bar" role="img" aria-label={`Invested in: ${data.bySymbol.map((b) => `${b.symbol} ${usd(b.usd, false)}`).join(", ")}`}>
                  {data.bySymbol.map((b) => (
                    <span
                      key={b.symbol}
                      style={{ "--c": `var(--series-${slotOf(b.symbol)})`, flexGrow: Number((b.usd * 10_000n) / (data.totalUsd || 1n)) } as CSSProperties}
                      title={`${b.symbol} ${usd(b.usd, false)}`}
                    />
                  ))}
                </div>
                <p className="aura-key small" style={{ marginTop: 6 }}>
                  {data.bySymbol.map((b) => (
                    <span key={b.symbol} className="aura-chip">
                      <span className="aura-dot" style={{ "--c": `var(--series-${slotOf(b.symbol)})` } as CSSProperties} />
                      {b.symbol} {data.totalUsd > 0n ? Math.round(Number((b.usd * 1000n) / data.totalUsd) / 10) : 0}%
                    </span>
                  ))}
                </p>
              </>
            )}
          </>
        )}
      </Card>

      {data && deployment && (
        <Card title="Latest trades, every vault" aside={<span className="muted small">only trades the contract accepted can land</span>}>
          {data.latest.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              No trades yet on {chain.name}. Pilots trade when an asset drifts past its trigger.
            </p>
          ) : (
            <ul className="log net-trades" aria-label="Latest trades">
              {data.latest.map((t) => (
                <li key={t.tx}>
                  <span className="muted">{ago(data.now - t.at)} ago</span> · vault{" "}
                  <a href={`?chain=${chainId}&vault=${t.vault}`} className="mono">
                    {t.vault.slice(0, 6)}…{t.vault.slice(-4)}
                  </a>{" "}
                  sold {usd(t.valueUsd)} of {t.sold} for {t.bought}
                  {explorerTx(chainId, t.tx) && (
                    <>
                      {" "}
                      · <a href={explorerTx(chainId, t.tx)} target="_blank" rel="noreferrer">tx</a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            A trade that breaks its vault's mandate reverts, so it never appears here: try one yourself with the Attack Theater on any vault page.
          </p>
        </Card>
      )}
    </div>
  );
}

// The pilot marketplace in the browser: pick a pilot for a new vault by its onchain track record, or list yourself.

import { useEffect, useState } from "react";
import type { Abi, Address, Hash, PublicClient, WalletClient, Chain } from "viem";
import { emptyRecord, listPilots, pilotScores, trackRecords, type PilotEntry, type PilotScore, type TrackRecord } from "../../agent/pilots";
import { pilotRegistryAbi, pilotVaultAbi, pilotVaultFactoryAbi } from "./abi";
import type { Deployment } from "./chains";
import { Card, usd } from "./ui";

export interface Market {
  pilots: PilotEntry[];
  records: Map<string, TrackRecord>;
  /** Value added after fees against holding, per pilot (lower-cased address); empty until read or if the RPC refuses. */
  scores: Map<string, PilotScore>;
  /** Registry entry by lower-cased address. */
  byAddress: Map<string, PilotEntry>;
  error?: string;
}

const EMPTY: Market = { pilots: [], records: new Map(), scores: new Map(), byAddress: new Map() };

/** The registry and every listed pilot's track record. Re-reads when `refresh` changes. */
export function useMarket(client: PublicClient, deployment: Deployment | undefined, refresh: number): Market {
  const [market, setMarket] = useState<Market>(EMPTY);
  useEffect(() => {
    let live = true;
    const registry = deployment?.registry;
    if (!deployment || !registry) return setMarket(EMPTY);
    (async () => {
      const pilots = await listPilots(client, pilotRegistryAbi as Abi, registry);
      const byAddress = new Map(pilots.map((p) => [p.address.toLowerCase(), p]));
      // Track records need event logs; an RPC that refuses a wide range should not hide the directory.
      const records = await trackRecords(client, { factory: pilotVaultFactoryAbi as Abi, vault: pilotVaultAbi as Abi }, deployment.factory, pilots.map((p) => p.address)).catch(
        () => new Map<string, TrackRecord>(),
      );
      if (live) setMarket({ pilots, records, scores: new Map(), byAddress });
      // Scores read each vault's history at sampled blocks: slower, so they fill in after the directory shows.
      const scores = await pilotScores(client, { factory: pilotVaultFactoryAbi as Abi, vault: pilotVaultAbi as Abi }, deployment.factory, pilots.map((p) => p.address)).catch(
        () => new Map<string, PilotScore>(),
      );
      if (live) setMarket({ pilots, records, scores, byAddress });
    })().catch((e) => live && setMarket({ ...EMPTY, error: (e as Error).message.split("\n")[0] }));
    return () => {
      live = false;
    };
  }, [client, deployment, refresh]);
  return market;
}

function recordLine(r: TrackRecord | undefined) {
  if (!r) return "Track record unavailable on this RPC";
  if (r.vaults === 0 && r.trades === 0) return "No vaults yet";
  return [
    `Flies ${r.vaults} vault${r.vaults === 1 ? "" : "s"} worth ${usd(r.aumUsd, false)}`,
    `${r.trades} trade${r.trades === 1 ? "" : "s"} (${usd(r.tradedUsd, false)})`,
    r.paused ? `${r.paused} paused` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const signedPct = (bps: number) => `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;

/** Active pilots first, then by value added (unscored last), then by registration. */
function ranked(market: Market) {
  const added = (p: PilotEntry) => market.scores.get(p.address.toLowerCase())?.addedBps ?? -Infinity;
  return market.pilots
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.active) - Number(a.p.active) || added(b.p) - added(a.p) || a.i - b.i)
    .map((x) => x.p);
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Choose who flies a new vault: yourself, a listed pilot, or any address. */
export function PilotPicker(props: { market: Market; me: Address; value: string; onPick: (pilot: string, feeBps: number) => void }) {
  const { market, me, value, onPick } = props;
  const active = market.pilots.filter((p) => p.active);
  // Which option was clicked: listing yourself makes "Myself" and your listing the same address, with different fees.
  const [mode, setMode] = useState<"me" | "listed" | "custom">(value.toLowerCase() === me.toLowerCase() ? "me" : "custom");

  return (
    <div className="pilot-list" role="radiogroup" aria-label="Pilot">
      <button type="button" role="radio" aria-checked={mode === "me"} className="pilot-option" onClick={() => (setMode("me"), onPick(me, 0))}>
        <span className="pilot-name">Myself</span>
        <span className="muted small">Run the pilot from this page with your wallet. No fee.</span>
      </button>
      {active.map((p) => {
        const selected = mode === "listed" && p.address.toLowerCase() === value.toLowerCase();
        return (
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            key={p.address}
            className="pilot-option"
            onClick={() => (setMode("listed"), onPick(p.address, p.feeBps))}
          >
            <span className="pilot-name">
              {p.name} <span className="mono muted small">{short(p.address)}</span>
            </span>
            <span className="small">
              Asks {(p.feeBps / 100).toFixed(2)}% a year · {recordLine(market.records.get(p.address.toLowerCase()))}
            </span>
            {p.uri && <span className="muted small pilot-uri">{p.uri}</span>}
          </button>
        );
      })}
      <button type="button" role="radio" aria-checked={mode === "custom"} className="pilot-option" onClick={() => setMode("custom")}>
        <span className="pilot-name">Another address</span>
        <span className="muted small">Any agent with its own key, e.g. one you run through the MCP server.</span>
      </button>
      {mode === "custom" && (
        <label className="field" style={{ margin: "4px 0 0" }}>
          Pilot address
          <input type="text" value={value} onChange={(e) => onPick(e.target.value.trim(), market.byAddress.get(e.target.value.trim().toLowerCase())?.feeBps ?? 0)} spellCheck={false} />
        </label>
      )}
      {market.error && <p className="notice bad small">Could not read the pilot registry: {market.error}</p>}
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        Names are chosen by the pilots themselves; the track record is read from the chain. Whoever you pick can only trade inside your mandate,
        and you can replace them at any time.
      </p>
    </div>
  );
}

/** The whole directory, and a form for the connected wallet to list itself as a pilot. */
export function MarketplaceCard(props: {
  market: Market;
  me: Address;
  /** False in a read-only view. */
  canList: boolean;
  registry: Address;
  wallet: WalletClient;
  chain: Chain;
  send: (label: string, write: () => Promise<Hash>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => () => void;
}) {
  const { market, me, canList, registry, wallet, chain, send, run } = props;
  const mine = market.byAddress.get(me.toLowerCase());
  const [name, setName] = useState(mine?.name ?? "");
  const [uri, setUri] = useState(mine?.uri ?? "");
  const [fee, setFee] = useState(mine ? mine.feeBps / 100 : 0.5);
  const [open, setOpen] = useState(false);
  const write = (functionName: "register" | "retire", args: readonly unknown[] = []) =>
    wallet.writeContract({ account: wallet.account!, chain, address: registry, abi: pilotRegistryAbi, functionName, args } as never);

  return (
    <Card title="Pilot marketplace" aside={<span className="muted small">{market.pilots.filter((p) => p.active).length} listed</span>}>
      {market.pilots.length === 0 ? (
        <p className="muted small" style={{ marginTop: 0 }}>
          No pilots are listed on this network yet.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="holdings">
            <thead>
              <tr>
                <th>Pilot</th>
                <th className="num">Asks</th>
                <th className="num" title="What the pilot's vaults are worth against holding what it took over, after fees">Added vs holding</th>
              </tr>
            </thead>
            <tbody>
              {ranked(market).map((p) => {
                const r = market.records.get(p.address.toLowerCase()) ?? emptyRecord();
                const sc = market.scores.get(p.address.toLowerCase());
                return (
                  <tr key={p.address} style={p.active ? undefined : { opacity: 0.55 }}>
                    <td>
                      <div>{p.name}{p.address.toLowerCase() === me.toLowerCase() ? " (you)" : ""}{p.active ? "" : " (retired)"}</div>
                      <div className="mono muted small">{short(p.address)}</div>
                      <div className="muted small">
                        {r.vaults} vault{r.vaults === 1 ? "" : "s"}{r.paused ? ` (${r.paused} paused)` : ""} · {usd(r.aumUsd, false)} · {r.trades} trade{r.trades === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="num">{(p.feeBps / 100).toFixed(2)}%</td>
                    <td className="num" data-testid="added">
                      {sc?.addedBps == null ? "–" : <strong className={sc.addedBps > 0 ? "up" : sc.addedBps < 0 ? "down" : ""}>{signedPct(sc.addedBps)}</strong>}
                      {sc?.addedBps != null && (
                        <div className="small muted" data-testid="falls">
                          worst fall {sc.worstFallPct.toFixed(1)}% vs {sc.untradedWorstFallPct.toFixed(1)}%
                          <br />
                          {sc.vaultDays < 10 ? sc.vaultDays.toFixed(1) : Math.round(sc.vaultDays)} vault-days
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {market.scores.size > 0 && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Ranked by value added after fees: each vault against holding what the pilot took over (plus later deposits, minus withdrawals), at
          the vaults' own oracle prices, all read from the chain. Worst fall is per dollar invested, the pilot's vaults then holding. Few vault-days
          mean little evidence either way.
        </p>
      )}
      {!canList ? null : !open ? (
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
          {mine?.active ? "Edit your listing" : "List yourself as a pilot"}
        </button>
      ) : (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <p className="muted small" style={{ margin: 0 }}>
            Lists {short(me)} as a pilot owners can hire. Run it with the fleet service or your own agent; the fee is what you ask, and each owner sets their vault's fee.
          </p>
          <label className="field">
            Name
            <input type="text" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Link (website, repository or MCP endpoint)
            <input type="text" maxLength={256} value={uri} onChange={(e) => setUri(e.target.value)} />
          </label>
          <label className="field">
            Fee you ask (% a year, max 2)
            <input type="number" min={0} max={2} step={0.05} value={fee} onChange={(e) => setFee(Math.min(2, Math.max(0, Number(e.target.value))))} />
          </label>
          <div className="row">
            <button className="btn primary" disabled={!name.trim()} onClick={run(() => send("List as pilot", () => write("register", [name.trim(), uri.trim(), Math.round(fee * 100)])))}>
              {mine ? "Save listing" : "List me"}
            </button>
            {mine?.active && (
              <button className="btn danger" onClick={run(() => send("Retire listing", () => write("retire")))}>
                Retire
              </button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

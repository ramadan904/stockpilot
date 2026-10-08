// Pilot funds: a vault many people own together. Anyone buys shares with an asset in the mandate at fresh oracle
// prices; any holder leaves at any time with their exact share of every holding. The mandate never changes, and a new
// pilot takes over only after three days' notice.

import { useEffect, useState } from "react";
import { formatUnits, isAddress, parseUnits, zeroAddress, type Address, type Chain, type Hash, type PublicClient, type WalletClient } from "viem";
import { LISTINGS } from "../../agent/listings";
import { toMandate, type Proposal } from "../../agent/mandate";
import type { VaultState } from "../../agent/model";
import { mockErc20Abi, pilotFundAbi, pilotFundFactoryAbi } from "./abi";
import type { Deployment } from "./chains";
import { PilotPicker, type Market } from "./Pilots";
import { Card, usd } from "./ui";

type Send = (label: string, write: () => Promise<Hash>) => Promise<unknown>;
type Run = (fn: () => Promise<unknown>) => () => void;
type Me = { client: WalletClient; address: Address; kind: "injected" | "dev" | "watch" };

const shares = (wad: bigint) => Number(formatUnits(wad, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The token amount worth `usdAmount` at the asset's price in the vault (18-decimal USD). */
function tokenAmount(usdAmount: number, priceWad: bigint, decimals: number) {
  const price = Number(priceWad) / 1e18;
  return parseUnits((usdAmount / price).toFixed(Math.min(decimals, 8)), decimals);
}

interface FundInfo {
  name: string;
  symbol: string;
  supply: bigint;
  nav: bigint;
  manager: Address;
  pendingPilot: Address;
  pilotChangeAt: number;
  mine: bigint;
}

/** On a vault page: if the vault belongs to a fund, its shares, a way in, a way out, and any announced pilot change. */
export function FundCard(props: {
  client: PublicClient;
  me: Me;
  chain: Chain;
  deployment: Deployment;
  owner: Address;
  pilot: Address;
  state: VaultState;
  market: Market;
  send: Send;
  run: Run;
}) {
  const { client, me, chain, deployment, owner, pilot, state, market, send, run } = props;
  const [info, setInfo] = useState<FundInfo | null>(null);
  const [asset, setAsset] = useState(() => (state.assets.find((a) => LISTINGS.some((l) => l.symbol === a.symbol && "stable" in l)) ?? state.assets[0]).token);
  const [amountUsd, setAmountUsd] = useState(1_000);
  const [sellShares, setSellShares] = useState("");
  const [nextPilot, setNextPilot] = useState("");

  useEffect(() => {
    if (!deployment.funds) return;
    let live = true;
    (async () => {
      const isFund = await client.readContract({ address: deployment.funds!, abi: pilotFundFactoryAbi, functionName: "isFund", args: [owner] });
      if (!isFund) return;
      const read = (functionName: string, args: readonly unknown[] = []) => client.readContract({ address: owner, abi: pilotFundAbi, functionName, args } as never) as Promise<unknown>;
      const [name, symbol, supply, nav, manager, pendingPilot, pilotChangeAt, mine] = await Promise.all([
        read("name"),
        read("symbol"),
        read("totalSupply"),
        read("navPerShare"),
        read("manager"),
        read("pendingPilot"),
        read("pilotChangeAt"),
        me.kind === "watch" ? Promise.resolve(0n) : read("balanceOf", [me.address]),
      ]);
      if (live)
        setInfo({
          name: name as string,
          symbol: symbol as string,
          supply: supply as bigint,
          nav: nav as bigint,
          manager: manager as Address,
          pendingPilot: pendingPilot as Address,
          pilotChangeAt: Number(pilotChangeAt),
          mine: mine as bigint,
        });
    })().catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [client, deployment.funds, owner, me.address, me.kind]);

  if (!info) return null;
  const w = me.client;
  const canWrite = me.kind !== "watch";
  const isManager = canWrite && info.manager.toLowerCase() === me.address.toLowerCase();
  const now = Number(state.now);
  const write = (label: string, functionName: string, args: readonly unknown[] = []) =>
    send(label, () => w.writeContract({ account: w.account!, chain, address: owner, abi: pilotFundAbi, functionName, args } as never));
  const pilotName = (a: Address) => (a === zeroAddress ? "no pilot" : (market.byAddress.get(a.toLowerCase())?.name ?? shortAddr(a)));

  const buy = run(async () => {
    const a = state.assets.find((x) => x.token === asset)!;
    const amount = tokenAmount(amountUsd, a.price, a.decimals);
    const [quoted] = (await client.readContract({ address: owner, abi: pilotFundAbi, functionName: "quote", args: [a.token, amount] })) as [bigint, bigint];
    const base = { account: w.account!, chain, address: a.token, abi: mockErc20Abi } as const;
    if (!deployment.production) await send(`Mint test ${a.symbol}`, () => w.writeContract({ ...base, functionName: "mint", args: [me.address, amount] }));
    await send(`Approve ${a.symbol}`, () => w.writeContract({ ...base, functionName: "approve", args: [owner, amount] }));
    // Allow half a percent for prices moving between the quote and the purchase.
    await write(`Buy ${info.symbol}`, "buy", [a.token, amount, (quoted * 995n) / 1000n]);
  });

  const redeem = run(async () => {
    const n = sellShares.trim() === "" ? 0n : parseUnits(sellShares.trim(), 18);
    if (n <= 0n || n > info.mine) throw new Error(`Enter up to ${shares(info.mine)} shares.`);
    await write(`Redeem ${info.symbol}`, "redeem", [n, me.address]);
  });

  const due = info.pilotChangeAt !== 0 && now >= info.pilotChangeAt;
  return (
    <Card title={<>Fund <span className="pill info">{info.symbol}</span></>} aside={<span className="muted small">many owners, one mandate that never changes</span>}>
      <p className="small" style={{ marginTop: 0 }}>
        <strong>{info.name}</strong> owns this vault. Anyone can buy shares with an asset in its mandate, at the vault's value at fresh prices;
        any holder can leave at any time with their exact share of every holding, paused or not. No one can change its rules.
      </p>
      <div className="stats">
        <div className="stat">
          <div className="label">Value per share</div>
          <div className="value" data-testid="fund-nav">{usd(info.nav)}</div>
        </div>
        <div className="stat">
          <div className="label">Shares outstanding</div>
          <div className="value">{shares(info.supply)}</div>
        </div>
        <div className="stat">
          <div className="label">Your shares</div>
          <div className="value" data-testid="fund-mine">{canWrite ? shares(info.mine) : "–"}</div>
          {canWrite && info.mine > 0n && <div className="muted small">worth {usd((info.mine * info.nav) / 10n ** 18n)}</div>}
        </div>
        <div className="stat">
          <div className="label">Manager</div>
          <div className="value" style={{ fontSize: 16 }}>{isManager ? "You" : shortAddr(info.manager)}</div>
          <div className="muted small">can pause; cannot move funds</div>
        </div>
      </div>

      {info.pilotChangeAt !== 0 && (
        <p className="notice warn" data-testid="pilot-change">
          New pilot announced: {pilotName(info.pendingPilot)} takes over from {pilotName(pilot)}{" "}
          {due ? "now that the notice has run" : `on ${new Date(info.pilotChangeAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}. Holders
          who disagree can leave before then.{" "}
          {due && canWrite && (
            <button className="btn small" onClick={run(() => write("Apply pilot change", "applyPilotChange"))}>
              Apply it
            </button>
          )}
        </p>
      )}

      {canWrite ? (
        <>
          <div className="row">
            <label className="field" style={{ width: 120 }}>
              Pay with
              <select value={asset} onChange={(e) => setAsset(e.target.value as Address)}>
                {state.assets.map((a) => (
                  <option key={a.token} value={a.token}>
                    {a.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ width: 150 }}>
              Amount (USD)
              <input type="number" min={1} step={100} value={amountUsd} onChange={(e) => setAmountUsd(Math.max(1, Number(e.target.value)))} />
            </label>
            <button className="btn primary" style={{ alignSelf: "end" }} disabled={state.paused} onClick={buy}>
              Buy shares
            </button>
          </div>
          {info.mine > 0n && (
            <div className="row">
              <label className="field" style={{ width: 170 }}>
                Shares to redeem
                <input type="text" inputMode="decimal" value={sellShares} placeholder={shares(info.mine)} onChange={(e) => setSellShares(e.target.value)} />
              </label>
              <button className="btn small" style={{ alignSelf: "end", marginBottom: 6 }} onClick={() => setSellShares(formatUnits(info.mine, 18))}>
                All
              </button>
              <button className="btn" style={{ alignSelf: "end" }} onClick={redeem}>
                Redeem in kind
              </button>
            </div>
          )}
          {isManager && (
            <div className="row">
              <button className={`btn ${state.paused ? "" : "danger"}`} onClick={run(() => write(state.paused ? "Unpause" : "Pause", state.paused ? "unpause" : "pause"))}>
                {state.paused ? "Unpause fund" : "Pause fund"}
              </button>
              {info.pilotChangeAt === 0 ? (
                <>
                  <input type="text" placeholder="New pilot address" value={nextPilot} onChange={(e) => setNextPilot(e.target.value.trim())} spellCheck={false} style={{ width: 220 }} />
                  <button
                    className="btn"
                    onClick={run(async () => {
                      if (!isAddress(nextPilot)) throw new Error("The pilot address is not valid.");
                      await write("Announce new pilot", "proposePilot", [nextPilot]);
                    })}
                  >
                    Announce (3 days' notice)
                  </button>
                </>
              ) : (
                <button className="btn" onClick={run(() => write("Cancel pilot change", "cancelPilotChange"))}>
                  Cancel the pilot change
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Connect a wallet to buy shares.
        </p>
      )}
    </Card>
  );
}

interface FundRow {
  fund: Address;
  vault: Address;
  name: string;
  symbol: string;
  supply: bigint;
  nav: bigint;
}

/** Every fund on this network, and a way to launch one from the drafted mandate. */
export function FundsCard(props: {
  client: PublicClient;
  me: Me;
  chain: Chain;
  deployment: Deployment;
  proposal: Proposal | null;
  market: Market;
  refresh: number;
  send: Send;
  run: Run;
  onOpen: (vault: Address) => void;
}) {
  const { client, me, chain, deployment, proposal, market, refresh, send, run, onOpen } = props;
  const [rows, setRows] = useState<FundRow[] | null>(null);
  const [launching, setLaunching] = useState(false);
  const [name, setName] = useState("StockPilot Core Fund");
  const [symbol, setSymbol] = useState("SPCORE");
  const [pilot, setPilot] = useState<string>(me.address);
  const [feePct, setFeePct] = useState(0);
  const [sizeUsd, setSizeUsd] = useState(100_000);
  const [seedUsd, setSeedUsd] = useState(1_000);

  useEffect(() => {
    if (!deployment.funds) return;
    let live = true;
    (async () => {
      const list = (await client.readContract({ address: deployment.funds!, abi: pilotFundFactoryAbi, functionName: "funds" })) as Address[];
      const out = await Promise.all(
        list.map(async (fund) => {
          const read = (functionName: string) => client.readContract({ address: fund, abi: pilotFundAbi, functionName } as never) as Promise<unknown>;
          const [vault, n, s, supply, nav] = await Promise.all([read("vault"), read("name"), read("symbol"), read("totalSupply"), read("navPerShare")]);
          return { fund, vault: vault as Address, name: n as string, symbol: s as string, supply: supply as bigint, nav: nav as bigint };
        }),
      );
      if (live) setRows(out.reverse());
    })().catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [client, deployment.funds, refresh]);

  if (!deployment.funds || rows === null) return null;
  const w = me.client;
  const canWrite = me.kind !== "watch";

  const launch = run(async () => {
    if (!proposal) throw new Error("Draft a mandate first.");
    if (!isAddress(pilot)) throw new Error("The pilot address is not valid.");
    if (!name.trim() || !symbol.trim()) throw new Error("Give the fund a name and a ticker.");
    const universe = LISTINGS.map((l) => ({ ...l, token: deployment.tokens[l.symbol], feed: deployment.feeds[l.symbol], stable: "stable" in l }));
    // The mandate is fixed for the fund's life, so its dollar limits are set for the size it expects to reach.
    const { mandate } = toMandate(proposal, universe, sizeUsd);
    const cfg = {
      pilot: pilot as Address,
      adapter: deployment.venue ?? deployment.marketMaker,
      assets: mandate.assets,
      limits: mandate.limits,
      feeRecipient: feePct > 0 ? (pilot as Address) : zeroAddress,
      feeBps: Math.round(feePct * 100),
    };
    await send("Launch fund", () =>
      w.writeContract({ account: w.account!, chain, address: deployment.funds!, abi: pilotFundFactoryAbi, functionName: "createFund", args: [name.trim(), symbol.trim().toUpperCase(), cfg] }),
    );
    const list = (await client.readContract({ address: deployment.funds!, abi: pilotFundFactoryAbi, functionName: "funds" })) as Address[];
    const fund = list[list.length - 1];
    const vault = (await client.readContract({ address: fund, abi: pilotFundAbi, functionName: "vault" })) as Address;
    if (seedUsd > 0) {
      // The first purchase, in the stablecoin: one share per dollar.
      const cash = LISTINGS.find((l) => "stable" in l)!;
      const token = deployment.tokens[cash.symbol];
      const amount = parseUnits(seedUsd.toFixed(2), cash.decimals);
      const base = { account: w.account!, chain, address: token, abi: mockErc20Abi } as const;
      if (!deployment.production) await send(`Mint test ${cash.symbol}`, () => w.writeContract({ ...base, functionName: "mint", args: [me.address, amount] }));
      await send(`Approve ${cash.symbol}`, () => w.writeContract({ ...base, functionName: "approve", args: [fund, amount] }));
      await send("First purchase", () => w.writeContract({ account: w.account!, chain, address: fund, abi: pilotFundAbi, functionName: "buy", args: [token, amount, 0n] }));
    }
    setLaunching(false);
    onOpen(vault);
  });

  return (
    <Card title="Pilot funds" aside={<span className="muted small">pooled vaults, open to anyone</span>}>
      {rows.length === 0 ? (
        <p className="muted small" style={{ marginTop: 0 }}>
          No funds yet. A fund is a vault many people own: buy in at the vault's value, leave any time with your share of every holding.
        </p>
      ) : (
        <ul className="fund-list" aria-label="Funds">
          {rows.map((r) => (
            <li key={r.fund}>
              <span>
                <strong>{r.name}</strong> <span className="pill info">{r.symbol}</span>
                <span className="muted small"> {usd((r.supply * r.nav) / 10n ** 18n, false)} · {usd(r.nav)} a share</span>
              </span>
              <button className="btn small" aria-label={`Open ${r.name}`} onClick={() => onOpen(r.vault)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      {canWrite &&
        (!launching ? (
          <button className="btn" onClick={() => setLaunching(true)} disabled={!proposal}>
            {proposal ? "Launch a fund with this mandate" : "Draft a mandate to launch a fund"}
          </button>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <p className="small" style={{ margin: 0 }}>
              The drafted mandate becomes the fund's rules for good: no one, you included, can change them. You can pause the fund and, with three
              days' notice to holders, replace its pilot.
            </p>
            <div className="row">
              <label className="field" style={{ flex: 1, minWidth: 160 }}>
                Fund name
                <input type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field" style={{ width: 110 }}>
                Ticker
                <input type="text" value={symbol} maxLength={8} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
              </label>
            </div>
            <div className="field">
              Pilot
              {deployment.registry ? (
                <PilotPicker market={market} me={me.address} value={pilot} onPick={(a, feeBps) => { setPilot(a); setFeePct(feeBps / 100); }} />
              ) : (
                <input type="text" value={pilot} onChange={(e) => setPilot(e.target.value.trim())} spellCheck={false} />
              )}
            </div>
            <div className="row">
              <label className="field" style={{ width: 130 }}>
                Pilot fee (%/yr)
                <input type="number" min={0} max={2} step={0.05} value={feePct} onChange={(e) => setFeePct(Math.min(2, Math.max(0, Number(e.target.value))))} />
              </label>
              <label className="field" style={{ width: 170 }}>
                Limits sized for (USD)
                <input type="number" min={1000} step={1000} value={sizeUsd} onChange={(e) => setSizeUsd(Math.max(1000, Number(e.target.value)))} />
              </label>
              <label className="field" style={{ width: 150 }}>
                First purchase (USD)
                <input type="number" min={0} step={100} value={seedUsd} onChange={(e) => setSeedUsd(Math.max(0, Number(e.target.value)))} />
              </label>
            </div>
            <div className="row">
              <button className="btn primary" onClick={launch}>
                Launch fund
              </button>
              <button className="btn" onClick={() => setLaunching(false)}>
                Cancel
              </button>
            </div>
          </div>
        ))}
    </Card>
  );
}

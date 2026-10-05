import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddress,
  parseUnits,
  type Abi,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hash,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { LISTINGS } from "../../agent/listings";
import { toMandate } from "../../agent/mandate";
import { readVault, sendTrade } from "../../agent/chain";
import type { VaultState } from "../../agent/model";
import { drift, plan } from "../../agent/planner";
import { mockErc20Abi, pilotVaultAbi, pilotVaultFactoryAbi } from "./abi";
import type { Draft } from "./App";
import { CHAINS, deploymentFor, explorerTx, type Deployment } from "./chains";
import { Card, HoldingsTable, totalUsd, usd } from "./ui";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

// Hardhat's first dev account. Its key is public; it only ever exists on a local chain.
const HARDHAT_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

type Wallet = { client: WalletClient; address: Address; kind: "injected" | "dev" };

export function Live({ draft }: { draft: Draft | null }) {
  const [chain, setChain] = useState<Chain>(CHAINS[0]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [status, setStatus] = useState<{ tone: "info" | "bad"; text: string; tx?: Hash } | null>(null);
  const [vaults, setVaults] = useState<Address[]>([]);
  const [selected, setSelected] = useState<Address | null>(null);
  const [refresh, setRefresh] = useState(0);
  const deployment = deploymentFor(chain.id);
  const client = useMemo(() => createPublicClient({ chain, transport: http() }), [chain]);

  const loadVaults = useCallback(async () => {
    if (!wallet || !deployment) return setVaults([]);
    const list = (await client.readContract({
      address: deployment.factory,
      abi: pilotVaultFactoryAbi,
      functionName: "vaultsOf",
      args: [wallet.address],
    })) as Address[];
    setVaults(list);
    setSelected((s) => (s && list.includes(s) ? s : (list[list.length - 1] ?? null)));
  }, [wallet, deployment, client]);

  useEffect(() => {
    loadVaults().catch((e) => setStatus({ tone: "bad", text: short(e) }));
  }, [loadVaults, refresh]);

  async function connectInjected() {
    const eth = window.ethereum;
    if (!eth) return setStatus({ tone: "bad", text: "No browser wallet found. Install one, or use the simulator." });
    try {
      const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      await switchTo(eth, chain);
      setWallet({ client: createWalletClient({ account: address, chain, transport: custom(eth) }), address, kind: "injected" });
      setStatus(null);
    } catch (e) {
      setStatus({ tone: "bad", text: short(e) });
    }
  }

  function connectDev() {
    const account = privateKeyToAccount(HARDHAT_DEV_KEY);
    setWallet({ client: createWalletClient({ account, chain: hardhat, transport: http() }), address: account.address, kind: "dev" });
    setStatus(null);
  }

  function pickChain(id: number) {
    const next = CHAINS.find((c) => c.id === id)!;
    setChain(next);
    setWallet(null);
    setVaults([]);
    setSelected(null);
  }

  /** Send one transaction, report it, and wait for it to land. */
  async function send(label: string, write: () => Promise<Hash>) {
    setStatus({ tone: "info", text: `${label}: confirm in your wallet…` });
    const tx = await write();
    setStatus({ tone: "info", text: `${label}: waiting for confirmation…`, tx });
    const receipt = await client.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error(`${label} reverted.`);
    setStatus({ tone: "info", text: `${label}: done.`, tx });
    return receipt;
  }

  const run = (fn: () => Promise<unknown>) => () =>
    fn()
      .then(() => setRefresh((r) => r + 1))
      .catch((e) => setStatus({ tone: "bad", text: short(e) }));

  const ctx: Ctx | null = wallet && deployment ? { wallet, deployment, chain, client, send, run } : null;

  return (
    <div className="stack">
      <Card title="Connect" aside={<span className="muted small">testnets only; contracts are unaudited</span>}>
        <div className="row">
          <label className="field" style={{ width: 240 }}>
            Network
            <select value={chain.id} onChange={(e) => pickChain(Number(e.target.value))}>
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {deploymentFor(c.id) ? "" : " (not deployed yet)"}
                </option>
              ))}
            </select>
          </label>
          {wallet ? (
            <span className="pill ok" style={{ alignSelf: "end", marginBottom: 8 }}>
              {wallet.kind === "dev" ? "Dev account " : ""}
              {shortAddr(wallet.address)}
            </span>
          ) : (
            <>
              <button className="btn primary" style={{ alignSelf: "end" }} onClick={connectInjected}>
                Connect wallet
              </button>
              {chain.id === hardhat.id && (
                <button className="btn" style={{ alignSelf: "end" }} onClick={connectDev}>
                  Use local dev account
                </button>
              )}
            </>
          )}
        </div>
        {status && (
          <p className={`notice ${status.tone === "bad" ? "bad" : ""}`}>
            {status.text}{" "}
            {status.tx && (explorerTx(chain.id, status.tx) ? <a href={explorerTx(chain.id, status.tx)} target="_blank" rel="noreferrer">view transaction</a> : <span className="mono">{status.tx}</span>)}
          </p>
        )}
        {!deployment && (
          <p className="notice warn">
            StockPilot is not deployed on {chain.name} in this build. Deploy it with <span className="mono">npm run deploy:{chain.id === hardhat.id ? "local" : chain.id === 46630 ? "robinhood-testnet" : "arbitrum-sepolia"}</span>,
            commit the file it writes to <span className="mono">deployments/</span>, and rebuild.
          </p>
        )}
      </Card>

      {ctx && (
        <div className="grid-2">
          <div className="stack">
            {selected ? (
              <VaultPanel key={`${selected}-${refresh}`} ctx={ctx} vault={selected} draft={draft} />
            ) : (
              <Card title="No vault yet">
                <p className="muted" style={{ margin: 0 }}>
                  Create one with the mandate you drafted above.
                </p>
              </Card>
            )}
          </div>
          <div className="stack">
            <CreateVault ctx={ctx} draft={draft} onCreated={(v) => { setSelected(v); setRefresh((r) => r + 1); }} />
            {vaults.length > 1 && (
              <Card title="Your vaults">
                {vaults.map((v) => (
                  <button key={v} className={`btn small ${v === selected ? "primary" : ""}`} style={{ margin: 3 }} onClick={() => setSelected(v)}>
                    {shortAddr(v)}
                  </button>
                ))}
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface Ctx {
  wallet: Wallet;
  deployment: Deployment;
  chain: Chain;
  client: ReturnType<typeof createPublicClient>;
  send: (label: string, write: () => Promise<Hash>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => () => void;
}

function universeOf(d: Deployment) {
  return LISTINGS.map((l) => ({ ...l, token: d.tokens[l.symbol], feed: d.feeds[l.symbol], stable: "stable" in l }));
}

function CreateVault({ ctx, draft, onCreated }: { ctx: Ctx; draft: Draft | null; onCreated: (v: Address) => void }) {
  const [pilot, setPilot] = useState<string>(ctx.wallet.address);
  const [fund, setFund] = useState(10_000);
  const { wallet, deployment, client, send, run } = ctx;
  const w = wallet.client;

  const create = run(async () => {
    if (!draft) throw new Error("Draft a mandate first.");
    if (!isAddress(pilot)) throw new Error("The pilot address is not valid.");
    const { mandate } = toMandate(draft.proposal, universeOf(deployment), fund);
    await send("Create vault", () =>
      w.writeContract({
        account: w.account!,
        chain: ctx.chain,
        address: deployment.factory,
        abi: pilotVaultFactoryAbi,
        functionName: "createVault",
        args: [pilot as Address, deployment.marketMaker, mandate.assets, mandate.limits],
      }),
    );
    const list = (await client.readContract({ address: deployment.factory, abi: pilotVaultFactoryAbi, functionName: "vaultsOf", args: [wallet.address] })) as Address[];
    const vault = list[list.length - 1];
    // Buy in at the targets with the testnet faucet tokens: mint, approve, deposit.
    for (const [i, l] of LISTINGS.entries()) {
      const share = (fund * mandate.assets[i].targetBps) / 10_000;
      if (share === 0) continue;
      const token = deployment.tokens[l.symbol];
      const amount = parseUnits((share / l.price).toFixed(Math.min(l.decimals, 8)), l.decimals);
      const base = { account: w.account!, chain: ctx.chain, address: token, abi: mockErc20Abi } as const;
      await send(`Mint test ${l.symbol}`, () => w.writeContract({ ...base, functionName: "mint", args: [wallet.address, amount] }));
      await send(`Approve ${l.symbol}`, () => w.writeContract({ ...base, functionName: "approve", args: [vault, amount] }));
      await send(`Deposit ${l.symbol}`, () =>
        w.writeContract({ account: w.account!, chain: ctx.chain, address: vault, abi: pilotVaultAbi, functionName: "deposit", args: [token, amount] }),
      );
    }
    onCreated(vault);
  });

  return (
    <Card title={<><span className="step">3</span>Create a vault</>}>
      {!draft ? (
        <p className="muted">Draft a mandate above first.</p>
      ) : (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            Creates a vault you own with the mandate above, then funds it with testnet stand-ins for each asset, bought at your target weights
            ({LISTINGS.length * 3} small transactions).
          </p>
          <label className="field">
            Pilot address (the agent allowed to rebalance)
            <input type="text" value={pilot} onChange={(e) => setPilot(e.target.value.trim())} spellCheck={false} />
          </label>
          <p className="muted small">
            Use a separate key for the pilot in production. Using your own address here lets you run the pilot from this page.
          </p>
          <div className="row">
            <label className="field" style={{ width: 160 }}>
              Fund with (test USD)
              <input type="number" min={100} step={100} value={fund} onChange={(e) => setFund(Math.max(100, Number(e.target.value)))} />
            </label>
            <button className="btn primary" style={{ alignSelf: "end" }} onClick={create}>
              Create and fund vault
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

type TradeEvent = { tx: Hash; amountIn: bigint; tokenIn: Address; tokenOut: Address; valueInUsd: bigint; rationale: Hash };

function VaultPanel({ ctx, vault, draft }: { ctx: Ctx; vault: Address; draft: Draft | null }) {
  const { wallet, client, send, run, deployment } = ctx;
  const w = wallet.client;
  const [state, setState] = useState<VaultState | null>(null);
  const [roles, setRoles] = useState<{ owner: Address; pilot: Address } | null>(null);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newPilot, setNewPilot] = useState("");

  useEffect(() => {
    (async () => {
      const read = (functionName: "owner" | "pilot") => client.readContract({ address: vault, abi: pilotVaultAbi, functionName }) as Promise<Address>;
      const [s, owner, pilot] = await Promise.all([readVault(client, pilotVaultAbi as Abi, vault), read("owner"), read("pilot")]);
      setState(s);
      setRoles({ owner, pilot });
      const head = await client.getBlockNumber();
      const logs = await client.getContractEvents({
        address: vault,
        abi: pilotVaultAbi,
        eventName: "Rebalanced",
        fromBlock: head > 50_000n ? head - 50_000n : 0n,
      });
      setEvents(
        logs
          .map((l) => ({ tx: l.transactionHash!, ...(l.args as Omit<TradeEvent, "tx">) }))
          .reverse(),
      );
    })().catch((e) => setError(short(e)));
  }, [client, vault]);

  if (error) return <Card title="Vault"><p className="notice bad">{error}</p></Card>;
  if (!state || !roles) return <Card title="Vault"><p className="muted">Loading…</p></Card>;

  const d = drift(state);
  const isOwner = roles.owner.toLowerCase() === wallet.address.toLowerCase();
  const isPilot = roles.pilot.toLowerCase() === wallet.address.toLowerCase();
  const p = plan(state);
  const symbolOf = (t: Address) => state.assets.find((a) => a.token.toLowerCase() === t.toLowerCase())?.symbol ?? shortAddr(t);
  const call = (label: string, functionName: string, args: readonly unknown[] = []) =>
    send(label, () => w.writeContract({ account: w.account!, chain: ctx.chain, address: vault, abi: pilotVaultAbi, functionName, args } as never));

  return (
    <>
      <Card
        title={<>Vault <span className="mono">{shortAddr(vault)}</span></>}
        aside={<span className={`pill ${state.paused ? "bad" : "ok"}`}>{state.paused ? "Paused" : "Active"}</span>}
      >
        <div className="stats">
          <div className="stat">
            <div className="label">Value</div>
            <div className="value">{usd(totalUsd(state.assets))}</div>
          </div>
          <div className="stat">
            <div className="label">Pilot can trade today</div>
            <div className="value">{usd(state.remainingToday, false)}</div>
          </div>
          <div className="stat">
            <div className="label">Your role</div>
            <div className="value" style={{ fontSize: 16 }}>{[isOwner && "Owner", isPilot && "Pilot"].filter(Boolean).join(" + ") || "Viewer"}</div>
          </div>
        </div>
        <div className="table-scroll">
          <HoldingsTable assets={state.assets} drift={d} />
        </div>
        <p className="small" style={{ marginBottom: 0 }}>
          Pilot's next move: {p.action === "trade" ? p.trade.rationale : p.reason}
        </p>
      </Card>

      <Card title="Controls">
        <div className="row">
          {isPilot && (
            <button
              className="btn primary"
              disabled={p.action !== "trade"}
              onClick={run(async () => {
                if (p.action !== "trade") return;
                setError(null);
                await sendTrade(client as never, w, pilotVaultAbi as Abi, vault, p.trade);
              })}
            >
              Run pilot (send planned trade)
            </button>
          )}
          {isOwner && (
            <>
              <button className={`btn ${state.paused ? "" : "danger"}`} onClick={run(() => call(state.paused ? "Unpause" : "Pause", state.paused ? "unpause" : "pause"))}>
                {state.paused ? "Unpause" : "Pause pilot"}
              </button>
              {draft && (
                <button
                  className="btn"
                  onClick={run(async () => {
                    const { mandate } = toMandate(draft.proposal, universeOf(deployment), Number(totalUsd(state.assets) / 10n ** 18n) || 1);
                    await call("Apply drafted mandate", "setMandate", [mandate.assets, mandate.limits]);
                  })}
                >
                  Apply drafted mandate
                </button>
              )}
              <button
                className="btn danger"
                onClick={run(async () => {
                  for (const a of state.assets) if (a.balance > 0n) await call(`Withdraw ${a.symbol}`, "withdraw", [a.token, a.balance, wallet.address]);
                })}
              >
                Withdraw everything
              </button>
            </>
          )}
        </div>
        {isOwner && (
          <div className="row" style={{ marginTop: 12 }}>
            <input type="text" placeholder={`Pilot: ${roles.pilot}`} value={newPilot} onChange={(e) => setNewPilot(e.target.value.trim())} spellCheck={false} style={{ flex: 1, minWidth: 200 }} />
            <button className="btn" disabled={!isAddress(newPilot)} onClick={run(() => call("Set pilot", "setPilot", [newPilot]))}>
              Set pilot
            </button>
            <button className="btn danger" onClick={run(() => call("Revoke pilot", "setPilot", ["0x0000000000000000000000000000000000000000"]))}>
              Revoke
            </button>
          </div>
        )}
      </Card>

      <Card title="Trades onchain" aside={<span className="muted small">Rebalanced events, newest first</span>}>
        {events.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No trades yet.
          </p>
        ) : (
          <ul className="log">
            {events.map((e) => (
              <li key={e.tx}>
                <span className="pill ok">Trade</span>
                <span>
                  Sold {usd(e.valueInUsd)} of {symbolOf(e.tokenIn)} for {symbolOf(e.tokenOut)}{" "}
                  {explorerTx(ctx.chain.id, e.tx) && (
                    <a href={explorerTx(ctx.chain.id, e.tx)} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  )}
                </span>
                <span className="hash">reason hash {e.rationale}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          The pilot's log holds the full reason for each trade; its keccak256 hash matches the one in the event.
        </p>
      </Card>
    </>
  );
}

async function switchTo(eth: EIP1193Provider, chain: Chain) {
  const hex = `0x${chain.id.toString(16)}` as const;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

function short(e: unknown) {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  getAddress,
  isAddress,
  parseUnits,
  type Abi,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hash,
  type WalletClient,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { LISTINGS } from "../../agent/listings";
import { toMandate } from "../../agent/mandate";
import { rationaleHash, readVault, sendTrade } from "../../agent/chain";
import { available, type VaultState } from "../../agent/model";
import { drift, plan } from "../../agent/planner";
import { mockErc20Abi, pilotVaultAbi, pilotVaultFactoryAbi } from "./abi";
import type { Draft } from "./App";
import { CHAINS, deploymentFor, explorerTx, type Deployment } from "./chains";
import { Card, HoldingsTable, totalUsd, usd } from "./ui";
import { ActivityFeed } from "./Activity";
import { AlertsCard } from "./Alerts";
import { MandateDiffCard } from "./MandateDiff";
import { ReportCard, holdingsFacts, valueFacts } from "./Report";
import { MarketplaceCard, PilotPicker, useMarket, type Market } from "./Pilots";
import { InheritanceCard } from "./Inheritance";
import { CrashGuardCard } from "./CrashGuard";
import { RecurringCard } from "./Recurring";
import { signAndRelay } from "./signed";
import { TaxCard } from "./Tax";
import { TaxPilotCard } from "./TaxPilot";
import { GlidePathCard } from "./GlidePath";
import { HouseholdCard } from "./Household";
import { TradeExplainer } from "./BandGauge";
import { explainTrade } from "../../agent/explain";
import { StatementCard } from "./Statement";
import { PerformanceCard } from "./Performance";
import { AskCard, rememberReason } from "./Ask";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

// Hardhat's first two dev accounts. Their keys are public; they only ever exist on a local chain. The second one
// lets you play a second person (an heir, a hired pilot) on the same machine.
const HARDHAT_DEV_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
] as const;

type Wallet = { client: WalletClient; address: Address; kind: "injected" | "dev" | "watch" };

/** A vault shared by link: ?chain=<id>&vault=<address>. */
function sharedVault(): { chainId: number; vault: Address } | null {
  const q = new URLSearchParams(window.location.search);
  const vault = q.get("vault");
  const chainId = Number(q.get("chain"));
  // Any letter case: links get retyped, and explorers show addresses in lower case.
  return vault && isAddress(vault, { strict: false }) && CHAINS.some((c) => c.id === chainId) ? { chainId, vault: getAddress(vault) } : null;
}

/** Read-only: no account, so nothing can be signed; every card shows its viewer state. */
function watchWallet(chain: Chain): Wallet {
  return { client: createWalletClient({ chain, transport: http() }), address: zeroAddress, kind: "watch" };
}

export function shareLink(chainId: number, vault: Address) {
  return `${window.location.origin}${window.location.pathname}?chain=${chainId}&vault=${vault}`;
}

export function Live({ draft }: { draft: Draft | null }) {
  const shared = useMemo(sharedVault, []);
  const [chain, setChain] = useState<Chain>(() => CHAINS.find((c) => c.id === shared?.chainId) ?? CHAINS[0]);
  const [wallet, setWallet] = useState<Wallet | null>(() => (shared ? watchWallet(CHAINS.find((c) => c.id === shared.chainId)!) : null));
  const [status, setStatus] = useState<{ tone: "info" | "bad"; text: string; tx?: Hash } | null>(null);
  const [vaults, setVaults] = useState<Address[]>([]);
  const [selected, setSelected] = useState<Address | null>(shared?.vault ?? null);
  const [refresh, setRefresh] = useState(0);
  const deployment = deploymentFor(chain.id);
  const client = useMemo(() => createPublicClient({ chain, transport: http() }), [chain]);
  const market = useMarket(client as never, deployment, refresh);

  const loadVaults = useCallback(async () => {
    if (!wallet || !deployment) return setVaults([]);
    const list = (await client.readContract({
      address: deployment.factory,
      abi: pilotVaultFactoryAbi,
      functionName: "vaultsOf",
      args: [wallet.address],
    })) as Address[];
    setVaults(list);
    // Keep an open vault open even if this wallet did not create it (an inherited or shared vault).
    setSelected((s) => s ?? list[list.length - 1] ?? null);
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

  function connectDev(index = 0) {
    const account = privateKeyToAccount(HARDHAT_DEV_KEYS[index]);
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

  const ctx: Ctx | null = wallet && deployment ? { wallet, deployment, chain, client, send, run, market } : null;

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
          {wallet?.kind === "watch" && (
            <span className="pill info" style={{ alignSelf: "end", marginBottom: 8 }}>
              Read-only view
            </span>
          )}
          {wallet && wallet.kind !== "watch" ? (
            <span className="pill ok" style={{ alignSelf: "end", marginBottom: 8 }}>
              {wallet.kind === "dev" ? `Dev account ${HARDHAT_DEV_KEYS.findIndex((k) => privateKeyToAccount(k).address === wallet.address) + 1} ` : ""}
              {shortAddr(wallet.address)}
            </span>
          ) : (
            <>
              <button className="btn primary" style={{ alignSelf: "end" }} onClick={connectInjected}>
                Connect wallet
              </button>
              {chain.id === hardhat.id && (
                <button className="btn" style={{ alignSelf: "end" }} onClick={() => connectDev(0)}>
                  Use local dev account
                </button>
              )}
              {deployment?.demoVault && (
                // No wallet needed: the same read-only view a shared link opens.
                <a className="btn" style={{ alignSelf: "end" }} href={`?chain=${chain.id}&vault=${deployment.demoVault}`}>
                  Open the demo vault
                </a>
              )}
            </>
          )}
          {wallet?.kind === "dev" && (
            <button
              className="btn small"
              style={{ alignSelf: "end", marginBottom: 6 }}
              onClick={() => connectDev(wallet.address === privateKeyToAccount(HARDHAT_DEV_KEYS[0]).address ? 1 : 0)}
            >
              Switch to dev account {wallet.address === privateKeyToAccount(HARDHAT_DEV_KEYS[0]).address ? 2 : 1}
            </button>
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
            {wallet!.kind !== "watch" && <CreateVault ctx={ctx} draft={draft} onCreated={(v) => { setSelected(v); setRefresh((r) => r + 1); }} />}
            {vaults.length > 0 && (
              <HouseholdCard client={client as never} abi={pilotVaultAbi as Abi} chainId={chain.id} vaults={vaults} me={wallet!.address} selected={selected} onOpen={setSelected} refresh={refresh} />
            )}
            <OpenVault onOpen={(v) => setSelected(v)} />
            {deployment?.registry && (
              <MarketplaceCard
                key={`${wallet!.address}-${market.pilots.length}`}
                market={market}
                me={wallet!.address}
                canList={wallet!.kind !== "watch"}
                registry={deployment.registry}
                wallet={wallet!.client}
                chain={chain}
                send={send}
                run={run}
              />
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
  market: Market;
}

function universeOf(d: Deployment) {
  return LISTINGS.map((l) => ({ ...l, token: d.tokens[l.symbol], feed: d.feeds[l.symbol], stable: "stable" in l }));
}

function CreateVault({ ctx, draft, onCreated }: { ctx: Ctx; draft: Draft | null; onCreated: (v: Address) => void }) {
  const [pilot, setPilot] = useState<string>(ctx.wallet.address);
  const [fund, setFund] = useState(10_000);
  const [feePct, setFeePct] = useState(0);
  const { wallet, deployment, client, send, run } = ctx;
  const [cashOnly, setCashOnly] = useState(!!deployment.production);
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
        // A hosted pilot is paid by an annual fee to the pilot's address; 0 means none.
        args: [pilot as Address, deployment.venue ?? deployment.marketMaker, mandate.assets, mandate.limits, feePct > 0 ? (pilot as Address) : zeroAddress, Math.round(feePct * 100)],
      }),
    );
    const list = (await client.readContract({ address: deployment.factory, abi: pilotVaultFactoryAbi, functionName: "vaultsOf", args: [wallet.address] })) as Address[];
    const vault = list[list.length - 1];
    // Testnet: buy in at the targets with faucet tokens (mint, approve, deposit). Cash only: deposit just the
    // stablecoin and let the pilot invest it, inside its 24-hour budget. Production: never mint, use the wallet's own.
    for (const [i, l] of LISTINGS.entries()) {
      const share = cashOnly ? ("stable" in l ? fund : 0) : (fund * mandate.assets[i].targetBps) / 10_000;
      if (share === 0) continue;
      const token = deployment.tokens[l.symbol];
      const amount = parseUnits((share / l.price).toFixed(Math.min(l.decimals, 8)), l.decimals);
      const base = { account: w.account!, chain: ctx.chain, address: token, abi: mockErc20Abi } as const;
      if (!deployment.production) await send(`Mint test ${l.symbol}`, () => w.writeContract({ ...base, functionName: "mint", args: [wallet.address, amount] }));
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
            Creates a vault you own with the mandate above, then funds it.{" "}
            {deployment.production
              ? "On this network the deposit comes from your wallet's stablecoin, and the pilot invests it toward your targets."
              : cashOnly
                ? "Cash only: you deposit test stablecoins and the pilot invests them toward your targets over the next days, inside its trade budget."
                : `With testnet stand-ins for each asset, bought at your target weights (${LISTINGS.length * 3} small transactions).`}
          </p>
          {!deployment.production && (
            <div className="row" style={{ marginBottom: 10 }}>
              <button className={`btn small ${cashOnly ? "" : "primary"}`} onClick={() => setCashOnly(false)}>
                Fund at targets
              </button>
              <button className={`btn small ${cashOnly ? "primary" : ""}`} onClick={() => setCashOnly(true)}>
                Cash only
              </button>
            </div>
          )}
          <div className="field">
            Pilot (the agent allowed to rebalance, inside your mandate)
            {deployment.registry ? (
              <PilotPicker market={ctx.market} me={wallet.address} value={pilot} onPick={(a, feeBps) => { setPilot(a); setFeePct(feeBps / 100); }} />
            ) : (
              <input type="text" value={pilot} onChange={(e) => setPilot(e.target.value.trim())} spellCheck={false} />
            )}
          </div>
          {!deployment.registry && (
            <p className="muted small">
              Use a separate key for the pilot in production. Using your own address here lets you run the pilot from this page.
            </p>
          )}
          <label className="field" style={{ marginBottom: 10 }}>
            Pilot fee (% a year, max 2; 0 if you run the pilot yourself)
            <input type="number" min={0} max={2} step={0.05} value={feePct} onChange={(e) => setFeePct(Math.min(2, Math.max(0, Number(e.target.value))))} />
          </label>
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
  const [roles, setRoles] = useState<{ owner: Address; pilot: Address; feeBps: number; feeRecipient: Address } | null>(null);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newPilot, setNewPilot] = useState("");
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    (async () => {
      const read = <T,>(functionName: "owner" | "pilot" | "feeBps" | "feeRecipient") =>
        client.readContract({ address: vault, abi: pilotVaultAbi, functionName }) as Promise<T>;
      const [s, owner, pilot, feeBps, feeRecipient] = await Promise.all([
        readVault(client, pilotVaultAbi as Abi, vault),
        read<Address>("owner"),
        read<Address>("pilot"),
        read<number>("feeBps"),
        read<Address>("feeRecipient"),
      ]);
      setState(s);
      setRoles({ owner, pilot, feeBps: Number(feeBps), feeRecipient });
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
  const isOwner = wallet.kind !== "watch" && roles.owner.toLowerCase() === wallet.address.toLowerCase();
  const isPilot = wallet.kind !== "watch" && roles.pilot.toLowerCase() === wallet.address.toLowerCase();
  const p = plan(state);
  const symbolOf = (t: Address) => state.assets.find((a) => a.token.toLowerCase() === t.toLowerCase())?.symbol ?? shortAddr(t);
  const call = (label: string, functionName: string, args: readonly unknown[] = []) =>
    send(label, () => w.writeContract({ account: w.account!, chain: ctx.chain, address: vault, abi: pilotVaultAbi, functionName, args } as never));

  return (
    <>
      <Card
        title={<>Vault <span className="mono" title={vault} data-address={vault}>{shortAddr(vault)}</span></>}
        aside={
          <span className="row" style={{ gap: 6 }}>
            <ShareButton chainId={ctx.chain.id} vault={vault} />
            <span className={`pill ${state.paused ? "bad" : "ok"}`}>{state.paused ? "Paused" : "Active"}</span>
          </span>
        }
      >
        <div className="stats">
          <div className="stat">
            <div className="label">Value</div>
            <div className="value">{usd(totalUsd(state.assets))}</div>
          </div>
          <div className="stat">
            <div className="label">Pilot can trade now (24h budget)</div>
            <div className="value">{usd(available(state), false)}</div>
          </div>
          <div className="stat">
            <div className="label">Your role</div>
            <div className="value" style={{ fontSize: 16 }}>{[isOwner && "Owner", isPilot && "Pilot"].filter(Boolean).join(" + ") || "Viewer"}</div>
          </div>
          <div className="stat">
            <div className="label">Pilot</div>
            <div className="value" style={{ fontSize: 16 }}>
              {roles.pilot === zeroAddress ? "None" : (ctx.market.byAddress.get(roles.pilot.toLowerCase())?.name ?? shortAddr(roles.pilot))}
            </div>
            <div className="muted small">{roles.feeBps === 0 ? "No fee" : `${(roles.feeBps / 100).toFixed(2)}% a year`}</div>
          </div>
        </div>
        <div className="table-scroll">
          <HoldingsTable assets={state.assets} drift={d} />
        </div>
        <p className="small" style={{ marginBottom: 0 }}>
          Pilot's next move: {p.action === "trade" ? p.trade.rationale : p.reason}
        </p>
        {p.action === "trade" && <TradeExplainer explanation={explainTrade(state, p.trade)} />}
      </Card>

      <PerformanceCard client={client as never} vault={vault} abi={pilotVaultAbi as Abi} assets={state.assets} />

      {(isOwner || isPilot) && (
        <Card title="Controls">
          <div className="row">
            {isPilot && (
              <button
                className="btn primary"
                disabled={p.action !== "trade"}
                onClick={run(async () => {
                  if (p.action !== "trade") return;
                  setError(null);
                  rememberReason(rationaleHash(p.trade.rationale), p.trade.rationale);
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
                {!state.paused && (
                  <button
                    className="btn danger"
                    title="Sign a pause; the operator's relay submits it, so you need no gas"
                    onClick={run(() => send("Pause by signature", () => signAndRelay(client as never, w, ctx.chain, vault, "pause")))}
                  >
                    Pause, no gas
                  </button>
                )}
                {draft && (
                  <button className="btn" onClick={() => setReviewing(true)}>
                    Review drafted mandate
                  </button>
                )}
                {roles.feeBps > 0 && (
                  <button className="btn" onClick={run(() => call("Cancel pilot fee", "setFee", [zeroAddress, 0]))}>
                    Cancel fee
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
              <input type="text" aria-label="New pilot address" placeholder="New pilot, 0x…" title={`Current pilot: ${roles.pilot}`} value={newPilot} onChange={(e) => setNewPilot(e.target.value.trim())} spellCheck={false} style={{ flex: "1 1 240px" }} />
              <button className="btn" disabled={!isAddress(newPilot)} onClick={run(() => call("Set pilot", "setPilot", [newPilot]))}>
                Set pilot
              </button>
              <button className="btn danger" onClick={run(() => call("Revoke pilot", "setPilot", [zeroAddress]))}>
                Revoke
              </button>
            </div>
          )}
        </Card>
      )}

      {reviewing && draft && isOwner && (() => {
        const { mandate } = toMandate(draft.proposal, universeOf(deployment), Number(totalUsd(state.assets) / 10n ** 18n) || 1);
        return (
          <MandateDiffCard
            state={state}
            next={mandate}
            symbolOf={(t) => symbolOf(t as Address)}
            onCancel={() => setReviewing(false)}
            onSign={run(async () => {
              await call("Sign the new mandate", "setMandate", [mandate.assets, mandate.limits]);
              setReviewing(false);
            })}
          />
        );
      })()}

      <ReportCard
        title="Weekly report"
        facts={() => ({
          period: "recent activity",
          valueStartUsd: null,
          valueNowUsd: valueFacts(state),
          paused: state.paused,
          budgetLeftUsd: Number(available(state) / 10n ** 16n) / 100,
          feeBps: roles.feeBps,
          holdings: holdingsFacts(state),
          trades: events.slice(0, 50).map((e) => ({ sold: symbolOf(e.tokenIn), bought: symbolOf(e.tokenOut), valueUsd: Number(e.valueInUsd / 10n ** 16n) / 100, reason: null })),
          blocked: [],
        })}
      />

      <AskCard
        client={client as never}
        vault={vault}
        abi={pilotVaultAbi as Abi}
        chainId={ctx.chain.id}
        chainName={ctx.chain.name}
        state={state}
        owner={roles.owner}
        pilot={roles.pilot}
        pilotName={ctx.market.byAddress.get(roles.pilot.toLowerCase())?.name ?? null}
        feeBps={roles.feeBps}
      />
      <StatementCard client={client as never} vault={vault} abi={pilotVaultAbi as Abi} state={state} owner={roles.owner} chainName={ctx.chain.name} />
      <TaxCard client={client as never} vault={vault} abi={pilotVaultAbi as Abi} assets={state.assets} />
      <TaxPilotCard client={client as never} wallet={wallet.kind === "watch" ? null : (w as never)} vault={vault} abi={pilotVaultAbi as Abi} state={state} chainId={ctx.chain.id} isOwner={isOwner} />
      <RecurringCard
        client={client as never}
        wallet={w}
        chain={ctx.chain}
        vault={vault}
        owner={roles.owner}
        assets={state.assets}
        isOwner={isOwner}
        canWrite={wallet.kind !== "watch"}
        send={send}
        run={run}
      />
      <GlidePathCard client={client as never} wallet={w} chain={ctx.chain} vault={vault} state={state} isOwner={isOwner} canWrite={wallet.kind !== "watch"} send={send} run={run} />
      <CrashGuardCard client={client as never} wallet={w} chain={ctx.chain} vault={vault} state={state} isOwner={isOwner} canWrite={wallet.kind !== "watch"} send={send} run={run} />
      <InheritanceCard client={client as never} wallet={w} chain={ctx.chain} vault={vault} me={wallet.address} isOwner={isOwner} send={send} run={run} />
      {isOwner && <AlertsCard client={client as never} wallet={w} vault={vault} abi={pilotVaultAbi as Abi} chainId={ctx.chain.id} symbolOf={symbolOf} />}

      <ActivityFeed client={client as never} vault={vault} abi={pilotVaultAbi as Abi} chainId={ctx.chain.id} assets={state.assets} owner={roles.owner} pilot={roles.pilot} />
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

/** Open any vault by address: as an heir, a pilot, or just to look. */
function OpenVault({ onOpen }: { onOpen: (v: Address) => void }) {
  const [addr, setAddr] = useState("");
  return (
    <Card title="Open a vault">
      <div className="row">
        <input type="text" aria-label="Vault address" placeholder="Vault address, 0x…" value={addr} onChange={(e) => setAddr(e.target.value.trim())} spellCheck={false} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn" disabled={!isAddress(addr)} onClick={() => onOpen(addr as Address)}>
          Open
        </button>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        For a vault you are the heir or pilot of, or one someone shared with you.
      </p>
    </Card>
  );
}

/** Copies a link that opens this vault read-only, no wallet needed. */
function ShareButton({ chainId, vault }: { chainId: number; vault: Address }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn small"
      title="A read-only link to this vault: anyone can follow it without a wallet"
      onClick={() => {
        const link = shareLink(chainId, vault);
        navigator.clipboard?.writeText(link).then(
          () => setCopied(true),
          () => window.prompt("Copy this link", link),
        );
        setTimeout(() => setCopied(false), 2_000);
      }}
    >
      {copied ? "Link copied" : "Share"}
    </button>
  );
}

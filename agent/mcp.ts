// StockPilot as an MCP server: any AI agent (Claude Desktop, Claude Code, or your own) can fly a vault. The agent
// gets tools to read the vault, see what the built-in planner would do, dry-run a trade against the real contract,
// and execute it with a written reason. Whatever the agent decides, the vault enforces the owner's mandate onchain;
// these tools cannot widen it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Abi, Address, PublicClient, WalletClient } from "viem";
import { z } from "zod/v4";
import { rationaleHash, readVault, revertReason } from "./chain";
import { BPS, WAD, amountFor, available, check, eq, valueOf, type AssetState, type VaultState } from "./model";
import { drift, fmtUsd, pct, plan } from "./planner";
import { listPilots, trackRecords } from "./pilots";

export interface McpConfig {
  client: PublicClient;
  /** The pilot's wallet. Without it the server is read-only: it can check trades but not send them. */
  wallet?: WalletClient;
  vault: Address;
  vaultAbi: Abi;
  /** Called with each executed trade, for the pilot's logbook. */
  onTrade?: (t: { tx: string; rationale: string; rationaleHash: string }) => void;
  /** The pilot directory and the factory whose vaults make up track records; adds the marketplace tools. */
  marketplace?: { registry: Address; registryAbi: Abi; factory: Address; factoryAbi: Abi };
}

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Text => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export function createStockPilotServer(cfg: McpConfig) {
  const server = new McpServer({ name: "stockpilot", version: "0.1.0" });
  const { client, vault, vaultAbi } = cfg;
  const read = <T>(functionName: string) => client.readContract({ address: vault, abi: vaultAbi, functionName }) as Promise<T>;

  async function snapshot() {
    const [state, pilot, owner, feeBps] = await Promise.all([readVault(client, vaultAbi, vault), read<Address>("pilot"), read<Address>("owner"), read<number>("feeBps")]);
    return { state, pilot, owner, feeBps: Number(feeBps) };
  }

  function findAsset(state: VaultState, symbol: string): AssetState {
    const a = state.assets.find((x) => x.symbol.toUpperCase() === symbol.trim().toUpperCase());
    if (!a) throw new Error(`${symbol} is not in this vault's mandate. Assets: ${state.assets.map((x) => x.symbol).join(", ")}.`);
    return a;
  }

  function sizeTrade(state: VaultState, sell: string, buy: string, usdAmount: number) {
    const a = findAsset(state, sell);
    const b = findAsset(state, buy);
    const usd = BigInt(Math.round(usdAmount * 100)) * (WAD / 100n);
    const amountIn = amountFor(usd, a.price, a.decimals);
    if (amountIn > a.balance) throw new Error(`The vault holds only ${fmtUsd(valueOf(a.balance, a.price, a.decimals))} of ${a.symbol}.`);
    const fair = amountFor(usd, b.price, b.decimals);
    const minAmountOut = (fair * (BPS - BigInt(state.limits.maxSlippageBps))) / BPS;
    return { a, b, amountIn, minAmountOut, fair };
  }

  async function dryRun(from: Address, args: readonly unknown[]) {
    try {
      await client.simulateContract({ account: from, address: vault, abi: vaultAbi, functionName: "rebalance", args });
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, reason: revertReason(e, vaultAbi) };
    }
  }

  server.registerTool(
    "get_vault",
    {
      title: "Read the vault",
      description:
        "The vault's holdings (value, weight, target, band), its trading limits, the trade budget left, whether it is paused, and who the owner and pilot are. Call this first.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { state, pilot, owner, feeBps } = await snapshot();
      const d = drift(state);
      const total = state.assets.reduce((t, a) => t + valueOf(a.balance, a.price, a.decimals), 0n);
      const cooldownEnds = state.lastTradeAt + BigInt(state.limits.cooldown);
      const lines = [
        `Vault ${vault}. Owner ${owner}. Pilot ${pilot}${cfg.wallet && eq(cfg.wallet.account!.address, pilot) ? " (this server)" : ""}.`,
        `Total value ${fmtUsd(total)}. ${state.paused ? "PAUSED: no trades possible." : "Active."} Fee ${(feeBps / 100).toFixed(2)}% a year.`,
        "",
        "Asset  Price        Value        Weight  Target  Band   Status",
        ...state.assets.map((a, i) =>
          [
            a.symbol.padEnd(6),
            fmtUsd(a.price).padEnd(12),
            fmtUsd(valueOf(a.balance, a.price, a.decimals)).padEnd(12),
            pct(d[i].weightBps).padEnd(7),
            pct(d[i].targetBps).padEnd(7),
            `±${pct(d[i].bandBps)}`.padEnd(6),
            d[i].outOfBand ? "outside band" : d[i].triggered ? "drifting" : "on target",
          ].join(" "),
        ),
        "",
        `Limits: ${fmtUsd(state.limits.maxTradeUsd)} per trade; ${fmtUsd(state.limits.dailyLimitUsd)} per 24 hours (${fmtUsd(available(state))} available now); max slippage ${state.limits.maxSlippageBps / 100}% against oracle prices; ${state.limits.cooldown}s between trades${state.lastTradeAt && state.now < cooldownEnds ? ` (next trade allowed in ${cooldownEnds - state.now}s)` : ""}; prices must be under ${state.limits.maxPriceAge}s old.`,
      ];
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "explain_rules",
    {
      title: "Explain the mandate's rules",
      description: "What the vault will and will not let the pilot do. Read this before planning trades.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        [
          "You are the pilot of a StockPilot vault. You can only call rebalance(): sell one asset in the mandate for another. The vault checks every trade and reverts if any rule fails:",
          "1. Both assets must be in the mandate. (AssetNotInMandate)",
          "2. The trade must be at most maxTradeUsd, and fit the trade budget, which refills to dailyLimitUsd over 24 hours. (TradeTooLarge, DailyLimitExceeded)",
          "3. The cooldown since the last trade must have passed. (CooldownActive)",
          "4. Every price must be fresher than maxPriceAge. (StalePrice)",
          "5. What arrives must be worth at least (1 - maxSlippage) of what left, at oracle prices. (SlippageExceeded)",
          "6. Neither asset may end outside its band around target, unless the trade moved it toward target without crossing it. (OutsideBand)",
          "You cannot withdraw, change the mandate, change the venue, or unpause. You can pause the vault if something looks wrong.",
          "Use check_trade to dry-run any trade against the real contract before execute_trade. Every executed trade needs a short written reason; its hash is stored onchain.",
        ].join("\n"),
      ),
  );

  server.registerTool(
    "plan_rebalance",
    {
      title: "What the built-in planner would do",
      description: "The deterministic planner's next move for this vault: a specific trade with its reason, or why it would hold.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { state } = await snapshot();
      const p = plan(state);
      if (p.action === "hold") return text(`Hold. ${p.reason}`);
      const sym = (t: Address) => state.assets.find((a) => eq(a.token, t))!.symbol;
      return text(`Trade: sell ${fmtUsd(p.trade.valueUsd)} of ${sym(p.trade.tokenIn)} for ${sym(p.trade.tokenOut)}.\nReason: ${p.trade.rationale}\nTo do it: execute_trade with sell=${sym(p.trade.tokenIn)}, buy=${sym(p.trade.tokenOut)}, usd_amount=${Number(p.trade.valueUsd / 10n ** 16n) / 100}.`);
    },
  );

  const tradeShape = {
    sell: z.string().describe("Symbol of the asset to sell, e.g. NVDA"),
    buy: z.string().describe("Symbol of the asset to buy, e.g. USDG"),
    usd_amount: z.number().positive().describe("How much to sell, in US dollars at the oracle price"),
  };

  server.registerTool(
    "check_trade",
    {
      title: "Dry-run a trade",
      description:
        "Checks a trade against the vault's rules and simulates it against the real contract and venue, without sending anything. Returns whether it would go through, and the exact rule it breaks if not.",
      inputSchema: tradeShape,
      annotations: { readOnlyHint: true },
    },
    async ({ sell, buy, usd_amount }) => {
      try {
        const { state, pilot } = await snapshot();
        const t = sizeTrade(state, sell, buy, usd_amount);
        const model = check({ ...state, now: state.now + 1n }, { tokenIn: t.a.token, tokenOut: t.b.token, amountIn: t.amountIn }, t.fair);
        const sim = await dryRun(pilot, [t.a.token, t.b.token, t.amountIn, t.minAmountOut, "0x", rationaleHash("dry run")]);
        const verdict = sim.ok ? "WOULD GO THROUGH" : `WOULD BE REJECTED: ${sim.reason}`;
        const modelLine = model.ok ? "The rule model agrees it is allowed at a fair price." : `The rule model says: ${model.reason}${model.detail ? ` (${model.detail})` : ""}.`;
        return text(`Sell ${fmtUsd(BigInt(Math.round(usd_amount * 100)) * (WAD / 100n))} of ${t.a.symbol} for ${t.b.symbol}: ${verdict} on the real contract.\n${modelLine}`);
      } catch (e) {
        return text(firstLine(e), true);
      }
    },
  );

  server.registerTool(
    "execute_trade",
    {
      title: "Execute a rebalancing trade",
      description:
        "Sends a rebalance transaction as the pilot. Requires a short plain-English reason, which is logged and whose keccak256 hash is stored onchain with the trade. The vault rejects anything outside the mandate; the trade is dry-run first so a rejected trade costs no gas.",
      inputSchema: { ...tradeShape, reason: z.string().min(10).max(500).describe("Why this trade, in one or two sentences, for the owner") },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ sell, buy, usd_amount, reason }) => {
      const wallet = cfg.wallet;
      if (!wallet) return text("This server is read-only: start it with the pilot's PRIVATE_KEY to execute trades.", true);
      try {
        const { state, pilot } = await snapshot();
        if (!eq(pilot, wallet.account!.address)) return text(`This server's key is not the vault's pilot (${pilot}).`, true);
        const t = sizeTrade(state, sell, buy, usd_amount);
        const args = [t.a.token, t.b.token, t.amountIn, t.minAmountOut, "0x", rationaleHash(reason)] as const;
        const sim = await dryRun(pilot, args);
        if (!sim.ok) return text(`Not sent: the vault would reject it with ${sim.reason}.`, true);
        const tx = await wallet.writeContract({ account: wallet.account!, chain: wallet.chain, address: vault, abi: vaultAbi, functionName: "rebalance", args });
        const receipt = await client.waitForTransactionReceipt({ hash: tx });
        if (receipt.status !== "success") return text(`Transaction ${tx} reverted.`, true);
        cfg.onTrade?.({ tx, rationale: reason, rationaleHash: rationaleHash(reason) });
        return text(`Done: sold ${fmtUsd(BigInt(Math.round(usd_amount * 100)) * (WAD / 100n))} of ${t.a.symbol} for ${t.b.symbol}. Transaction ${tx}. Reason hash ${rationaleHash(reason)}.`);
      } catch (e) {
        return text(firstLine(e), true);
      }
    },
  );

  server.registerTool(
    "trade_history",
    {
      title: "Recent trades",
      description: "The vault's recent rebalancing trades from onchain events, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many, default 10") },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const { state } = await snapshot();
      const head = await client.getBlockNumber();
      const logs = await client.getContractEvents({ address: vault, abi: vaultAbi, eventName: "Rebalanced", fromBlock: head > 50_000n ? head - 50_000n : 0n });
      const sym = (t: unknown) => state.assets.find((a) => eq(a.token, String(t)))?.symbol ?? String(t);
      const rows = logs
        .slice(-(limit ?? 10))
        .reverse()
        .map((l) => {
          const a = l.args as Record<string, unknown>;
          return `${fmtUsd(a.valueInUsd as bigint)} of ${sym(a.tokenIn)} → ${sym(a.tokenOut)} (tx ${l.transactionHash}, reason hash ${a.rationale})`;
        });
      return text(rows.length ? rows.join("\n") : "No trades yet.");
    },
  );

  server.registerTool(
    "pause_vault",
    {
      title: "Emergency pause",
      description: "Pauses the vault so no trades can happen, including your own. Only the owner can unpause. Use it if prices or fills look wrong.",
      inputSchema: { reason: z.string().min(5).max(300).describe("Why you are pausing, for the owner") },
      annotations: { destructiveHint: true },
    },
    async ({ reason }) => {
      const wallet = cfg.wallet;
      if (!wallet) return text("This server is read-only: start it with the pilot's PRIVATE_KEY to pause.", true);
      try {
        const tx = await wallet.writeContract({ account: wallet.account!, chain: wallet.chain, address: vault, abi: vaultAbi, functionName: "pause" });
        await client.waitForTransactionReceipt({ hash: tx });
        console.error(`paused ${vault}: ${reason}`);
        return text(`Vault paused (tx ${tx}). The owner has to unpause it. Reason recorded: ${reason}`);
      } catch (e) {
        return text(firstLine(e), true);
      }
    },
  );

  const market = cfg.marketplace;
  if (market) {
    server.registerTool(
      "list_pilots",
      {
        title: "The pilot marketplace",
        description:
          "Every pilot listed in the onchain PilotRegistry, with the fee it asks and its track record computed from the chain: vaults it flies now, their value, how many it has seen paused, and its trades.",
        annotations: { readOnlyHint: true },
      },
      async () => {
        const pilots = await listPilots(client, market.registryAbi, market.registry);
        if (!pilots.length) return text("No pilots are listed yet. Use register_as_pilot to be the first.");
        const records = await trackRecords(client, { factory: market.factoryAbi, vault: vaultAbi }, market.factory, pilots.map((p) => p.address));
        const me = cfg.wallet?.account?.address;
        return text(
          pilots
            .map((p) => {
              const r = records.get(p.address.toLowerCase())!;
              return [
                `${p.name} (${p.address})${me && eq(me, p.address) ? " (this server)" : ""}${p.active ? "" : " RETIRED"}`,
                `  asks ${(p.feeBps / 100).toFixed(2)}% a year${p.uri ? `; ${p.uri}` : ""}`,
                `  flies ${r.vaults} vault(s) worth ${fmtUsd(r.aumUsd)}, ${r.paused} paused; ${r.trades} trade(s) worth ${fmtUsd(r.tradedUsd)}`,
              ].join("\n");
            })
            .join("\n"),
        );
      },
    );

    server.registerTool(
      "register_as_pilot",
      {
        title: "List yourself in the marketplace",
        description:
          "Lists this server's pilot address in the onchain PilotRegistry (or updates its entry), so vault owners can find and hire it. The fee is what you ask; each owner sets their vault's fee when they hire you.",
        inputSchema: {
          name: z.string().min(1).max(64).describe("What owners will see, e.g. 'Momentum-aware rebalancer'"),
          uri: z.string().max(256).default("").describe("Where owners can learn how you trade: a website, repository or MCP endpoint"),
          fee_percent: z.number().min(0).max(2).describe("Annual fee you ask, in percent (max 2)"),
        },
      },
      async ({ name, uri, fee_percent }) => {
        const wallet = cfg.wallet;
        if (!wallet) return text("This server is read-only: start it with the pilot's PRIVATE_KEY to register.", true);
        try {
          const tx = await wallet.writeContract({
            account: wallet.account!,
            chain: wallet.chain,
            address: market.registry,
            abi: market.registryAbi,
            functionName: "register",
            args: [name, uri, Math.round(fee_percent * 100)],
          });
          await client.waitForTransactionReceipt({ hash: tx });
          return text(`Listed as "${name}" asking ${fee_percent}% a year (tx ${tx}). Owners hire you by naming ${wallet.account!.address} as their vault's pilot.`);
        } catch (e) {
          return text(revertReason(e, market.registryAbi), true);
        }
      },
    );
  }

  return server;
}

function firstLine(e: unknown) {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
}

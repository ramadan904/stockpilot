import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { keccak256, toHex } from "viem";
import { createStockPilotServer } from "../agent/mcp";
import { deployStockPilot, px } from "./fixture";

describe("agent/mcp", () => {
  async function connect(
    f: Awaited<ReturnType<typeof deployStockPilot>>,
    opts: { readOnly?: boolean; wallet?: unknown; marketplace?: Parameters<typeof createStockPilotServer>[0]["marketplace"] } = {},
  ) {
    const logged: string[] = [];
    const server = createStockPilotServer({
      client: f.publicClient as never,
      wallet: opts.readOnly ? undefined : ((opts.wallet ?? f.pilot) as never),
      vault: f.vault.address,
      vaultAbi: f.vault.abi,
      onTrade: (t) => void logged.push(t.rationale),
      marketplace: opts.marketplace,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
    };
    return { client, call, logged };
  }

  it("lists its tools, with read-only ones marked", async () => {
    const f = await loadFixture(deployStockPilot);
    const { client } = await connect(f);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).to.have.members(["get_vault", "explain_rules", "plan_rebalance", "check_trade", "execute_trade", "trade_history", "pause_vault"]);
    expect(tools.find((t) => t.name === "check_trade")!.annotations?.readOnlyHint).to.equal(true);
    expect(tools.find((t) => t.name === "execute_trade")!.inputSchema.required).to.include.members(["sell", "buy", "usd_amount", "reason"]);
  });

  it("reads the vault the way an agent needs it", async () => {
    const f = await loadFixture(deployStockPilot);
    const { call } = await connect(f);
    const { text } = await call("get_vault");
    expect(text).to.include("Total value $10,000.00").and.include("(this server)").and.match(/NVDA\s+\$125\.00\s+\$2,500\.00\s+25\.0%/);
    expect(text).to.include("$5,000.00 per trade").and.include("$20,000.00 per 24 hours");
  });

  it("dry-runs trades against the real contract and names the rule a bad one breaks", async () => {
    const f = await loadFixture(deployStockPilot);
    const { call } = await connect(f);
    expect((await call("check_trade", { sell: "AAPL", buy: "NVDA", usd_amount: 300 })).text).to.include("WOULD GO THROUGH");
    expect((await call("check_trade", { sell: "AAPL", buy: "TSLA", usd_amount: 1000 })).text).to.include("WOULD BE REJECTED: OutsideBand");
    expect((await call("check_trade", { sell: "nvda", buy: "usdg", usd_amount: 2400 })).text).to.include("REJECTED");
    const unknown = await call("check_trade", { sell: "DOGE", buy: "USDG", usd_amount: 1 });
    expect(unknown.isError).to.equal(true);
    expect(unknown.text).to.include("not in this vault's mandate");
  });

  it("follows the planner's advice and executes with a reason whose hash lands onchain", async () => {
    const f = await loadFixture(deployStockPilot);
    await f.nvdaFeed.write.setPrice([px(200)]);
    const { call, logged } = await connect(f);
    const advice = (await call("plan_rebalance")).text;
    expect(advice).to.match(/^Trade: sell \$[\d,.]+ of NVDA/);
    const usd = Number(/usd_amount=([\d.]+)/.exec(advice)![1]);
    const reason = "NVDA rallied 60% and is well over its 25% target; trimming it back.";
    const done = await call("execute_trade", { sell: "NVDA", buy: /buy=(\w+)/.exec(advice)![1], usd_amount: usd, reason });
    expect(done.isError, done.text).to.equal(false);
    const [event] = await f.vault.getEvents.Rebalanced({}, { fromBlock: 0n });
    expect(event.args.rationale).to.equal(keccak256(toHex(reason)));
    expect(logged).to.deep.equal([reason]);
    expect((await call("trade_history")).text).to.include("of NVDA →");
  });

  it("will not send a trade the vault would reject, and spends no gas trying", async () => {
    const f = await loadFixture(deployStockPilot);
    const { call } = await connect(f);
    const nonceBefore = await f.publicClient.getTransactionCount({ address: f.pilot.account.address });
    const r = await call("execute_trade", { sell: "AAPL", buy: "TSLA", usd_amount: 1000, reason: "Trying to concentrate into TSLA." });
    expect(r.isError).to.equal(true);
    expect(r.text).to.include("OutsideBand");
    expect(await f.publicClient.getTransactionCount({ address: f.pilot.account.address })).to.equal(nonceBefore);
  });

  it("is read-only without the pilot key, and refuses to act with someone else's", async () => {
    const f = await loadFixture(deployStockPilot);
    const ro = await connect(f, { readOnly: true });
    expect((await ro.call("check_trade", { sell: "AAPL", buy: "NVDA", usd_amount: 100 })).text).to.include("WOULD GO THROUGH");
    expect((await ro.call("execute_trade", { sell: "AAPL", buy: "NVDA", usd_amount: 100, reason: "a fine reason" })).text).to.include("read-only");
    const impostor = await connect(f, { wallet: f.stranger });
    expect((await impostor.call("execute_trade", { sell: "AAPL", buy: "NVDA", usd_amount: 100, reason: "a fine reason" })).text).to.include("not the vault's pilot");
  });

  it("can pull the emergency brake, and then nothing trades", async () => {
    const f = await loadFixture(deployStockPilot);
    const { call } = await connect(f);
    expect((await call("pause_vault", { reason: "Fills look off against the oracle." })).text).to.include("Vault paused");
    expect(await f.vault.read.paused()).to.equal(true);
    expect((await call("check_trade", { sell: "AAPL", buy: "NVDA", usd_amount: 100 })).text).to.include("EnforcedPause");
  });

  it("lets an agent list itself in the pilot marketplace and see everyone's track record", async () => {
    const f = await loadFixture(deployStockPilot);
    const registry = await hre.viem.deployContract("PilotRegistry");
    const marketplace = { registry: registry.address, registryAbi: registry.abi, factory: f.factory.address, factoryAbi: f.factory.abi };
    const { client, call } = await connect(f, { marketplace });
    expect((await client.listTools()).tools.map((t) => t.name)).to.include.members(["list_pilots", "register_as_pilot"]);
    expect((await call("list_pilots")).text).to.include("No pilots are listed yet");

    expect((await call("register_as_pilot", { name: "Patient rebalancer", uri: "https://example.com/bot", fee_percent: 0.75 })).text).to.include(
      'Listed as "Patient rebalancer" asking 0.75%',
    );
    const listed = (await call("list_pilots")).text;
    expect(listed).to.include("Patient rebalancer").and.include("(this server)").and.include("asks 0.75% a year");
    expect(listed).to.include("flies 1 vault(s) worth $10,000.00, 0 paused; 0 trade(s)");

    // The vault's 2% cap applies to asks too.
    const greedy = await call("register_as_pilot", { name: "Greedy", fee_percent: 2.5 }).catch((e: Error) => ({ isError: true, text: e.message }));
    expect(greedy.isError).to.equal(true);
    const { isError } = await connect(f, { marketplace, readOnly: true }).then((c) => c.call("register_as_pilot", { name: "x", fee_percent: 0 }));
    expect(isError).to.equal(true);
  });

  it("has no marketplace tools without a registry", async () => {
    const f = await loadFixture(deployStockPilot);
    const { client } = await connect(f);
    expect((await client.listTools()).tools.map((t) => t.name)).to.not.include("list_pilots");
  });
});

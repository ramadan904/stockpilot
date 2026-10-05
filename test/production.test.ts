import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, parseUnits, toHex, zeroAddress, type Address } from "viem";
import { deployProduction, validateConfig, type ProductionConfig } from "../scripts/lib/production";
import { DEFAULT_LIMITS, px } from "./fixture";

describe("production deployment", () => {
  async function chainWithRealishAssets() {
    const [owner, pilot] = await hre.viem.getWalletClients();
    const usdg = await hre.viem.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
    const tsla = await hre.viem.deployContract("MockERC20", ["Tesla", "TSLA", 18]);
    const aapl = await hre.viem.deployContract("MockERC20", ["Apple", "AAPL", 18]);
    const pyth = await hre.viem.deployContract("MockPyth");
    const aaplChainlink = await hre.viem.deployContract("MockPriceFeed", ["AAPL / USD", 8, px(200)]);
    // A DEX: the mock router prices through an oracle market maker that knows the same feeds.
    const pricer = await hre.viem.deployContract("OracleMarketMaker", [0n]);
    const router = await hre.viem.deployContract("MockSwapRouter", [pricer.address]);
    const TSLA_ID = keccak256(toHex("Equity.US.TSLA/USD"));
    await pyth.write.setPrice([TSLA_ID, 25_000_000n, 5_000n, -5, BigInt(await time.latest())]);
    return { owner, pilot, usdg, tsla, aapl, pyth, aaplChainlink, pricer, router, TSLA_ID };
  }

  it("rejects a config with mistakes before deploying anything", () => {
    const bad = {
      network: "x",
      swapRouter: "0x123",
      assets: [
        { symbol: "DOGE", token: zeroAddress, feed: { type: "fixed", usd: 1 } },
        { symbol: "TSLA", token: zeroAddress, feed: { type: "pyth", id: "0x12" } },
      ],
      pools: [{ a: "TSLA", b: "AAPL", fee: 1234 }],
    } as unknown as ProductionConfig;
    const errors = validateConfig(bad).join("\n");
    expect(errors).to.match(/swapRouter/).and.match(/DOGE/).and.match(/needs "pyth"/).and.match(/32 bytes/).and.match(/unknown symbol/);
  });

  it("deploys a working stack: Pyth, Chainlink and fixed feeds, a DEX venue, and a vault that trades through it", async () => {
    const c = await loadFixture(chainWithRealishAssets);
    const out = await deployProduction(hre, {
      network: "test",
      swapRouter: c.router.address,
      pyth: c.pyth.address,
      assets: [
        { symbol: "USDG", token: c.usdg.address, feed: { type: "fixed", usd: 1 } },
        { symbol: "TSLA", token: c.tsla.address, feed: { type: "pyth", id: c.TSLA_ID } },
        { symbol: "AAPL", token: c.aapl.address, feed: { type: "chainlink", address: c.aaplChainlink.address } },
      ],
      pools: [{ a: "USDG", b: "TSLA", fee: 3000 }],
    });

    // Teach the mock DEX the same prices, and give it inventory.
    for (const [sym, t] of [["USDG", c.usdg], ["TSLA", c.tsla], ["AAPL", c.aapl]] as const) {
      await c.pricer.write.setFeed([t.address, out.feeds[sym]]);
      await t.write.mint([c.router.address, sym === "USDG" ? parseUnits("1000000", 6) : parseUnits("10000", 18)]);
    }

    const factory = await hre.viem.getContractAt("PilotVaultFactory", out.factory);
    const mandate = [
      { token: c.usdg.address, feed: out.feeds.USDG, targetBps: 5000, bandBps: 1000 },
      { token: c.tsla.address, feed: out.feeds.TSLA, targetBps: 3000, bandBps: 1000 },
      { token: c.aapl.address, feed: out.feeds.AAPL, targetBps: 2000, bandBps: 1000 },
    ];
    await factory.write.createVault([c.pilot.account.address, out.venue, mandate, DEFAULT_LIMITS, zeroAddress, 0]);
    const [vaultAddress] = await factory.read.vaultsOf([c.owner.account.address]);
    const vault = await hre.viem.getContractAt("PilotVault", vaultAddress);
    await c.usdg.write.mint([vault.address, parseUnits("10000", 6)]);

    const [, total] = await vault.read.portfolio();
    expect(total).to.equal(parseUnits("10000", 18));

    // Cash-only vault: the pilot buys TSLA toward target through the DEX's default pool.
    const asPilot = await hre.viem.getContractAt("PilotVault", vaultAddress, { client: { wallet: c.pilot } });
    await asPilot.write.rebalance([c.usdg.address, c.tsla.address, parseUnits("2000", 6), 0n, "0x", keccak256(toHex("deploy cash"))]);
    expect((await c.tsla.read.balanceOf([vault.address])) > parseUnits("7.9", 18)).to.equal(true);
    void (out.tokens.TSLA as Address);
  });
});

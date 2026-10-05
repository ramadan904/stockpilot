import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { encodePacked, keccak256, parseUnits, toHex } from "viem";
import { DEFAULT_LIMITS, deployStockPilot } from "./fixture";

const WHY = keccak256(toHex("adapter test"));

describe("UniswapV3Adapter", () => {
  async function withUniswap() {
    const f = await deployStockPilot();
    await f.mm.write.setFee([0n]); // the router uses the market maker only for oracle quotes
    const router = await hre.viem.deployContract("MockSwapRouter", [f.mm.address]);
    for (const t of [f.usdg, f.tsla, f.aapl, f.nvda]) {
      await t.write.mint([router.address, t === f.usdg ? parseUnits("10000000", 6) : parseUnits("100000", 18)]);
    }
    const adapter = await hre.viem.deployContract("UniswapV3Adapter", [router.address]);
    await adapter.write.setPoolFee([f.aapl.address, f.nvda.address, 3000]); // 0.3%
    await f.vault.write.setAdapter([adapter.address]);
    return { ...f, router, adapter };
  }

  it("trades through the operator's default pool when the pilot sends no route", async () => {
    const { vaultAsPilot, router, aapl, nvda, vault } = await loadFixture(withUniswap);
    await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("1", 18), 0n, "0x", WHY]);
    expect(await router.read.lastPath()).to.equal(encodePacked(["address", "uint24", "address"], [aapl.address, 3000, nvda.address]));
    // $200 of AAPL at 0.3% → $199.40 of NVDA at $125.
    expect(await nvda.read.balanceOf([vault.address])).to.equal(parseUnits("20", 18) + parseUnits("1.5952", 18));
  });

  it("follows a multi-hop route the pilot chooses, and still answers to the vault's slippage check", async () => {
    const { vaultAsPilot, router, tsla, nvda, usdg } = await loadFixture(withUniswap);
    const route = encodePacked(["address", "uint24", "address", "uint24", "address"], [tsla.address, 500, usdg.address, 500, nvda.address]);
    await vaultAsPilot.write.rebalance([tsla.address, nvda.address, parseUnits("1", 18), 0n, route, WHY]);
    expect(await router.read.lastPath()).to.equal(route);

    // Two 1% hops lose 2% against the oracle: more than the mandate's 1% cap.
    const pricey = encodePacked(["address", "uint24", "address", "uint24", "address"], [tsla.address, 10000, usdg.address, 10000, nvda.address]);
    await time.increase(DEFAULT_LIMITS.cooldown);
    await expect(vaultAsPilot.write.rebalance([tsla.address, nvda.address, parseUnits("1", 18), 0n, pricey, WHY])).to.be.rejectedWith(
      "SlippageExceeded",
    );
  });

  it("rejects routes that do not go from the sold asset to the bought one", async () => {
    const { vaultAsPilot, tsla, nvda, usdg, aapl } = await loadFixture(withUniswap);
    const wrongEnd = encodePacked(["address", "uint24", "address"], [tsla.address, 500, usdg.address]);
    const wrongStart = encodePacked(["address", "uint24", "address"], [aapl.address, 500, nvda.address]);
    const truncated = "0x1234";
    for (const route of [wrongEnd, wrongStart, truncated] as const) {
      await expect(vaultAsPilot.write.rebalance([tsla.address, nvda.address, parseUnits("1", 18), 0n, route, WHY])).to.be.rejectedWith("BadPath");
    }
  });

  it("needs a configured pool for routeless trades, and only its operator can configure one", async () => {
    const { vaultAsPilot, adapter, tsla, usdg, pilot } = await loadFixture(withUniswap);
    await expect(vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("1", 18), 0n, "0x", WHY])).to.be.rejectedWith("NoPool");
    const asPilot = await hre.viem.getContractAt("UniswapV3Adapter", adapter.address, { client: { wallet: pilot } });
    await expect(asPilot.write.setPoolFee([tsla.address, usdg.address, 500])).to.be.rejectedWith("OwnableUnauthorizedAccount");
  });

  it("keeps no tokens or allowances between trades", async () => {
    const { vaultAsPilot, adapter, router, aapl, nvda } = await loadFixture(withUniswap);
    await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("1", 18), 0n, "0x", WHY]);
    expect(await aapl.read.balanceOf([adapter.address])).to.equal(0n);
    expect(await aapl.read.allowance([adapter.address, router.address])).to.equal(0n);
  });
});

describe("PythPriceFeed", () => {
  const TSLA_ID = keccak256(toHex("Equity.US.TSLA/USD"));

  async function withPyth() {
    const f = await deployStockPilot();
    const pyth = await hre.viem.deployContract("MockPyth");
    const feed = await hre.viem.deployContract("PythPriceFeed", [pyth.address, TSLA_ID, 100n, "TSLA / USD (Pyth)"]); // conf ≤ 1%
    return { ...f, pyth, feed };
  }

  it("converts Pyth's exponent to 8 decimals", async () => {
    const { pyth, feed } = await loadFixture(withPyth);
    const now = BigInt(await time.latest());
    await pyth.write.setPrice([TSLA_ID, 25_012_345n, 10_000n, -5, now]); // $250.12345
    expect((await feed.read.latestRoundData())[1]).to.equal(25_012_345_000n);
    await pyth.write.setPrice([TSLA_ID, 2_501_234_567_890n, 1_000_000_000n, -10, now]); // $250.123456789
    expect((await feed.read.latestRoundData())[1]).to.equal(25_012_345_678n);
    expect((await feed.read.latestRoundData())[3]).to.equal(now);
  });

  it("refuses prices whose confidence interval is too wide", async () => {
    const { pyth, feed } = await loadFixture(withPyth);
    await pyth.write.setPrice([TSLA_ID, 25_000_000n, 300_000n, -5, BigInt(await time.latest())]); // ±1.2%
    await expect(feed.read.latestRoundData()).to.be.rejectedWith("ConfidenceTooWide");
  });

  it("prices a vault asset, and the vault still rejects it once stale", async () => {
    const { vault, vaultAsPilot, mandate, pyth, feed, tsla, usdg } = await loadFixture(withPyth);
    await pyth.write.setPrice([TSLA_ID, 25_000_000n, 10_000n, -5, BigInt(await time.latest())]);
    await vault.write.setMandate([mandate.map((m) => (m.token === tsla.address ? { ...m, feed: feed.address } : m)), DEFAULT_LIMITS]);
    const [holdings] = await vault.read.portfolio();
    expect(holdings[1].valueUsd).to.equal(parseUnits("2500", 18));

    await time.increase(3_601);
    await expect(vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("1", 18), 0n, "0x", WHY])).to.be.rejectedWith("StalePrice");
  });
});

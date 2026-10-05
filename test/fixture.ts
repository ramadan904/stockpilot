import hre from "hardhat";
import { parseUnits, type Address } from "viem";

export const usd = (n: number | string) => parseUnits(String(n), 18);
export const px = (n: number | string) => parseUnits(String(n), 8);

export const DEFAULT_LIMITS = {
  maxTradeUsd: usd(5_000),
  dailyLimitUsd: usd(20_000),
  maxSlippageBps: 100,
  maxPriceAge: 3_600,
  cooldown: 60,
};

/**
 * A $10,000 portfolio split evenly across USDG and three tokenized stocks, with a 5% band on each, a funded
 * market maker charging 0.1%, and a pilot wallet that is not the owner.
 */
export async function deployStockPilot() {
  const [owner, pilot, stranger] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const usdg = await hre.viem.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const tsla = await hre.viem.deployContract("MockERC20", ["Tesla (tokenized)", "TSLA", 18]);
  const aapl = await hre.viem.deployContract("MockERC20", ["Apple (tokenized)", "AAPL", 18]);
  const nvda = await hre.viem.deployContract("MockERC20", ["NVIDIA (tokenized)", "NVDA", 18]);

  const usdgFeed = await hre.viem.deployContract("FixedPriceFeed", ["USDG / USD", 8, px(1)]);
  const tslaFeed = await hre.viem.deployContract("MockPriceFeed", ["TSLA / USD", 8, px(250)]);
  const aaplFeed = await hre.viem.deployContract("MockPriceFeed", ["AAPL / USD", 8, px(200)]);
  const nvdaFeed = await hre.viem.deployContract("MockPriceFeed", ["NVDA / USD", 8, px(125)]);

  const mm = await hre.viem.deployContract("OracleMarketMaker", [10n]);
  for (const [t, f] of [
    [usdg, usdgFeed],
    [tsla, tslaFeed],
    [aapl, aaplFeed],
    [nvda, nvdaFeed],
  ] as const) {
    await mm.write.setFeed([t.address, f.address]);
  }
  // Deep inventory so the venue never runs dry in tests.
  await usdg.write.mint([mm.address, parseUnits("10000000", 6)]);
  for (const t of [tsla, aapl, nvda]) await t.write.mint([mm.address, parseUnits("100000", 18)]);

  const factory = await hre.viem.deployContract("PilotVaultFactory");

  const mandate = [
    { token: usdg.address, feed: usdgFeed.address, targetBps: 2500, bandBps: 500 },
    { token: tsla.address, feed: tslaFeed.address, targetBps: 2500, bandBps: 500 },
    { token: aapl.address, feed: aaplFeed.address, targetBps: 2500, bandBps: 500 },
    { token: nvda.address, feed: nvdaFeed.address, targetBps: 2500, bandBps: 500 },
  ];

  const hash = await factory.write.createVault([pilot.account.address, mm.address, mandate, DEFAULT_LIMITS]);
  await publicClient.waitForTransactionReceipt({ hash });
  const [vaultAddress] = await factory.read.vaultsOf([owner.account.address]);
  const vault = await hre.viem.getContractAt("PilotVault", vaultAddress);
  const vaultAsPilot = await hre.viem.getContractAt("PilotVault", vaultAddress, { client: { wallet: pilot } });
  const vaultAsStranger = await hre.viem.getContractAt("PilotVault", vaultAddress, { client: { wallet: stranger } });

  // $2,500 in each asset.
  await fund(vault.address, usdg, parseUnits("2500", 6));
  await fund(vault.address, tsla, parseUnits("10", 18));
  await fund(vault.address, aapl, parseUnits("12.5", 18));
  await fund(vault.address, nvda, parseUnits("20", 18));

  async function fund(to: Address, token: typeof usdg, amount: bigint) {
    await token.write.mint([owner.account.address, amount]);
    await token.write.approve([to, amount]);
    await vault.write.deposit([token.address, amount]);
  }

  return {
    owner,
    pilot,
    stranger,
    publicClient,
    usdg,
    tsla,
    aapl,
    nvda,
    usdgFeed,
    tslaFeed,
    aaplFeed,
    nvdaFeed,
    mm,
    factory,
    mandate,
    vault,
    vaultAsPilot,
    vaultAsStranger,
  };
}

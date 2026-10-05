import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, parseUnits, zeroAddress } from "viem";
import { fleetTick, type FleetConfig } from "../agent/fleet";
import { listPilots, registrationNeeded, trackRecords } from "../agent/pilots";
import { DEFAULT_LIMITS, deployStockPilot, px, usd } from "./fixture";

describe("PilotRegistry and track records", () => {
  async function marketplace() {
    const f = await deployStockPilot(); // vault #0 names `pilot`
    const [, , , owner2, rival] = await hre.viem.getWalletClients();
    const registry = await hre.viem.deployContract("PilotRegistry");
    const as = (w: typeof rival) => hre.viem.getContractAt("PilotRegistry", registry.address, { client: { wallet: w } });
    // A second vault, owned by someone else, flown by the rival.
    const factory2 = await hre.viem.getContractAt("PilotVaultFactory", f.factory.address, { client: { wallet: owner2 } });
    await factory2.write.createVault([rival.account.address, f.mm.address, f.mandate, DEFAULT_LIMITS, zeroAddress, 0]);
    const [rivalVault] = await f.factory.read.vaultsOf([owner2.account.address]);
    for (const [t, amt] of [[f.usdg, parseUnits("2500", 6)], [f.tsla, parseUnits("10", 18)], [f.aapl, parseUnits("12.5", 18)], [f.nvda, parseUnits("20", 18)]] as const) {
      await t.write.mint([rivalVault, amt]);
    }
    const fleetCfg = (wallet: typeof rival): FleetConfig => ({
      client: f.publicClient as never,
      wallet: wallet as never,
      vaultAbi: f.vault.abi,
      factoryAbi: f.factory.abi,
      factory: f.factory.address,
    });
    return { ...f, registry, as, rival, owner2, rivalVault, fleetCfg };
  }

  it("lets a pilot register, update and retire itself, and lists everyone", async () => {
    const { registry, as, pilot, rival, publicClient } = await loadFixture(marketplace);
    await (await as(pilot)).write.register(["Claude fleet", "https://stockpilot.example/fleet", 50]);
    await (await as(rival)).write.register(["Rival bot", "mcp://rival.example", 100]);
    await (await as(pilot)).write.register(["Claude fleet v2", "https://stockpilot.example/fleet", 75]);
    await (await as(rival)).write.retire();

    expect(await registry.read.pilotCount()).to.equal(2n); // updating does not add an entry
    const list = await listPilots(publicClient as never, registry.abi, registry.address);
    expect(list.map((p) => [p.address, p.name, p.feeBps, p.active])).to.deep.equal([
      [getAddress(pilot.account.address), "Claude fleet v2", 75, true],
      [getAddress(rival.account.address), "Rival bot", 100, false],
    ]);
    expect(list[0].registeredAt).to.be.greaterThan(0);
    expect(await registry.read.isActive([rival.account.address])).to.equal(false);

    // Registering again reactivates.
    await (await as(rival)).write.register(["Rival bot", "mcp://rival.example", 100]);
    expect(await registry.read.isActive([rival.account.address])).to.equal(true);
  });

  it("refuses bad entries: empty or long names, long links, fees above the vault's cap, retiring unregistered", async () => {
    const { as, stranger } = await loadFixture(marketplace);
    const r = await as(stranger);
    await expect(r.write.register(["", "", 0])).to.be.rejectedWith("InvalidName");
    await expect(r.write.register(["x".repeat(65), "", 0])).to.be.rejectedWith("InvalidName");
    await expect(r.write.register(["ok", "u".repeat(257), 0])).to.be.rejectedWith("UriTooLong");
    await expect(r.write.register(["ok", "", 201])).to.be.rejectedWith("FeeTooHigh");
    await expect(r.write.retire()).to.be.rejectedWith("NotRegistered");
    await r.write.register(["x".repeat(64), "u".repeat(256), 200]); // the limits themselves are fine
  });

  it("pages the directory", async () => {
    const { registry, as } = await loadFixture(marketplace);
    const wallets = await hre.viem.getWalletClients();
    for (const w of wallets.slice(5, 9)) await (await as(w)).write.register([`p${w.account.address.slice(2, 6)}`, "", 0]);
    const [a] = await registry.read.pilots([1n, 2n]);
    expect(a.map((x) => getAddress(x))).to.deep.equal(wallets.slice(6, 8).map((w) => getAddress(w.account.address)));
    const [tail] = await registry.read.pilots([3n, 10n]);
    expect(tail.length).to.equal(1);
    const [none] = await registry.read.pilots([10n, 5n]);
    expect(none.length).to.equal(0);
  });

  it("computes track records from the chain: vaults, value, trades while in charge, pauses", async () => {
    const f = await loadFixture(marketplace);
    const { publicClient, factory, vault, pilot, rival, rivalVault, nvdaFeed, fleetCfg } = f;
    const abis = { factory: factory.abi, vault: vault.abi };
    const pilots = [pilot.account.address, rival.account.address];

    // Before any trade: each flies one $10,000 vault.
    let records = await trackRecords(publicClient as never, abis, factory.address, pilots);
    const mine = () => records.get(pilot.account.address.toLowerCase())!;
    const theirs = () => records.get(rival.account.address.toLowerCase())!;
    expect(mine().vaults).to.equal(1);
    expect(mine().aumUsd).to.equal(usd(10_000));
    expect(theirs().vaults).to.equal(1);
    expect(mine().trades).to.equal(0);

    // NVDA rallies; both pilots trade.
    await nvdaFeed.write.setPrice([px(200)]);
    expect((await fleetTick(fleetCfg(pilot))).map((e) => e.kind)).to.deep.equal(["trade"]);
    expect((await fleetTick(fleetCfg(rival))).map((e) => e.kind)).to.deep.equal(["trade"]);
    records = await trackRecords(publicClient as never, abis, factory.address, pilots);
    expect(mine().trades).to.equal(1);
    expect(mine().tradedUsd > 0n).to.equal(true);
    expect(mine().lastTradeBlock).to.not.equal(null);
    expect(theirs().trades).to.equal(1);

    // The owner of vault #0 fires its pilot and hires the rival: the old trades stay out of the rival's record,
    // and the old pilot no longer has the vault.
    await vault.write.setPilot([rival.account.address]);
    await vault.write.pause();
    records = await trackRecords(publicClient as never, abis, factory.address, pilots);
    expect(mine()).to.deep.include({ vaults: 0, trades: 0, aumUsd: 0n });
    expect(theirs().vaults).to.equal(2);
    expect(theirs().trades).to.equal(1); // only its own trade in its original vault
    expect(theirs().paused).to.equal(1);
    expect(rivalVault).to.not.equal(vault.address);
  });

  it("tells a fleet when its registry entry needs writing", () => {
    const want = { name: "Claude fleet", uri: "https://x", feeBps: 50 };
    expect(registrationNeeded(null, want)).to.equal(true);
    expect(registrationNeeded({ ...want, active: false }, want)).to.equal(true);
    expect(registrationNeeded({ ...want, active: true }, want)).to.equal(false);
    expect(registrationNeeded({ ...want, feeBps: 75, active: true }, want)).to.equal(true);
  });
});

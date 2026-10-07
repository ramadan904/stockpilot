import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { STRANGER, explainRevert, liveAttacks, revertName } from "../agent/theater";
import { readVault } from "../agent/chain";
import { deployStockPilot } from "./fixture";

async function stage(f: Awaited<ReturnType<typeof deployStockPilot>>) {
  const state = await readVault(f.publicClient, f.vault.abi, f.vault.address);
  const pilot = await f.vault.read.pilot();
  const results = [];
  for (const a of liveAttacks({ assets: state.assets, pilot })) {
    try {
      await f.publicClient.simulateContract({ address: f.vault.address, abi: f.vault.abi, functionName: a.functionName, args: a.args as never, account: a.from });
      results.push({ name: a.name, error: null as string | null });
    } catch (e) {
      results.push({ name: a.name, error: revertName(e) ?? "unknown" });
    }
  }
  return { results, pilot };
}

describe("Attack Theater", () => {
  it("every attack, simulated against a real vault from the pilot's own address, is refused for the right reason", async () => {
    const f = await loadFixture(deployStockPilot);
    const { results, pilot } = await stage(f);
    expect(pilot.toLowerCase()).to.equal(f.pilot.account.address.toLowerCase());
    expect(Object.fromEntries(results.map((r) => [r.name, r.error]))).to.deep.equal({
      "Pile into TSLA": "OutsideBand",
      "Dump all of TSLA": "OutsideBand",
      "Buy a token outside the mandate": "AssetNotInMandate",
      "Withdraw to its own wallet": "OwnableUnauthorizedAccount",
      "Hand the vault to another pilot": "OwnableUnauthorizedAccount",
      "Route trades through its own venue": "OwnableUnauthorizedAccount",
      "Pay itself a 20% fee": "OwnableUnauthorizedAccount",
      "A stranger trades": "NotPilot",
      "A stranger claims the vault": "NotHeir",
    });
  });

  it("nothing is written: the vault is exactly as it was", async () => {
    const f = await loadFixture(deployStockPilot);
    const before = await readVault(f.publicClient, f.vault.abi, f.vault.address);
    await stage(f);
    const after = await readVault(f.publicClient, f.vault.abi, f.vault.address);
    expect(after.assets.map((a) => a.balance)).to.deep.equal(before.assets.map((a) => a.balance));
    expect((await f.vault.read.owner()).toLowerCase()).to.equal(f.owner.account.address.toLowerCase());
    expect((await f.vault.read.pilot()).toLowerCase()).to.equal(f.pilot.account.address.toLowerCase());
  });

  it("a paused vault refuses the pilot's trades for being paused, and the owner-only calls as before", async () => {
    const f = await loadFixture(deployStockPilot);
    await f.vault.write.pause();
    const { results } = await stage(f);
    const by = Object.fromEntries(results.map((r) => [r.name, r.error]));
    expect(by["Pile into TSLA"]).to.equal("EnforcedPause");
    expect(by["Withdraw to its own wallet"]).to.equal("OwnableUnauthorizedAccount");
    expect(results.every((r) => r.error !== null)).to.equal(true);
  });

  it("with no pilot set, the trades come from a stranger and are refused as such", async () => {
    const assets = [{ token: STRANGER, symbol: "USDG", decimals: 6, balance: 0n, price: 10n ** 18n, priceUpdatedAt: 0n, targetBps: 10_000, bandBps: 0 }];
    const attacks = liveAttacks({ assets, pilot: "0x0000000000000000000000000000000000000000" });
    expect(attacks.every((a) => a.from === STRANGER)).to.equal(true);
    // An empty position still yields a non-zero amount, so the refusal is the contract's rule, not "nothing to trade".
    expect(attacks[0].args[2]).to.equal(1n);
  });

  it("explains a refusal in plain words, and still calls an unknown one a refusal", () => {
    expect(explainRevert("OwnableUnauthorizedAccount")).to.match(/Only the owner/);
    expect(explainRevert("StalePrice")).to.match(/too old/);
    expect(explainRevert("SomethingNew")).to.equal("Refused by the contract.");
    expect(explainRevert(undefined)).to.equal("Refused by the contract.");
  });
});

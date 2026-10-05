import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, parseUnits, zeroAddress, type Address } from "viem";
import { collectFees, describe as describeEvent, discoverVaults, fleetTick, webhookNotifier, type FleetConfig, type FleetEvent } from "../agent/fleet";
import { DEFAULT_LIMITS, deployStockPilot, px } from "./fixture";

describe("agent/fleet", () => {
  /** Four vaults: two pay this pilot a fee, one names it without a fee, one belongs to another pilot. */
  async function fleet() {
    const f = await deployStockPilot(); // vault #0: names `pilot`, no fee
    const [, , , owner2, otherPilot] = await hre.viem.getWalletClients();
    const create = async (pilot: Address, feeTo: Address, feeBps: number) => {
      const factory = await hre.viem.getContractAt("PilotVaultFactory", f.factory.address, { client: { wallet: owner2 } });
      await factory.write.createVault([pilot, f.mm.address, f.mandate, DEFAULT_LIMITS, feeTo, feeBps]);
      const list = await f.factory.read.vaultsOf([owner2.account.address]);
      const vault = list[list.length - 1];
      for (const [t, amt] of [[f.usdg, parseUnits("2500", 6)], [f.tsla, parseUnits("10", 18)], [f.aapl, parseUnits("12.5", 18)], [f.nvda, parseUnits("20", 18)]] as const) {
        await t.write.mint([vault, amt]);
      }
      return vault;
    };
    const p = f.pilot.account.address;
    const paying1 = await create(p, p, 50);
    const paying2 = await create(p, p, 100);
    const others = await create(otherPilot.account.address, otherPilot.account.address, 50);
    const cfg = (extra: Partial<FleetConfig> = {}): FleetConfig => ({
      client: f.publicClient as never,
      wallet: f.pilot as never,
      vaultAbi: f.vault.abi,
      factoryAbi: f.factory.abi,
      factory: f.factory.address,
      ...extra,
    });
    return { ...f, paying1, paying2, others, cfg };
  }

  it("finds exactly the vaults that name it as pilot", async () => {
    const { cfg, vault, paying1, paying2, pilot } = await loadFixture(fleet);
    const found = await discoverVaults(cfg(), pilot.account.address);
    expect(found).to.deep.equal([vault.address, paying1, paying2].map((a) => getAddress(a)));
  });

  it("rebalances every drifted vault in one tick, and holds the ones on target", async () => {
    const { cfg, nvdaFeed } = await loadFixture(fleet);
    let events = await fleetTick(cfg());
    expect(events.map((e) => e.kind)).to.deep.equal(["hold", "hold", "hold"]);

    await nvdaFeed.write.setPrice([px(200)]);
    const seen: FleetEvent[] = [];
    events = await fleetTick(cfg({ notify: (e) => void seen.push(e) }));
    expect(events.map((e) => e.kind)).to.deep.equal(["trade", "trade", "trade"]);
    expect(seen).to.have.length(3);
    expect(describeEvent(events[0])).to.match(/^StockPilot traded \$[\d,.]+ in vault 0x.+NVDA/);
  });

  it("can serve only vaults that pay it", async () => {
    const { cfg, nvdaFeed, paying1, paying2 } = await loadFixture(fleet);
    await nvdaFeed.write.setPrice([px(200)]);
    const events = await fleetTick(cfg({ minFeeBps: 50 }));
    expect(events.map((e) => e.kind)).to.deep.equal(["skip", "trade", "trade"]);
    expect(events.filter((e) => e.kind === "trade").map((e) => e.vault)).to.deep.equal([paying1, paying2].map((a) => getAddress(a)));
  });

  it("keeps flying the rest of the fleet when one vault is paused or broken", async () => {
    const { cfg, nvdaFeed, vault, paying1 } = await loadFixture(fleet);
    await nvdaFeed.write.setPrice([px(200)]);
    await vault.write.pause(); // the owner of vault #0 stops it
    const [, , , owner2] = await hre.viem.getWalletClients();
    // Vault #1's owner points it at a venue that does not exist: its trade fails, the others go through.
    const asOwner2 = await hre.viem.getContractAt("PilotVault", paying1, { client: { wallet: owner2 } });
    await asOwner2.write.setAdapter(["0x000000000000000000000000000000000000dEaD"]);
    const events = await fleetTick(cfg());
    expect(events.map((e) => e.kind)).to.deep.equal(["hold", "error", "trade"]);
  });

  it("collects its management fees", async () => {
    const { cfg, pilot, usdg } = await loadFixture(fleet);
    await time.increase(30 * 86_400);
    const before = await usdg.read.balanceOf([pilot.account.address]);
    const events = await collectFees(cfg());
    expect(events.map((e) => e.kind)).to.deep.equal(["fee", "fee"]); // the no-fee vault is not touched
    expect((await usdg.read.balanceOf([pilot.account.address])) > before).to.equal(true);
  });

  it("posts trades and errors to a webhook in a Slack- and Discord-compatible shape", async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const notify = webhookNotifier("https://hooks.example/abc", fakeFetch);
    const vault = zeroAddress;
    await notify({ kind: "hold", vault, reason: "fine" });
    await notify({ kind: "trade", vault, tx: "0x1", rationale: "NVDA ran up.", valueUsd: 500n * 10n ** 18n });
    await notify({ kind: "error", vault, error: "boom" });
    expect(posts).to.have.length(2);
    expect(posts[0].body.text).to.equal(posts[0].body.content);
    expect(posts[0].body.text).to.match(/\$500\.00.*NVDA ran up/);
    expect((posts[0].body.event as { valueUsd: string }).valueUsd).to.equal("500000000000000000000");
  });

  it("never lets a failing webhook stop the pilot", async () => {
    const notify = webhookNotifier("https://down.example", (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    const original = console.error;
    console.error = () => {};
    try {
      await notify({ kind: "error", vault: zeroAddress, error: "x" });
    } finally {
      console.error = original;
    }
  });
});

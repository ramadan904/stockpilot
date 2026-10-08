import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, toBytes } from "viem";
import { deployStockPilot, px } from "./fixture";

async function withJournal() {
  const f = await deployStockPilot();
  const journal = await hre.viem.deployContract("PilotJournal", [f.factory.address]);
  const asPilot = await hre.viem.getContractAt("PilotJournal", journal.address, { client: { wallet: f.pilot } });
  const asStranger = await hre.viem.getContractAt("PilotJournal", journal.address, { client: { wallet: f.stranger } });
  return { ...f, journal, asPilot, asStranger };
}

const LETTER = "Dear owner,\nNo trades today: every asset stayed inside its trigger. The vault is worth $10,000.\nYour pilot";

describe("PilotJournal: letters from the pilot, onchain", () => {
  it("publishes the vault's pilot's letter in full, numbered, with its hash", async () => {
    const { asPilot, journal, vault, pilot, publicClient } = await loadFixture(withJournal);
    const head = await publicClient.getBlockNumber();
    await asPilot.write.post([vault.address, 1n, head, LETTER]);
    expect(await journal.read.letterCount([vault.address])).to.equal(1n);
    const [log] = await journal.getEvents.Letter({ vault: vault.address }, { fromBlock: 0n });
    expect(log.args.pilot!.toLowerCase()).to.equal(pilot.account.address.toLowerCase());
    expect(log.args.number).to.equal(1n);
    expect(log.args.text).to.equal(LETTER);
    expect(log.args.textHash).to.equal(keccak256(toBytes(LETTER)));
    expect([log.args.fromBlock, log.args.toBlock]).to.deep.equal([1n, head]);
    await asPilot.write.post([vault.address, head, head, "Second letter."]);
    expect(await journal.read.letterCount([vault.address])).to.equal(2n);
  });

  it("refuses anyone but the vault's current pilot, the owner included", async () => {
    const { journal, asStranger, asPilot, vault, stranger } = await loadFixture(withJournal);
    await expect(journal.write.post([vault.address, 0n, 0n, LETTER])).to.be.rejectedWith("NotPilot"); // the owner
    await expect(asStranger.write.post([vault.address, 0n, 0n, LETTER])).to.be.rejectedWith("NotPilot");
    // Once the owner replaces the pilot, the old one can no longer speak for the vault.
    await vault.write.setPilot([stranger.account.address]);
    await expect(asPilot.write.post([vault.address, 0n, 0n, LETTER])).to.be.rejectedWith("NotPilot");
    await asStranger.write.post([vault.address, 0n, 0n, LETTER]);
  });

  it("only for genuine StockPilot vaults, with a sane length and block range", async () => {
    const { asPilot, vault, publicClient } = await loadFixture(withJournal);
    const lookalike = await hre.viem.deployContract("PilotVault");
    await expect(asPilot.write.post([lookalike.address, 0n, 0n, LETTER])).to.be.rejectedWith("NotAStockPilotVault");
    await expect(asPilot.write.post([vault.address, 0n, 0n, ""])).to.be.rejectedWith("EmptyLetter");
    await expect(asPilot.write.post([vault.address, 0n, 0n, "x".repeat(4_001)])).to.be.rejectedWith("LetterTooLong(4001)");
    const head = await publicClient.getBlockNumber();
    await expect(asPilot.write.post([vault.address, 5n, 4n, LETTER])).to.be.rejectedWith("BadRange");
    await expect(asPilot.write.post([vault.address, 0n, head + 100n, LETTER])).to.be.rejectedWith("BadRange");
    await asPilot.write.post([vault.address, 0n, 0n, "x".repeat(4_000)]);
  });

  it("publishes the full reason for a trade, which matches the hash the trade recorded, word for word", async () => {
    const f = await loadFixture(withJournal);
    const { asPilot, asStranger, journal, vault, vaultAsPilot, usdg, nvda } = f;
    const { rationaleHash } = await import("../agent/chain");
    const reason = "NVDA is 3.1 points under its 25% target; selling $200 of USDG brings it back inside its band.";
    await vaultAsPilot.write.rebalance([usdg.address, nvda.address, 200_000_000n, 0n, "0x", rationaleHash(reason)]);
    const [trade] = await vault.getEvents.Rebalanced({}, { fromBlock: 0n });

    await expect(asStranger.write.explain([vault.address, reason])).to.be.rejectedWith("NotPilot");
    await expect(asPilot.write.explain([vault.address, ""])).to.be.rejectedWith("EmptyLetter");
    await asPilot.write.explain([vault.address, reason]);
    const [published] = await journal.getEvents.Reason({ vault: vault.address }, { fromBlock: 0n });
    expect(published.args.rationale).to.equal(trade.args.rationale); // the published text is the one the trade committed to
    expect(published.args.text).to.equal(reason);
    // Any other wording has another hash, so it matches no trade.
    await asPilot.write.explain([vault.address, reason + " "]);
    const [, other] = await journal.getEvents.Reason({ vault: vault.address }, { fromBlock: 0n });
    expect(other.args.rationale).to.not.equal(trade.args.rationale);
  });

  it("the fleet publishes each trade's reason right after the trade, so the feed can show it", async () => {
    const f = await loadFixture(withJournal);
    const { fleetTick } = await import("../agent/fleet");
    await f.nvdaFeed.write.setPrice([px(200)]); // NVDA rallies: the vault drifts
    const [event] = await fleetTick({
      client: f.publicClient as never,
      wallet: f.pilot as never,
      vaultAbi: f.vault.abi,
      factoryAbi: f.factory.abi,
      factory: f.factory.address,
      journal: f.journal.address,
    });
    expect(event.kind).to.equal("trade");
    const [trade] = await f.vault.getEvents.Rebalanced({}, { fromBlock: 0n });
    const [reason] = await f.journal.getEvents.Reason({ vault: f.vault.address }, { fromBlock: 0n });
    expect(reason.args.rationale).to.equal(trade.args.rationale);
    expect(reason.args.text).to.equal(event.kind === "trade" ? event.rationale : "");
    expect(reason.args.text).to.match(/NVDA/);
  });
});

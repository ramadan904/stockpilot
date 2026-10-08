import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, toBytes } from "viem";
import { deployStockPilot } from "./fixture";

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
});

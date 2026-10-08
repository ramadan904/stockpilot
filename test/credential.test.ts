import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { DEFAULT_LIMITS, deployStockPilot, usd } from "./fixture";

const DAY = 86_400n;

async function withCredential() {
  const f = await deployStockPilot();
  const credential = await hre.viem.deployContract("MandateCredential", [f.factory.address, DAY]);
  const asStranger = await hre.viem.getContractAt("MandateCredential", credential.address, { client: { wallet: f.stranger } });
  return { ...f, credential, asStranger };
}

const decode = (uri: string) => JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));

describe("MandateCredential: a soulbound Verified Mandate", () => {
  it("is issued once the enrolled mandate has stood, unchanged, for the minimum time", async () => {
    const { credential, vault, owner } = await loadFixture(withCredential);
    await credential.write.enroll([vault.address]);
    const [, enrolledAt] = await credential.read.enrollments([vault.address]);
    await expect(credential.write.issue([vault.address])).to.be.rejectedWith(`TooSoon(${enrolledAt + DAY})`);
    await time.increase(DAY);
    await credential.write.issue([vault.address]);
    expect((await credential.read.ownerOf([1n])).toLowerCase()).to.equal(owner.account.address.toLowerCase());
    expect(await credential.read.isCurrent([1n])).to.equal(true);
    expect(await credential.read.locked([1n])).to.equal(true);
    expect(await credential.read.credentialOf([vault.address, await vault.read.mandateVersion()])).to.equal(1n);
    await expect(credential.write.issue([vault.address])).to.be.rejectedWith("AlreadyIssued(1)");
  });

  it("can't be transferred", async () => {
    const { credential, vault, owner, stranger } = await loadFixture(withCredential);
    await credential.write.enroll([vault.address]);
    await time.increase(DAY);
    await credential.write.issue([vault.address]);
    await expect(credential.write.transferFrom([owner.account.address, stranger.account.address, 1n])).to.be.rejectedWith("Soulbound");
    expect(await credential.read.supportsInterface(["0xb45a3c0e"])).to.equal(true); // ERC-5192
  });

  it("stops being current when the owner changes the mandate, and a change during enrollment restarts the clock", async () => {
    const { credential, vault, mandate } = await loadFixture(withCredential);
    await credential.write.enroll([vault.address]);
    await time.increase(DAY);
    await credential.write.issue([vault.address]);
    await vault.write.setMandate([mandate, { ...DEFAULT_LIMITS, maxTradeUsd: usd(500) }]);
    expect(await credential.read.isCurrent([1n])).to.equal(false);
    expect(decode(await credential.read.tokenURI([1n])).attributes.find((a: { trait_type: string }) => a.trait_type === "Status").value).to.equal("Superseded");
    // The new mandate needs its own enrollment and its own wait.
    await expect(credential.write.issue([vault.address])).to.be.rejectedWith("MandateChanged(1, 2)");
    await credential.write.enroll([vault.address]);
    await expect(credential.write.issue([vault.address])).to.be.rejectedWith("TooSoon");
  });

  it("only a genuine StockPilot vault, and only its owner, can enroll", async () => {
    const { credential, asStranger, vault } = await loadFixture(withCredential);
    await expect(asStranger.write.enroll([vault.address])).to.be.rejectedWith("NotVaultOwner");
    // A PilotVault deployed by hand is not a clone of the factory's implementation.
    const lookalike = await hre.viem.deployContract("PilotVault");
    await expect(credential.write.enroll([lookalike.address])).to.be.rejectedWith(`NotAStockPilotVault`);
    await expect(credential.write.issue([vault.address])).to.be.rejectedWith("NotEnrolled");
  });

  it("carries fully onchain metadata: the vault, its version and fingerprint, the days kept, and an image", async () => {
    const { credential, vault } = await loadFixture(withCredential);
    await credential.write.enroll([vault.address]);
    await time.increase(3n * DAY);
    await credential.write.issue([vault.address]);
    const meta = decode(await credential.read.tokenURI([1n]));
    expect(meta.name).to.equal("Verified Mandate #1");
    const attr = Object.fromEntries(meta.attributes.map((a: { trait_type: string; value: unknown }) => [a.trait_type, a.value]));
    expect(String(attr.Vault).toLowerCase()).to.equal(vault.address.toLowerCase());
    expect(attr["Mandate version"]).to.equal(1);
    expect(attr["Days under the mandate"]).to.equal(3);
    expect(attr["Mandate hash"]).to.equal(await credential.read.mandateHash([vault.address]));
    expect(attr.Status).to.equal("Current");
    const svg = Buffer.from(meta.image.split(",")[1], "base64").toString("utf8");
    expect(svg).to.contain("Rules kept for 3 days").and.contain("Still in force");
  });
});

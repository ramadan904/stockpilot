import hre from "hardhat";
import { expect } from "chai";
import { zeroAddress } from "viem";
import { checkClone, checkCode, codeHash } from "../agent/codecheck";
import { CODE_PRINTS } from "../web/src/codeprints";
import { DEFAULT_LIMITS, deployStockPilot } from "./fixture";

describe("Code check: deployed code is this repository's code", () => {
  it("every contract of a fresh deployment matches its print, immutables and all", async () => {
    const f = await deployStockPilot();
    const client = f.publicClient;
    const registry = await hre.viem.deployContract("PilotRegistry");
    const credential = await hre.viem.deployContract("MandateCredential", [f.factory.address, 86_400n]);
    const journal = await hre.viem.deployContract("PilotJournal", [f.factory.address]);
    const funds = await hre.viem.deployContract("PilotFundFactory", [f.factory.address]);
    await funds.write.createFund(["Check", "CHK", { pilot: f.pilot.account.address, adapter: f.mm.address, assets: f.mandate, limits: DEFAULT_LIMITS, feeRecipient: zeroAddress, feeBps: 0 }]);
    const [fund] = await funds.read.funds();
    const implementation = await f.factory.read.implementation();

    const checks = [
      [f.factory.address, CODE_PRINTS.PilotVaultFactory],
      [implementation, CODE_PRINTS.PilotVault],
      [registry.address, CODE_PRINTS.PilotRegistry],
      [credential.address, CODE_PRINTS.MandateCredential],
      [journal.address, CODE_PRINTS.PilotJournal],
      [funds.address, CODE_PRINTS.PilotFundFactory],
      [fund, CODE_PRINTS.PilotFund],
    ] as const;
    for (const [address, print] of checks) expect(await checkCode(client, address, print)).to.equal("match");
    expect(await checkClone(client, f.vault.address, implementation)).to.equal("match");
  });

  it("anything else is different, and an empty address has no code", async () => {
    const f = await deployStockPilot();
    expect(await checkCode(f.publicClient, f.usdg.address, CODE_PRINTS.PilotRegistry)).to.equal("different");
    expect(await checkCode(f.publicClient, f.factory.address, CODE_PRINTS.PilotJournal)).to.equal("different"); // right code, wrong contract
    expect(await checkCode(f.publicClient, "0x000000000000000000000000000000000000dEaD", CODE_PRINTS.PilotVault)).to.equal("no code");
    // A vault-shaped contract that is not a clone of the real implementation is not a vault.
    expect(await checkClone(f.publicClient, f.mm.address, await f.factory.read.implementation())).to.equal("different");
  });

  it("ignores the compiler's metadata trailer (a build from CRLF sources differs only there), but not one instruction", async () => {
    const f = await deployStockPilot();
    const code = (await f.publicClient.getCode({ address: f.factory.address }))!;
    const print = CODE_PRINTS.PilotVaultFactory;
    const flip = (hex: string, byteIndex: number) => {
      const i = 2 + byteIndex * 2;
      return (hex.slice(0, i) + (hex.slice(i, i + 2) === "ff" ? "00" : "ff") + hex.slice(i + 2)) as `0x${string}`;
    };
    const bytes = (code.length - 2) / 2;
    expect(codeHash(flip(code, bytes - 10), print.immutables)).to.equal(print.hash); // inside the metadata trailer
    expect(codeHash(flip(code, 5), print.immutables)).to.not.equal(print.hash); // an instruction
  });

  it("ignores a child's metadata inside a factory too (the fund factory carries the fund's creation code)", async () => {
    const f = await deployStockPilot();
    const funds = await hre.viem.deployContract("PilotFundFactory", [f.factory.address]);
    const code = (await f.publicClient.getCode({ address: funds.address }))!;
    const print = CODE_PRINTS.PilotFundFactory;
    const embedded = code.indexOf("a264697066735822"); // the fund's metadata block, before the factory's own
    expect(embedded).to.be.greaterThan(2);
    expect(embedded).to.be.lessThan(code.lastIndexOf("a264697066735822"));
    const byte = (embedded - 2) / 2 + 8 + 5; // inside the fund's 34-byte source hash
    const flipped = (code.slice(0, 2 + byte * 2) + (code.slice(2 + byte * 2, 4 + byte * 2) === "ff" ? "00" : "ff") + code.slice(4 + byte * 2)) as `0x${string}`;
    expect(codeHash(flipped, print.immutables)).to.equal(print.hash); // a CRLF build of the fund
    expect(await checkCode(f.publicClient, funds.address, print)).to.equal("match");
  });
});

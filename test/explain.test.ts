import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { readVault, sendTrade } from "../agent/chain";
import { explainTrade } from "../agent/explain";
import { plan } from "../agent/planner";
import { deployStockPilot, px } from "./fixture";

describe("agent/explain", () => {
  async function rallied() {
    const f = await deployStockPilot();
    await f.nvdaFeed.write.setPrice([px(160)]); // NVDA +28%: 29.9% of the vault against a 25% target, 5-point band
    return f;
  }

  it("states each side's band arithmetic in plain words", async () => {
    const f = await loadFixture(rallied);
    const state = await readVault(f.publicClient, f.vault.abi, f.vault.address);
    const p = plan(state);
    if (p.action !== "trade") throw new Error("expected a trade");
    const e = explainTrade(state, p.trade);
    expect(e.sell).to.include({ symbol: "NVDA", targetBps: 2_500, bandBps: 500, triggerBps: 250, beforeBps: 2_991 });
    expect(e.lines[0]).to.equal(
      `Selling ${e.lines[0].match(/\$[\d,.]+/)![0]} of NVDA: it is 29.9%, 4.9 points over its 25.0% target, past the pilot's trigger, inside its ±5.0-point band. ` +
        `After the trade: ${(e.sell.afterBps / 100).toFixed(1)}%, ${(Math.abs(e.sell.afterBps - 2_500) / 100).toFixed(1)} points from target.`,
    );
    expect(e.lines[1]).to.match(/^Buying \$[\d,.]+ of \w+: it is 23\.\d%, 1\.\d points under its 25\.0% target, inside its ±5\.0-point band\./);
    // The trade moves both sides toward target.
    expect(Math.abs(e.sell.afterBps - 2_500)).to.be.lessThan(Math.abs(e.sell.beforeBps - 2_500));
    expect(Math.abs(e.buy.afterBps - 2_500)).to.be.lessThan(Math.abs(e.buy.beforeBps - 2_500));
  });

  it("predicts the weights the vault reports once the trade has gone through", async () => {
    const f = await loadFixture(rallied);
    const state = await readVault(f.publicClient, f.vault.abi, f.vault.address);
    const p = plan(state);
    if (p.action !== "trade") throw new Error("expected a trade");
    const e = explainTrade(state, p.trade);
    await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
    const [holdings] = await f.vault.read.portfolio();
    const weight = (token: string) => Number(holdings.find((h) => h.token.toLowerCase() === token.toLowerCase())!.weightBps);
    expect(weight(p.trade.tokenIn)).to.be.closeTo(e.sell.afterBps, 15);
    expect(weight(p.trade.tokenOut)).to.be.closeTo(e.buy.afterBps, 15);
  });
});

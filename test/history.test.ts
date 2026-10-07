import { expect } from "chai";
import { blockAtOrBefore, logsInRange } from "../agent/history";

/** A chain whose block n was made at 1_000 + 2n seconds, counting every block read. */
function chain(head: number) {
  let reads = 0;
  return {
    reads: () => reads,
    client: {
      getBlockNumber: async () => BigInt(head),
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        reads++;
        return { timestamp: 1_000n + 2n * blockNumber };
      },
    } as never,
  };
}

describe("Reading a vault's whole history", () => {
  it("finds the last block at or before a time in a few rounds of parallel reads", async () => {
    const c = chain(10_000_000);
    expect(await blockAtOrBefore(c.client, 1_000 + 2 * 4_321_000)).to.equal(4_321_000n);
    expect(await blockAtOrBefore(c.client, 1_000 + 2 * 4_321_000 + 1)).to.equal(4_321_000n);
    // Eight rounds of eight, plus the two ends.
    expect(c.reads()).to.be.at.most(2 * (2 + 8 * 9));
    // Exact at the edges of a small chain too.
    for (const n of [0, 1, 2, 99, 100]) expect(await blockAtOrBefore(chain(100).client, 1_000 + 2 * n)).to.equal(BigInt(n));
  });

  it("handles times before the first block and after the head", async () => {
    const c = chain(100);
    expect(await blockAtOrBefore(c.client, 0)).to.equal(0n);
    expect(await blockAtOrBefore(c.client, 1_000)).to.equal(0n);
    expect(await blockAtOrBefore(c.client, 999_999)).to.equal(100n);
  });

  it("splits a log query the node refuses until each part fits, keeping order", async () => {
    const spans: [bigint, bigint][] = [];
    // A node that refuses more than 1,000 blocks at once; one log every 250 blocks.
    const read = async (from: bigint, to: bigint) => {
      if (to - from + 1n > 1_000n) throw new Error("block range too large");
      spans.push([from, to]);
      const out: bigint[] = [];
      for (let b = from; b <= to; b++) if (b % 250n === 0n) out.push(b);
      return out;
    };
    const logs = await logsInRange(read, 0n, 9_999n);
    expect(logs).to.have.length(40);
    expect(logs).to.deep.equal([...logs].sort((a, b) => (a < b ? -1 : 1)));
    expect(spans.every(([f, t]) => t - f + 1n <= 1_000n)).to.equal(true);
  });

  it("reads in one call when the node allows it, and fails when the node is down", async () => {
    let calls = 0;
    expect(await logsInRange(async () => (calls++, [1, 2]), 0n, 1_000_000n)).to.deep.equal([1, 2]);
    expect(calls).to.equal(1);
    expect(await logsInRange(async () => [1], 5n, 4n)).to.deep.equal([]);
    let tries = 0;
    await logsInRange(async () => {
      tries++;
      throw new Error("down");
    }, 0n, 7n).then(
      () => expect.fail("should fail"),
      (e) => expect((e as Error).message).to.equal("down"),
    );
    expect(tries).to.be.at.most(4);
  });
});

import { expect } from "chai";
import { count, isHealthy, metricsText, newState, runService } from "../agent/service";

describe("agent/service", () => {
  it("is healthy during start-up and after recent ticks, stale otherwise", () => {
    const s = newState("fleet");
    expect(isHealthy(s, 60_000, s.startedAt + 59_000)).to.equal(true);
    expect(isHealthy(s, 60_000, s.startedAt + 61_000)).to.equal(false);
    s.lastTickAt = s.startedAt + 100_000;
    expect(isHealthy(s, 60_000, s.startedAt + 120_000)).to.equal(true);
  });

  it("exports counters and gauges as Prometheus text", () => {
    const s = newState("fleet-1");
    s.ticks = 3;
    count(s, "trade");
    count(s, "trade");
    count(s, "hold", 5);
    s.gauges.vaults = 7;
    const text = metricsText(s);
    expect(text).to.contain('stockpilot_ticks_total{service="fleet_1"} 3');
    expect(text).to.contain('stockpilot_events_total{service="fleet_1",kind="trade"} 2');
    expect(text).to.contain('stockpilot_events_total{service="fleet_1",kind="hold"} 5');
    expect(text).to.contain("# TYPE stockpilot_vaults gauge");
    expect(text).to.contain('stockpilot_vaults{service="fleet_1"} 7');
  });

  it("serves /health and /metrics, survives failing ticks, and stops gracefully", async () => {
    const abort = new AbortController();
    let port = 0;
    let n = 0;
    let resolveListening!: () => void;
    const listening = new Promise<void>((r) => (resolveListening = r));
    let resolveThird!: () => void;
    const third = new Promise<void>((r) => (resolveThird = r));
    const done = runService({
      name: "test",
      intervalMs: 10,
      healthPort: 0,
      abort: abort.signal,
      onListening: (p) => {
        port = p;
        resolveListening();
      },
      tick: async (state) => {
        n++;
        if (n === 2) throw new Error("rpc down\nstack trace");
        count(state, "pushed");
        if (n === 3) resolveThird();
      },
    });
    await Promise.all([listening, third]);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).to.equal(200);
    const body = await health.json();
    expect(body.status).to.equal("ok");
    expect(body.service).to.equal("test");

    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(metrics).to.match(/stockpilot_failed_ticks_total\{service="test"\} 1/);
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).to.equal(404);

    abort.abort();
    const state = await done;
    expect(state.failedTicks).to.equal(1);
    expect(state.ticks).to.be.greaterThanOrEqual(2);
    expect(state.counters.pushed).to.equal(state.ticks);
    // The health server is closed with the loop.
    const refused = await fetch(`http://127.0.0.1:${port}/health`).then(() => false, () => true);
    expect(refused).to.equal(true);
  });

  it("runs a single tick with once, and reports stale health with 503", async () => {
    const state = await runService({ name: "once", intervalMs: 1_000, once: true, tick: async () => {} });
    expect(state.ticks).to.equal(1);

    const abort = new AbortController();
    let port = 0;
    let resolveListening!: () => void;
    const listening = new Promise<void>((r) => (resolveListening = r));
    const done = runService({
      name: "stuck",
      intervalMs: 1_000,
      healthPort: 0,
      abort: abort.signal,
      onListening: (p) => {
        port = p;
        resolveListening();
      },
      tick: async (s) => {
        // Pretend the last good tick was long ago and this one fails.
        s.startedAt = 0;
        throw new Error("hung");
      },
    });
    await listening;
    await new Promise((r) => setTimeout(r, 20));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).to.equal(503);
    expect((await res.json()).lastError).to.equal("hung");
    abort.abort();
    await done;
  });
});

// What every long-running StockPilot service shares: a tick loop, a health endpoint for orchestrators, Prometheus
// metrics, and a graceful stop (SIGTERM finishes the current tick, then exits; it never cuts a transaction in half).

import { createServer, type Server } from "node:http";

export interface ServiceState {
  name: string;
  startedAt: number;
  ticks: number;
  failedTicks: number;
  lastTickAt: number | null;
  lastError: string | null;
  /** Free-form counters, e.g. trades, holds, errors, prices pushed. Exported as metrics. */
  counters: Record<string, number>;
  /** Current values, e.g. vaults served. Exported as `stockpilot_<name>` gauges. */
  gauges: Record<string, number>;
}

export function newState(name: string): ServiceState {
  return { name, startedAt: Date.now(), ticks: 0, failedTicks: 0, lastTickAt: null, lastError: null, counters: {}, gauges: {} };
}

export function count(state: ServiceState, key: string, by = 1) {
  state.counters[key] = (state.counters[key] ?? 0) + by;
}

/** Healthy once a tick has completed recently; during start-up, healthy for one grace period. */
export function isHealthy(state: ServiceState, staleAfterMs: number, now = Date.now()) {
  const since = state.lastTickAt ?? state.startedAt;
  return now - since <= staleAfterMs;
}

export function metricsText(state: ServiceState) {
  const n = state.name.replace(/[^a-z0-9_]/gi, "_");
  const lines = [
    `# HELP stockpilot_ticks_total Completed ticks.`,
    `# TYPE stockpilot_ticks_total counter`,
    `stockpilot_ticks_total{service="${n}"} ${state.ticks}`,
    `# TYPE stockpilot_failed_ticks_total counter`,
    `stockpilot_failed_ticks_total{service="${n}"} ${state.failedTicks}`,
    `# TYPE stockpilot_last_tick_timestamp_seconds gauge`,
    `stockpilot_last_tick_timestamp_seconds{service="${n}"} ${state.lastTickAt ? Math.floor(state.lastTickAt / 1000) : 0}`,
    `# TYPE stockpilot_events_total counter`,
    ...Object.entries(state.counters).map(([k, v]) => `stockpilot_events_total{service="${n}",kind="${k.replace(/"/g, "")}"} ${v}`),
    ...Object.entries(state.gauges).flatMap(([k, v]) => {
      const g = `stockpilot_${k.replace(/[^a-z0-9_]/gi, "_")}`;
      return [`# TYPE ${g} gauge`, `${g}{service="${n}"} ${v}`];
    }),
  ];
  return lines.join("\n") + "\n";
}

export function startHealthServer(port: number, state: ServiceState, staleAfterMs: number): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const ok = isHealthy(state, staleAfterMs);
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ok ? "ok" : "stale", service: state.name, ticks: state.ticks, lastTickAt: state.lastTickAt, lastError: state.lastError }));
    } else if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metricsText(state));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port);
  return server;
}

/**
 * Run `tick` every `intervalMs` until SIGTERM/SIGINT (or after one tick when `once`). A failing tick is logged and
 * counted, never fatal. Starts the health server when `healthPort` is set.
 */
export async function runService(opts: {
  name: string;
  intervalMs: number;
  once?: boolean;
  healthPort?: number;
  /** Stops the loop like SIGTERM does; for embedding and tests. */
  abort?: AbortSignal;
  /** Called once the health server listens, with its port (useful with `healthPort: 0`). */
  onListening?: (port: number) => void;
  tick: (state: ServiceState) => Promise<void>;
}): Promise<ServiceState> {
  const state = newState(opts.name);
  const server = opts.healthPort !== undefined ? startHealthServer(opts.healthPort, state, Math.max(3 * opts.intervalMs, 60_000)) : null;
  server?.on("listening", () => {
    const a = server.address();
    if (a && typeof a === "object") {
      console.log(`${opts.name}: health on :${a.port}/health, metrics on :${a.port}/metrics`);
      opts.onListening?.(a.port);
    }
  });
  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${opts.name}: ${signal} received, finishing the current tick`);
    wake?.();
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  const onAbort = () => stop("abort");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  if (opts.abort?.aborted) stopping = true;
  opts.abort?.addEventListener("abort", onAbort);

  while (!stopping) {
    try {
      await opts.tick(state);
      state.ticks++;
      state.lastTickAt = Date.now();
      state.lastError = null;
    } catch (e) {
      state.failedTicks++;
      state.lastError = (e as Error).message.split("\n")[0];
      console.error(`${opts.name}: tick failed: ${state.lastError}`);
    }
    if (opts.once || stopping) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.intervalMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  }
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  opts.abort?.removeEventListener("abort", onAbort);
  if (server) await new Promise<void>((r) => server.close(() => r()));
  // A one-shot run (e.g. from cron) reports a failed tick in its exit code.
  if (opts.once && state.failedTicks) process.exitCode = 1;
  console.log(`${opts.name}: stopped after ${state.ticks} tick(s)`);
  return state;
}

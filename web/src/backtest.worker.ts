// Runs backtests off the page's main thread, so the app keeps responding while hundreds of simulated markets fly,
// and reports progress after every path.

import { backtest, taxBacktest, type BacktestOptions, type TaxSettings } from "../../agent/backtest";

export type Job = { kind: "backtest"; options: BacktestOptions } | { kind: "tax"; options: BacktestOptions; rates: Omit<TaxSettings, "aware"> };
export type Reply = { type: "progress"; done: number; total: number } | { type: "done"; result: unknown } | { type: "error"; message: string };

const post = (r: Reply) => (self as unknown as Worker).postMessage(r);
let last = 0;
const progress = (done: number, total: number) => {
  // At most every 50 ms, and always the last one.
  const now = Date.now();
  if (done === total || now - last > 50) {
    last = now;
    post({ type: "progress", done, total });
  }
};

self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const job = e.data;
    const result = job.kind === "tax" ? taxBacktest(job.options, job.rates, progress) : backtest(job.options, progress);
    post({ type: "done", result });
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  }
};

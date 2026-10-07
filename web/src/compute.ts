// Heavy simulations as cancellable jobs on a Web Worker. Starting a new job cancels the one before it, so changing a
// setting mid-run never queues stale work behind it. Where workers aren't available, the job runs on the page.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, Reply } from "./backtest.worker";
import { backtest, taxBacktest } from "../../agent/backtest";

export interface JobState<T> {
  result: T | null;
  busy: boolean;
  done: number;
  total: number;
  error: string | null;
}

export function useComputeJob<T>() {
  const [state, setState] = useState<JobState<T>>({ result: null, busy: false, done: 0, total: 0, error: null });
  const worker = useRef<Worker | null>(null);
  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
  };
  useEffect(() => stop, []);

  const run = useCallback((job: Job) => {
    stop();
    setState((s) => ({ ...s, busy: true, done: 0, total: job.options.paths, error: null }));
    if (typeof Worker === "undefined") {
      // No workers: run here after letting the busy state paint.
      setTimeout(() => {
        const result = (job.kind === "tax" ? taxBacktest(job.options, job.rates) : backtest(job.options)) as T;
        setState({ result, busy: false, done: job.options.paths, total: job.options.paths, error: null });
      }, 30);
      return;
    }
    const w = new Worker(new URL("./backtest.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e: MessageEvent<Reply>) => {
      if (worker.current !== w) return;
      const r = e.data;
      if (r.type === "progress") setState((s) => ({ ...s, done: r.done, total: r.total }));
      else {
        stop();
        if (r.type === "done") setState((s) => ({ ...s, result: r.result as T, busy: false }));
        else setState((s) => ({ ...s, busy: false, error: r.message }));
      }
    };
    w.onerror = (e) => {
      if (worker.current !== w) return;
      stop();
      setState((s) => ({ ...s, busy: false, error: e.message || "The simulation stopped unexpectedly." }));
    };
    w.postMessage(job);
  }, []);

  const reset = useCallback(() => {
    stop();
    setState({ result: null, busy: false, done: 0, total: 0, error: null });
  }, []);

  return { ...state, run, reset };
}

/** A thin bar and count for a running job. */
export function progressLabel(done: number, total: number, what = "paths") {
  return total > 0 ? `${done} of ${total} ${what}` : "Starting…";
}

// The pilot's logbook: one JSON line per trade with the full rationale. The vault's Rebalanced event carries
// keccak256(rationale), so anyone can check that a logged explanation is the one committed with the trade.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const LOG_DIR = process.env.PILOT_LOG_DIR ?? "pilot-log";

export function appendLog(vault: string, entry: { tx: string; rationale: string; rationaleHash: string }) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, `${vault}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

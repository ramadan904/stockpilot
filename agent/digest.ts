// Builds a vault's daily digest from the chain: current holdings plus the trades since the last digest.

import type { Abi, Address, PublicClient } from "viem";
import { readVault } from "./chain";
import { available, eq } from "./model";
import { holdingsFacts, valueFacts, type ReportFacts } from "./report";

export async function digestFacts(client: PublicClient, vaultAbi: Abi, vault: Address, fromBlock: bigint): Promise<{ facts: ReportFacts; head: bigint }> {
  const [state, head, feeBps] = await Promise.all([
    readVault(client, vaultAbi, vault),
    client.getBlockNumber(),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "feeBps" }) as Promise<number>,
  ]);
  const logs = await client.getContractEvents({ address: vault, abi: vaultAbi, eventName: "Rebalanced", fromBlock, toBlock: head });
  const sym = (t: unknown) => state.assets.find((a) => eq(a.token, String(t)))?.symbol ?? String(t).slice(0, 8);
  const trades = logs.slice(-50).map((l) => {
    const a = l.args as Record<string, unknown>;
    return { sold: sym(a.tokenIn), bought: sym(a.tokenOut), valueUsd: Number((a.valueInUsd as bigint) / 10n ** 16n) / 100, reason: null };
  });
  return {
    head,
    facts: {
      period: "the last day",
      valueStartUsd: null,
      valueNowUsd: valueFacts(state),
      paused: state.paused,
      budgetLeftUsd: Number(available(state) / 10n ** 16n) / 100,
      feeBps: Number(feeBps),
      holdings: holdingsFacts(state),
      trades,
      blocked: [],
    },
  };
}

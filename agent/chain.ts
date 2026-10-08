// Reads a PilotVault into the planner's VaultState and sends the pilot's trades.

import { BaseError, ContractFunctionRevertedError, decodeErrorResult, isHex, keccak256, toHex, type Abi, type Hash, type PublicClient, type WalletClient } from "viem";
import type { Address, VaultState } from "./model";
import type { PlannedTrade } from "./planner";

const erc20SymbolAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** Only what reading needs, so any viem public client fits (Node scripts, Hardhat, the browser). */
type Reader = Pick<PublicClient, "readContract" | "getBlock">;

export async function readVault(client: Reader, vaultAbi: Abi, vault: Address): Promise<VaultState> {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: vault, abi: vaultAbi, functionName, args }) as Promise<T>;

  type Holding = {
    token: Address;
    balance: bigint;
    priceUsd: bigint;
    priceUpdatedAt: bigint;
    targetBps: number;
    bandBps: number;
  };
  const [[holdings], limits, lastTradeAt, budgetUsd, budgetUpdatedAt, paused, block] = await Promise.all([
    read<readonly [Holding[], bigint]>("portfolio"),
    read<readonly [bigint, bigint, number, number, number]>("limits"),
    read<bigint>("lastTradeAt"),
    read<bigint>("budgetUsd"),
    read<bigint>("budgetUpdatedAt"),
    read<boolean>("paused"),
    client.getBlock(),
  ]);

  const assets = await Promise.all(
    holdings.map(async (h) => {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: h.token, abi: erc20SymbolAbi, functionName: "symbol" }),
        client.readContract({ address: h.token, abi: erc20SymbolAbi, functionName: "decimals" }),
      ]);
      return {
        token: h.token,
        symbol,
        decimals,
        balance: h.balance,
        price: h.priceUsd,
        priceUpdatedAt: h.priceUpdatedAt,
        targetBps: Number(h.targetBps),
        bandBps: Number(h.bandBps),
      };
    }),
  );

  return {
    address: vault,
    assets,
    limits: {
      maxTradeUsd: limits[0],
      dailyLimitUsd: limits[1],
      maxSlippageBps: Number(limits[2]),
      maxPriceAge: Number(limits[3]),
      cooldown: Number(limits[4]),
    },
    lastTradeAt,
    budgetUsd,
    budgetUpdatedAt,
    paused,
    now: block.timestamp,
  };
}

export function rationaleHash(rationale: string) {
  return keccak256(toHex(rationale));
}

/** Simulate first, so a trade the vault would reject never costs gas, then send it. */
export async function sendTrade(
  client: PublicClient,
  wallet: WalletClient,
  vaultAbi: Abi,
  vault: Address,
  trade: PlannedTrade,
) {
  const { request } = await client.simulateContract({
    account: wallet.account!,
    address: vault,
    abi: vaultAbi,
    functionName: "rebalance",
    args: [trade.tokenIn, trade.tokenOut, trade.amountIn, trade.minAmountOut, "0x", rationaleHash(trade.rationale)],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}

const journalExplainAbi = [
  { type: "function", name: "explain", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "string" }], outputs: [{ type: "bytes32" }] },
] as const;

/**
 * Publish a trade's full reason in the pilot journal once the trade has landed, so anyone can read it and check it
 * against the hash the trade recorded. Best effort: the trade stands either way, so this never throws.
 */
export async function publishReason(client: PublicClient, wallet: WalletClient, journal: Address | undefined, vault: Address, rationale: string): Promise<Hash | null> {
  if (!journal) return null;
  try {
    const { request } = await client.simulateContract({ account: wallet.account!, address: journal, abi: journalExplainAbi, functionName: "explain", args: [vault, rationale] });
    const hash = await wallet.writeContract(request);
    await client.waitForTransactionReceipt({ hash });
    return hash;
  } catch {
    return null;
  }
}

/**
 * The custom error a failed call reverted with (e.g. "OutsideBand"), however the node reported it: viem's decoded
 * error, raw revert data anywhere in the cause chain, or a node's text message. Falls back to the first line.
 */
export function revertReason(e: unknown, abi?: Abi): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return revert.data.errorName;
  }
  for (let c = e as { cause?: unknown; data?: unknown; message?: string } | undefined, i = 0; c && i < 10; c = c.cause as typeof c, i++) {
    const data = typeof c.data === "string" ? c.data : (c.data as { data?: unknown } | undefined)?.data;
    if (abi && typeof data === "string" && isHex(data) && data.length >= 10) {
      try {
        return decodeErrorResult({ abi, data }).errorName;
      } catch {
        // not one of ours; keep looking
      }
    }
    const m = /custom error '?(\w+)/.exec(String(c.message ?? ""));
    if (m) return m[1];
  }
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
}

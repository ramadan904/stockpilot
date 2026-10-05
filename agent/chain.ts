// Reads a PilotVault into the planner's VaultState and sends the pilot's trades.

import { keccak256, toHex, type Abi, type PublicClient, type WalletClient } from "viem";
import type { Address, VaultState } from "./model";
import type { PlannedTrade } from "./planner";

const erc20SymbolAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export async function readVault(client: PublicClient, vaultAbi: Abi, vault: Address): Promise<VaultState> {
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
  const [[holdings], limits, lastTradeAt, remainingToday, paused, block] = await Promise.all([
    read<readonly [Holding[], bigint]>("portfolio"),
    read<readonly [bigint, bigint, number, number, number]>("limits"),
    read<bigint>("lastTradeAt"),
    read<bigint>("remainingToday"),
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
    remainingToday,
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

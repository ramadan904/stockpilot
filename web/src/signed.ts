// Gasless safety actions: the owner signs a check-in or a pause (EIP-712, no gas), and the operator's relay submits it.

import type { Address, Chain, Hash, PublicClient, WalletClient } from "viem";
import { pilotVaultAbi } from "./abi";

export type SignedAction = "checkIn" | "pause";

const TYPE = { checkIn: "CheckIn", pause: "Pause" } as const;

/** Sign `action` for `vault` and have the relay submit it. Returns the transaction hash once it has landed. */
export async function signAndRelay(client: PublicClient, wallet: WalletClient, chain: Chain, vault: Address, action: SignedAction): Promise<Hash> {
  const [nonce, block] = await Promise.all([
    client.readContract({ address: vault, abi: pilotVaultAbi, functionName: "sigNonce" }) as Promise<bigint>,
    client.getBlock(),
  ]);
  const deadline = block.timestamp + 3_600n;
  const primaryType = TYPE[action];
  const signature = await wallet.signTypedData({
    account: wallet.account!,
    domain: { name: "StockPilot Vault", version: "1", chainId: chain.id, verifyingContract: vault },
    types: { [primaryType]: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType,
    message: { nonce, deadline },
  });
  const res = await fetch("/api/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: chain.id, vault, action, deadline: deadline.toString(), signature }),
  });
  const json = (await res.json()) as { tx?: Hash; error?: string };
  if (!res.ok || !json.tx) throw new Error(json.error ?? `Relay failed (HTTP ${res.status}).`);
  await client.waitForTransactionReceipt({ hash: json.tx });
  return json.tx;
}

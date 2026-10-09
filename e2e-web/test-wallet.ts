// A browser wallet for recordings: window.ethereum backed by a key held in the test process, so the app's own
// "Connect wallet" flow signs and sends real transactions with no extension and no prompts. Testnet keys only.

import type { Page } from "@playwright/test";
import { createPublicClient, createWalletClient, defineChain, http, toHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Rpcs = Record<number, string>;

/** uint/int fields of signed typed data come over JSON as strings; viem wants bigints. */
function revive(types: Record<string, { name: string; type: string }[]>, type: string, value: unknown): unknown {
  if (type.endsWith("[]")) return (value as unknown[]).map((v) => revive(types, type.slice(0, -2), v));
  if (types[type]) {
    const out: Record<string, unknown> = {};
    for (const f of types[type]) out[f.name] = revive(types, f.type, (value as Record<string, unknown>)[f.name]);
    return out;
  }
  return /^u?int\d*$/.test(type) && (typeof value === "string" || typeof value === "number") ? BigInt(value) : value;
}

export async function injectWallet(page: Page, key: Hex, rpcs: Rpcs, startChain: number) {
  const account = privateKeyToAccount(key);
  let chainId = startChain;
  const chain = (id: number) =>
    defineChain({ id, name: `chain ${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcs[id]] } } });
  const reader = (id: number) => createPublicClient({ chain: chain(id), transport: http(rpcs[id]) });

  await page.exposeFunction("__testWallet", async (method: string, paramsJson: string) => {
    const params = JSON.parse(paramsJson || "[]");
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return toHex(chainId);
      case "net_version":
        return String(chainId);
      case "wallet_switchEthereumChain":
        chainId = Number(params[0].chainId);
        if (!rpcs[chainId]) throw new Error(`No RPC for chain ${chainId}`);
        return null;
      case "wallet_addEthereumChain":
        return null;
      case "eth_sendTransaction": {
        const tx = params[0] as { to?: Address; data?: Hex; value?: Hex; gas?: Hex };
        const wallet = createWalletClient({ account, chain: chain(chainId), transport: http(rpcs[chainId]) });
        return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
      }
      case "eth_signTypedData_v4": {
        const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        const { EIP712Domain: _, ...types } = typed.types;
        const domain = revive({ EIP712Domain: typed.types.EIP712Domain ?? [] }, "EIP712Domain", typed.domain);
        return account.signTypedData({ domain, types, primaryType: typed.primaryType, message: revive(types, typed.primaryType, typed.message) } as TypedDataDefinition);
      }
      case "personal_sign":
        return account.signMessage({ message: { raw: params[0] as Hex } });
      default:
        return reader(chainId).request({ method, params } as never);
    }
  });

  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: unknown; __testWallet: (m: string, p: string) => Promise<unknown> };
    w.ethereum = {
      isTestWallet: true,
      request: ({ method, params }: { method: string; params?: unknown }) =>
        w.__testWallet(method, JSON.stringify(params ?? [], (_, v) => (typeof v === "bigint" ? v.toString() : v))),
      on() {},
      removeListener() {},
    };
  });
  return account.address;
}

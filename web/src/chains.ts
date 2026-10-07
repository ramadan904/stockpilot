import { defineChain, type Address, type Chain } from "viem";
import { arbitrumSepolia, hardhat } from "viem/chains";

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export interface Deployment {
  network: string;
  chainId: number;
  /** Real assets (scripts/deploy-production.ts): no faucet tokens, fund from the wallet. */
  production?: boolean;
  factory: Address;
  /** The pilot directory. Older deployment files predate it. */
  registry?: Address;
  /** The venue adapter vaults trade through. Older testnet files only have marketMaker. */
  venue?: Address;
  marketMaker: Address;
  /** A funded vault anyone can open read-only (scripts/create-vault.ts with DEMO=1). */
  demoVault?: Address;
  tokens: Record<string, Address>;
  feeds: Record<string, Address>;
}

// Every deployments/<network>.json that scripts/deploy.ts wrote is picked up at build time.
const files = import.meta.glob<Deployment>("../../deployments/*.json", { eager: true, import: "default" });
export const DEPLOYMENTS: Deployment[] = Object.values(files);

export const CHAINS: Chain[] = [robinhoodTestnet, arbitrumSepolia, hardhat];

export function chainById(id: number) {
  return CHAINS.find((c) => c.id === id);
}

export function deploymentFor(chainId: number) {
  return DEPLOYMENTS.find((d) => d.chainId === chainId);
}

export function explorerTx(chainId: number, hash: string) {
  const url = chainById(chainId)?.blockExplorers?.default.url;
  return url ? `${url}/tx/${hash}` : undefined;
}

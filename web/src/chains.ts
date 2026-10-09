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
  /** Verified Mandate credentials. Older deployment files predate it. */
  credential?: Address;
  /** Letters from pilots. Older deployment files predate it. */
  journal?: Address;
  /** Journals this one replaced (scripts/deploy-addons.ts): trade reasons published there still count. */
  pastJournals?: Address[];
  /** Pilot funds: vaults many people own together. Older deployment files predate it. */
  funds?: Address;
  /** The pilot directory. Older deployment files predate it. */
  registry?: Address;
  /** The venue adapter vaults trade through. Older testnet files only have marketMaker. */
  venue?: Address;
  marketMaker: Address;
  /** When it was written (ISO time), and the block the deploy started at: where reading a vault's history begins. */
  deployedAt?: string;
  startBlock?: number;
  /** A funded vault anyone can open read-only (scripts/create-vault.ts with DEMO=1). */
  demoVault?: Address;
  /** The demo fund's vault: a pooled vault anyone can buy into (scripts/demo-fund.ts). */
  demoFundVault?: Address;
  tokens: Record<string, Address>;
  feeds: Record<string, Address>;
}

// Every deployments/<network>.json that scripts/deploy.ts wrote is picked up at build time.
const files = import.meta.glob<Deployment>("../../deployments/*.json", { eager: true, import: "default" });
export const DEPLOYMENTS: Deployment[] = Object.values(files);

// The local Hardhat chain exists only on a developer's own machine, so it is offered only when this build has a local
// deployment (deployments/localhost.json is never committed, so the public site never lists it).
export const CHAINS: Chain[] = [robinhoodTestnet, arbitrumSepolia, hardhat].filter((c) => c.id !== hardhat.id || DEPLOYMENTS.some((d) => d.chainId === hardhat.id));

export function chainById(id: number) {
  return CHAINS.find((c) => c.id === id);
}

export function deploymentFor(chainId: number) {
  return DEPLOYMENTS.find((d) => d.chainId === chainId);
}

export function explorerAddress(chainId: number, address: string) {
  const url = chainById(chainId)?.blockExplorers?.default.url;
  return url ? `${url}/address/${address}` : undefined;
}

export function explorerTx(chainId: number, hash: string) {
  const url = chainById(chainId)?.blockExplorers?.default.url;
  return url ? `${url}/tx/${hash}` : undefined;
}

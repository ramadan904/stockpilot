// Is the code at an address exactly this repository's contract? A contract's deployed code is its compiled runtime
// code with a few values filled in at deployment (immutables: addresses, the EIP-712 domain) and the compiler's
// metadata trailer at the end (a hash of the sources, which line endings alone can change; a factory also carries its
// child's, inside the child's creation code). Blank those, hash the rest,
// and compare with the same hash of this repository's build: equal means the same instructions, byte for byte.

import { hexToBytes, keccak256, type Address, type Hex, type PublicClient } from "viem";

export interface CodePrint {
  /** keccak256 of the runtime code with immutables zeroed and the metadata trailer removed. */
  hash: Hex;
  /** Byte ranges [start, length] of the immutables, from the compiler's immutableReferences. */
  immutables: (readonly [number, number])[];
}

export type CodeVerdict = "match" | "different" | "no code";

/** The runtime code without its CBOR metadata trailer (its length is the last two bytes). */
function withoutMetadata(code: Uint8Array): Uint8Array {
  if (code.length < 2) return code;
  const length = (code[code.length - 2] << 8) | code[code.length - 1];
  return length + 2 <= code.length ? code.slice(0, code.length - length - 2) : code;
}

// A solc metadata block: a2 64 "ipfs" 58 22 <34-byte source hash> 64 "solc" 43 <version>. A contract that deploys
// another (the fund factory deploys funds) carries the child's whole creation code, metadata block included.
const IPFS_TAG = [0xa2, 0x64, 0x69, 0x70, 0x66, 0x73, 0x58, 0x22];
const SOLC_TAG = [0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43];

/** Zero the source hash of every embedded metadata block, so a child built from CRLF sources still matches. */
function blankEmbeddedMetadata(bytes: Uint8Array) {
  const at = (i: number, tag: number[]) => tag.every((b, k) => bytes[i + k] === b);
  for (let i = 0; i + IPFS_TAG.length + 34 + SOLC_TAG.length <= bytes.length; i++) {
    if (at(i, IPFS_TAG) && at(i + IPFS_TAG.length + 34, SOLC_TAG)) bytes.fill(0, i + IPFS_TAG.length, i + IPFS_TAG.length + 34);
  }
}

export function codeHash(code: Hex, immutables: CodePrint["immutables"]): Hex {
  const bytes = hexToBytes(code);
  for (const [start, length] of immutables) bytes.fill(0, start, Math.min(bytes.length, start + length));
  blankEmbeddedMetadata(bytes);
  return keccak256(withoutMetadata(bytes));
}

export async function checkCode(client: Pick<PublicClient, "getCode">, address: Address, print: CodePrint): Promise<CodeVerdict> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") return "no code";
  return codeHash(code, print.immutables) === print.hash ? "match" : "different";
}

/** EIP-1167 minimal proxy runtime code pointing at `implementation`: exactly what the factory deploys for a vault. */
export function cloneCode(implementation: Address): Hex {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

/** A vault is genuine when its code is a clone of the factory's implementation, and nothing else. */
export async function checkClone(client: Pick<PublicClient, "getCode">, vault: Address, implementation: Address): Promise<CodeVerdict> {
  const code = (await client.getCode({ address: vault }))?.toLowerCase();
  if (!code || code === "0x") return "no code";
  return code === cloneCode(implementation) ? "match" : "different";
}

export interface CodeCheckRow {
  label: string;
  contract: string;
  address: Address;
  verdict: CodeVerdict;
}

const IMPLEMENTATION_ABI = [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const FUND_VAULT_ABI = [{ type: "function", name: "vault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** Every StockPilot contract a deployment file names, checked against this repository's build. */
export async function checkDeployment(
  client: Pick<PublicClient, "getCode" | "readContract">,
  d: { factory: Address; registry?: Address; credential?: Address; journal?: Address; funds?: Address; demoVault?: Address; demoFund?: Address },
  prints: Record<string, CodePrint>,
): Promise<CodeCheckRow[]> {
  const implementation = (await client.readContract({ address: d.factory, abi: IMPLEMENTATION_ABI, functionName: "implementation" }).catch(() => null)) as Address | null;
  const rows: Omit<CodeCheckRow, "verdict">[] = [{ label: "Vault factory", contract: "PilotVaultFactory", address: d.factory }];
  if (implementation) rows.push({ label: "Vault code (every vault runs it)", contract: "PilotVault", address: implementation });
  if (d.registry) rows.push({ label: "Pilot marketplace", contract: "PilotRegistry", address: d.registry });
  if (d.credential) rows.push({ label: "Verified Mandate", contract: "MandateCredential", address: d.credential });
  if (d.journal) rows.push({ label: "Pilot journal", contract: "PilotJournal", address: d.journal });
  if (d.funds) rows.push({ label: "Fund factory", contract: "PilotFundFactory", address: d.funds });
  if (d.demoFund) rows.push({ label: "Demo fund", contract: "PilotFund", address: d.demoFund });
  const checked = await Promise.all(rows.map(async (r) => ({ ...r, verdict: await checkCode(client, r.address, prints[r.contract]) })));
  // Vaults are clones: genuine only if they point at the implementation checked above.
  if (implementation) {
    if (d.demoVault) checked.push({ label: "Demo vault (a clone of the vault code)", contract: "PilotVault clone", address: d.demoVault, verdict: await checkClone(client, d.demoVault, implementation) });
    if (d.demoFund) {
      const vault = (await client.readContract({ address: d.demoFund, abi: FUND_VAULT_ABI, functionName: "vault" }).catch(() => null)) as Address | null;
      if (vault) checked.push({ label: "Demo fund's vault (a clone)", contract: "PilotVault clone", address: vault, verdict: await checkClone(client, vault, implementation) });
    }
  }
  return checked;
}

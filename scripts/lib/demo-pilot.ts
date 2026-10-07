// A demo vault's pilot must not be its owner: otherwise "the pilot" holds the owner's powers and the vault can't show
// what a pilot is kept from doing. A fresh pilot key is made for it and kept out of the repository, in .secrets/, so
// the fleet can fly the vault later (PILOT_KEY) without the owner's key.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export function demoPilot(network: string): Address {
  const dir = ".secrets";
  const file = `${dir}/demo-pilot-${network}.key`;
  let key: Hex;
  if (existsSync(file)) key = readFileSync(file, "utf8").trim() as Hex;
  else {
    key = generatePrivateKey();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    console.log(`New demo pilot key saved to ${file} (not committed). Give it to the fleet as PILOT_KEY to fly the demo vault.`);
  }
  return privateKeyToAccount(key).address;
}

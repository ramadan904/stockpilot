// Is what's deployed exactly this repository's code? Checks every contract in deployments/<network>.json against this
// build (immutables blanked, compiler metadata excluded; see agent/codecheck.ts). Read-only: needs no key.
//
//   npx hardhat compile && node scripts/export-codeprints.mjs   (only if you changed the contracts)
//   npm run check-code -- --network robinhoodTestnet

import hre from "hardhat";
import { readFileSync } from "node:fs";
import { checkDeployment } from "../agent/codecheck";
import { CODE_PRINTS, SOLC_VERSION } from "../web/src/codeprints";

async function main() {
  const d = JSON.parse(readFileSync(`deployments/${hre.network.name}.json`, "utf8"));
  const rows = await checkDeployment(await hre.viem.getPublicClient(), d, CODE_PRINTS);
  console.log(`StockPilot on ${hre.network.name} (chain ${d.chainId}) against this repository's build (solc ${SOLC_VERSION}):\n`);
  for (const r of rows) console.log(`  ${r.verdict === "match" ? "✓" : "✗"} ${r.label.padEnd(40)} ${r.address}  ${r.verdict}`);
  const bad = rows.filter((r) => r.verdict !== "match");
  console.log(bad.length ? `\n${bad.length} of ${rows.length} do not match.` : `\nAll ${rows.length} match, instruction for instruction.`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

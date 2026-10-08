// Is what's live exactly the code in this repository? Each StockPilot contract on this chain, fetched and compared
// with this build's own print (immutables blanked, compiler metadata excluded), plus the demo vaults checked as
// genuine clones of the vault code. Anyone can run the same check from a terminal: npm run check-code.

import { useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { checkDeployment, type CodeCheckRow } from "../../agent/codecheck";
import { explorerAddress, type Deployment } from "./chains";
import { CODE_PRINTS, SOLC_VERSION } from "./codeprints";
import { Card } from "./ui";

const SOURCE = "https://github.com/ramadan904/stockpilot/blob/main/contracts/";

export function CodeCheckCard({ client, deployment, chainId }: { client: PublicClient; deployment: Deployment; chainId: number }) {
  const [rows, setRows] = useState<CodeCheckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    checkDeployment(client, deployment, CODE_PRINTS)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof Error ? e.message.split("\n")[0] : String(e)));
    return () => {
      live = false;
    };
  }, [client, deployment]);

  const matched = rows?.filter((r) => r.verdict === "match").length ?? 0;
  return (
    <Card
      title="Code check"
      aside={rows && <span className={`pill ${matched === rows.length ? "ok" : "bad"}`} data-testid="code-summary">{matched} of {rows.length} match this repository</span>}
    >
      <p className="small" style={{ marginTop: 0 }}>
        Each contract's code, fetched from the chain now and compared with this repository's own build (solc {SOLC_VERSION}), instruction for instruction.
        Values set at deployment (addresses, signing domains) and the compiler's metadata trailer are left out of the comparison. Vaults are checked as
        exact clones of the vault code. Run it yourself: <span className="mono">npm run check-code -- --network robinhoodTestnet</span>.
      </p>
      {error && <p className="notice bad">Could not check: {error}</p>}
      {!rows && !error && <p className="muted small">Fetching code…</p>}
      {rows && (
        <ul className="code-check" aria-label="Code check">
          {rows.map((r) => {
            const url = explorerAddress(chainId, r.address);
            const file = r.contract.replace(" clone", "");
            return (
              <li key={`${r.contract}-${r.address}`}>
                <span className={`pill ${r.verdict === "match" ? "ok" : "bad"}`}>{r.verdict === "match" ? "✓ match" : r.verdict === "no code" ? "✗ no code" : "✗ different"}</span>
                <span>
                  {r.label}{" "}
                  <a href={`${SOURCE}${file}.sol`} target="_blank" rel="noreferrer" className="muted small">
                    {file}.sol
                  </a>
                </span>
                {url ? (
                  <a className="mono small" href={url} target="_blank" rel="noreferrer">
                    {r.address.slice(0, 6)}…{r.address.slice(-4)}
                  </a>
                ) : (
                  <span className="mono small">
                    {r.address.slice(0, 6)}…{r.address.slice(-4)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

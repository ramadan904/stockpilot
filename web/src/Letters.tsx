// Letters from the pilot, read from the pilot journal onchain: what it did and why, in its own words, signed by the
// key that trades. Each letter's text is checked against the hash the contract recorded.

import { useEffect, useState } from "react";
import { keccak256, toBytes, type Address, type Hash, type PublicClient } from "viem";
import { logsInRange } from "../../agent/history";
import { pilotJournalAbi } from "./abi";
import { explorerTx } from "./chains";
import { historyStart } from "./rpc";
import { Card } from "./ui";

interface Letter {
  number: bigint;
  pilot: Address;
  text: string;
  verified: boolean;
  time: number | null;
  tx: Hash;
}

export function LettersCard({ client, journal, vault, chainId }: { client: PublicClient; journal: Address | undefined; vault: Address; chainId: number }) {
  const [letters, setLetters] = useState<Letter[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!journal) return;
    let live = true;
    (async () => {
      const [head, start] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), historyStart(client)]);
      const logs = await logsInRange(
        (fromBlock, toBlock) => client.getContractEvents({ address: journal, abi: pilotJournalAbi, eventName: "Letter", args: { vault }, fromBlock, toBlock }),
        start,
        head,
      );
      const newest = [...logs].reverse().slice(0, 10);
      const list = await Promise.all(
        newest.map(async (l) => {
          const a = l.args as { number: bigint; pilot: Address; text: string; textHash: Hash };
          const time = l.blockNumber !== null ? Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp) : null;
          return { number: a.number, pilot: a.pilot, text: a.text, verified: keccak256(toBytes(a.text)) === a.textHash, time, tx: l.transactionHash! };
        }),
      );
      if (live) setLetters(list);
    })().catch(() => live && setLetters([]));
    return () => {
      live = false;
    };
  }, [client, journal, vault]);

  if (!journal || letters === null) return null;
  const shown = showAll ? letters : letters.slice(0, 1);
  return (
    <Card title="Letters from the pilot" aside={<span className="muted small">published onchain, signed by the pilot</span>}>
      {letters.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          No letters yet. The pilot writes to the owner about once a day: what it did, why, and how the vault stands. Only the vault's pilot can
          post here, so every letter is a public statement by the agent that trades.
        </p>
      ) : (
        <>
          {shown.map((l) => (
            <article key={l.number.toString()} className="letter" aria-label={`Letter ${l.number}`}>
              <div className="spread small muted">
                <span>
                  Letter #{l.number.toString()}
                  {l.time !== null && ` · ${new Date(l.time * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}
                </span>
                <span className={`pill ${l.verified ? "ok" : "bad"}`}>{l.verified ? "Text matches onchain hash" : "Hash mismatch"}</span>
              </div>
              <p className="letter-text">{l.text}</p>
              <div className="small muted">
                Signed by the pilot {l.pilot.slice(0, 6)}…{l.pilot.slice(-4)}
                {explorerTx(chainId, l.tx) && (
                  <>
                    {" "}
                    · <a href={explorerTx(chainId, l.tx)} target="_blank" rel="noreferrer">see it onchain</a>
                  </>
                )}
              </div>
            </article>
          ))}
          {letters.length > 1 && (
            <button className="btn small" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show the latest only" : `Show ${letters.length - 1} earlier letter${letters.length === 2 ? "" : "s"}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

// Attack Theater on a live vault: a compromised pilot (and a stranger) try nine attacks, each simulated against the
// real contract on its own chain, from the attacker's own address. The answers are the contract's own reverts.
// Nothing is signed, sent or spent, so anyone can run it, wallet or not.

import { useRef, useState } from "react";
import type { Abi, Address, PublicClient } from "viem";
import type { AssetState } from "../../agent/model";
import { explainRevert, liveAttacks, revertName, type LiveAttack } from "../../agent/theater";
import { FlashLayer, type Flash } from "./Glow";
import { Card } from "./ui";

type Outcome = { attack: LiveAttack; error: string | null };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function AttackTheater(props: { client: PublicClient; abi: Abi; vault: Address; owner: Address; pilot: Address; assets: AssetState[]; chainName: string }) {
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [running, setRunning] = useState(false);
  const [block, setBlock] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const id = useRef(0);

  async function run() {
    setRunning(true);
    setOutcomes([]);
    setError(null);
    try {
      // Every attempt is judged at the same block, so the answers describe one moment of the vault.
      const blockNumber = await props.client.getBlockNumber({ cacheTime: 0 });
      setBlock(blockNumber);
      for (const attack of liveAttacks({ assets: props.assets, pilot: props.pilot })) {
        let outcome: Outcome;
        try {
          await props.client.simulateContract({
            address: props.vault,
            abi: props.abi,
            functionName: attack.functionName,
            args: attack.args as never,
            account: attack.from,
            blockNumber,
          });
          outcome = { attack, error: null };
        } catch (e) {
          const name = revertName(e);
          // A node that is down is not a refusal: say so rather than claim the contract said no.
          if (name === null && !/revert/i.test(String((e as Error).message))) throw e;
          outcome = { attack, error: name ?? "Reverted" };
        }
        setOutcomes((o) => [...o, outcome]);
        if (outcome.error) setFlash({ kind: "blocked", id: id.current++ });
        await pause(450);
      }
    } catch (e) {
      setError(`Could not reach the chain: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      setRunning(false);
    }
  }

  const blocked = outcomes.filter((o) => o.error).length;
  const allowed = outcomes.filter((o) => !o.error);
  return (
    <Card className="fx-host theater" title="Attack Theater" aside={<span className="muted small">against this live contract</span>}>
      <FlashLayer flash={flash} />
      <p className="small" style={{ marginTop: 0 }}>
        Suppose the pilot's key is stolen. Nine attacks, each sent to the real vault on {props.chainName} from the attacker's own address as a
        simulated call: the contract answers exactly as it would a real transaction, but nothing is signed or spent.
      </p>
      {props.owner.toLowerCase() === props.pilot.toLowerCase() && (
        <p className="notice warn small">
          This vault's owner is also its pilot, so here "the pilot" holds the owner's powers and some attacks will go through. A vault with a pilot
          of its own refuses every one.
        </p>
      )}
      <button className="btn primary" onClick={run} disabled={running}>
        {running ? `Attacking… ${outcomes.length} of 9` : outcomes.length ? "Run the attacks again" : "Simulate a compromised pilot"}
      </button>
      {error && <p className="notice bad">{error}</p>}
      {outcomes.length > 0 && (
        <ol className="theater-list" aria-label="Attack results">
          {outcomes.map(({ attack, error: name }) => (
            <li key={attack.name} className={name ? "refused" : "allowed"}>
              <div className="spread">
                <strong>{attack.name}</strong>
                <span className={`pill ${name ? "bad" : "warn"}`}>{name ? "Blocked" : "Allowed"}</span>
              </div>
              <div className="small muted">
                {attack.desc} From {attack.as === "pilot" ? "the pilot's address" : "a stranger's address"} {short(attack.from)}.
              </div>
              {name ? (
                <div className="small">
                  <code>{name}</code> {explainRevert(name)}
                </div>
              ) : (
                <div className="small">The contract would have accepted this call.</div>
              )}
            </li>
          ))}
        </ol>
      )}
      {!running && outcomes.length === 9 && (
        <p className="small" style={{ marginBottom: 0 }} data-testid="theater-summary">
          <strong>
            {blocked} of 9 blocked{allowed.length ? `, ${allowed.length} allowed` : ""}
          </strong>{" "}
          by the vault contract at block {block?.toString()}. These are its own answers, read from the chain.
        </p>
      )}
    </Card>
  );
}

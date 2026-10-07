// Verified Mandate: a soulbound credential that this vault flew one mandate, unchanged, for at least a day, with every
// trade checked against it. The owner starts the clock and later issues it; anyone can see it and check whether the
// vault still flies those rules.

import { useEffect, useState } from "react";
import type { Address, Chain, Hash, PublicClient, WalletClient } from "viem";
import { mandateCredentialAbi, pilotVaultAbi } from "./abi";
import { Card } from "./ui";

interface Meta {
  name: string;
  image: string;
  attributes: { trait_type: string; value: string | number }[];
}

interface Status {
  version: bigint;
  enrolledVersion: bigint;
  enrolledAt: number;
  minAge: number;
  tokenId: bigint;
  meta: Meta | null;
  current: boolean;
}

const fromDataUri = (uri: string) => JSON.parse(atob(uri.slice(uri.indexOf(",") + 1))) as Meta;
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function CredentialCard(props: {
  client: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  credential: Address | undefined;
  vault: Address;
  now: number;
  isOwner: boolean;
  canWrite: boolean;
  send: (label: string, write: () => Promise<Hash>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => () => void;
}) {
  const { client, wallet, chain, credential, vault, now, isOwner, canWrite, send, run } = props;
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    if (!credential) return;
    let live = true;
    (async () => {
      const read = (functionName: string, args: unknown[] = []) =>
        client.readContract({ address: credential, abi: mandateCredentialAbi, functionName, args } as never) as Promise<unknown>;
      const mandateVersion = (await client.readContract({ address: vault, abi: pilotVaultAbi, functionName: "mandateVersion" })) as bigint;
      const [[enrolledVersion, enrolledAt], minAge, tokenId] = (await Promise.all([
        read("enrollments", [vault]),
        read("minAge"),
        read("credentialOf", [vault, mandateVersion]),
      ])) as [[bigint, bigint], bigint, bigint];
      let meta: Meta | null = null;
      let current = false;
      if (tokenId > 0n) {
        const [uri, cur] = (await Promise.all([read("tokenURI", [tokenId]), read("isCurrent", [tokenId])])) as [string, boolean];
        meta = fromDataUri(uri);
        current = cur;
      }
      if (live) setStatus({ version: mandateVersion, enrolledVersion, enrolledAt: Number(enrolledAt), minAge: Number(minAge), tokenId, meta, current });
    })().catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [client, credential, vault]);

  if (!credential || !status) return null;
  const write = (label: string, functionName: "enroll" | "issue") =>
    run(() => send(label, () => wallet.writeContract({ account: wallet.account!, chain, address: credential, abi: mandateCredentialAbi, functionName, args: [vault] })));
  const enrolled = status.enrolledAt > 0 && status.enrolledVersion === status.version;
  const eligibleAt = status.enrolledAt + status.minAge;
  const ready = enrolled && now >= eligibleAt;
  const owns = isOwner && canWrite;

  return (
    <Card title="Verified Mandate" aside={<span className="muted small">soulbound, onchain</span>}>
      {status.meta ? (
        <div className="credential">
          <img src={status.meta.image} alt={`${status.meta.name}: ${status.meta.attributes.map((a) => `${a.trait_type} ${a.value}`).join(", ")}`} />
          <p className="small" style={{ margin: "10px 0 0" }}>
            <span className={`pill ${status.current ? "ok" : "warn"}`}>{status.current ? "Still in force" : "Superseded"}</span>{" "}
            {status.meta.name}: this vault flew mandate version {status.version.toString()} unchanged, with every trade checked against it. Any
            contract or agent can confirm it with <code>isCurrent({status.tokenId.toString()})</code> on {credential.slice(0, 6)}…{credential.slice(-4)}.
          </p>
        </div>
      ) : enrolled ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            The clock is running on mandate version {status.version.toString()} since {when(status.enrolledAt)}.{" "}
            {ready ? "It has stood long enough to be verified." : `It can be verified from ${when(eligibleAt)}, if the rules don't change before then.`}
          </p>
          <progress className="run-progress" max={status.minAge} value={Math.min(status.minAge, Math.max(0, now - status.enrolledAt))} aria-label="Time under this mandate" />
          {owns && (
            <button className="btn primary" disabled={!ready} onClick={write("Issue the Verified Mandate", "issue")}>
              Mint the Verified Mandate
            </button>
          )}
        </>
      ) : (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            A soulbound credential that this vault flew one mandate, unchanged, for at least {Math.round(status.minAge / 3600)} hours, with every trade
            checked against it by the contract. Other protocols and agents can read it, and ask whether the rules still stand.
            {status.enrolledAt > 0 && status.enrolledVersion !== status.version && " The mandate changed since the clock started, so it starts again."}
          </p>
          {owns ? (
            <button className="btn" onClick={write("Start the Verified Mandate clock", "enroll")}>
              Start the clock
            </button>
          ) : (
            <p className="muted small" style={{ marginBottom: 0 }}>
              Not started by the owner yet.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

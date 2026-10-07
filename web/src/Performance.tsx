// A live vault's value over time against its deposits left untraded, both read from the chain at sampled blocks.

import { useEffect, useState } from "react";
import type { Abi, Address, PublicClient } from "viem";
import type { AssetState } from "../../agent/model";
import { vaultPerformance, type PerformancePoint } from "../../agent/performance";
import { LineChart, compactUsd } from "./LineChart";
import { Card, usd } from "./ui";
import { historyStart } from "./rpc";

const toNum = (wad: bigint) => Number(wad / 10n ** 12n) / 1e6;
const signed = (wad: bigint) => (wad < 0n ? `−${usd(-wad)}` : `+${usd(wad)}`);
const tone = (wad: bigint) => (wad < 0n ? "down" : wad > 0n ? "up" : "");

export function PerformanceCard({ client, vault, abi, assets }: { client: PublicClient; vault: Address; abi: Abi; assets: AssetState[] }) {
  const [points, setPoints] = useState<PerformancePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const start = await historyStart(client);
      const decimals = new Map(assets.map((a) => [a.token.toLowerCase(), a.decimals]));
      const p = await vaultPerformance(client, abi, vault, decimals, 30, start);
      if (live) setPoints(p);
    })().catch((e) => live && setError((e as Error).message.split("\n")[0]));
    return () => {
      live = false;
    };
    // Re-read when the vault panel reloads (it remounts after every transaction).
  }, [client, vault, abi, assets]);

  if (error) return null; // an RPC without historical state: nothing honest to show
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const gain = last.valueUsd - last.netDepositedUsd;
  const added = last.valueUsd - last.untradedUsd;
  const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <Card title="Performance" aside={<span className="muted small">read from the chain</span>}>
      <div className="stats">
        <div className="stat">
          <div className="label">Value now</div>
          <div className="value">{usd(last.valueUsd)}</div>
        </div>
        <div className="stat">
          <div className="label">Put in, net</div>
          <div className="value">{usd(last.netDepositedUsd)}</div>
        </div>
        <div className="stat">
          <div className="label">Gain</div>
          <div className={`value ${tone(gain)}`}>{signed(gain)}</div>
        </div>
        <div className="stat">
          <div className="label">Pilot vs untraded</div>
          <div className={`value ${tone(added)}`}>{signed(added)}</div>
        </div>
      </div>
      <LineChart
        title="The vault against your deposits, never traded"
        series={[
          { name: "Vault", values: points.map((p) => toNum(p.valueUsd)) },
          { name: "Untraded", values: points.map((p) => toNum(p.untradedUsd)) },
        ]}
        xLabel={(i) => day(points[i].time)}
        format={compactUsd}
        height={220}
      />
      <p className="muted small" style={{ marginBottom: 0 }}>
        "Untraded" holds exactly what you deposited and withdrew, token for token, with no trades and no fee, at the same oracle prices. The gap is
        what the pilot and its fee added or cost; money moving in or out does not distort it.
      </p>
    </Card>
  );
}

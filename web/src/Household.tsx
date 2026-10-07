// All of an owner's vaults, one per goal, side by side and added up: the household's total, how much of it is in
// stocks, the combined allocation, and each vault's goal and safeguards at a glance.

import { useEffect, useState } from "react";
import type { Abi, Address, PublicClient } from "viem";
import { readHousehold, type Household } from "../../agent/household";
import { LISTINGS } from "../../agent/listings";
import { Card, usd } from "./ui";

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Colour follows the asset, in the listing's fixed order: never its rank, so a filter or a new vault never repaints one. */
const slotOf = (symbol: string) => {
  const i = LISTINGS.findIndex((l) => l.symbol === symbol);
  return i >= 0 && i < 5 ? `var(--series-${i + 1})` : "var(--muted)";
};
const orderOf = (symbol: string) => {
  const i = LISTINGS.findIndex((l) => l.symbol === symbol);
  return i < 0 ? LISTINGS.length : i;
};

/** Goal names are this browser's own labels for the owner's vaults; nothing is stored onchain or shared. */
const goalKey = (chainId: number, vault: Address) => `stockpilot.goal.${chainId}.${vault.toLowerCase()}`;
function readGoal(chainId: number, vault: Address) {
  try {
    return localStorage.getItem(goalKey(chainId, vault)) ?? "";
  } catch {
    return "";
  }
}
function writeGoal(chainId: number, vault: Address, name: string) {
  try {
    if (name.trim()) localStorage.setItem(goalKey(chainId, vault), name.trim().slice(0, 40));
    else localStorage.removeItem(goalKey(chainId, vault));
  } catch {
    // storage unavailable: the name lasts for this page only
  }
}

export function HouseholdCard(props: { client: PublicClient; abi: Abi; chainId: number; vaults: Address[]; me: Address; selected: Address | null; onOpen: (v: Address) => void; refresh: number }) {
  const { client, abi, chainId, vaults, me, selected, onOpen, refresh } = props;
  const [h, setH] = useState<Household | null>(null);
  const [goals, setGoals] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Address | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readHousehold(client, abi, vaults, me)
      .then((r) => live && setH(r))
      .catch(() => live && setH(null));
    setGoals(Object.fromEntries(vaults.map((v) => [v.toLowerCase(), readGoal(chainId, v)])));
    return () => {
      live = false;
    };
  }, [client, abi, chainId, vaults.join(), me, refresh]);

  if (!h) return null;
  const segments = [...h.allocation].filter((a) => a.valueUsd > 0n).sort((a, b) => orderOf(a.symbol) - orderOf(b.symbol));
  const mine = h.vaults.filter((v) => v.stillYours).length;
  const hovered = segments.find((s) => s.symbol === hover);

  return (
    <Card title="Household" aside={<span className="muted small">all your vaults</span>}>
      <div className="stats">
        <div className="stat">
          <div className="label">Total, {mine} vault{mine === 1 ? "" : "s"}</div>
          <div className="value">{usd(h.totalUsd)}</div>
        </div>
        <div className="stat">
          <div className="label">In stocks</div>
          <div className="value">{pct(h.stocksBps)}</div>
        </div>
      </div>

      {segments.length > 0 && (
        <figure className="household-alloc" aria-label="Combined allocation">
          <figcaption className="small muted">Combined allocation</figcaption>
          <div className="alloc-bar" role="img" aria-label={segments.map((s) => `${s.symbol} ${pct(s.bps)}`).join(", ")} onMouseLeave={() => setHover(null)}>
            {segments.map((s) => (
              <div
                key={s.symbol}
                className={`alloc-seg ${hover && hover !== s.symbol ? "dim" : ""}`}
                style={{ flexGrow: Math.max(s.bps, 1), background: slotOf(s.symbol) }}
                onMouseEnter={() => setHover(s.symbol)}
              />
            ))}
          </div>
          <div className="alloc-tip small" aria-live="polite">
            {hovered ? (
              <>
                <strong>{hovered.symbol}</strong> {usd(hovered.valueUsd)} · {pct(hovered.bps)}
              </>
            ) : (
              <span className="muted">Hover a segment for its value.</span>
            )}
          </div>
          <table className="holdings alloc-table">
            <tbody>
              {segments.map((s) => (
                <tr key={s.symbol} onMouseEnter={() => setHover(s.symbol)} onMouseLeave={() => setHover(null)}>
                  <td>
                    <span className="alloc-swatch" style={{ background: slotOf(s.symbol) }} /> {s.symbol}
                  </td>
                  <td className="num">{usd(s.valueUsd)}</td>
                  <td className="num">{pct(s.bps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}

      <table className="holdings household-vaults" aria-label="Your vaults">
        <tbody>
          {h.vaults.map((v) => {
            const key = v.vault.toLowerCase();
            const name = goals[key] || shortAddr(v.vault);
            return (
              <tr key={v.vault} className={v.stillYours ? "" : "muted"}>
                <td>
                  {editing === v.vault ? (
                    <input
                      autoFocus
                      aria-label="Goal name"
                      defaultValue={goals[key]}
                      placeholder="e.g. Retirement 2050"
                      maxLength={40}
                      onBlur={(e) => {
                        writeGoal(chainId, v.vault, e.target.value);
                        setGoals((g) => ({ ...g, [key]: e.target.value.trim() }));
                        setEditing(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <button className={`goal-name ${goals[key] ? "" : "mono"}`} title="Name this goal" onClick={() => setEditing(v.vault)}>
                      {name}
                    </button>
                  )}
                  <div className="pills">
                    {!v.stillYours && <span className="small">handed on to {shortAddr(v.owner)}</span>}
                    {v.paused && <span className="pill warn">Paused</span>}
                    {v.glide && <span className="pill info">{v.glide.progress >= 1 ? "Glide done" : `Glide ${Math.round(v.glide.progress * 100)}%`}</span>}
                    {v.guard === "defensive" && <span className="pill warn">Defensive</span>}
                    {v.guard === "armed" && <span className="pill ok">Guard</span>}
                    {v.heir && <span className="pill ok">Heir</span>}
                  </div>
                </td>
                <td className="num">
                  {usd(v.totalUsd)}
                  <div className="small muted">{pct(v.stocksBps)} stocks</div>
                </td>
                <td className="num">
                  <button
                    className={`btn small ${v.vault === selected ? "primary" : ""}`}
                    aria-label={`${v.vault === selected ? "Viewing" : "Open"} ${name}`}
                    onClick={() => onOpen(v.vault)}
                    disabled={v.vault === selected}
                  >
                    {v.vault === selected ? "Viewing" : "Open"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small" style={{ marginBottom: 0 }}>
        One vault per goal, each with its own mandate, pilot and safeguards. Goal names are kept in this browser only. Totals count the vaults you
        still own.
      </p>
    </Card>
  );
}

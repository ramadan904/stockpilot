// Tax-aware rebalancing, the way the better robo-advisors do it, inside the same mandate. The vault matches lots first
// in, first out, so what a sale realizes is knowable before it happens: which lots go, at what gain, short or long
// term. The planner uses that to choose among the trades the mandate allows:
//
// - of the overweight assets worth selling, sell the one whose sale costs the least tax per dollar (a loss is a
//   benefit; cash and long-term gains are cheap; short-term gains are dear);
// - prefer not to buy back an asset within 30 days of selling it at a loss, and don't count on a loss when the same
//   asset was bought in the last 30 days (a wash sale defers the loss into the new lot's basis: no saving now);
// - when the only sale on offer realizes short-term gains on lots that turn long term within a few weeks, wait.
//
// None of this ever overrides the mandate: an asset outside its band is always traded back, whatever the tax.
// Estimates only, at rates the owner sets; not tax advice. Wash-sale rules are applied as if tokenized stocks were the
// stocks themselves, which is the conservative reading.

import { getAddress, isAddress, verifyMessage, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod/v4";
import { LISTINGS } from "./listings";
import { BPS, WAD, valueOf, type VaultState } from "./model";
import { LotBook, YEAR_SECONDS, readTaxEvents, take, yearOf, type AssetInfo, type Lot, type Sale } from "./tax";

export const WASH_SALE_SECONDS = 30 * 86_400;

export interface TaxPolicy {
  /** Open lots, oldest first per token (a `LotBook`'s, or `taxReport().open`). */
  lots: Lot[];
  /** When each token (lower-case address) was last sold at a loss. */
  lastLossSale: Map<string, number>;
  /** Tokens (lower-case) that are cash: selling them realizes nothing. */
  cash: Set<string>;
  shortTermRateBps: number;
  longTermRateBps: number;
  /** Wait up to this many days for short-term lots to turn long term, while nothing is outside its band. 0: never. */
  deferDays: number;
  /**
   * Net gains the owner is willing to realize this calendar year (USD, 18 decimals). Past it, the pilot only sells to
   * bring an asset back inside its band. Undefined: no budget.
   */
  gainBudgetUsd?: bigint;
  /** Net gains realized so far this calendar year (a `LotBook`'s `gainsIn(year)`). */
  realizedThisYearUsd?: bigint;
}

/**
 * Illustrative US federal rates for a high earner; the owner sets their own. Waiting for lots to turn long term is
 * off by default: in the backtest it saves little and lets drift run further before rebalancing.
 */
export const DEFAULT_TAX = { shortTermRateBps: 3_500, longTermRateBps: 1_500, deferDays: 0 };

export interface SaleEstimate {
  shortGainUsd: bigint;
  longGainUsd: bigint;
  /** Estimated tax (negative: a loss that saves tax). A loss inside a wash-sale window saves nothing now. */
  taxUsd: bigint;
  /** A loss that would be disallowed as a wash sale (the asset was bought in the last 30 days). */
  washSale: boolean;
  /** If waiting would turn every short-term gain in this sale long term: the days to wait. */
  longTermInDays: number | null;
}

const lower = (a: string) => a.toLowerCase();

/** What selling `amount` of `token` now would realize, lot by lot, without changing the lots. */
export function estimateSale(policy: TaxPolicy, token: Address, amount: bigint, price: bigint, decimals: number, now: number): SaleEstimate {
  const none = { shortGainUsd: 0n, longGainUsd: 0n, taxUsd: 0n, washSale: false, longTermInDays: null };
  if (policy.cash.has(lower(token)) || amount === 0n) return none;
  const lots = policy.lots.filter((l) => lower(l.token) === lower(token)).map((l) => ({ ...l }));
  const { pieces, short } = take(lots, amount);
  // Units the history doesn't explain have no basis, as in the tax report.
  if (short > 0n) pieces.push({ token, amount: short, basisUsd: 0n, acquired: now, basisKnown: false });
  let shortGain = 0n;
  let longGain = 0n;
  let wait = 0;
  for (const p of pieces) {
    const gain = valueOf(p.amount, price, decimals) - p.basisUsd;
    if (now - p.acquired > YEAR_SECONDS) longGain += gain;
    else {
      shortGain += gain;
      if (gain > 0n) wait = Math.max(wait, Math.ceil((p.acquired + YEAR_SECONDS + 1 - now) / 86_400));
    }
  }
  const boughtRecently = policy.lots.some((l) => lower(l.token) === lower(token) && now - l.acquired < WASH_SALE_SECONDS);
  const washSale = shortGain + longGain < 0n && boughtRecently;
  const tax = washSale ? 0n : netTax(shortGain, longGain, policy);
  return { shortGainUsd: shortGain, longGainUsd: longGain, taxUsd: tax, washSale, longTermInDays: shortGain > 0n ? wait : null };
}

/** Tax on one sale's gains, short and long netted against each other first (a net loss is a saving at the same rates). */
function netTax(shortGain: bigint, longGain: bigint, r: Pick<TaxPolicy, "shortTermRateBps" | "longTermRateBps">) {
  let s = shortGain;
  let l = longGain;
  if (s < 0n && l > 0n) [l, s] = [l + s, 0n];
  if (l < 0n && s > 0n) [s, l] = [s + l, 0n];
  return (s * BigInt(r.shortTermRateBps) + l * BigInt(r.longTermRateBps)) / BPS;
}

/** Inside the wash-sale window of a loss on this token: buying it now would disallow that loss. */
export function inWashWindow(policy: TaxPolicy, token: Address, now: number) {
  const t = policy.lastLossSale.get(lower(token));
  return t !== undefined && now - t < WASH_SALE_SECONDS;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tax due on a history

export interface TaxDue {
  /** Tax due year by year: short and long netted within the year, net losses carried forward. */
  taxUsd: bigint;
  shortGainUsd: bigint;
  longGainUsd: bigint;
  /** Net losses left over to carry forward. */
  carryUsd: bigint;
}

/**
 * Tax on realized sales, year by year. Short-term and long-term gains net within a year; a net loss carries forward
 * (the $3,000 a year against ordinary income is left out, which only understates the benefit of losses).
 */
export function taxDue(sales: Sale[], r: Pick<TaxPolicy, "shortTermRateBps" | "longTermRateBps">): TaxDue {
  const years = new Map<number, { s: bigint; l: bigint }>();
  let shortGain = 0n;
  let longGain = 0n;
  for (const x of sales) {
    const y = years.get(yearOf(x.sold)) ?? { s: 0n, l: 0n };
    if (x.term === "long") (y.l += x.gainUsd), (longGain += x.gainUsd);
    else (y.s += x.gainUsd), (shortGain += x.gainUsd);
    years.set(yearOf(x.sold), y);
  }
  let carryS = 0n;
  let carryL = 0n;
  let tax = 0n;
  for (const year of [...years.keys()].sort((a, b) => a - b)) {
    const y = years.get(year)!;
    let s = y.s + carryS;
    let l = y.l + carryL;
    if (s < 0n && l > 0n) [l, s] = [l + s, 0n];
    else if (l < 0n && s > 0n) [s, l] = [s + l, 0n];
    tax += ((s > 0n ? s : 0n) * BigInt(r.shortTermRateBps) + (l > 0n ? l : 0n) * BigInt(r.longTermRateBps)) / BPS;
    carryS = s < 0n ? s : 0n;
    carryL = l < 0n ? l : 0n;
  }
  return { taxUsd: tax, shortGainUsd: shortGain, longGainUsd: longGain, carryUsd: -(carryS + carryL) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The owner's preferences, signed like alert subscriptions: only the vault's current owner can change how the pilot
// treats taxes on it. They steer the pilot, inside the mandate; the vault itself does not know about them.

export const TaxPreferences = z.object({
  kind: z.literal("tax-preferences"),
  vault: z.string().refine((v) => isAddress(v), "not an address"),
  chainId: z.number().int().positive(),
  enabled: z.boolean(),
  shortTermRateBps: z.number().int().min(0).max(10_000),
  longTermRateBps: z.number().int().min(0).max(10_000),
  /** Whole dollars of net gains a calendar year; null: no budget. */
  gainBudgetUsd: z.number().int().min(0).max(1e12).nullable(),
  deferDays: z.number().int().min(0).max(60),
  /** Unix seconds; newer preferences for the same vault replace older ones. */
  issuedAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
export type TaxPreferences = z.infer<typeof TaxPreferences>;
export type UnsignedTaxPreferences = Omit<TaxPreferences, "signature">;

/** The exact text the owner signs, readable in the wallet prompt. */
export function taxPreferencesMessage(p: UnsignedTaxPreferences) {
  return [
    "StockPilot tax preferences",
    `Vault: ${getAddress(p.vault)}`,
    `Chain: ${p.chainId}`,
    `Tax-aware pilot: ${p.enabled ? "on" : "off"}`,
    `Short-term rate: ${p.shortTermRateBps / 100}%`,
    `Long-term rate: ${p.longTermRateBps / 100}%`,
    `Yearly gains budget: ${p.gainBudgetUsd === null ? "none" : `$${p.gainBudgetUsd.toLocaleString("en-US")}`}`,
    `Wait for long term: ${p.deferDays === 0 ? "no" : `up to ${p.deferDays} days`}`,
    `Issued: ${p.issuedAt}`,
  ].join("\n");
}

export async function verifyTaxPreferences(raw: unknown, readOwner: (vault: Address) => Promise<Address>): Promise<{ ok: true; prefs: TaxPreferences } | { ok: false; why: string }> {
  const parsed = TaxPreferences.safeParse(raw);
  if (!parsed.success) return { ok: false, why: "malformed tax preferences" };
  const { signature, ...unsigned } = parsed.data;
  const owner = await readOwner(getAddress(unsigned.vault));
  const valid = await verifyMessage({ address: owner, message: taxPreferencesMessage(unsigned), signature: signature as Hex }).catch(() => false);
  return valid ? { ok: true, prefs: parsed.data } : { ok: false, why: "not signed by the vault's owner" };
}

/** The newest valid preferences per vault, from a store that may hold other signed documents too. */
export async function activeTaxPreferences(raw: unknown[], readOwner: (vault: Address) => Promise<Address>): Promise<Map<string, TaxPreferences>> {
  const out = new Map<string, TaxPreferences>();
  for (const r of raw) {
    if ((r as { kind?: unknown } | null)?.kind !== "tax-preferences") continue;
    const v = await verifyTaxPreferences(r, readOwner).catch(() => ({ ok: false as const, why: "error" }));
    if (!v.ok) continue;
    const k = v.prefs.vault.toLowerCase();
    if (!out.has(k) || out.get(k)!.issuedAt < v.prefs.issuedAt) out.set(k, v.prefs);
  }
  return out;
}

/** Stablecoins are cash. */
export const isCash = (symbol: string) => LISTINGS.some((l) => l.symbol === symbol && "stable" in l);

/** A vault's tax policy now: its lots from the chain, its gains so far this year, and the owner's preferences. */
export async function taxPolicyFor(
  client: Pick<PublicClient, "getLogs" | "getBlock" | "readContract">,
  vaultAbi: Abi,
  state: VaultState,
  prefs: Pick<TaxPreferences, "shortTermRateBps" | "longTermRateBps" | "gainBudgetUsd" | "deferDays">,
): Promise<TaxPolicy> {
  const info = new Map<string, AssetInfo>(state.assets.map((a) => [a.token.toLowerCase(), { symbol: a.symbol, decimals: a.decimals, cash: isCash(a.symbol) }]));
  const book = new LotBook(info);
  for (const e of await readTaxEvents(client, vaultAbi, state.address)) book.apply(e);
  return {
    lots: book.open(),
    lastLossSale: book.lastLossSale,
    cash: new Set(state.assets.filter((a) => isCash(a.symbol)).map((a) => a.token.toLowerCase())),
    shortTermRateBps: prefs.shortTermRateBps,
    longTermRateBps: prefs.longTermRateBps,
    deferDays: prefs.deferDays,
    gainBudgetUsd: prefs.gainBudgetUsd === null ? undefined : BigInt(prefs.gainBudgetUsd) * WAD,
    realizedThisYearUsd: book.gainsIn(yearOf(Number(state.now))),
  };
}

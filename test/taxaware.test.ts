import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { handleSubscribe } from "../agent/api";
import { rationaleHash, readVault } from "../agent/chain";
import { fleetTick, type FleetConfig } from "../agent/fleet";
import { backtest, modelsFor, taxBacktest } from "../agent/backtest";
import { LISTINGS } from "../agent/listings";
import { presetFor, toMandate } from "../agent/mandate";
import { WAD, type VaultState } from "../agent/model";
import { plan } from "../agent/planner";
import { YEAR_SECONDS, type Lot, type Sale } from "../agent/tax";
import { activeTaxPreferences, estimateSale, taxDue, taxPolicyFor, taxPreferencesMessage, verifyTaxPreferences, type TaxPolicy, type TaxPreferences, type UnsignedTaxPreferences } from "../agent/taxaware";
import { deployStockPilot, px } from "./fixture";

const DAY = 86_400;
const NOW = 1_800_000_000;
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const tok = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [USDG, AAA, BBB, CCC] = [tok(1), tok(2), tok(3), tok(4)];

const lot = (token: Address, units: number, basis: number, daysAgo: number): Lot => ({ token, amount: BigInt(units) * WAD, basisUsd: usd(basis), acquired: NOW - daysAgo * DAY, basisKnown: true });

function policy(lots: Lot[], extra: Partial<TaxPolicy> = {}): TaxPolicy {
  return { lots, lastLossSale: new Map(), cash: new Set([USDG.toLowerCase()]), shortTermRateBps: 3_500, longTermRateBps: 1_500, deferDays: 0, ...extra };
}

/** Four assets at 25% each with a 10% band; values in dollars. AAA $100, BBB $50, CCC $10, USDG $1. */
function vault(values: { AAA: number; BBB: number; CCC: number; USDG: number }): VaultState {
  const asset = (token: Address, symbol: string, price: number, value: number, decimals: number) => ({
    token,
    symbol,
    decimals,
    balance: (BigInt(Math.round(value * 1e6)) * 10n ** BigInt(decimals)) / BigInt(Math.round(price * 1e6)),
    price: usd(price),
    priceUpdatedAt: BigInt(NOW),
    targetBps: 2_500,
    bandBps: 1_000,
  });
  return {
    address: tok(99),
    assets: [asset(USDG, "USDG", 1, values.USDG, 6), asset(AAA, "AAA", 100, values.AAA, 18), asset(BBB, "BBB", 50, values.BBB, 18), asset(CCC, "CCC", 10, values.CCC, 18)],
    limits: { maxTradeUsd: usd(5_000), dailyLimitUsd: usd(20_000), maxSlippageBps: 100, maxPriceAge: 3_600, cooldown: 60 },
    lastTradeAt: 0n,
    budgetUsd: usd(20_000),
    budgetUpdatedAt: BigInt(NOW),
    paused: false,
    now: BigInt(NOW),
  };
}

const sale = (year: number, term: "short" | "long", gain: number): Sale => ({
  token: AAA,
  symbol: "AAA",
  amount: WAD,
  acquired: 0,
  sold: Date.UTC(year, 5, 1) / 1000,
  proceedsUsd: usd(Math.max(gain, 0)),
  basisUsd: usd(Math.max(-gain, 0)),
  gainUsd: usd(gain),
  term,
  via: "trade",
  basisKnown: true,
  tx: "0x",
});

describe("agent/taxaware", () => {
  it("estimates a sale lot by lot, first in first out, netting short against long", () => {
    // 10 AAA held 400 days (basis $500) and 10 held 100 days (basis $1,500); sell 15 at $100.
    const p = policy([lot(AAA, 10, 500, 400), lot(AAA, 10, 1_500, 100)]);
    const e = estimateSale(p, AAA, 15n * WAD, usd(100), 18, NOW);
    expect(e.longGainUsd).to.equal(usd(500));
    expect(e.shortGainUsd).to.equal(usd(-250));
    expect(e.taxUsd).to.equal(usd(37.5)); // ($500 - $250) at 15%
    expect(e.longTermInDays).to.equal(null);
    expect(p.lots[1].amount).to.equal(10n * WAD); // the policy's lots are untouched

    // At $200 the short-term piece gains too, and turns long term in 266 days.
    const g = estimateSale(p, AAA, 12n * WAD, usd(200), 18, NOW);
    expect(g.shortGainUsd).to.equal(usd(100));
    expect(g.longTermInDays).to.equal(266);
    expect(YEAR_SECONDS).to.equal(365 * DAY);
  });

  it("counts a loss within 30 days of buying as nothing (wash sale), and cash as no gain at all", () => {
    const p = policy([lot(BBB, 10, 1_000, 10)]);
    const e = estimateSale(p, BBB, 10n * WAD, usd(50), 18, NOW);
    expect(e.shortGainUsd).to.equal(usd(-500));
    expect(e.washSale).to.equal(true);
    expect(e.taxUsd).to.equal(0n);
    expect(estimateSale(p, USDG, 1_000_000n, usd(1), 6, NOW).taxUsd).to.equal(0n);
  });

  it("nets gains within each year and carries net losses forward", () => {
    const t = taxDue([sale(2024, "short", 1_000), sale(2024, "long", -400), sale(2025, "short", -2_000), sale(2025, "long", 500), sale(2026, "long", 1_000)], {
      shortTermRateBps: 3_500,
      longTermRateBps: 1_500,
    });
    expect(t.taxUsd).to.equal(usd(210)); // 2024: $600 short at 35%; 2025: a $1,500 loss; 2026: $1,000 long, all offset
    expect(t.carryUsd).to.equal(usd(500));
  });
});

describe("tax-aware planning", () => {
  // AAA and BBB are both overweight, inside their bands; CCC and USDG are underweight.
  const drifted = vault({ AAA: 3_100, BBB: 3_050, CCC: 1_900, USDG: 1_950 });
  // AAA has a large short-term gain; BBB sits at a loss.
  const lots = [lot(AAA, 31, 2_000, 180), lot(BBB, 61, 4_000, 200), lot(CCC, 190, 1_900, 200)];

  it("without a tax policy, plans exactly as before: the most overweight asset", () => {
    const p = plan(drifted);
    expect(p.action === "trade" && p.trade.tokenIn).to.equal(AAA);
  });

  it("sells the overweight asset that costs the least tax, and says what the sale realizes", () => {
    const p = plan(drifted, undefined, policy(lots));
    expect(p.action).to.equal("trade");
    if (p.action !== "trade") return;
    expect(p.trade.tokenIn).to.equal(BBB);
    expect(p.trade.tokenOut).to.equal(CCC);
    expect(p.trade.rationale).to.match(/Tax-aware: selling BBB rather than AAA\. Realizes a short-term loss of \$[\d,.]+: about \$[\d,.]+ of tax saved/);
  });

  it("a band always wins: an asset outside its band is sold whatever the tax", () => {
    const p = plan(vault({ AAA: 3_600, BBB: 3_000, CCC: 1_700, USDG: 1_700 }), undefined, policy(lots));
    expect(p.action === "trade" && p.trade.tokenIn).to.equal(AAA);
  });

  it("holds within the owner's yearly gains budget, until a band forces the sale", () => {
    const gains = [lot(AAA, 31, 2_000, 180), lot(BBB, 61, 2_500, 200)];
    const held = plan(drifted, undefined, policy(gains, { gainBudgetUsd: usd(100), realizedThisYearUsd: usd(50) }));
    expect(held.action).to.equal("hold");
    expect(held.action === "hold" && held.reason).to.match(/against your \$100\.00 budget/);
    // Room in the budget: it trades.
    expect(plan(drifted, undefined, policy(gains, { gainBudgetUsd: usd(10_000) })).action).to.equal("trade");
    // Out of band: it trades even with no budget left.
    const forced = plan(vault({ AAA: 3_600, BBB: 3_000, CCC: 1_700, USDG: 1_700 }), undefined, policy(gains, { gainBudgetUsd: 0n }));
    expect(forced.action === "trade" && forced.trade.tokenIn).to.equal(AAA);
  });

  it("buys a clean asset rather than one sold at a loss in the last 30 days", () => {
    const p = plan(drifted, undefined, policy(lots, { lastLossSale: new Map([[CCC.toLowerCase(), NOW - 10 * DAY]]) }));
    expect(p.action === "trade" && p.trade.tokenOut).to.equal(USDG);
  });

  it("can wait for short-term lots to turn long term, but only well inside the bands", () => {
    const soon = [lot(AAA, 31, 2_000, 350), lot(BBB, 61, 2_500, 350)];
    const p = plan(vault({ AAA: 3_050, BBB: 3_000, CCC: 2_000, USDG: 1_950 }), undefined, policy(soon, { deferDays: 30 }));
    expect(p.action === "hold" && p.reason).to.match(/^Waiting 16 days: selling BBB now would realize .* short-term gains/);
    // Near a band edge (AAA 8% over, against a 10% band): no waiting.
    expect(plan(vault({ AAA: 3_300, BBB: 2_900, CCC: 1_900, USDG: 1_900 }), undefined, policy(soon, { deferDays: 30 })).action).to.equal("trade");
  });
});

describe("tax-aware backtest", () => {
  const universe = LISTINGS.map((l) => ({ ...l, token: "0x0000000000000000000000000000000000000001" as const, feed: "0x0000000000000000000000000000000000000002" as const, stable: "stable" in l }));
  const { mandate } = toMandate(presetFor("balanced", universe), universe, 10_000);
  const o = { assets: modelsFor(LISTINGS), mandate, startUsd: 10_000, days: 252 * 2, paths: 24, seed: 11, venueFeeBps: 10, feeBps: 50 };

  it("tracking lots changes nothing about the plain pilot", () => {
    const r = taxBacktest(o, { shortTermRateBps: 3_500, longTermRateBps: 1_500, deferDays: 0 });
    expect(r.plain.tradesPerYear).to.equal(backtest(o).tradesPerYear);
  });

  it("with no gains budget left, pays less tax along the way, inside the same mandate", () => {
    const r = taxBacktest(o, { shortTermRateBps: 3_500, longTermRateBps: 1_500, deferDays: 0, gainBudgetUsd: 0 });
    expect(r.rejected).to.equal(0);
    expect(r.aware.taxAlongTheWayUsd).to.be.lessThan(r.plain.taxAlongTheWayUsd * 0.8);
    expect(r.savedPathsPct).to.be.greaterThan(r.costlierPathsPct);
    expect(r.aware.tradesPerYear).to.be.lessThan(r.plain.tradesPerYear);
    // It lets drift run further, but trades back at the band: never far past it.
    const band = Math.max(...mandate.assets.map((a) => a.bandBps));
    expect(r.aware.maxDriftBpsP95).to.be.greaterThan(r.plain.maxDriftBpsP95);
    expect(r.aware.maxDriftBpsP95).to.be.at.most(band * 1.1);
  });
});

describe("owner-signed tax preferences", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const VAULT = "0x1111111111111111111111111111111111111111" as Address;
  const readOwner = async () => owner.address;
  const sign = async (by: typeof owner, p: Partial<UnsignedTaxPreferences> = {}): Promise<TaxPreferences> => {
    const unsigned: UnsignedTaxPreferences = { kind: "tax-preferences", vault: VAULT, chainId: 46630, enabled: true, shortTermRateBps: 3_500, longTermRateBps: 1_500, gainBudgetUsd: 2_000, deferDays: 0, issuedAt: 1_800_000_000, ...p };
    return { ...unsigned, signature: await by.signMessage({ message: taxPreferencesMessage(unsigned) }) };
  };

  it("accepts only the owner's, unedited, in a message the wallet shows in plain words", async () => {
    const p = await sign(owner);
    expect(taxPreferencesMessage(p)).to.include("Tax-aware pilot: on").and.include("Yearly gains budget: $2,000").and.include("Wait for long term: no");
    expect((await verifyTaxPreferences(p, readOwner)).ok).to.equal(true);
    expect(await verifyTaxPreferences(await sign(stranger), readOwner)).to.deep.equal({ ok: false, why: "not signed by the vault's owner" });
    expect((await verifyTaxPreferences({ ...p, gainBudgetUsd: null }, readOwner)).ok).to.equal(false);
    expect((await verifyTaxPreferences({ ...p, shortTermRateBps: 20_000 }, readOwner)).ok).to.equal(false);
  });

  it("keeps the newest per vault from a store shared with alert subscriptions, and takes them at /api/subscribe", async () => {
    const older = await sign(owner, { issuedAt: 1_800_000_000 });
    const newer = await sign(owner, { issuedAt: 1_800_000_100, enabled: false });
    const active = await activeTaxPreferences([newer, { vault: VAULT, email: "me@example.com" }, older, await sign(stranger, { issuedAt: 1_900_000_000 })], readOwner);
    expect(active.get(VAULT.toLowerCase())?.enabled).to.equal(false);
    const reader = () => readOwner;
    expect((await handleSubscribe(older, reader)).json).to.deep.equal({ verified: true, forwarded: false });
    expect((await handleSubscribe(await sign(stranger), reader)).json).to.deep.equal({ error: "Tax preferences rejected: not signed by the vault's owner." });
  });
});

describe("the fleet, tax-aware on a real vault", () => {
  async function drifted() {
    const f = await deployStockPilot();
    await f.nvdaFeed.write.setPrice([px(150)]); // NVDA +20%: 3.6 points over target, inside its 5-point band
    const cfg = (extra: Partial<FleetConfig> = {}): FleetConfig => ({
      client: f.publicClient as never,
      wallet: f.pilot as never,
      vaultAbi: f.vault.abi,
      factoryAbi: f.factory.abi,
      factory: f.factory.address,
      ...extra,
    });
    const prefs = (p: Partial<TaxPreferences>) => () =>
      new Map([[f.vault.address.toLowerCase(), { kind: "tax-preferences", vault: f.vault.address, chainId: 31337, enabled: true, shortTermRateBps: 3_500, longTermRateBps: 1_500, gainBudgetUsd: 0, deferDays: 0, issuedAt: 1, signature: "0x00", ...p } as TaxPreferences]]);
    return { ...f, cfg, prefs };
  }

  it("reads the vault's lots and this year's gains from the chain", async () => {
    const f = await loadFixture(drifted);
    const state = await readVault(f.publicClient, f.vault.abi, f.vault.address);
    const policy = await taxPolicyFor(f.publicClient, f.vault.abi, state, { shortTermRateBps: 3_500, longTermRateBps: 1_500, gainBudgetUsd: 0, deferDays: 0 });
    expect(policy.lots.map((l) => l.basisUsd)).to.deep.equal([usd(2_500), usd(2_500), usd(2_500)]); // three stocks; USDG is cash
    expect(policy.realizedThisYearUsd).to.equal(0n);
    expect(policy.gainBudgetUsd).to.equal(0n);
  });

  it("holds a gain-realizing rebalance past the owner's budget, trades with room in it or with preferences off", async () => {
    const f = await loadFixture(drifted);
    const [held] = await fleetTick(f.cfg({ taxPreferences: f.prefs({}) }));
    expect(held.kind === "hold" && held.reason).to.match(/would realize \$[\d,.]+ of gains.*against your \$0\.00 budget/);
    const [off] = await fleetTick(f.cfg({ taxPreferences: f.prefs({ enabled: false }) }));
    expect(off.kind).to.equal("trade");
  });

  it("with room in the budget, the trade says what it realizes, and the hash of that goes onchain", async () => {
    const f = await loadFixture(drifted);
    const [t] = await fleetTick(f.cfg({ taxPreferences: f.prefs({ gainBudgetUsd: 10_000 }) }));
    expect(t.kind === "trade" && t.rationale).to.match(/Realizes \$[\d,.]+ short-term gain: about \$[\d,.]+ of tax at 35%\/15%\./);
    const [event] = await f.vault.getEvents.Rebalanced({}, { fromBlock: 0n });
    expect(event.args.rationale).to.equal(t.kind === "trade" && rationaleHash(t.rationale));
  });
});

import { expect } from "chai";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { zeroAddress, type Address } from "viem";
import { activeSubscriptions, checkInReminder, deliverDigest, digestDue, digestText, routedNotifier, sendEmail, subscriptionMessage, verifySubscription, type Subscription, type UnsignedSubscription } from "../agent/alerts";
import { handleSubscribe } from "../agent/api";
import { basicReport } from "../agent/report";

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const readOwner = async (v: Address) => (v.toLowerCase() === VAULT.toLowerCase() ? owner.address : stranger.address);

async function sign(by: typeof owner, s: Partial<UnsignedSubscription> = {}): Promise<Subscription> {
  const unsigned: UnsignedSubscription = { vault: VAULT, chainId: 46630, email: "me@example.com", webhook: null, digest: true, issuedAt: 1_800_000_000, ...s };
  return { ...unsigned, signature: await by.signMessage({ message: subscriptionMessage(unsigned) }) };
}

function recorder() {
  const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("agent/alerts", () => {
  it("accepts a subscription signed by the vault's owner, in a message a wallet can show", async () => {
    const sub = await sign(owner);
    expect(subscriptionMessage(sub)).to.include("StockPilot alerts").and.include("Email: me@example.com").and.include("Daily digest: yes");
    expect((await verifySubscription(sub, readOwner)).ok).to.equal(true);
  });

  it("rejects one signed by anyone else, or edited after signing", async () => {
    expect(await verifySubscription(await sign(stranger), readOwner)).to.deep.equal({ ok: false, why: "not signed by the vault's owner" });
    const tampered = { ...(await sign(owner)), email: "attacker@example.com" };
    expect((await verifySubscription(tampered, readOwner)).ok).to.equal(false);
    expect((await verifySubscription({ ...(await sign(owner, { email: null })) }, readOwner)).ok).to.equal(false); // nowhere to send
  });

  it("keeps only the newest valid subscription per vault", async () => {
    const old = await sign(owner, { email: "old@example.com", issuedAt: 1 });
    const fresh = await sign(owner, { email: "new@example.com", issuedAt: 2 });
    const forged = await sign(stranger, { email: "evil@example.com", issuedAt: 3 });
    const active = await activeSubscriptions([old, forged, fresh, { junk: true }], readOwner);
    expect(active.get(VAULT.toLowerCase())!.email).to.equal("new@example.com");
    expect(active.size).to.equal(1);
  });

  it("sends each vault's trades only to that vault's subscribers, by email and webhook", async () => {
    const sub = await sign(owner, { webhook: "https://hooks.example/me" });
    const { calls, fetchImpl } = recorder();
    const notify = routedNotifier(() => new Map([[VAULT.toLowerCase(), sub]]), { apiKey: "re_test", from: "StockPilot <a@b.c>" }, fetchImpl);
    await notify({ kind: "trade", vault: VAULT, tx: "0x1", rationale: "NVDA ran up.", valueUsd: 400n * 10n ** 18n });
    await notify({ kind: "trade", vault: OTHER, tx: "0x2", rationale: "x", valueUsd: 1n });
    await notify({ kind: "hold", vault: VAULT, reason: "fine" });
    expect(calls.map((c) => c.url).sort()).to.deep.equal(["https://api.resend.com/emails", "https://hooks.example/me"]);
    const email = calls.find((c) => c.url.includes("resend"))!;
    expect(email.auth).to.equal("Bearer re_test");
    expect(email.body).to.deep.include({ to: ["me@example.com"], subject: "StockPilot traded in your vault" });
    expect(String(email.body.text)).to.include("$400.00").and.include("NVDA ran up.");
  });

  it("skips email cleanly without an API key", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(await sendEmail({ from: "x" }, "me@example.com", "s", "t")).to.equal(false);
    } finally {
      console.error = original;
    }
  });

  it("sends a daily digest at most once a day", async () => {
    const sent = new Map<string, number>();
    expect(digestDue(sent, VAULT, 1000)).to.equal(true);
    sent.set(VAULT.toLowerCase(), 1000);
    expect(digestDue(sent, VAULT, 1000 + 3600)).to.equal(false);
    expect(digestDue(sent, VAULT, 1000 + 86_400)).to.equal(true);

    const report = basicReport({ period: "the last day", valueStartUsd: null, valueNowUsd: 10_500, paused: false, budgetLeftUsd: 2000, feeBps: 50, holdings: [], trades: [{ sold: "NVDA", bought: "USDG", valueUsd: 300, reason: null }], blocked: [] });
    const { calls, fetchImpl } = recorder();
    await deliverDigest(await sign(owner), report, { apiKey: "k", from: "f" }, fetchImpl);
    expect(calls[0].body.subject).to.equal(`StockPilot daily: ${report.headline}`);
    expect(digestText(VAULT, report)).to.include("$300 of NVDA into USDG").and.include("signed up for StockPilot's daily digest");
  });

  it("the endpoint verifies against the chain before forwarding to the operator", async () => {
    const reader = (chainId: number) => (chainId === 46630 ? readOwner : null);
    expect((await handleSubscribe({ ...(await sign(owner)), chainId: 1 }, reader)).status).to.equal(400);
    expect((await handleSubscribe(await sign(stranger), reader)).json).to.deep.equal({ error: "Subscription rejected: not signed by the vault's owner." });
    expect((await handleSubscribe(await sign(owner), reader)).json).to.deep.equal({ verified: true, forwarded: false });

    const { calls, fetchImpl } = recorder();
    process.env.SUBSCRIPTION_SINK_URL = "https://operator.example/subs";
    try {
      expect((await handleSubscribe(await sign(owner), reader, fetchImpl)).json).to.deep.equal({ verified: true, forwarded: true });
      expect(calls[0].url).to.equal("https://operator.example/subs");
      expect(calls[0].body.vault).to.equal(VAULT);
    } finally {
      delete process.env.SUBSCRIPTION_SINK_URL;
    }
    void zeroAddress;
  });
});

describe("inheritance check-in reminders", () => {
  const DAY = 86_400;
  const HEIR = "0x3333333333333333333333333333333333333333" as Address;
  const status = (claimableAt: number, period = 90 * DAY) => ({ heir: HEIR, period, claimableAt });
  const NOW = 1_800_000_000;

  it("stays quiet without an heir and early in the period", () => {
    expect(checkInReminder(VAULT, { heir: zeroAddress, period: 0, claimableAt: 0 }, NOW)).to.equal(null);
    expect(checkInReminder(VAULT, status(NOW + 60 * DAY), NOW)).to.equal(null); // 30 of 90 days gone
    expect(checkInReminder(VAULT, status(NOW + 23 * DAY), NOW)).to.equal(null); // just under three quarters
  });

  it("warns in the last quarter (or last week, if longer), at most once a day, and says how to stop it", () => {
    const r = checkInReminder(VAULT, status(NOW + 20 * DAY), NOW)!;
    expect(r.subject).to.equal("Check in: your StockPilot heir can claim your vault in 20 days");
    expect(r.text).to.include(HEIR).and.include("I'm here").and.include("pilot's trades do not count");
    expect(checkInReminder(VAULT, status(NOW + 20 * DAY), NOW, NOW - 3_600)).to.equal(null);
    expect(checkInReminder(VAULT, status(NOW + 20 * DAY), NOW, NOW - DAY)).to.not.equal(null);
    // A 30-day period: the last week, not just the last 7.5 days.
    expect(checkInReminder(VAULT, status(NOW + 7 * DAY, 30 * DAY), NOW)!.subject).to.include("in 7 days");
    expect(checkInReminder(VAULT, status(NOW + 1, 30 * DAY), NOW)!.subject).to.include("in 1 day");
  });

  it("says plainly when the heir can already claim", () => {
    expect(checkInReminder(VAULT, status(NOW - 5), NOW)!.subject).to.equal("Your StockPilot heir can now claim your vault");
  });
});

describe("agent/digest", () => {
  it("summarises a vault's holdings and the trades since the last digest", async () => {
    const { loadFixture } = await import("@nomicfoundation/hardhat-toolbox-viem/network-helpers");
    const { deployStockPilot, px } = await import("./fixture");
    const { readVault, sendTrade } = await import("../agent/chain");
    const { plan } = await import("../agent/planner");
    const { digestFacts } = await import("../agent/digest");
    const f = await loadFixture(deployStockPilot);
    const start = await f.publicClient.getBlockNumber();
    await f.nvdaFeed.write.setPrice([px(200)]);
    const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
    if (p.action !== "trade") throw new Error("expected a trade");
    await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);

    const { facts, head } = await digestFacts(f.publicClient as never, f.vault.abi, f.vault.address, start);
    expect(facts.trades).to.have.length(1);
    expect(facts.trades[0].sold).to.equal("NVDA");
    expect(facts.holdings.map((h) => h.symbol)).to.deep.equal(["USDG", "TSLA", "AAPL", "NVDA"]);
    const again = await digestFacts(f.publicClient as never, f.vault.abi, f.vault.address, head + 1n);
    expect(again.facts.trades).to.have.length(0); // nothing new since
  });
});

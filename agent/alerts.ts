// Owner alerts from the hosted pilot: trade and error alerts as they happen, and a daily digest, by email and/or
// webhook, per vault. Owners subscribe by signing a message with the vault's owner key, so nobody can point another
// owner's alerts somewhere else; the fleet honours only subscriptions whose signer is the vault's current owner.

import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { z } from "zod/v4";
import { describe as describeEvent, type FleetEvent, type Notifier } from "./fleet";
import type { Report } from "./report";

export const Subscription = z.object({
  vault: z.string().refine((v) => isAddress(v), "not an address"),
  chainId: z.number().int().positive(),
  email: z.email().max(200).nullable(),
  webhook: z.url().max(500).nullable(),
  digest: z.boolean(),
  /** Unix seconds; a newer signed subscription for the same vault replaces an older one. */
  issuedAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
export type Subscription = z.infer<typeof Subscription>;
export type UnsignedSubscription = Omit<Subscription, "signature">;

/** The exact text the owner signs. Human-readable, so the wallet prompt says what it authorises. */
export function subscriptionMessage(s: UnsignedSubscription) {
  return [
    "StockPilot alerts",
    `Vault: ${getAddress(s.vault)}`,
    `Chain: ${s.chainId}`,
    `Email: ${s.email ?? "none"}`,
    `Webhook: ${s.webhook ?? "none"}`,
    `Daily digest: ${s.digest ? "yes" : "no"}`,
    `Issued: ${s.issuedAt}`,
  ].join("\n");
}

/** Valid when the signature is by the vault's current owner. `readOwner` reads `owner()` onchain. */
export async function verifySubscription(raw: unknown, readOwner: (vault: Address) => Promise<Address>): Promise<{ ok: true; sub: Subscription } | { ok: false; why: string }> {
  const parsed = Subscription.safeParse(raw);
  if (!parsed.success) return { ok: false, why: "malformed subscription" };
  const sub = parsed.data;
  if (!sub.email && !sub.webhook) return { ok: false, why: "no email or webhook" };
  const owner = await readOwner(getAddress(sub.vault));
  const { signature, ...unsigned } = sub;
  const valid = await verifyMessage({ address: owner, message: subscriptionMessage(unsigned), signature: signature as Hex }).catch(() => false);
  return valid ? { ok: true, sub } : { ok: false, why: "not signed by the vault's owner" };
}

/** Keep the newest verified subscription per vault. */
export async function activeSubscriptions(raw: unknown[], readOwner: (vault: Address) => Promise<Address>): Promise<Map<string, Subscription>> {
  const out = new Map<string, Subscription>();
  for (const r of raw) {
    const v = await verifySubscription(r, readOwner).catch(() => ({ ok: false as const, why: "error" }));
    if (!v.ok) continue;
    const key = v.sub.vault.toLowerCase();
    if (!out.has(key) || out.get(key)!.issuedAt < v.sub.issuedAt) out.set(key, v.sub);
  }
  return out;
}

export interface EmailConfig {
  /** Resend API key (https://resend.com); without it, email is skipped and logged. */
  apiKey?: string;
  from: string;
}

type Fetch = typeof fetch;

export async function sendEmail(cfg: EmailConfig, to: string, subject: string, text: string, fetchImpl: Fetch = fetch) {
  if (!cfg.apiKey) {
    console.error(`(email to ${to} skipped: no RESEND_API_KEY) ${subject}`);
    return false;
  }
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: cfg.from, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`email failed: HTTP ${res.status}`);
  return true;
}

async function postWebhook(url: string, text: string, event: unknown, fetchImpl: Fetch) {
  await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, content: text, event }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
}

/**
 * A fleet notifier that sends each vault's trades and errors to that vault's own subscribers. `subs` is read on every
 * event, so subscriptions can be reloaded without restarting the fleet. Delivery failures are logged, never thrown.
 */
export function routedNotifier(subs: () => Map<string, Subscription>, email: EmailConfig, fetchImpl: Fetch = fetch): Notifier {
  return async (event: FleetEvent) => {
    if (event.kind === "hold" || event.kind === "skip" || event.kind === "fee") return;
    const sub = subs().get(event.vault.toLowerCase());
    if (!sub) return;
    const text = describeEvent(event);
    const subject =
      event.kind === "trade"
        ? "StockPilot traded in your vault"
        : event.kind === "defensive"
          ? "Crash guard: your vault switched to defensive targets"
          : event.kind === "deposit"
            ? "Your recurring investment arrived"
            : "StockPilot could not fly your vault";
    await Promise.all([
      sub.webhook ? postWebhook(sub.webhook, text, event, fetchImpl).catch((e) => console.error(`webhook failed: ${(e as Error).message}`)) : null,
      sub.email ? sendEmail(email, sub.email, subject, text, fetchImpl).catch((e) => console.error((e as Error).message)) : null,
    ]);
  };
}

/** Plain-text body of a digest email or post. */
export function digestText(vault: string, report: Report) {
  return [
    report.headline,
    "",
    report.summary,
    "",
    ...report.highlights.map((h) => `- ${h}`),
    ...(report.watch.length ? ["", "Keep an eye on:", ...report.watch.map((w) => `- ${w}`)] : []),
    "",
    `Vault ${vault}. You get this because the vault's owner signed up for StockPilot's daily digest.`,
  ].join("\n");
}

/** Digests go out once a day per vault; `sent` remembers when each last went. */
export function digestDue(sent: Map<string, number>, vault: string, now: number, everySec = 86_400) {
  const last = sent.get(vault.toLowerCase());
  return last === undefined || now - last >= everySec;
}

export async function deliverDigest(sub: Subscription, report: Report, email: EmailConfig, fetchImpl: Fetch = fetch) {
  const text = digestText(sub.vault, report);
  await Promise.all([
    sub.webhook ? postWebhook(sub.webhook, text, { kind: "digest", vault: sub.vault, report }, fetchImpl) : null,
    sub.email ? sendEmail(email, sub.email, `StockPilot daily: ${report.headline}`, text, fetchImpl) : null,
  ]);
}

export interface HeirStatus {
  heir: Address;
  /** Seconds of owner inactivity after which the heir may claim. */
  period: number;
  claimableAt: number;
}

/**
 * Proof-of-life reminders, so an owner who is merely busy never loses the vault to their heir by accident. Nothing
 * until three quarters of the period has passed (or the last 7 days, whichever is longer), then at most once a day.
 */
export function checkInReminder(vault: string, s: HeirStatus, now: number, lastSent?: number): { subject: string; text: string } | null {
  if (/^0x0+$/.test(s.heir) || s.period === 0) return null;
  const left = s.claimableAt - now;
  if (left > Math.max(7 * 86_400, s.period / 4)) return null;
  if (lastSent !== undefined && now - lastSent < 86_400) return null;
  const when = new Date(s.claimableAt * 1000).toUTCString();
  if (left <= 0)
    return {
      subject: "Your StockPilot heir can now claim your vault",
      text: [
        `Vault ${vault} has had no action from its owner for ${Math.round(s.period / 86_400)} days, so its heir ${s.heir} can take it over now.`,
        "If you still hold the owner key, any action (or the \"I'm here\" button) stops this until the period runs out again.",
      ].join("\n\n"),
    };
  const days = Math.ceil(left / 86_400);
  return {
    subject: `Check in: your StockPilot heir can claim your vault in ${days} day${days === 1 ? "" : "s"}`,
    text: [
      `Vault ${vault} names ${s.heir} as its heir. If you do nothing with the vault until ${when}, they can take it over.`,
      "If all is well, open the vault and press \"I'm here\", or make any change: either restarts the clock. Your pilot's trades do not count; only you can.",
    ].join("\n\n"),
  };
}

export async function deliverReminder(sub: Subscription, reminder: { subject: string; text: string }, email: EmailConfig, fetchImpl: Fetch = fetch) {
  await Promise.all([
    sub.webhook ? postWebhook(sub.webhook, `${reminder.subject}\n\n${reminder.text}`, { kind: "check-in", vault: sub.vault }, fetchImpl) : null,
    sub.email ? sendEmail(email, sub.email, reminder.subject, reminder.text, fetchImpl) : null,
  ]);
}

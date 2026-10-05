import { useEffect, useRef, useState } from "react";
import type { Abi, Address, PublicClient, WalletClient } from "viem";
import { subscriptionMessage, type Subscription, type UnsignedSubscription } from "../../agent/alerts";
import { Card } from "./ui";

/**
 * Owner alerts. Browser notifications work while this page is open; email and webhook alerts come from the hosted
 * pilot, which honours only subscriptions signed by the vault's owner.
 */
export function AlertsCard(props: { client: PublicClient; wallet: WalletClient; vault: Address; abi: Abi; chainId: number; symbolOf: (t: Address) => string }) {
  const { client, wallet, vault, abi, chainId } = props;
  const [email, setEmail] = useState("");
  const [webhook, setWebhook] = useState("");
  const [digest, setDigest] = useState(true);
  const [status, setStatus] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const [signed, setSigned] = useState<Subscription | null>(null);
  const [browserOn, setBrowserOn] = useState(false);
  const lastBlock = useRef<bigint | null>(null);

  // Browser alerts: poll for new vault events while the page is open.
  useEffect(() => {
    if (!browserOn) return;
    let stopped = false;
    const tick = async () => {
      const head = await client.getBlockNumber();
      if (lastBlock.current !== null && head > lastBlock.current) {
        const logs = await client.getContractEvents({ address: vault, abi, fromBlock: lastBlock.current + 1n, toBlock: head });
        for (const l of logs) {
          const body = describeLog(l as unknown as { eventName: string; args: Record<string, unknown> }, props.symbolOf);
          if (body && !stopped) new Notification("StockPilot", { body, tag: `${l.transactionHash}-${l.logIndex}` });
        }
      }
      lastBlock.current = head;
    };
    tick().catch(() => {});
    const t = setInterval(() => tick().catch(() => {}), 15_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [browserOn, client, vault, abi]);

  async function enableBrowser() {
    if (!("Notification" in window)) return setStatus({ tone: "bad", text: "This browser does not support notifications." });
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return setStatus({ tone: "bad", text: "Notifications were not allowed." });
    setBrowserOn(true);
    setStatus({ tone: "info", text: "Browser alerts are on while this page is open." });
  }

  async function subscribe() {
    setStatus(null);
    const unsigned: UnsignedSubscription = {
      vault,
      chainId,
      email: email.trim() || null,
      webhook: webhook.trim() || null,
      digest,
      issuedAt: Math.floor(Date.now() / 1000),
    };
    if (!unsigned.email && !unsigned.webhook) return setStatus({ tone: "bad", text: "Add an email address or a webhook URL." });
    try {
      setStatus({ tone: "info", text: "Sign the message in your wallet. It costs nothing and sends no transaction." });
      const signature = await wallet.signMessage({ account: wallet.account!, message: subscriptionMessage(unsigned) });
      const sub = { ...unsigned, signature };
      setSigned(sub);
      const res = await fetch("/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }).catch(() => null);
      const body = res ? await res.json().catch(() => ({})) : {};
      if (res?.ok && body.forwarded) setStatus({ tone: "info", text: "Subscribed. Your pilot will send alerts from now on." });
      else if (res?.ok) setStatus({ tone: "info", text: "Signature verified. This deployment has no alert store yet: send the subscription below to your pilot's operator." });
      else setStatus({ tone: "bad", text: body.error ?? "The alert service is not reachable here. Send the subscription below to your pilot's operator." });
    } catch (e) {
      setStatus({ tone: "bad", text: (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message });
    }
  }

  return (
    <Card title="Alerts" aside={browserOn ? <span className="pill ok">Browser alerts on</span> : null}>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" disabled={browserOn} onClick={enableBrowser}>
          {browserOn ? "Browser alerts on" : "Alert me in this browser"}
        </button>
        <span className="muted small">Trades, pauses and setting changes, while this page is open.</span>
      </div>
      <div className="guardrails" style={{ marginTop: 0 }}>
        <label className="field">
          Email
          <input type="text" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Webhook (Slack, Discord, any URL)
          <input type="text" placeholder="https://hooks.slack.com/…" value={webhook} onChange={(e) => setWebhook(e.target.value)} />
        </label>
      </div>
      <label className="row small" style={{ margin: "10px 0" }}>
        <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} /> Also send a daily digest written by Claude
      </label>
      <button className="btn primary" onClick={subscribe}>
        Sign and subscribe
      </button>
      <p className="muted small">
        Alerts from the hosted pilot need a signature from this vault's owner, so nobody else can redirect them. Signing sends no transaction.
      </p>
      {status && <p className={`notice ${status.tone === "bad" ? "bad" : ""}`}>{status.text}</p>}
      {signed && (
        <details className="small">
          <summary>Signed subscription</summary>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(signed, null, 2)}
          </pre>
        </details>
      )}
    </Card>
  );
}

function describeLog(l: { eventName: string; args: Record<string, unknown> }, symbolOf: (t: Address) => string) {
  const a = l.args;
  switch (l.eventName) {
    case "Rebalanced":
      return `Your pilot sold $${(Number((a.valueInUsd as bigint) / 10n ** 16n) / 100).toFixed(2)} of ${symbolOf(a.tokenIn as Address)} for ${symbolOf(a.tokenOut as Address)}.`;
    case "Paused":
      return "Your vault was paused.";
    case "Unpaused":
      return "Your vault was unpaused.";
    case "MandateSet":
      return "Your vault's mandate changed.";
    case "PilotSet":
      return "Your vault's pilot changed.";
    case "AdapterSet":
      return "Your vault's trading venue changed.";
    case "Withdrawn":
      return "A withdrawal left your vault.";
    default:
      return null;
  }
}

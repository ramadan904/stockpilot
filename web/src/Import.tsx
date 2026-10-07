// Start from what you already own: a screenshot of a brokerage statement (read by Claude on the server) or pasted
// holdings (parsed in plain code). Every line's mapping onto the vault's assets is shown before anything is used.

import { useRef, useState } from "react";
import { IMAGE_TYPES, MAX_IMAGE_BASE64, mapToUniverse, type ExtractedHoldings, type ImportResult } from "../../agent/holdings";
import { LISTINGS } from "../../agent/listings";
import type { Proposal } from "../../agent/mandate";

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Shrink a screenshot so it uploads quickly and stays under the server's limit: at most 2000px on the long side. */
async function shrink(file: File): Promise<{ media_type: (typeof IMAGE_TYPES)[number]; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // PNG keeps small text sharp; fall back to JPEG when the PNG would be too large.
  for (const [type, quality] of [["image/png", undefined], ["image/jpeg", 0.9], ["image/jpeg", 0.75]] as const) {
    const data = canvas.toDataURL(type, quality).split(",")[1];
    if (data.length <= MAX_IMAGE_BASE64) return { media_type: type, data };
  }
  throw new Error("That image is too large even after shrinking it. Try a tighter crop of the holdings.");
}

export function ImportPortfolio({ onUse }: { onUse: (proposal: Proposal, usd: number) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(ImportResult & { note: string; source: string }) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function send(body: unknown, label: string) {
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { holdings?: ExtractedHoldings; source?: string; error?: string };
      if (!res.ok || !json.holdings) throw new Error(json.error ?? "The import service is not reachable here.");
      setResult({ ...mapToUniverse(json.holdings, [...LISTINGS]), note: json.holdings.note, source: json.source ?? "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Choose an image (a screenshot), or paste your holdings as text.");
    try {
      await send({ image: await shrink(file) }, "Reading your statement…");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        Start from what I own
      </button>
    );
  }

  return (
    <div
      className="import-box"
      onPaste={(e) => {
        const img = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
        if (img) {
          e.preventDefault();
          onFile(img.getAsFile() ?? undefined);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFile(e.dataTransfer.files[0]);
      }}
    >
      <strong className="small">Start from what you own</strong>
      <p className="muted small" style={{ margin: "4px 0 8px" }}>
        Drop or paste a screenshot of your brokerage holdings (Claude reads it), or paste them as text: one per line, a ticker and its value. You
        see how every line maps before anything is used.
      </p>
      <div className="row">
        <button className="btn" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          Choose a screenshot
        </button>
        <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(",")} hidden aria-label="Statement screenshot" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      <textarea
        aria-label="Paste your holdings"
        placeholder={"AAPL  $11,500\nVOO   $11,000\nCash  $3,000"}
        value={text}
        maxLength={20_000}
        onChange={(e) => setText(e.target.value)}
        style={{ minHeight: 80, marginTop: 8 }}
      />
      <div className="row">
        <button className="btn" disabled={busy !== null || !text.trim()} onClick={() => send({ text }, "Reading…")}>
          Read pasted holdings
        </button>
        {busy && <span className="muted small">{busy}</span>}
      </div>
      {error && <p className="notice bad">{error}</p>}

      {result && (
        <div className="import-review">
          <table className="holdings" aria-label="How your holdings map">
            <tbody>
              {result.lines.map((l, i) => (
                <tr key={i} className={l.to ? "" : "muted"}>
                  <td>{l.name}</td>
                  <td className="num">{l.valueUsd > 0 ? money(l.valueUsd) : "–"}</td>
                  <td>
                    <strong>{l.to ? `→ ${l.to}` : "left out"}</strong>
                    <div className="small muted">{l.why}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.note && <p className="notice warn small">{result.note}</p>}
          <p className="small" style={{ margin: "8px 0" }}>
            {money(result.totalUsd - result.leftOutUsd)} mapped{result.leftOutUsd > 0 ? `, ${money(result.leftOutUsd)} left out` : ""}.{" "}
            {result.source === "claude" && "Read by Claude: check the numbers against your statement."}
          </p>
          <button className="btn primary" onClick={() => onUse(result.proposal, Math.max(100, Math.round(result.totalUsd - result.leftOutUsd)))}>
            Use as my draft
          </button>
        </div>
      )}
    </div>
  );
}

/** The browser's own speech recognition, where it has one (Chrome, Edge, Safari). Nothing is recorded or uploaded by us. */
type Recognition = { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: () => void; start: () => void; stop: () => void };
const Speech = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (globalThis as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

export function SpeakButton({ onText }: { onText: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  if (!Speech) return null;
  const toggle = () => {
    if (listening) return rec.current?.stop();
    const r = new Speech();
    r.lang = navigator.language || "en-US";
    r.interimResults = false;
    r.onresult = (e) => onText(Array.from(e.results, (res) => res[0].transcript).join(" "));
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  return (
    <button className={`btn ${listening ? "primary" : ""}`} onClick={toggle} aria-pressed={listening}>
      {listening ? "Listening… tap to stop" : "Speak your goal"}
    </button>
  );
}

import { useEffect, useRef, useState } from "react";
import { basicReport, type Report, type ReportFacts } from "../../agent/report";
import { Card } from "./ui";

export { holdingsFacts, valueFacts } from "../../agent/report";

async function fetchReport(facts: ReportFacts): Promise<{ report: Report; source: "claude" | "basic" }> {
  try {
    const res = await fetch("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(facts) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return { report: basicReport(facts), source: "basic" };
  }
}

export function ReportCard({ facts, title = "Owner's report", trigger = 0, tour }: { facts: () => ReportFacts; title?: string; trigger?: number; tour?: string }) {
  const [out, setOut] = useState<{ report: Report; source: "claude" | "basic" } | null>(null);
  const [busy, setBusy] = useState(false);
  const factsRef = useRef(facts);
  factsRef.current = facts;
  // Lets the guided tour ask for a report.
  useEffect(() => {
    if (trigger === 0) return;
    setBusy(true);
    fetchReport(factsRef.current()).then((r) => {
      setOut(r);
      setBusy(false);
    });
  }, [trigger]);
  return (
    <Card
      tour={tour}
      title={title}
      aside={
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setOut(await fetchReport(facts()));
            setBusy(false);
          }}
        >
          {busy ? "Writing…" : out ? "Rewrite" : "Write my report"}
        </button>
      }
    >
      {!out ? (
        <p className="muted small" style={{ margin: 0 }}>
          A plain-English summary of what happened and why, written by Claude from numbers computed onchain. It never invents figures.
        </p>
      ) : (
        <div className="report">
          <div className="spread">
            <strong>{out.report.headline}</strong>
            <span className={`pill ${out.source === "claude" ? "info" : "warn"}`}>{out.source === "claude" ? "Written by Claude" : "Basic report"}</span>
          </div>
          {out.report.summary.split(/\n+/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {out.report.highlights.length > 0 && (
            <ul>
              {out.report.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
          {out.report.watch.length > 0 && (
            <>
              <div className="small muted">Keep an eye on</div>
              <ul>
                {out.report.watch.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

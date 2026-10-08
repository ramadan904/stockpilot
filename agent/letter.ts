// A letter from the pilot to the owner, from a report: the form it is published in onchain (PilotJournal), so it must
// read well as plain text and fit the contract's limit. The numbers come from the report, which takes them from the
// chain; the letter only arranges them.

import type { Report } from "./report";

/** PilotJournal.MAX_LETTER, in bytes. */
export const MAX_LETTER_BYTES = 4_000;

const bytes = (s: string) => new TextEncoder().encode(s).length;

export function composeLetter(report: Report, o: { vault: string; pilotName: string; written: "claude" | "basic" }): string {
  const short = `${o.vault.slice(0, 6)}…${o.vault.slice(-4)}`;
  const lines = [
    "Dear owner,",
    "",
    report.headline,
    "",
    report.summary,
    ...(report.highlights.length ? ["", ...report.highlights.map((h) => `- ${h}`)] : []),
    ...(report.watch.length ? ["", "Worth keeping an eye on:", ...report.watch.map((w) => `- ${w}`)] : []),
    "",
    `Every trade I made was checked by vault ${short} against the mandate you signed; I can't withdraw or change your rules.`,
    "",
    `${o.pilotName}${o.written === "claude" ? " (written with Claude from figures read onchain)" : ""}`,
  ];
  let text = lines.join("\n");
  // Keep inside the contract's limit: drop the optional middle before ever cutting a sentence.
  if (bytes(text) > MAX_LETTER_BYTES) text = [lines[0], "", report.headline, "", report.summary, "", lines[lines.length - 1]].join("\n");
  while (bytes(text) > MAX_LETTER_BYTES) text = `${text.slice(0, Math.floor(text.length * 0.9)).trimEnd()}…`;
  return text;
}

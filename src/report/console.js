import { deltaLabel, summaryLine, budgetBanner } from "./format.js";

/* =========================================================================
 * console.js - the concise triage table for stdout.
 *
 * One line per fixture, already ranked, so the first rows an analyst sees are
 * the ones worth their 30 minutes. Returns a string (the caller prints it), so
 * it stays testable.
 * ========================================================================= */

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderConsole(report) {
  const lines = [summaryLine(report.summary)];
  const banner = budgetBanner(report.summary);
  if (banner) lines.push(banner);
  lines.push("");
  lines.push(`${pad("ACTION", 22)} ${pad("CONF", 6)} ${pad("DELTA", 7)} ${pad("FIXTURE", 9)} MATCH`);

  for (const f of report.fixtures) {
    lines.push(
      `${pad(f.action, 22)} ${pad(f.confidence, 6)} ${pad(deltaLabel(f.delta_minutes), 7)} ${pad(f.fixture_id, 9)} ${f.match.home} v ${f.match.away}`,
    );
  }
  return lines.join("\n");
}

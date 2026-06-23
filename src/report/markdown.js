import { ACTION } from "../config.js";
import { localLabel, deltaLabel, summaryLine, budgetBanner } from "./format.js";

/* =========================================================================
 * markdown.js - REPORT.md: a triage summary plus one block per fixture.
 *
 * The block tells the honest story for each action: a confident change carries a
 * copyable new time; a postponement carries NONE (hard stop); a clash shows both
 * candidate times side by side; rumors say "keep the feed time".
 * ========================================================================= */

function utcAndLocal(utc, zone) {
  const local = localLabel(utc, zone);
  return local ? `${utc}  (${local})` : utc;
}

function breakdownLine(b) {
  if (!b) return null;
  if (b.score == null) return b.note ? `Note: ${b.note}` : null;
  const parts = [`AUTHORITY ${b.authority}`, `CORROBORATION ${b.corroboration}`];
  if (b.recency_clarity) parts.push(`RECENCY ${b.recency_clarity}`);
  if (b.tentative_penalty) parts.push(`- TENTATIVE ${b.tentative_penalty}`);
  if (b.conflict_penalty) parts.push(`- CONFLICT ${b.conflict_penalty}`);
  return `Score ${b.score}: ${parts.join(" + ").replace(/\+ -/g, "-")}`;
}

// The closing line is action-specific: it is where the no-write discipline shows.
function actionLine(f) {
  switch (f.action) {
    case ACTION.CHANGE_RECOMMENDED:
      return `New kickoff_utc (analyst applies): ${f.resolved_kickoff_utc}`;
    case ACTION.POSTPONED_OR_CANCELLED:
      return "New kickoff_utc: - (none; reschedule -> league resequencing)";
    case ACTION.REVIEW:
      return f.candidate_times.length > 1
        ? "New kickoff_utc: - (two fresh officials disagree; human confirm)"
        : "New kickoff_utc: - (human confirm)";
    case ACTION.CONFIRMED:
      return "Feed time verified by a fresh official source; no change.";
    case ACTION.MONITOR:
      return "Keeping feed time; re-poll (no credible source yet).";
    case ACTION.INSUFFICIENT_EVIDENCE:
      return "Keeping feed time; insufficient evidence (explicitly NOT verified).";
    case ACTION.COULD_NOT_ASSESS:
      return "Evidence fetch failed after retries; RETRY_LATER (infra, not a guess).";
    default:
      return "";
  }
}

function renderFixture(f) {
  const zone = f.match.venue_timezone;
  const out = [];
  out.push(`### ${f.fixture_id} - ${f.match.home} v ${f.match.away} - ${f.match.competition}`);
  out.push(`RECOMMENDATION: ${f.action}  -  confidence: ${f.confidence}`);
  out.push(`Current feed : ${utcAndLocal(f.current_kickoff_utc, zone)}`);

  if (f.resolved_kickoff_utc) {
    out.push(`Concluded    : ${utcAndLocal(f.resolved_kickoff_utc, zone)}   delta ${deltaLabel(f.delta_minutes)}`);
  } else if (f.candidate_times.length) {
    const cands = f.candidate_times.map((c) => utcAndLocal(c, zone)).join("   vs   ");
    out.push(`Candidates   : ${cands}`);
  } else {
    out.push("Concluded    : - (no trusted new time)");
  }

  if (f.why?.length) out.push(`Why: ${f.why[0]}`);
  for (const s of f.sources_used ?? []) {
    const arrow = s.utc ? ` -> ${s.utc}` : "";
    const quote = s.quote ? `  "${s.quote}"` : "";
    out.push(`  - ${s.label} (trust ${s.trust_score})${arrow} [${s.evidence_id}]${quote}`);
  }

  const bd = breakdownLine(f.score_breakdown);
  if (bd) out.push(bd);

  for (const d of f.dropped ?? []) {
    out.push(`Dropped evidence: [${d.evidenceId}] ${d.reason}`);
  }

  out.push(actionLine(f));
  return out.join("\n");
}

export function renderMarkdown(report) {
  const head = ["# Pitchside Kickoff Verification - Triage", "", summaryLine(report.summary)];
  const banner = budgetBanner(report.summary);
  if (banner) head.push(banner);
  if (report.generated_at) head.push(`_generated ${report.generated_at}_`);

  const blocks = report.fixtures.map(renderFixture);
  return `${head.join("\n")}\n\n---\n\n${blocks.join("\n\n---\n\n")}\n`;
}

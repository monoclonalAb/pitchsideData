import { ACTION } from "../config.js";

/* =========================================================================
 * json.js - the canonical report artifact, built and ranked.
 *
 * Triage-first ordering is a hard requirement, not presentation polish: the
 * highest-blast-radius items (changes, flags, postponements) sort to the top so
 * an analyst's limited attention hits the ones that matter. The Markdown and
 * console renderers are derived from this object, so all three agree by
 * construction and the tests assert against this one shape.
 * ========================================================================= */

// ~5 good flags/day is the attention ceiling; over it we banner, never hide.
export const FLAG_BUDGET = 5;

// Lower number sorts first. Actionable, high-blast-radius work leads.
const PRIORITY = {
  [ACTION.CHANGE_RECOMMENDED]: 0,
  [ACTION.REVIEW]: 1,
  [ACTION.POSTPONED_OR_CANCELLED]: 2,
  [ACTION.COULD_NOT_ASSESS]: 3,
  [ACTION.CONFIRMED]: 4,
  [ACTION.MONITOR]: 5,
  [ACTION.INSUFFICIENT_EVIDENCE]: 6,
};

/**
 * Build the canonical report from [{ fixture, verdict }]. Each fixture entry is
 * the verdict verbatim plus a small match descriptor (for local rendering).
 */
export function buildReport(items, { generatedAt = null } = {}) {
  const fixtures = items.map(({ fixture, verdict }) => ({
    ...verdict,
    match: {
      home: fixture.home,
      away: fixture.away,
      competition: fixture.competition,
      venue_city: fixture.venue?.city ?? null,
      venue_timezone: fixture.venue?.timezone ?? null,
    },
  }));

  fixtures.sort((a, b) => {
    const pa = PRIORITY[a.action] ?? 99;
    const pb = PRIORITY[b.action] ?? 99;
    if (pa !== pb) return pa - pb;
    // Within an action, a bigger time delta is more urgent.
    const da = Math.abs(a.delta_minutes ?? 0);
    const db = Math.abs(b.delta_minutes ?? 0);
    if (da !== db) return db - da;
    return a.fixture_id.localeCompare(b.fixture_id);
  });

  const count = (action) => fixtures.filter((f) => f.action === action).length;
  const summary = {
    change_recommended: count(ACTION.CHANGE_RECOMMENDED),
    review: count(ACTION.REVIEW),
    postponed_or_cancelled: count(ACTION.POSTPONED_OR_CANCELLED),
    confirmed: count(ACTION.CONFIRMED),
    monitor: count(ACTION.MONITOR),
    insufficient_evidence: count(ACTION.INSUFFICIENT_EVIDENCE),
    could_not_assess: count(ACTION.COULD_NOT_ASSESS),
  };
  summary.actionable =
    summary.change_recommended + summary.review + summary.postponed_or_cancelled;
  summary.over_budget = summary.actionable > FLAG_BUDGET;

  return { generated_at: generatedAt, summary, fixtures };
}

export function serializeReport(report) {
  return JSON.stringify(report, null, 2) + "\n";
}

import { nameMatches } from "./sources.js";
import { venueLocalDate } from "./timezone.js";

/* =========================================================================
 * relevance.js - is this claim about THIS fixture?
 *
 * Applied before scoring, and visible: dropped claims are surfaced with a
 * reason, never silently omitted (silent omission reads as a bug to an auditor).
 *
 * The decisive signal is the opponent. A claim that names a non-participant is
 * about a different match (the fx-2207 Caldera-vs-Fogline distractor). Opponent
 * match is kept regardless of date, so a genuine postponement to a far-off date
 * is not wrongly dropped; date/venue only act when no opponent is named.
 * ========================================================================= */

const RELEVANCE_DATE_TOLERANCE_DAYS = 10;

function daysBetween(isoDateA, isoDateB) {
  const a = Date.parse(`${isoDateA}T00:00:00Z`);
  const b = Date.parse(`${isoDateB}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/** Decide whether a single extracted claim concerns the fixture. */
export function keepClaim(claim, fixture) {
  const opponent = claim.opponent_mentioned;
  if (opponent) {
    if (nameMatches(opponent, fixture.home) || nameMatches(opponent, fixture.away)) {
      return { keep: true, reason: `opponent "${opponent}" matches a participant` };
    }
    return {
      keep: false,
      reason: `opponent "${opponent}" is neither ${fixture.home} nor ${fixture.away}`,
    };
  }

  // No opponent named: fall back to an explicit-date sanity check.
  const iso = claim.date_reference?.explicit_iso_date;
  if (iso) {
    const fixtureDate = venueLocalDate(fixture).toISODate();
    const gap = Math.abs(daysBetween(iso, fixtureDate));
    if (gap > RELEVANCE_DATE_TOLERANCE_DAYS) {
      return {
        keep: false,
        reason: `claim date ${iso} is ${gap}d from fixture date ${fixtureDate}`,
      };
    }
  }
  return { keep: true, reason: "no contradicting opponent/date signal" };
}

/** Split claims into kept vs dropped (each dropped item carries its reason). */
export function filterRelevant(claims, fixture) {
  const kept = [];
  const dropped = [];
  for (const claim of claims) {
    const verdict = keepClaim(claim, fixture);
    if (verdict.keep) {
      kept.push(claim);
    } else {
      dropped.push({ claim, reason: verdict.reason });
    }
  }
  return { kept, dropped };
}

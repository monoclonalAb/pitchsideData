import { DateTime } from "luxon";

/* =========================================================================
 * timezone.js - local wall-clock to UTC, library-correct.
 *
 * The LLM only ever emits a LOCAL assertion ("7:00 PM", hint "Denver"). All UTC
 * math lives here, in deterministic code, so the DST / no-DST class of bug is
 * structurally impossible to express in the model.
 *
 * Invariant: resolve the local wall-clock DATE first, then convert to UTC. The
 * conversion may roll the date across midnight Zulu (e.g. 7 PM Phoenix on the
 * 30th becomes 02:00Z on the 1st). Luxon's IANA database handles DST and, the
 * point of fx-2209, America/Phoenix = MST year-round.
 * ========================================================================= */

// tz_hint enum values that map straight to a zone.
const ABBREV_ZONES = {
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
  PT: "America/Los_Angeles",
};

// Keyword (lowercased, substring-matched) to zone, for EXPLICIT_CITY /
// OTHER_EXPLICIT verbatims like "hora de Denver" or "Eastern".
const KEYWORD_ZONES = {
  "new york": "America/New_York",
  boston: "America/New_York",
  eastern: "America/New_York",
  chicago: "America/Chicago",
  central: "America/Chicago",
  denver: "America/Denver",
  mountain: "America/Denver",
  phoenix: "America/Phoenix",
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  pacific: "America/Los_Angeles",
};

const WEEKDAYS = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };

/**
 * Resolve the IANA zone for a claim. A stated abbreviation or city wins; with no
 * usable hint we default to the venue's own zone (never a hardcoded offset).
 */
export function zoneFor(tzHint, tzHintVerbatim, venueZone) {
  if (ABBREV_ZONES[tzHint]) {
    return { zone: ABBREV_ZONES[tzHint], source: "tz_hint" };
  }
  if (
    (tzHint === "EXPLICIT_CITY" || tzHint === "OTHER_EXPLICIT") &&
    tzHintVerbatim
  ) {
    const hay = tzHintVerbatim.toLowerCase();
    for (const [keyword, zone] of Object.entries(KEYWORD_ZONES)) {
      if (hay.includes(keyword)) return { zone, source: "tz_verbatim" };
    }
  }
  return { zone: venueZone, source: "venue_default" };
}

/** The fixture's scheduled kickoff as a calendar datetime in the venue zone. */
export function venueLocalDate(fixture) {
  return DateTime.fromISO(fixture.kickoff_utc, { zone: "utc" }).setZone(
    fixture.venue.timezone,
  );
}

// Nearest date to the anchor whose weekday matches, searched within +/- 3 days.
function nearestWeekday(anchor, targetWeekday) {
  let best = null;
  let bestDistance = Infinity;
  for (let delta = -3; delta <= 3; delta++) {
    const candidate = anchor.plus({ days: delta });
    if (candidate.weekday === targetWeekday && Math.abs(delta) < bestDistance) {
      best = candidate;
      bestDistance = Math.abs(delta);
    }
  }
  return best ?? anchor;
}

/**
 * Resolve the local calendar date for a claim. The LLM only labels the date cue;
 * code computes the date, so the model never does weekday arithmetic or guesses
 * a year. Falls back to the fixture's scheduled date when nothing is asserted.
 */
export function localDateFor({ kind, explicitIsoDate, weekday } = {}, anchor) {
  // Code owns the date. A named weekday wins: a kickoff-time claim is about THIS
  // match, so the occurrence nearest the scheduled day is the right date even
  // when the model guessed the wrong week in explicit_iso_date (a live failure
  // mode the recorded golden did not exhibit).
  if (WEEKDAYS[weekday]) {
    return nearestWeekday(anchor, WEEKDAYS[weekday]).toISODate();
  }
  if (kind === "EXPLICIT_DATE" && explicitIsoDate) {
    return explicitIsoDate;
  }
  return anchor.toISODate();
}

/**
 * The invariant in one place: build the local wall clock in its zone, THEN go to
 * UTC. Returns a canonical "...Z" instant. Throws on an unbuildable datetime.
 */
export function wallClockToUtc({ date, time, zone }) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const local = DateTime.fromObject({ year, month, day, hour, minute }, { zone });
  if (!local.isValid) {
    throw new Error(
      `invalid local datetime: ${date} ${time} ${zone} (${local.invalidReason})`,
    );
  }
  return local.toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/**
 * Compose zone + date + wall clock into a resolved UTC instant for one claim.
 * The high-level adapter from the extractor's snake_case schema to the pure
 * helpers above. Returns utc:null when the claim asserts no time.
 */
export function resolveKickoff(claim, fixture) {
  if (!claim?.claimed_local_time) {
    return { utc: null, zone: null, zoneSource: null, localDate: null, localTime: null };
  }
  const venueZone = fixture.venue.timezone;
  const { zone, source } = zoneFor(claim.tz_hint, claim.tz_hint_verbatim, venueZone);
  const anchor = venueLocalDate(fixture);
  const dr = claim.date_reference ?? {};
  const date = localDateFor(
    { kind: dr.kind, explicitIsoDate: dr.explicit_iso_date, weekday: dr.weekday },
    anchor,
  );
  const utc = wallClockToUtc({ date, time: claim.claimed_local_time, zone });
  return {
    utc,
    zone,
    zoneSource: source,
    localDate: date,
    localTime: claim.claimed_local_time,
  };
}

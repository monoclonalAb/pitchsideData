import { DateTime } from "luxon";

/* =========================================================================
 * prompt.js - the extraction contract: system + user prompt + strict schema.
 *
 * The model is a translator from messy text into a typed LOCAL claim, never a
 * decider. It never sees the current kickoff or the feed time, and never does
 * timezone math: it reports the local wall clock exactly as written plus a
 * timezone HINT, and code converts. That single boundary kills the DST bug
 * class, the false-conflict, and feed-anchoring bias at once.
 * ========================================================================= */

const nullableString = { type: ["string", "null"] };

// Strict JSON schema (OpenAI Structured Outputs): every field required,
// additionalProperties false, nullability expressed in the type union.
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "mentions_kickoff",
          "claimed_local_time",
          "tz_hint",
          "tz_hint_verbatim",
          "date_reference",
          "is_change",
          "is_postponement",
          "is_rumor_or_tentative",
          "is_tbc",
          "is_broadcast_pick",
          "opponent_mentioned",
          "venue_or_city_mentioned",
          "home_away_context",
          "verbatim_quote",
          "extraction_confidence",
        ],
        properties: {
          mentions_kickoff: { type: "boolean" },
          claimed_local_time: nullableString, // "HH:MM" 24h, copied from text; no conversion
          tz_hint: {
            type: "string",
            enum: ["ET", "CT", "MT", "PT", "EXPLICIT_CITY", "OTHER_EXPLICIT", "NONE"],
          },
          tz_hint_verbatim: nullableString,
          date_reference: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "verbatim", "explicit_iso_date", "weekday"],
            properties: {
              kind: {
                type: "string",
                enum: ["EXPLICIT_DATE", "RELATIVE_WEEKDAY", "RELATIVE_OTHER", "NONE"],
              },
              verbatim: nullableString,
              explicit_iso_date: nullableString, // only if the calendar window makes the year unambiguous
              weekday: {
                type: ["string", "null"],
                enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN", null],
              },
            },
          },
          is_change: { type: "boolean" },
          is_postponement: { type: "boolean" },
          is_rumor_or_tentative: { type: "boolean" },
          is_tbc: { type: "boolean" },
          is_broadcast_pick: { type: "boolean" },
          opponent_mentioned: nullableString,
          venue_or_city_mentioned: nullableString,
          home_away_context: {
            type: "string",
            enum: ["SELF_HOME", "SELF_AWAY", "NEUTRAL_OR_UNKNOWN"],
          },
          verbatim_quote: { type: "string" }, // EXACT substring of the input
          extraction_confidence: { type: "number" }, // parsing confidence, not truth
        },
      },
    },
  },
};

export function buildSystemPrompt() {
  return [
    "You convert ONE piece of soccer evidence text into zero or more typed claims",
    "about a fixture's kickoff. You are a translator, not a decider.",
    "",
    "HARD RULES:",
    "- NEVER output a UTC time, an offset, or any timezone conversion. Report the",
    "  LOCAL wall-clock time EXACTLY as written (\"6:00 PM\" -> \"18:00\", \"7pm\" ->",
    "  \"19:00\") in claimed_local_time, plus a separate tz_hint. Code does all math.",
    "- You never see the current scheduled time. Do not invent or guess a time.",
    "- claimed_local_time is 24h \"HH:MM\" copied from the text, or null if no clock",
    "  time is stated.",
    "- Every claim MUST include verbatim_quote: an EXACT substring of the input that",
    "  proves it. If you cannot quote it from the text, do not emit the claim.",
    "- mentions_kickoff is true only when the text concerns THIS match's start time,",
    "  not gates/parking/tickets/result chatter.",
    "- Flags: is_change (now/moved/updated/rescheduled), is_postponement",
    "  (postponed/abandoned/replayed/called off), is_rumor_or_tentative",
    "  (might/hearing/??? /anyone confirm), is_tbc (TBC / to be confirmed / pending",
    "  broadcast SELECTION - a disclaimer, NOT a decision), is_broadcast_pick (a",
    "  CONCRETE TV/broadcast slot assertion: \"selected for live TV\", \"broadcast slot",
    "  moved to ...\"). is_tbc and is_broadcast_pick are mutually exclusive.",
    "- date_reference: label the date cue. Give explicit_iso_date ONLY when the",
    "  calendar window makes the year unambiguous; set weekday MON..SUN if named.",
    "- opponent_mentioned: the OTHER team named, verbatim. venue_or_city_mentioned:",
    "  any venue or city named. home_away_context: is the SOURCE home, away, or unknown.",
    "- Multiple distinct claims -> multiple entries. No claim -> empty array.",
    "- Text may be non-English; keep quotes in the original language. Output ONLY JSON.",
  ].join("\n");
}

// A weekday<->date window around the fixture for grounding relative dates. It
// exposes DATES only, never the kickoff time, so the model cannot parrot a time.
export function buildCalendarWindow(fixture, days = 10) {
  const anchor = DateTime.fromISO(fixture.kickoff_utc, { zone: "utc" })
    .setZone(fixture.venue.timezone)
    .startOf("day");
  const lines = [];
  for (let d = -days; d <= days; d++) {
    const dt = anchor.plus({ days: d });
    lines.push(`  ${dt.toFormat("ccc")}: ${dt.toISODate()}`);
  }
  return lines.join("\n");
}

export function buildUserPrompt(item, fixture, sourceText) {
  return [
    `Fixture: ${fixture.home} (home) vs ${fixture.away} (away)`,
    `Competition: ${fixture.competition}`,
    `Venue city: ${fixture.venue?.city ?? "unknown"}`,
    "Calendar window (weekday -> date, for resolving relative dates):",
    buildCalendarWindow(fixture),
    "",
    `Source type: ${item.type}`,
    "Source text:",
    '"""',
    sourceText,
    '"""',
    "",
    "Extract all kickoff claims as JSON.",
  ].join("\n");
}

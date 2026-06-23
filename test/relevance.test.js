import { test } from "node:test";
import assert from "node:assert/strict";
import { keepClaim, filterRelevant } from "../src/domain/relevance.js";

// Mirrors the real fx-2207 fixture (Red Vale United v Caldera FC, Boston).
const fixture = {
  id: "fx-2207",
  home: "Red Vale United",
  away: "Caldera FC",
  competition: "Continental Soccer League",
  venue: { city: "Boston", timezone: "America/New_York" },
  kickoff_utc: "2026-06-26T22:00:00Z",
};

test("fx-2207 distractor: Caldera's July-18 vs Fogline post is dropped (opponent mismatch)", () => {
  const distractor = {
    opponent_mentioned: "Fogline SC",
    venue_or_city_mentioned: null,
    date_reference: {
      kind: "EXPLICIT_DATE",
      explicit_iso_date: "2026-07-18",
      weekday: null,
    },
    verbatim_quote:
      "our July 18 HOME fixture against Fogline SC moves to 6:00 PM",
  };
  const verdict = keepClaim(distractor, fixture);
  assert.equal(verdict.keep, false);
  assert.match(verdict.reason, /Fogline/);
});

test("fx-2207 valid: 'Friday vs Caldera FC' is kept (opponent matches a participant)", () => {
  const valid = {
    opponent_mentioned: "Caldera FC",
    date_reference: {
      kind: "RELATIVE_WEEKDAY",
      weekday: "FRI",
      explicit_iso_date: null,
    },
  };
  assert.equal(keepClaim(valid, fixture).keep, true);
});

test("opponent match wins over a far date (a postponement to a far date stays relevant)", () => {
  const postponed = {
    opponent_mentioned: "Caldera FC",
    date_reference: { kind: "EXPLICIT_DATE", explicit_iso_date: "2026-08-15" },
  };
  assert.equal(keepClaim(postponed, fixture).keep, true);
});

test("no opponent + far explicit date is dropped as a different week", () => {
  const farDate = {
    opponent_mentioned: null,
    date_reference: { kind: "EXPLICIT_DATE", explicit_iso_date: "2026-08-01" },
  };
  assert.equal(keepClaim(farDate, fixture).keep, false);
});

test("no opponent + no date is kept (cannot disprove relevance)", () => {
  assert.equal(keepClaim({ opponent_mentioned: null }, fixture).keep, true);
});

test("filterRelevant splits kept vs dropped, each drop carrying a reason", () => {
  const claims = [
    { opponent_mentioned: "Caldera FC" },
    { opponent_mentioned: "Fogline SC" },
  ];
  const { kept, dropped } = filterRelevant(claims, fixture);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /Fogline/);
});

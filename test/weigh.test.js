import { test } from "node:test";
import assert from "node:assert/strict";
import { weighFixture } from "../src/domain/weigh.js";
import { loadFixtures, loadBundle, REFERENCE_NOW } from "./helpers/replay.js";
import { ACTION, CONFIDENCE } from "../src/config.js";

/* =========================================================================
 * weigh.test.js - the spec. The 9 captured fixtures reproduce the truth table,
 * plus synthetic tests that pin each gate in isolation.
 * ========================================================================= */

// ---- Part 1: the 9-fixture golden table (replayed, offline, deterministic) ----

const TRUTH = {
  "fx-2201": [ACTION.CHANGE_RECOMMENDED, CONFIDENCE.HIGH],
  "fx-2202": [ACTION.CONFIRMED, CONFIDENCE.HIGH],
  "fx-2203": [ACTION.POSTPONED_OR_CANCELLED, CONFIDENCE.LOW],
  "fx-2204": [ACTION.REVIEW, CONFIDENCE.MEDIUM],
  "fx-2205": [ACTION.REVIEW, CONFIDENCE.LOW],
  "fx-2206": [ACTION.MONITOR, CONFIDENCE.LOW],
  "fx-2207": [ACTION.CHANGE_RECOMMENDED, CONFIDENCE.HIGH],
  "fx-2208": [ACTION.REVIEW, CONFIDENCE.LOW],
  "fx-2209": [ACTION.CHANGE_RECOMMENDED, CONFIDENCE.HIGH],
};

async function weighGolden(id) {
  const { fixture, evidenceWithClaims } = await loadBundle(id);
  return weighFixture(fixture, evidenceWithClaims, { now: REFERENCE_NOW });
}

test("all 9 captured fixtures reproduce the truth table", async () => {
  for (const fx of await loadFixtures()) {
    const v = await weighGolden(fx.id);
    const [action, confidence] = TRUTH[fx.id];
    assert.equal(v.action, action, `${fx.id} action`);
    assert.equal(v.confidence, confidence, `${fx.id} confidence`);
  }
});

test("fx-2201: clean consensus change -> proposes the new UTC", async () => {
  const v = await weighGolden("fx-2201");
  assert.equal(v.action, ACTION.CHANGE_RECOMMENDED);
  assert.equal(v.resolved_kickoff_utc, "2026-06-20T22:00:00Z");
  assert.equal(v.delta_minutes, 120);
});

test("fx-2202: false conflict normalizes to agreement -> CONFIRMED, delta 0", async () => {
  const v = await weighGolden("fx-2202");
  assert.equal(v.action, ACTION.CONFIRMED);
  assert.equal(v.delta_minutes, 0);
});

test("fx-2203: postponement is a hard stop - NO time proposed anywhere", async () => {
  const v = await weighGolden("fx-2203");
  assert.equal(v.action, ACTION.POSTPONED_OR_CANCELLED);
  assert.equal(v.resolved_kickoff_utc, null);
  assert.deepEqual(v.candidate_times, []); // guards the copyable-time leak
  assert.equal(v.delta_minutes, null);
});

test("fx-2204: lone club correction -> REVIEW/MED, and is robust without the stale ScoreFeed", async () => {
  const { fixture, evidenceWithClaims } = await loadBundle("fx-2204");
  const withFeed = weighFixture(fixture, evidenceWithClaims, { now: REFERENCE_NOW });
  assert.equal(withFeed.action, ACTION.REVIEW);
  assert.equal(withFeed.confidence, CONFIDENCE.MEDIUM);

  // Remove the stale aggregator entirely: the verdict must not change, proving
  // the cap is about corroboration, not the inert feed.
  const noFeed = evidenceWithClaims.filter(({ item }) => item.type !== "feed_listing");
  const without = weighFixture(fixture, noFeed, { now: REFERENCE_NOW });
  assert.equal(without.action, ACTION.REVIEW);
  assert.equal(without.confidence, CONFIDENCE.MEDIUM);
});

test("fx-2205: cross-source official conflict -> REVIEW/LOW, both candidates, conflict penalty", async () => {
  const v = await weighGolden("fx-2205");
  assert.equal(v.action, ACTION.REVIEW);
  assert.equal(v.confidence, CONFIDENCE.LOW);
  assert.equal(v.resolved_kickoff_utc, null);
  assert.equal(v.candidate_times.length, 2); // both times surfaced, no winner picked
  assert.ok(v.candidate_times.includes("2026-06-28T01:00:00Z"));
  assert.ok(v.candidate_times.includes("2026-06-28T01:30:00Z"));
});

test("fx-2206: rumor only -> MONITOR/LOW, feed time kept", async () => {
  const v = await weighGolden("fx-2206");
  assert.equal(v.action, ACTION.MONITOR);
  assert.equal(v.resolved_kickoff_utc, null);
});

test("fx-2207: off-topic distractor is dropped with a reason; real change survives", async () => {
  const v = await weighGolden("fx-2207");
  assert.equal(v.action, ACTION.CHANGE_RECOMMENDED);
  assert.equal(v.resolved_kickoff_utc, "2026-06-26T23:00:00Z");
  assert.equal(v.dropped.length, 1);
  assert.match(v.dropped[0].reason, /Fogline/);
});

test("fx-2208: authority disclaims its own time (TBC) -> REVIEW, no resolved time", async () => {
  const v = await weighGolden("fx-2208");
  assert.equal(v.action, ACTION.REVIEW);
  assert.equal(v.resolved_kickoff_utc, null);
});

test("fx-2209: Phoenix no-DST change -> 02:00Z, not 01:00Z", async () => {
  const v = await weighGolden("fx-2209");
  assert.equal(v.action, ACTION.CHANGE_RECOMMENDED);
  assert.equal(v.resolved_kickoff_utc, "2026-07-01T02:00:00Z");
});

// ---- Part 2: synthetic gate tests (each gate isolated) ----

// A synthetic fixture: feed says 4 PM EDT (20:00Z) on Sat 2026-06-20.
const FX = {
  id: "fx-syn",
  home: "Harbour City FC",
  away: "Red Vale United",
  competition: "Continental Soccer League",
  venue: { city: "New York", timezone: "America/New_York" },
  kickoff_utc: "2026-06-20T20:00:00Z",
  last_verified_at: "2026-06-01T00:00:00Z",
};
const NOW = "2026-06-18T00:00:00Z"; // posts dated 06-15..16 are fresh here

function social(id, handle, postedAt) {
  return {
    id,
    type: "social_post",
    platform: "twitter",
    account: { handle, display_name: handle.replace("@", ""), verified: true },
    posted_at: postedAt,
    text: "synthetic",
    likes: 0,
  };
}

function feed(id, listedUtc, retrievedAt = "2026-06-16T05:00:00Z") {
  return {
    id,
    type: "feed_listing",
    provider: "ScoreFeed",
    retrieved_at: retrievedAt,
    listed_kickoff_utc: listedUtc,
  };
}

// A claim defaulting to "6:00 PM ET on Saturday" (-> 22:00Z, delta +120).
function claim(over = {}) {
  return {
    mentions_kickoff: true,
    claimed_local_time: "18:00",
    tz_hint: "ET",
    tz_hint_verbatim: "ET",
    date_reference: { kind: "RELATIVE_WEEKDAY", verbatim: "Saturday", explicit_iso_date: null, weekday: "SAT" },
    is_change: false,
    is_postponement: false,
    is_rumor_or_tentative: false,
    is_tbc: false,
    is_broadcast_pick: false,
    opponent_mentioned: "Red Vale United",
    venue_or_city_mentioned: "New York",
    home_away_context: "SELF_HOME",
    verbatim_quote: "synthetic",
    extraction_confidence: 0.9,
    ...over,
  };
}

const weighSyn = (evidence) => weighFixture(FX, evidence, { now: NOW });

test("D1: a lone official change (even the league) caps at REVIEW, not CHANGE", () => {
  const v = weighSyn([
    { item: social("a", "@CSLeague", "2026-06-15T10:00:00Z"), claims: [claim({ is_change: true })] },
  ]);
  assert.equal(v.action, ACTION.REVIEW);
  assert.equal(v.confidence, CONFIDENCE.MEDIUM); // +2 authority +1 recency, no corroboration
});

test("D1: lone official + one independent fresh corroborator -> CHANGE/HIGH", () => {
  const v = weighSyn([
    { item: social("a", "@CSLeague", "2026-06-15T10:00:00Z"), claims: [claim({ is_change: true })] },
    { item: social("b", "@HarbourCityFC", "2026-06-15T11:00:00Z"), claims: [claim({ is_change: true })] },
  ]);
  assert.equal(v.action, ACTION.CHANGE_RECOMMENDED);
  assert.equal(v.confidence, CONFIDENCE.HIGH);
  assert.equal(v.resolved_kickoff_utc, "2026-06-20T22:00:00Z");
});

test("D2: two fresh officials disagree -> OFFICIAL_CONFLICT/REVIEW, both candidates, no winner", () => {
  const v = weighSyn([
    { item: social("a", "@HarbourCityFC", "2026-06-15T10:00:00Z"), claims: [claim({ claimed_local_time: "18:00", is_change: true })] },
    { item: social("b", "@CSLeague", "2026-06-15T11:00:00Z"), claims: [claim({ claimed_local_time: "18:30", is_change: true })] },
  ]);
  assert.equal(v.action, ACTION.REVIEW);
  assert.equal(v.resolved_kickoff_utc, null);
  assert.deepEqual(v.candidate_times, ["2026-06-20T22:00:00Z", "2026-06-20T22:30:00Z"]);
});

test("D3: a fresh TBC disclaimer dominates is_change -> REVIEW, time only a candidate", () => {
  const v = weighSyn([
    { item: social("a", "@CSLeague", "2026-06-15T10:00:00Z"), claims: [claim({ is_change: true, is_tbc: true })] },
  ]);
  assert.equal(v.action, ACTION.REVIEW);
  assert.equal(v.resolved_kickoff_utc, null);
  assert.deepEqual(v.candidate_times, ["2026-06-20T22:00:00Z"]);
});

test("same-account supersession: latest post wins, the prior is not a conflictor", () => {
  const v = weighSyn([
    { item: social("a", "@HarbourCityFC", "2026-06-15T10:00:00Z"), claims: [claim({ claimed_local_time: "19:00" })] },
    { item: social("b", "@HarbourCityFC", "2026-06-16T10:00:00Z"), claims: [claim({ claimed_local_time: "19:30", is_change: true })] },
  ]);
  assert.equal(v.action, ACTION.REVIEW); // lone account -> capped
  assert.equal(v.score_breakdown.conflict_penalty, 0); // superseded prior does NOT penalize
  assert.equal(v.delta_minutes, 210); // 23:30Z vs feed 20:00Z, the latest time wins
});

test("cross-source NEVER supersedes: same passive-then-move shape across accounts -> conflict", () => {
  const v = weighSyn([
    { item: social("a", "@HarbourCityFC", "2026-06-15T10:00:00Z"), claims: [claim({ claimed_local_time: "19:00" })] },
    { item: social("b", "@CSLeague", "2026-06-16T10:00:00Z"), claims: [claim({ claimed_local_time: "19:30", is_change: true })] },
  ]);
  assert.equal(v.action, ACTION.REVIEW);
  assert.equal(v.candidate_times.length, 2); // both surfaced, no recency winner across accounts
});

test("ScoreFeed alone never yields a confident change", () => {
  const v = weighSyn([{ item: feed("a", "2026-06-20T22:00:00Z"), claims: [] }]);
  assert.notEqual(v.action, ACTION.CHANGE_RECOMMENDED);
  assert.equal(v.confidence, CONFIDENCE.LOW);
});

test("freshness gate: stale official agreement -> INSUFFICIENT_EVIDENCE, never CONFIRMED", () => {
  // delta 0 (agrees with feed) but the post is well outside the fresh window.
  const stale = { ...FX, last_verified_at: "2026-05-01T00:00:00Z" };
  const v = weighFixture(
    stale,
    [{ item: social("a", "@HarbourCityFC", "2026-05-10T10:00:00Z"), claims: [claim({ claimed_local_time: "16:00" })] }],
    { now: NOW },
  );
  assert.equal(v.action, ACTION.INSUFFICIENT_EVIDENCE);
});

test("AM/PM sanity bound: an implausibly large move is flagged, not written", () => {
  // Two fresh officials agree, but on a time 12h off the feed (04:00 ET -> 08:00Z).
  const v = weighSyn([
    { item: social("a", "@HarbourCityFC", "2026-06-15T10:00:00Z"), claims: [claim({ claimed_local_time: "04:00", is_change: true })] },
    { item: social("b", "@CSLeague", "2026-06-15T11:00:00Z"), claims: [claim({ claimed_local_time: "04:00", is_change: true })] },
  ]);
  assert.equal(v.action, ACTION.REVIEW); // would be HIGH, but the delta guard holds it
  assert.match(v.why.join(" "), /implausibl|AM\/PM/i);
});

test("the canonical verdict shape is stable", async () => {
  const v = await weighGolden("fx-2201");
  for (const key of [
    "fixture_id",
    "action",
    "confidence",
    "score_breakdown",
    "current_kickoff_utc",
    "resolved_kickoff_utc",
    "delta_minutes",
    "candidate_times",
    "why",
    "sources_used",
    "dropped",
  ]) {
    assert.ok(key in v, `missing ${key}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DateTime } from "luxon";
import {
  wallClockToUtc,
  zoneFor,
  localDateFor,
  resolveKickoff,
} from "../src/domain/timezone.js";

test("fx-2201: 6:00 PM EDT (New York) -> 22:00Z", () => {
  assert.equal(
    wallClockToUtc({ date: "2026-06-20", time: "18:00", zone: "America/New_York" }),
    "2026-06-20T22:00:00Z",
  );
});

test("fx-2202 false conflict: 9 PM Eastern == 7 PM Denver == feed 01:00Z", () => {
  const eastern = wallClockToUtc({
    date: "2026-06-20",
    time: "21:00",
    zone: "America/New_York",
  });
  const denver = wallClockToUtc({
    date: "2026-06-20",
    time: "19:00",
    zone: "America/Denver",
  });
  assert.equal(eastern, "2026-06-21T01:00:00Z");
  assert.equal(denver, "2026-06-21T01:00:00Z");
  assert.equal(eastern, denver); // the "conflict" was only a pre-normalization artifact
});

test("fx-2209 Phoenix no-DST: 7 PM MST -> 02:00Z, and wrong-MDT would give 01:00Z", () => {
  const phoenix = wallClockToUtc({
    date: "2026-06-30",
    time: "19:00",
    zone: "America/Phoenix",
  });
  assert.equal(phoenix, "2026-07-01T02:00:00Z");

  // Regression guard: naively treating it as Mountain-with-DST (Denver) drops an
  // hour to 01:00Z. America/Phoenix = MST year-round is the whole point.
  const wrongDenver = wallClockToUtc({
    date: "2026-06-30",
    time: "19:00",
    zone: "America/Denver",
  });
  assert.equal(wrongDenver, "2026-07-01T01:00:00Z");
  assert.notEqual(phoenix, wrongDenver);
});

test("fx-2205 date-roll: 6:30 PM PDT (LA) -> next-day 01:30Z", () => {
  assert.equal(
    wallClockToUtc({ date: "2026-06-27", time: "18:30", zone: "America/Los_Angeles" }),
    "2026-06-28T01:30:00Z",
  );
});

test("date-then-UTC invariant: local date resolved before the UTC midnight roll", () => {
  // Local stays the 30th; only the UTC instant crosses into the 1st.
  assert.equal(
    wallClockToUtc({ date: "2026-06-30", time: "23:30", zone: "America/Phoenix" }),
    "2026-07-01T06:30:00Z",
  );
});

test("zoneFor: abbreviations, verbatim city, and venue fallback", () => {
  assert.equal(zoneFor("ET", null, "America/Chicago").zone, "America/New_York");
  assert.equal(zoneFor("PT", null, "America/Chicago").zone, "America/Los_Angeles");
  assert.equal(
    zoneFor("EXPLICIT_CITY", "hora de Denver", "America/Chicago").zone,
    "America/Denver",
  );
  assert.equal(
    zoneFor("OTHER_EXPLICIT", "Eastern", "America/Chicago").zone,
    "America/New_York",
  );
  const fallback = zoneFor("NONE", null, "America/Phoenix");
  assert.equal(fallback.zone, "America/Phoenix");
  assert.equal(fallback.source, "venue_default");
});

test("localDateFor: explicit date, weekday resolution, and schedule fallback", () => {
  const anchor = DateTime.fromObject(
    { year: 2026, month: 6, day: 20 },
    { zone: "America/New_York" },
  ); // a Saturday
  assert.equal(
    localDateFor({ kind: "EXPLICIT_DATE", explicitIsoDate: "2026-06-22" }, anchor),
    "2026-06-22",
  );
  assert.equal(
    localDateFor({ kind: "RELATIVE_WEEKDAY", weekday: "SAT" }, anchor),
    "2026-06-20",
  );
  assert.equal(localDateFor({ kind: "NONE" }, anchor), "2026-06-20");
});

test("resolveKickoff composes zone + date + wall clock against real fixture data", async () => {
  const fixtures = JSON.parse(
    await readFile("test/fixtures/fixtures.json", "utf8"),
  ).fixtures;
  const fx = fixtures.find((f) => f.id === "fx-2202");
  const claim = {
    claimed_local_time: "19:00",
    tz_hint: "EXPLICIT_CITY",
    tz_hint_verbatim: "hora de Denver",
    date_reference: { kind: "RELATIVE_WEEKDAY", weekday: "SAT", explicit_iso_date: null },
  };
  const resolved = resolveKickoff(claim, fx);
  assert.equal(resolved.utc, "2026-06-21T01:00:00Z");
  assert.equal(resolved.zone, "America/Denver");
  assert.equal(resolved.localDate, "2026-06-20");
});

test("resolveKickoff returns utc:null when the claim asserts no time", () => {
  const fx = { venue: { timezone: "America/New_York" }, kickoff_utc: "2026-06-20T20:00:00Z" };
  assert.equal(resolveKickoff({ claimed_local_time: null }, fx).utc, null);
});

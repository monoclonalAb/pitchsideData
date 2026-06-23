import { test } from "node:test";
import assert from "node:assert/strict";
import { weighFixture } from "../src/domain/weigh.js";
import { buildReport, serializeReport } from "../src/report/json.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { renderConsole } from "../src/report/console.js";
import { loadFixtures, loadBundle, REFERENCE_NOW } from "./helpers/replay.js";
import { ACTION } from "../src/config.js";

async function buildNineFixtureReport() {
  const items = [];
  for (const fx of await loadFixtures()) {
    const { fixture, evidenceWithClaims } = await loadBundle(fx.id);
    items.push({ fixture, verdict: weighFixture(fixture, evidenceWithClaims, { now: REFERENCE_NOW }) });
  }
  return buildReport(items);
}

test("summary counts the nine fixtures by action", async () => {
  const report = await buildNineFixtureReport();
  assert.deepEqual(report.summary, {
    change_recommended: 3, // 2201, 2207, 2209
    review: 3, // 2204, 2205, 2208
    postponed_or_cancelled: 1, // 2203
    confirmed: 1, // 2202
    monitor: 1, // 2206
    insufficient_evidence: 0,
    could_not_assess: 0,
    actionable: 7,
    over_budget: true, // 7 > the ~5/day ceiling
  });
});

test("fixtures are ranked: actionable items lead, low-priority trails", async () => {
  const report = await buildNineFixtureReport();
  const rankOf = (a) =>
    [
      ACTION.CHANGE_RECOMMENDED,
      ACTION.REVIEW,
      ACTION.POSTPONED_OR_CANCELLED,
      ACTION.COULD_NOT_ASSESS,
      ACTION.CONFIRMED,
      ACTION.MONITOR,
      ACTION.INSUFFICIENT_EVIDENCE,
    ].indexOf(a);
  const ranks = report.fixtures.map((f) => rankOf(f.action));
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y), "actions must be non-decreasing in priority");
  // High-blast-radius first, status-quo last.
  assert.equal(report.fixtures[0].action, ACTION.CHANGE_RECOMMENDED);
  assert.equal(report.fixtures.at(-1).action, ACTION.MONITOR);
});

test("postponed fixture leaks NO copyable new time in any artifact", async () => {
  const report = await buildNineFixtureReport();
  const fx2203 = report.fixtures.find((f) => f.fixture_id === "fx-2203");
  assert.equal(fx2203.resolved_kickoff_utc, null);
  assert.deepEqual(fx2203.candidate_times, []);

  // The normalized postponed instant (2026-07-09T..Z) must appear nowhere.
  const leak = "2026-07-09";
  const json = serializeReport(report);
  const md = renderMarkdown(report);
  const console = renderConsole(report);
  assert.ok(!json.includes(leak), "json leaks a postponed time");
  assert.ok(!md.includes(leak), "markdown leaks a postponed time");
  assert.ok(!console.includes(leak), "console leaks a postponed time");
  assert.match(md, /reschedule -> league resequencing/);
});

test("markdown surfaces the triage summary, budget banner, and a dropped-evidence line", async () => {
  const report = await buildNineFixtureReport();
  const md = renderMarkdown(report);
  assert.match(md, /3 change-rec . 3 review . 1 postponed/);
  assert.match(md, /actionable flags exceed/);
  assert.match(md, /Dropped evidence:.*Fogline/); // fx-2207 distractor surfaced
});

test("a clash renders both candidate times side by side, never a resolved one", async () => {
  const report = await buildNineFixtureReport();
  const md = renderMarkdown(report);
  // fx-2205 block: both candidates present, no "analyst applies" copyable time.
  const block = md.split("---").find((b) => b.includes("fx-2205"));
  assert.ok(block.includes("2026-06-28T01:00:00Z"));
  assert.ok(block.includes("2026-06-28T01:30:00Z"));
  assert.ok(!block.includes("analyst applies"));
});

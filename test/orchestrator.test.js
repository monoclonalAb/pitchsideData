import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFixture, run, makeReplayExtractor } from "../src/index.js";
import { loadFixtures, REFERENCE_NOW } from "./helpers/replay.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACTION } from "../src/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Real getEvidence backed by the captured golden, for offline end-to-end runs.
async function goldenGetEvidence(fixtureId) {
  const { evidence } = JSON.parse(
    await readFile(join(ROOT, "test", "fixtures", "evidence", `${fixtureId}.json`), "utf8"),
  );
  return evidence;
}

test("a failed evidence fetch degrades to COULD_NOT_ASSESS, never a crash", async () => {
  const fixture = { id: "fx-x", kickoff_utc: "2026-06-20T20:00:00Z", venue: { timezone: "America/New_York" } };
  const failing = async () => {
    throw new Error("503 after retries");
  };
  const { verdict } = await assessFixture(fixture, {
    getEvidence: failing,
    extract: makeReplayExtractor(),
    now: REFERENCE_NOW,
  });
  assert.equal(verdict.action, ACTION.COULD_NOT_ASSESS);
  assert.equal(verdict.resolved_kickoff_utc, null);
  assert.match(verdict.why[0], /503/);
});

test("run() assembles, ranks, writes both artifacts, and prints the triage", async () => {
  const fixtures = await loadFixtures();
  const writes = {};
  const logs = [];
  const report = await run({
    getFixtures: async () => fixtures,
    getEvidence: goldenGetEvidence,
    extract: makeReplayExtractor(),
    now: REFERENCE_NOW,
    write: (path, contents) => {
      writes[path] = contents;
    },
    log: (line) => logs.push(line),
  });

  // Same nine-fixture verdicts as the weigh spec, now end to end through I/O.
  assert.equal(report.summary.change_recommended, 3);
  assert.equal(report.summary.review, 3);
  assert.equal(report.summary.postponed_or_cancelled, 1);
  assert.equal(report.summary.confirmed, 1);
  assert.equal(report.summary.monitor, 1);

  assert.ok(writes["report.json"], "report.json written");
  assert.ok(writes["REPORT.md"], "REPORT.md written");
  assert.ok(JSON.parse(writes["report.json"]).fixtures.length === 9);
  assert.match(logs.join("\n"), /change-rec/);
});

test("a fixtures-feed failure propagates (hard stop), not a partial report", async () => {
  await assert.rejects(
    () =>
      run({
        getFixtures: async () => {
          throw new Error("feed unreachable");
        },
        getEvidence: goldenGetEvidence,
        extract: makeReplayExtractor(),
        now: REFERENCE_NOW,
        write: () => {},
        log: () => {},
      }),
    /feed unreachable/,
  );
});

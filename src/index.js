import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFixtures, getEvidence } from "./api/pitchsideApi.js";
import { weighFixture } from "./domain/weigh.js";
import { buildReport, serializeReport } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderConsole } from "./report/console.js";
import { ACTION, CONFIDENCE, requireBaseUrl } from "./config.js";
import { makeLiveExtractor } from "./llm/extractor.js";

/* =========================================================================
 * index.js - the orchestrator.
 *
 *   config -> getFixtures -> for each: getEvidence -> extract -> weigh
 *          -> rank + summarize -> write REPORT.md + report.json -> print.
 *
 * Resilience is a reported OUTCOME, not a crash: a fixture whose evidence fetch
 * fails after retries becomes COULD_NOT_ASSESS (never a silent NO_CHANGE). The
 * only hard failure is the fixtures feed itself being unreachable (nothing to
 * iterate), which exits non-zero with a clean message.
 *
 * Extraction is injected. The default replays the recorded extractions (free,
 * deterministic, no live model), so `npm start` runs the live API end to end
 * without spend. A live OpenAI extractor is a drop-in for the same seam.
 * ========================================================================= */

const here = dirname(fileURLToPath(import.meta.url));
const EXTRACTIONS_DIR = join(here, "..", "test", "extractions");

// Replay extractor: turn an evidence item into claims from its recorded
// extraction. feed_listings carry no free text and are handled by weigh.
export function makeReplayExtractor(dir = EXTRACTIONS_DIR) {
  return async function extract(item) {
    if (item.type === "feed_listing") return [];
    try {
      const env = JSON.parse(await readFile(join(dir, `${item.id}.json`), "utf8"));
      return env.usable ? (env.claims ?? []) : [];
    } catch {
      return []; // no recording for this item; it simply contributes nothing
    }
  };
}

function couldNotAssess(fixture, err) {
  return {
    fixture_id: fixture.id,
    action: ACTION.COULD_NOT_ASSESS,
    confidence: CONFIDENCE.LOW,
    score_breakdown: null,
    current_kickoff_utc: fixture.kickoff_utc,
    resolved_kickoff_utc: null,
    delta_minutes: null,
    candidate_times: [],
    why: [`evidence fetch failed after retries: ${err.message}`],
    sources_used: [],
    dropped: [],
  };
}

// Assess one fixture. A failed evidence fetch degrades to COULD_NOT_ASSESS.
export async function assessFixture(fixture, { getEvidence: fetchEvidence, extract, now }) {
  let evidence;
  try {
    evidence = await fetchEvidence(fixture.id);
  } catch (err) {
    return { fixture, verdict: couldNotAssess(fixture, err) };
  }
  const evidenceWithClaims = [];
  for (const item of evidence) {
    evidenceWithClaims.push({ item, claims: await extract(item, fixture) });
  }
  return { fixture, verdict: weighFixture(fixture, evidenceWithClaims, { now }) };
}

// Run the whole pipeline with injected dependencies (testable offline).
export async function run(deps) {
  const { getFixtures: fetchFixtures, getEvidence: fetchEvidence, extract, now, write, log } = deps;
  const fixtures = await fetchFixtures(); // throws -> handled by caller (hard stop)

  const items = [];
  for (const fixture of fixtures) {
    items.push(await assessFixture(fixture, { getEvidence: fetchEvidence, extract, now }));
  }

  const report = buildReport(items, { generatedAt: now });
  await write("report.json", serializeReport(report));
  await write("REPORT.md", renderMarkdown(report));
  log(renderConsole(report));
  return report;
}

async function main() {
  requireBaseUrl();
  // Real wall clock by default; NOW pins it (e.g. to replay the golden run date).
  const now = process.env.NOW ?? new Date().toISOString();
  // Live OpenAI extraction by default; EXTRACTOR=replay reuses recorded golden.
  const extract =
    process.env.EXTRACTOR === "replay" ? makeReplayExtractor() : makeLiveExtractor();
  try {
    await run({
      getFixtures,
      getEvidence,
      extract,
      now,
      write: (path, contents) => writeFile(join(process.cwd(), path), contents, "utf8"),
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`fatal: cannot reach the fixtures feed (${err.message}); nothing to assess.`);
    process.exitCode = 1;
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

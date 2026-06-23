import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchJson } from "../src/api/pitchsideApi.js";

/* =========================================================================
 * capture.js - one-shot golden capture.
 *
 * Pulls the live /fixtures list and every /fixtures/{id}/evidence payload and
 * writes them verbatim into test/fixtures/, so the whole pipeline can replay
 * offline and deterministically. Run once with `npm run capture`.
 *
 * It wraps fetch with a per-request attempt counter so the flaky gateway's
 * retries (e.g. the known fx-2206 503-then-200) are visible during capture.
 * ========================================================================= */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "..", "test", "fixtures");
const EVIDENCE_DIR = join(FIXTURES_DIR, "evidence");

function countingFetch() {
  let count = 0;
  const fn = async (url, opts) => {
    count += 1;
    return globalThis.fetch(url, opts);
  };
  fn.reset = () => {
    count = 0;
  };
  fn.count = () => count;
  return fn;
}

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const fetchImpl = countingFetch();

  // 1) Fixtures list.
  fetchImpl.reset();
  const fixturesBody = await fetchJson("/fixtures", { fetchImpl });
  await writeJson(join(FIXTURES_DIR, "fixtures.json"), fixturesBody);
  const fixtures = fixturesBody.fixtures;
  console.log(
    `fixtures: ${fixtures.length} captured (${fetchImpl.count()} fetch attempt(s))`,
  );

  // 2) Evidence per fixture.
  const retried = [];
  for (const fx of fixtures) {
    fetchImpl.reset();
    const body = await fetchJson(`/fixtures/${fx.id}/evidence`, { fetchImpl });
    await writeJson(join(EVIDENCE_DIR, `${fx.id}.json`), body);
    const attempts = fetchImpl.count();
    if (attempts > 1) retried.push(`${fx.id} (${attempts})`);
    const note = attempts > 1 ? `  <- RETRIED (${attempts} attempts)` : "";
    console.log(`  ${fx.id}: ${body.evidence.length} evidence item(s)${note}`);
  }

  console.log(
    `\nDone. ${fixtures.length} evidence files written to test/fixtures/evidence/.`,
  );
  console.log(
    retried.length
      ? `Observed gateway retries on: ${retried.join(", ")}`
      : "No retries needed this run (gateway healthy); the retry path is covered by httpClient tests.",
  );
}

main().catch((err) => {
  console.error("capture failed:", err.message);
  process.exitCode = 1;
});

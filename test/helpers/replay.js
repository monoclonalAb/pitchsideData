import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* Replay helper: assemble a fixture's { fixture, evidenceWithClaims } bundle from
 * the captured golden payloads + recorded extractions, exactly as the live
 * pipeline would after fetch + extract, but offline and deterministic. */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const FIXTURES = join(ROOT, "test", "fixtures");
const EXTRACTIONS = join(ROOT, "test", "extractions");

// The plan's stated run date, where the decisive evidence is fresh.
export const REFERENCE_NOW = "2026-06-21T00:00:00Z";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadFixtures() {
  return (await readJson(join(FIXTURES, "fixtures.json"))).fixtures;
}

export async function loadBundle(fixtureId) {
  const fixtures = await loadFixtures();
  const fixture = fixtures.find((f) => f.id === fixtureId);
  const { evidence } = await readJson(join(FIXTURES, "evidence", `${fixtureId}.json`));

  const evidenceWithClaims = [];
  for (const item of evidence) {
    let claims = [];
    if (item.type !== "feed_listing") {
      try {
        const env = await readJson(join(EXTRACTIONS, `${item.id}.json`));
        claims = env.usable ? (env.claims ?? []) : [];
      } catch {
        claims = []; // no recorded extraction for this item
      }
    }
    evidenceWithClaims.push({ item, claims });
  }
  return { fixture, evidenceWithClaims };
}

import OpenAI from "openai";
import { OPENAI_MODEL, requireOpenAIKey } from "../config.js";
import { EXTRACTION_SCHEMA, buildSystemPrompt, buildUserPrompt } from "./prompt.js";

/* =========================================================================
 * extractor.js - the live OpenAI extraction layer.
 *
 * Only free text hits the model (social_post.text, web_page.title+snippet);
 * feed_listings skip it entirely. The call is temperature:0 with Structured
 * Outputs for a guaranteed shape, and code enforces anti-hallucination
 * guardrails AFTER extraction: a quote must be a real substring, and a claimed
 * time must actually appear as a time token in the text, or it is dropped.
 * ========================================================================= */

export function buildSourceText(item) {
  if (item.type === "social_post") return item.text ?? "";
  if (item.type === "web_page") return [item.title, item.snippet].filter(Boolean).join("\n");
  return "";
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// All time tokens in the text, normalized to "HH:MM". Bare numbers (no am/pm)
// admit both readings, since the guard only needs to confirm a time was stated.
function timeTokens(text) {
  const out = new Set();
  const re = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi;
  const fmt = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  let match;
  while ((match = re.exec(text)) !== null) {
    const h = Number(match[1]);
    const m = match[2] ? Number(match[2]) : 0;
    if (h > 23 || m > 59) continue;
    const ap = match[3] ? match[3].toLowerCase().replace(/\./g, "") : null;
    if (ap === "pm") out.add(fmt(h === 12 ? 12 : h + 12, m));
    else if (ap === "am") out.add(fmt(h === 12 ? 0 : h, m));
    else {
      out.add(fmt(h, m));
      if (h <= 11) out.add(fmt(h + 12, m));
    }
  }
  return out;
}

// Drop claims the text does not support; null a time the text does not contain.
export function applyGuardrails(claims, text) {
  const tokens = timeTokens(text);
  const kept = [];
  for (const claim of claims ?? []) {
    if (!claim.verbatim_quote) continue;
    if (!normalizeWhitespace(text).includes(normalizeWhitespace(claim.verbatim_quote))) continue;
    if (claim.claimed_local_time && !tokens.has(claim.claimed_local_time)) {
      kept.push({ ...claim, claimed_local_time: null });
    } else {
      kept.push(claim);
    }
  }
  return kept;
}

export function makeOpenAIClient() {
  return new OpenAI({ apiKey: requireOpenAIKey() });
}

function envelope(item, fixture, fields) {
  return {
    evidence_id: item.id,
    fixture_id: fixture.id,
    type: item.type,
    usable: false,
    model: null,
    claims: [],
    ...fields,
  };
}

// Extract one evidence item into the recorded envelope shape.
export async function extractEvidence(item, fixture, { client, model = OPENAI_MODEL } = {}) {
  if (item.type === "feed_listing") {
    return envelope(item, fixture, { usable: true }); // structured already; weigh handles it
  }
  const text = buildSourceText(item);
  if (!text.trim()) return envelope(item, fixture, { usable: false, model });

  const oa = client ?? makeOpenAIClient();
  try {
    const response = await oa.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(item, fixture, text) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "kickoff_claims", strict: true, schema: EXTRACTION_SCHEMA },
      },
    });
    const message = response.choices?.[0]?.message;
    if (message?.refusal) return envelope(item, fixture, { usable: false, model });
    const parsed = JSON.parse(message?.content ?? "{}");
    const claims = applyGuardrails(parsed.claims ?? [], text);
    return envelope(item, fixture, { usable: true, model, claims });
  } catch {
    // Schema-invalid / API error / refusal -> zero claims, never a fabricated time.
    return envelope(item, fixture, { usable: false, model });
  }
}

// The extract(item, fixture) -> claims[] seam the orchestrator injects. One
// client is reused across the run.
export function makeLiveExtractor({ client, model } = {}) {
  const oa = client ?? makeOpenAIClient();
  return async (item, fixture) => (await extractEvidence(item, fixture, { client: oa, model })).claims;
}

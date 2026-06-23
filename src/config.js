import "dotenv/config";

/* =========================================================================
 * config.js - single source of truth for every tunable.
 *
 * Nothing here *decides* anything; it only holds the numbers and small pure
 * helpers (tierRank, band, corroborationPoints) that the deterministic
 * pipeline reads. Keeping all magic numbers in one file is what makes every
 * verdict auditable and tunable.
 *
 * Confidence is the integer-additive model. The 0–1 TRUST_SCORE map is
 * provenance + the source TIER_RANK is derived from - NOT a confidence surface.
 * ========================================================================= */

// ---------------------------------------------------------------------------
// Environment (secrets via dotenv; never hardcode the key, never commit .env).
// Fail-fast is LAZY - exposed as require*() helpers called only on the live
// paths (extractor, capture, `npm start`), so offline unit tests need no key.
// ---------------------------------------------------------------------------
export const BASE_URL = process.env.BASE_URL; // Pitchside fixtures API base
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini"; // pinned; called at temperature:0

export function getOpenAIKey() {
  return process.env.OPENAI_API_KEY ?? null;
}

/** Fail-fast accessor for the OpenAI key - live extraction paths only. */
export function requireOpenAIKey() {
  const key = getOpenAIKey();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is missing - copy .env.example to .env and set it. " +
        "(NOTE: the key shipped in the brief is treated as compromised; rotate it.)",
    );
  }
  return key;
}

/** Fail-fast accessor for the fixtures API base. */
export function requireBaseUrl() {
  if (!BASE_URL) {
    throw new Error("BASE_URL is missing - set it in .env (see .env.example).");
  }
  return BASE_URL;
}

// ---------------------------------------------------------------------------
// Source trust tiers - (Sam-call-2 numbers).
//   TRUST_SCORE (0–1) is Sam's canonical provenance number and the ONLY source
//   TIER_RANK (winner-selection) derives from. AUTHORITY collapses every fresh
//   official to ONE band (+2) on purpose: the club>league>club-site ordering
//   lives in TIER_RANK, never in the band magnitude.
// ---------------------------------------------------------------------------
export const TIER = Object.freeze({
  CLUB_SOCIAL: "CLUB_SOCIAL",
  LEAGUE: "LEAGUE",
  CLUB_WEBSITE: "CLUB_WEBSITE",
  SCOREFEED: "SCOREFEED",
  BLOG: "BLOG",
  FAN: "FAN",
});

export const TRUST_SCORE = Object.freeze({
  [TIER.CLUB_SOCIAL]: 0.9, // verified club account, name-matched - default top authority
  [TIER.LEAGUE]: 0.85, // official league account/site (→ 0.95 for a TV-pick, below)
  [TIER.CLUB_WEBSITE]: 0.8, // club's own site - official but slower/less explicit than its social
  [TIER.SCOREFEED]: 0.4, // aggregator - corroborates, never originates
  [TIER.BLOG]: 0.1, // 3rd-party preview blog
  [TIER.FAN]: 0.1, // unverified / not name-matched ("Ultras", "supporters")
});

// A FRESH league broadcast/TV-pick slot announcement lifts the league to the
// strongest SINGLE signal - but only TIER_RANK/provenance, never the AUTHORITY
// band, and it never bypasses OFFICIAL_CONFLICT.
export const LEAGUE_TV_PICK_TRUST = 0.95;

// AUTHORITY band per tier: every fresh official = +2; ScoreFeed = +1; noise = 0.
export const AUTHORITY = Object.freeze({
  [TIER.CLUB_SOCIAL]: 2,
  [TIER.LEAGUE]: 2,
  [TIER.CLUB_WEBSITE]: 2,
  [TIER.SCOREFEED]: 1,
  [TIER.BLOG]: 0,
  [TIER.FAN]: 0,
});

// The "fresh official" set the gates key off: CONFIRMED corroboration,
// postponement authority, and OFFICIAL_CONFLICT participants.
export const OFFICIAL_TIERS = Object.freeze([
  TIER.CLUB_SOCIAL,
  TIER.LEAGUE,
  TIER.CLUB_WEBSITE,
]);

export function isOfficialTier(tier) {
  return OFFICIAL_TIERS.includes(tier);
}

/**
 * TIER_RANK - winner-selection ordering among NON-conflicting sources.
 * Higher = preferred representative. Derived straight from TRUST_SCORE, with the
 * TV-pick conditional. It NEVER resolves a fresh official-vs-official conflict
 *.
 */
export function tierRank(tier, { isBroadcastPick = false } = {}) {
  if (tier === TIER.LEAGUE && isBroadcastPick) return LEAGUE_TV_PICK_TRUST;
  return TRUST_SCORE[tier] ?? 0;
}

// ---------------------------------------------------------------------------
// Confidence - integer additive model:
//   score = AUTHORITY + CORROBORATION + RECENCY_CLARITY − TENTATIVE − CONFLICT
// ---------------------------------------------------------------------------
export const RECENCY_CLARITY = 1; // winning claim definitive AND (move-signal OR uncontested)
export const TENTATIVE_PENALTY = 3; // winning evidence is rumor/tentative
export const CONFLICT_PENALTY = 2; // a fresh DIFFERENT-account representative disagrees on resolved UTC (an account never self-conflicts)

/** CORROBORATION points from the count of INDEPENDENT agreeing sources. */
export function corroborationPoints(independentAgreeingCount) {
  if (independentAgreeingCount >= 3) return 2;
  if (independentAgreeingCount === 2) return 1;
  return 0;
}

// Confidence bands: HIGH ≥ 4 · MEDIUM 2–3 · LOW ≤ 1.
export const CONFIDENCE = Object.freeze({
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

export function band(score) {
  if (score >= 4) return CONFIDENCE.HIGH;
  if (score >= 2) return CONFIDENCE.MEDIUM;
  return CONFIDENCE.LOW;
}

// ---------------------------------------------------------------------------
// Freshness window.
//   fresh(claim) ≡ (now − posted_at ≤ FRESH_WINDOW_DAYS) AND posted_at > last_verified_at
//   No supersession margin: each account collapses to its single most-recent
//   kickoff claim (its "representative position"), so an account never conflicts
//   with itself and a rapid self-correction is treated as a settled position.
//   The lone-source safeguard is SINGLE_SOURCE_CAP (a lone official → REVIEW),
//   not a time-based margin.
// ---------------------------------------------------------------------------
export const FRESH_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// HTTP resilience - the flaky gateway.
// ---------------------------------------------------------------------------
export const HTTP = Object.freeze({
  TIMEOUT_MS: 5000, // AbortController - slow-but-alive gateway; too tight self-inflicts failures
  MAX_ATTEMPTS: 3, // 1 + 2 retries
  BACKOFF_BASE_MS: 300,
  BACKOFF_CAP_MS: 4000,
  RETRYABLE_STATUS: Object.freeze([502, 503, 504, 429]),
  FATAL_STATUS: Object.freeze([400, 401, 403, 404, 422]),
});

// ---------------------------------------------------------------------------
// Action vocabulary - the canonical set report.json emits.
// ---------------------------------------------------------------------------
export const ACTION = Object.freeze({
  CONFIRMED: "CONFIRMED",
  CHANGE_RECOMMENDED: "CHANGE_RECOMMENDED",
  POSTPONED_OR_CANCELLED: "POSTPONED_OR_CANCELLED",
  REVIEW: "REVIEW",
  MONITOR: "MONITOR",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  COULD_NOT_ASSESS: "COULD_NOT_ASSESS",
});

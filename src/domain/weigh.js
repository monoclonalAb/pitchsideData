import {
  ACTION,
  CONFIDENCE,
  AUTHORITY,
  RECENCY_CLARITY,
  TENTATIVE_PENALTY,
  CONFLICT_PENALTY,
  corroborationPoints,
  band,
  tierRank,
  isOfficialTier,
  FRESH_WINDOW_DAYS,
} from "../config.js";
import { classifySource } from "./sources.js";
import { resolveKickoff } from "./timezone.js";
import { keepClaim } from "./relevance.js";

/* =========================================================================
 * weigh.js - the decider. Evidence + claims in, one auditable Verdict out.
 *
 * Two freshness senses, both used (see config fresh definition):
 *   isNew   = posted_at > last_verified_at        ("new since we last checked")
 *             drives ACTIONABILITY: postponement, change, conflict, review.
 *   isFresh = isNew AND within FRESH_WINDOW_DAYS   ("recent enough to trust now")
 *             drives CONFIRMED and the >=2-source change cap.
 * A feed_listing is never on the recency axis: it corroborates the status quo
 * but never originates, and never counts as new.
 *
 * Sources are de-duplicated by ACCOUNT/CHANNEL identity (handle / domain /
 * provider): a club's social and its website are two corroborating channels,
 * but two posts from one account are one source (and can self-supersede).
 *
 * Gate order: relevance -> tier -> freshness -> POSTPONEMENT -> OFFICIAL_CONFLICT
 * -> TBC dominance -> single-source cap -> CONFIRMED freshness -> bands -> action.
 * ========================================================================= */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
// A non-postponement kickoff move larger than this is suspect: an AM/PM misread
// is exactly 12h. Flag it for a human rather than write it. Real moves are minutes.
const MAX_PLAUSIBLE_DELTA_MINUTES = 6 * 60;

function toMs(t) {
  if (t == null) return null;
  return typeof t === "number" ? t : Date.parse(t);
}

function accountKey(item) {
  if (item.type === "social_post") {
    return "h:" + String(item.account?.handle ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  if (item.type === "web_page") {
    try {
      return "d:" + new URL(item.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "d:" + String(item.url ?? "");
    }
  }
  if (item.type === "feed_listing") return "f:" + String(item.provider ?? "feed");
  return "x:" + String(item.id ?? "");
}

// Distinct account identities among a set of signals.
function distinctKeys(signals) {
  return new Set(signals.map((s) => s.key)).size;
}

// Build one signal per feed listing and per kept claim.
function buildSignals(fixture, evidenceWithClaims, nowMs, dropped) {
  const lastVerifiedMs = toMs(fixture.last_verified_at);
  const signals = [];

  for (const { item, claims } of evidenceWithClaims) {
    const src = classifySource(item, fixture);
    const key = accountKey(item);

    if (item.type === "feed_listing") {
      signals.push({
        id: item.id,
        tier: src.tier,
        src,
        key,
        utc: item.listed_kickoff_utc ?? null,
        assertedAt: null,
        isNew: false,
        isFresh: false,
        isFeed: true,
        isOfficial: false,
        isChange: false,
        isPostponement: false,
        isTentative: false,
        isTbc: false,
        rank: tierRank(src.tier),
        superseded: false,
        quote: null,
        label: src.label,
      });
      continue;
    }

    const assertedAt = toMs(item.posted_at ?? item.fetched_at ?? null);
    const isNew = assertedAt != null && assertedAt > lastVerifiedMs;
    const isFresh = isNew && nowMs - assertedAt <= FRESH_WINDOW_DAYS * DAY_MS;

    for (const claim of claims ?? []) {
      const relevance = keepClaim(claim, fixture);
      if (!relevance.keep) {
        dropped.push({
          evidenceId: item.id,
          reason: relevance.reason,
          quote: claim.verbatim_quote ?? null,
        });
        continue;
      }
      const resolved = resolveKickoff(claim, fixture);
      signals.push({
        id: item.id,
        tier: src.tier,
        src,
        key,
        utc: resolved.utc,
        resolved,
        assertedAt,
        isNew,
        isFresh,
        isFeed: false,
        isOfficial: isOfficialTier(src.tier),
        isChange: !!claim.is_change,
        isPostponement: !!claim.is_postponement,
        isTentative: !!claim.is_rumor_or_tentative,
        isTbc: !!claim.is_tbc,
        rank: tierRank(src.tier, { isBroadcastPick: !!claim.is_broadcast_pick }),
        superseded: false,
        quote: claim.verbatim_quote ?? null,
        label: src.label,
      });
    }
  }
  return signals;
}

// Same-account self-correction is the ONLY supersession: each account collapses
// to its single most-recent time-bearing claim, so a later post silently
// corrects the same account's earlier one. The superseded prior is exempt from
// conflict and excluded from corroboration. Cross-account disagreement is never
// a supersession; it is a conflict.
function markSupersessions(signals) {
  const byKey = new Map();
  for (const s of signals) {
    if (s.isFeed || s.utc == null) continue;
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.assertedAt - b.assertedAt);
    const latest = group[group.length - 1];
    for (const s of group) {
      if (s !== latest) s.superseded = true;
    }
  }
}

function verdict(fixture, fields) {
  return {
    fixture_id: fixture.id,
    action: fields.action,
    confidence: fields.confidence ?? CONFIDENCE.LOW,
    score_breakdown: fields.breakdown ?? null,
    current_kickoff_utc: fixture.kickoff_utc,
    resolved_kickoff_utc: fields.resolved ?? null,
    delta_minutes: fields.deltaMinutes ?? null,
    candidate_times: fields.candidateTimes ?? [],
    why: fields.why ?? [],
    sources_used: fields.sourcesUsed ?? [],
    dropped: fields.dropped ?? [],
  };
}

function sourceLine(s) {
  return {
    evidence_id: s.id,
    tier: s.tier,
    trust_score: s.src.trustScore,
    utc: s.utc ?? null,
    posted_at: s.assertedAt ? new Date(s.assertedAt).toISOString() : null,
    label: s.label,
    quote: s.quote,
  };
}

/**
 * Weigh one fixture. evidenceWithClaims is [{ item, claims }]; feed_listings
 * carry claims:[]. Pass { now } (Date/ISO/ms) to pin the run time in tests.
 */
export function weighFixture(fixture, evidenceWithClaims, { now = Date.now() } = {}) {
  const nowMs = toMs(now);
  const feedUtc = fixture.kickoff_utc;
  const dropped = [];
  const signals = buildSignals(fixture, evidenceWithClaims, nowMs, dropped);
  markSupersessions(signals);

  const live = signals.filter((s) => !s.superseded);
  const liveClaims = live.filter((s) => !s.isFeed);

  // --- Gate 1: postponement short-circuit (fresh official, relevance-passed) ---
  const postponements = liveClaims.filter(
    (s) => s.isPostponement && s.isOfficial && s.isNew,
  );
  if (postponements.length) {
    const latestPostpone = Math.max(...postponements.map((s) => s.assertedAt));
    const laterOn = liveClaims.some(
      (s) => !s.isPostponement && s.isOfficial && s.isNew && s.assertedAt > latestPostpone,
    );
    if (!laterOn) {
      return verdict(fixture, {
        action: ACTION.POSTPONED_OR_CANCELLED,
        confidence: CONFIDENCE.LOW,
        resolved: null,
        deltaMinutes: null,
        candidateTimes: [], // hard stop: never a copyable time
        why: [
          "fresh official postponement; reschedules re-enter via league resequencing",
          ...postponements.map((s) => `${s.label}: "${s.quote}"`),
        ],
        // Hard stop: receipts are the verbatim quotes ONLY. Null the normalized
        // time so no copyable kickoff for a postponed fixture appears anywhere.
        sourcesUsed: postponements.map((s) => ({ ...sourceLine(s), utc: null })),
        dropped,
      });
    }
  }

  // --- Gate 2: official-vs-official conflict (cross-account, fresh, disagree) ---
  const officialTimed = liveClaims.filter((s) => s.isOfficial && s.isNew && s.utc);
  const officialTimes = [...new Set(officialTimed.map((s) => s.utc))];
  if (officialTimes.length >= 2 && distinctKeys(officialTimed) >= 2) {
    const rep = officialTimed.reduce((a, b) => (b.rank > a.rank ? b : a));
    const score =
      AUTHORITY[rep.tier] +
      (officialTimed.some((s) => s.isChange) ? RECENCY_CLARITY : 0) -
      CONFLICT_PENALTY;
    return verdict(fixture, {
      action: ACTION.REVIEW,
      confidence: band(score),
      breakdown: {
        score,
        authority: AUTHORITY[rep.tier],
        corroboration: 0,
        recency_clarity: officialTimed.some((s) => s.isChange) ? RECENCY_CLARITY : 0,
        conflict_penalty: CONFLICT_PENALTY,
        note: "OFFICIAL_CONFLICT: two fresh officials disagree; tool never picks a winner",
      },
      resolved: null,
      deltaMinutes: null,
      candidateTimes: officialTimes.slice().sort(),
      why: [
        "two fresh official sources disagree on the resolved kickoff; human confirm",
        ...officialTimed.map((s) => `${s.label}: ${s.utc} "${s.quote}"`),
      ],
      sourcesUsed: officialTimed.map(sourceLine),
      dropped,
    });
  }

  // --- Gate 3: fresh official TBC disclaimer dominates is_change -> REVIEW/LOW ---
  const freshTbc = liveClaims.filter((s) => s.isTbc && s.isOfficial && s.isNew);
  if (freshTbc.length) {
    const stated = [...new Set(freshTbc.map((s) => s.utc).filter(Boolean))].sort();
    return verdict(fixture, {
      action: ACTION.REVIEW,
      confidence: CONFIDENCE.LOW,
      breakdown: { note: "TBC_DOMINANCE: fresh self-disclaimed time; escalate, do not write" },
      resolved: null,
      deltaMinutes: null,
      candidateTimes: stated,
      why: [
        "authority is disclaiming its own time (TBC); promised confirmation absent; escalate",
        ...freshTbc.map((s) => `${s.label}: "${s.quote}"`),
      ],
      sourcesUsed: freshTbc.map(sourceLine),
      dropped,
    });
  }

  // --- Pick the winning time and its supporters ---
  const timed = live.filter((s) => s.utc);
  const newTimed = timed.filter((s) => s.isNew);
  const pool = officialTimed.length ? officialTimed : newTimed.length ? newTimed : timed;
  if (!pool.length) {
    return verdict(fixture, {
      action: ACTION.INSUFFICIENT_EVIDENCE,
      confidence: CONFIDENCE.LOW,
      why: ["no fresh, fixture-relevant evidence asserts a kickoff time"],
      dropped,
    });
  }
  const rep = pool.reduce((a, b) => (b.rank > a.rank ? b : a));
  const winningUtc = rep.utc;

  // Supporters of the winning time, de-duplicated by account identity.
  const supportingAll = timed.filter((s) => s.utc === winningUtc);
  const supporting = [...new Map(supportingAll.map((s) => [s.key, s])).values()];
  const supportNew = supporting.filter((s) => s.isNew);
  const supportFresh = supporting.filter((s) => s.isFresh);
  const officialSupport = supporting.filter((s) => s.isOfficial && s.isNew);

  // --- Confidence (integer additive) ---
  const authority = officialSupport.length
    ? Math.max(...officialSupport.map((s) => AUTHORITY[s.tier]))
    : Math.max(...supportNew.map((s) => AUTHORITY[s.tier]), 0);
  const corroboration = corroborationPoints(distinctKeys(supportNew));
  const liveConflictor = newTimed.some(
    (s) => !s.isFeed && s.key !== rep.key && s.utc !== winningUtc,
  );
  const hasDefinitive = supporting.some((s) => !s.isTentative);
  const recency =
    hasDefinitive && (supporting.some((s) => s.isChange) || !liveConflictor)
      ? RECENCY_CLARITY
      : 0;
  const tentative =
    !officialSupport.length && supporting.every((s) => s.isTentative)
      ? TENTATIVE_PENALTY
      : 0;
  const conflict = liveConflictor ? CONFLICT_PENALTY : 0;
  const score = authority + corroboration + recency - tentative - conflict;
  const confidence = band(score);
  const breakdown = {
    score,
    authority,
    corroboration,
    recency_clarity: recency,
    tentative_penalty: tentative,
    conflict_penalty: conflict,
  };

  const deltaMinutes = Math.round((toMs(winningUtc) - toMs(feedUtc)) / MINUTE_MS);
  const capMet = distinctKeys(supportFresh) >= 2;
  const hasOfficial = officialSupport.length > 0;
  const hasFreshOfficial = officialSupport.some((s) => s.isFresh);
  const implausibleDelta = Math.abs(deltaMinutes) > MAX_PLAUSIBLE_DELTA_MINUTES;
  // A confident write must clear EVERY guard: HIGH band, two independent fresh
  // sources, an ABSOLUTELY-fresh official driving it (not just relationally new),
  // NO fresh different-account source disagreeing, and a sane move size. Any one
  // failing drops to REVIEW. This is the no-false-positives gate.
  const changeIsClean =
    confidence === CONFIDENCE.HIGH &&
    capMet &&
    hasFreshOfficial &&
    !liveConflictor &&
    !implausibleDelta;
  const why = supporting.map((s) => `${s.label}: ${s.utc} "${s.quote}"`);
  const sourcesUsed = supporting.map(sourceLine);

  // --- Action mapping ---
  if (deltaMinutes !== 0) {
    if (changeIsClean) {
      return verdict(fixture, {
        action: ACTION.CHANGE_RECOMMENDED,
        confidence,
        breakdown,
        resolved: winningUtc,
        deltaMinutes,
        why: [`feed is ${deltaMinutes} min off; corroborated official change`, ...why],
        sourcesUsed,
        dropped,
      });
    }
    if (hasOfficial) {
      return verdict(fixture, {
        action: ACTION.REVIEW,
        confidence,
        breakdown,
        resolved: null,
        deltaMinutes,
        candidateTimes: [winningUtc],
        why: [
          implausibleDelta
            ? `implausibly large move (${deltaMinutes} min); suspect AM/PM error, human confirm`
            : liveConflictor
              ? "a fresh source disagrees on the resolved time; human confirm"
              : capMet
                ? "credible change but not high confidence; human confirm"
                : "single uncorroborated official change; human confirm",
          ...why,
        ],
        sourcesUsed,
        dropped,
      });
    }
    return verdict(fixture, {
      action: ACTION.MONITOR,
      confidence,
      breakdown,
      resolved: null,
      deltaMinutes,
      candidateTimes: [winningUtc],
      why: ["only tentative/unverified evidence; keep feed time and re-poll", ...why],
      sourcesUsed,
      dropped,
    });
  }

  // delta === 0: CONFIRMED is a positive too, so it gets the same disagreement
  // veto. A fresh official must corroborate the current time AND nothing fresh
  // may disagree, else we say "insufficient" rather than falsely verifying.
  if (
    confidence !== CONFIDENCE.LOW &&
    supportFresh.some((s) => s.isOfficial) &&
    !liveConflictor
  ) {
    return verdict(fixture, {
      action: ACTION.CONFIRMED,
      confidence,
      breakdown,
      resolved: winningUtc,
      deltaMinutes: 0,
      why: ["current feed time corroborated by a fresh official source", ...why],
      sourcesUsed,
      dropped,
    });
  }
  return verdict(fixture, {
    action: ACTION.INSUFFICIENT_EVIDENCE,
    confidence,
    breakdown,
    resolved: null,
    deltaMinutes: 0,
    why: ["agreement is stale or unofficial; not enough to confirm", ...why],
    sourcesUsed,
    dropped,
  });
}

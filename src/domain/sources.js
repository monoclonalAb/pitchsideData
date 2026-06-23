import { TIER, TRUST_SCORE, AUTHORITY } from "../config.js";
import {
  officialForHandle,
  officialForDomain,
  recordSpeaksForCompetition,
} from "./officialSources.js";

/* =========================================================================
 * sources.js - assign a trust tier to one piece of evidence.
 *
 * Source TRUST (who is speaking) is decided by an exact-match allowlist of
 * confirmed official handles/domains (officialSources.js). A name that merely
 * embeds the league acronym or a club name (@cslericleague, harbourcityfans.com)
 * is not on the allowlist, so it can never reach an official tier - the
 * structural defense against impersonation. A fan marker or a missing
 * verification demotes a social account before the allowlist is consulted.
 *
 * nameMatches is the FUZZY content matcher; it is exported for the relevance
 * gate (matching what a claim is about), never for deciding trust.
 * ========================================================================= */

const TYPE_SUFFIXES = new Set(["fc", "sc", "afc", "cf", "cfc", "ac", "club"]);
const FAN_MARKERS = [
  "ultras",
  "ultra",
  "supporters",
  "faithful",
  "fanclub",
  "brigade",
  "firm",
];

function tokens(name) {
  return String(name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function normalizeName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function clubTokens(name) {
  return tokens(name).filter((t) => !TYPE_SUFFIXES.has(t));
}

/** Fuzzy name match for CONTENT relevance (opponent matching), never for trust. */
export function nameMatches(candidate, fullName) {
  const c = normalizeName(candidate);
  const core = clubTokens(fullName).join("");
  if (!c || !core) return false;
  if (c.includes(core) || core.includes(c)) return true;
  const first = clubTokens(fullName)[0] ?? "";
  return first.length >= 4 && c.includes(first);
}

function hasFanMarker(s) {
  const n = normalizeName(s);
  return FAN_MARKERS.some((m) => n.includes(m));
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url ?? "");
  }
}

function result(tier, extra = {}) {
  return {
    tier,
    trustScore: TRUST_SCORE[tier],
    authority: AUTHORITY[tier],
    matchedTeam: extra.matchedTeam ?? null,
    isHome: extra.isHome ?? false,
    verified: extra.verified ?? null,
    label: extra.label ?? tier,
    reasons: extra.reasons ?? [],
  };
}

/**
 * Classify one evidence item into a trust tier for the given fixture. Official
 * tiers require an allowlist hit that ALSO speaks for this fixture (the league
 * for this competition, or the club playing home/away here).
 */
export function classifySource(item, fixture) {
  const { home, away, competition } = fixture;

  if (item.type === "feed_listing") {
    return result(TIER.SCOREFEED, {
      label: `${item.provider ?? "aggregator"} feed listing`,
      reasons: ["structured aggregator; corroborates, never originates"],
    });
  }

  if (item.type === "social_post") {
    const account = item.account ?? {};
    const handle = account.handle ?? "";
    const display = account.display_name ?? "";
    const verified = !!account.verified;

    if (hasFanMarker(handle) || hasFanMarker(display)) {
      return result(TIER.FAN, {
        verified,
        label: `fan account (${handle || display})`,
        reasons: ["fan/ultras marker in name; not an official club voice"],
      });
    }
    if (!verified) {
      return result(TIER.FAN, {
        verified,
        label: `unverified account (${handle || display})`,
        reasons: ["not verified; verified is necessary but insufficient for official"],
      });
    }

    const record = officialForHandle(handle);
    if (record && recordSpeaksForCompetition(record, competition)) {
      return result(TIER.LEAGUE, {
        verified,
        label: `league social (${handle})`,
        reasons: [`allowlisted official account for "${competition}"`],
      });
    }
    if (record && record.kind === "club" && (record.name === home || record.name === away)) {
      const isHome = record.name === home;
      return result(TIER.CLUB_SOCIAL, {
        verified,
        matchedTeam: isHome ? "home" : "away",
        isHome,
        label: `${isHome ? "home" : "away"} club social (${handle}, verified)`,
        reasons: [`allowlisted official account for ${isHome ? "home" : "away"} "${record.name}"`],
      });
    }
    return result(TIER.FAN, {
      verified,
      label: `unrecognized account (${handle || display})`,
      reasons: ["not an allowlisted official source for either club or the competition"],
    });
  }

  if (item.type === "web_page") {
    const host = hostname(item.url);
    const record = officialForDomain(item.url);
    if (record && recordSpeaksForCompetition(record, competition)) {
      return result(TIER.LEAGUE, {
        label: `league site (${host})`,
        reasons: [`allowlisted official domain for "${competition}"`],
      });
    }
    if (record && record.kind === "club" && (record.name === home || record.name === away)) {
      const isHome = record.name === home;
      return result(TIER.CLUB_WEBSITE, {
        matchedTeam: isHome ? "home" : "away",
        isHome,
        label: `club website (${host})`,
        reasons: [`allowlisted official domain for ${isHome ? "home" : "away"} "${record.name}"`],
      });
    }
    return result(TIER.BLOG, {
      label: `preview/3rd-party site (${host})`,
      reasons: ["domain is not an allowlisted official source; 3rd-party"],
    });
  }

  return result(TIER.BLOG, {
    label: "unknown evidence type",
    reasons: [`unrecognized evidence type "${item.type}"`],
  });
}

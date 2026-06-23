/* =========================================================================
 * officialSources.js - the allowlist of CONFIRMED official sources.
 *
 * Source trust is decided by EXACT membership here, not by fuzzy name matching.
 * This is the structural defense against impersonation: a handle or domain that
 * merely embeds the league acronym or a club name (@cslericleague,
 * harbourcityfans.com) is simply absent from the registry, so it can never be
 * granted an official tier. An ops team curates this list as accounts are
 * confirmed; it is the one place to add a newly verified official source.
 *
 * "covers" lets one authority speak for several competitions: the league also
 * runs the Founders Cup, so @CSLeague / cslsoccer.com are official for both.
 * ========================================================================= */

const REGISTRY = [
  {
    name: "Continental Soccer League",
    kind: "league",
    covers: ["Continental Soccer League", "Founders Cup"],
    handles: ["@CSLeague"],
    domains: ["cslsoccer.com"],
  },
  { name: "Harbour City FC", kind: "club", handles: ["@HarbourCityFC"], domains: ["harbourcityfc.com"] },
  { name: "Red Vale United", kind: "club", handles: ["@RedValeUnited"], domains: ["redvaleunited.com"] },
  { name: "Summit Rovers", kind: "club", handles: ["@SummitRovers"], domains: ["summitrovers.com"] },
  {
    name: "Pacific Crown",
    kind: "club",
    handles: ["@PacificCrown", "@pacificcrown_es"],
    domains: ["pacificcrown.com"],
  },
  { name: "Caldera FC", kind: "club", handles: ["@CalderaFC"], domains: ["calderafc.com"] },
  { name: "Prairie Union", kind: "club", handles: ["@PrairieUnion"], domains: ["prairieunion.com"] },
  { name: "Cactus Athletic", kind: "club", handles: ["@CactusAthletic"], domains: ["cactusathletic.com"] },
  { name: "Lakefront SC", kind: "club", handles: ["@LakefrontSC"], domains: ["lakefrontsc.com"] },
  { name: "Fogline SC", kind: "club", handles: ["@FoglineSC"], domains: ["foglinesc.com"] },
];

function normHandle(handle) {
  return String(handle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Reduce any URL or host to its registrable domain (last two labels), so a
// subdomain or a full URL still matches the registered base domain.
function registrableDomain(input) {
  let host = String(input ?? "").trim();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      /* not a parseable URL; fall through and treat the string as a host */
    }
  }
  host = host.replace(/^www\./, "").toLowerCase();
  const parts = host.split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

const handleIndex = new Map();
const domainIndex = new Map();
for (const entry of REGISTRY) {
  const record = {
    name: entry.name,
    kind: entry.kind,
    covers: entry.covers ?? [entry.name],
  };
  for (const handle of entry.handles ?? []) handleIndex.set(normHandle(handle), record);
  for (const domain of entry.domains ?? []) domainIndex.set(registrableDomain(domain), record);
}

/** The official record for a social handle, or null if it is not allowlisted. */
export function officialForHandle(handle) {
  return handleIndex.get(normHandle(handle)) ?? null;
}

/** The official record for a URL/host, or null if it is not allowlisted. */
export function officialForDomain(urlOrHost) {
  return domainIndex.get(registrableDomain(urlOrHost)) ?? null;
}

/** Does this official record actually speak for the given competition name? */
export function recordSpeaksForCompetition(record, competition) {
  return !!record && record.kind === "league" && record.covers.includes(competition);
}

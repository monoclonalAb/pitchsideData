import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifySource, nameMatches } from "../src/domain/sources.js";
import { TIER } from "../src/config.js";

async function load(id) {
  const fixtures = JSON.parse(
    await readFile("test/fixtures/fixtures.json", "utf8"),
  ).fixtures;
  const fixture = fixtures.find((f) => f.id === id);
  const { evidence } = JSON.parse(
    await readFile(`test/fixtures/evidence/${id}.json`, "utf8"),
  );
  return { fixture, evidence };
}

const item = (evidence, id) => evidence.find((e) => e.id === id);

test("fx-2201: home/away club socials and the league website", async () => {
  const { fixture, evidence } = await load("fx-2201");
  const home = classifySource(item(evidence, "ev-2201-a"), fixture);
  assert.equal(home.tier, TIER.CLUB_SOCIAL); // @HarbourCityFC
  assert.equal(home.isHome, true);
  assert.equal(classifySource(item(evidence, "ev-2201-b"), fixture).tier, TIER.CLUB_SOCIAL); // @redvaleunited (away)
  assert.equal(classifySource(item(evidence, "ev-2201-c"), fixture).tier, TIER.LEAGUE); // cslsoccer.com
});

test("fx-2202: @pacificcrown_es is a CLUB (locale, not a fan); ScoreFeed + blog tiers", async () => {
  const { fixture, evidence } = await load("fx-2202");
  const crown = classifySource(item(evidence, "ev-2202-d"), fixture);
  assert.equal(crown.tier, TIER.CLUB_SOCIAL); // _es is a locale; language is irrelevant to trust
  assert.equal(classifySource(item(evidence, "ev-2202-b"), fixture).tier, TIER.SCOREFEED);
  assert.equal(classifySource(item(evidence, "ev-2202-c"), fixture).tier, TIER.BLOG); // scorelines-weekly.com
});

test("fx-2206: @LakefrontUltras is a FAN despite naming the club; rumor blog", async () => {
  const { fixture, evidence } = await load("fx-2206");
  assert.equal(classifySource(item(evidence, "ev-2206-a"), fixture).tier, TIER.FAN);
  assert.equal(classifySource(item(evidence, "ev-2206-b"), fixture).tier, TIER.BLOG); // chisoccerbuzz.net
});

test("fx-2207: @RedValeUnited club social and redvaleunited.com club website", async () => {
  const { fixture, evidence } = await load("fx-2207");
  assert.equal(classifySource(item(evidence, "ev-2207-a"), fixture).tier, TIER.CLUB_SOCIAL);
  assert.equal(classifySource(item(evidence, "ev-2207-b"), fixture).tier, TIER.CLUB_WEBSITE); // redvaleunited.com
});

test("hardened domains: lookalike fan/rumor sites are NOT trusted as official", () => {
  const fixture = {
    home: "Harbour City FC",
    away: "Red Vale United",
    competition: "Continental Soccer League",
  };
  const tierOf = (url) => classifySource({ type: "web_page", url }, fixture).tier;

  // The over-trust gap: substring lookalikes must fall to BLOG, not official tiers.
  assert.equal(tierOf("https://csl-rumors.com/x"), TIER.BLOG); // was wrongly LEAGUE
  assert.equal(tierOf("https://harbourcityfans.com/x"), TIER.BLOG); // was wrongly CLUB_WEBSITE

  // Genuinely official domains still classify correctly.
  assert.equal(tierOf("https://www.cslsoccer.com/fixtures"), TIER.LEAGUE);
  assert.equal(tierOf("https://www.harbourcityfc.com/news"), TIER.CLUB_WEBSITE);
});

test("allowlist: embedding the acronym or a club name confers NO official trust", () => {
  const fixture = {
    home: "Harbour City FC",
    away: "Pacific Crown",
    competition: "Continental Soccer League",
  };
  const social = (handle) =>
    classifySource(
      { type: "social_post", account: { handle, display_name: handle, verified: true } },
      fixture,
    ).tier;
  const web = (url) => classifySource({ type: "web_page", url }, fixture).tier;

  assert.equal(social("@cslericleague"), TIER.FAN); // embeds the csl acronym
  assert.equal(social("@harbourcityeric"), TIER.FAN); // embeds a club name
  assert.equal(web("https://cslericleague.com"), TIER.BLOG);

  // the genuine officials still resolve
  assert.equal(social("@CSLeague"), TIER.LEAGUE);
  assert.equal(social("@pacificcrown_es"), TIER.CLUB_SOCIAL);
});

test("allowlist: the league authority also covers the Founders Cup (fx-2208)", async () => {
  const { fixture, evidence } = await load("fx-2208");
  assert.equal(fixture.competition, "Founders Cup");
  const csl = evidence.find((e) => e.account?.handle === "@CSLeague");
  assert.equal(classifySource(csl, fixture).tier, TIER.LEAGUE);
});

test("nameMatches (the relevance content matcher) behaves on tricky cases", () => {
  assert.ok(nameMatches("@pacificcrown_es", "Pacific Crown")); // locale suffix
  assert.ok(nameMatches("@HarbourCityFC", "Harbour City FC")); // type suffix
  assert.ok(!nameMatches("Fogline SC", "Caldera FC")); // genuinely different club
});

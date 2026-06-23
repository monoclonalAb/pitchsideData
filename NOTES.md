Include a NOTES.md in your repo covering, briefly:

- The requirements you gathered, and any assumptions you made where you didn't have an answer
- The key design decisions (source weighting, conflict handling, output design) and why
- Anything you found in the data that surprised you, and how you handled it
- If you think any requirement you gathered is wrong, costly, or worth pushing back on — say so, and propose what you'd do instead. What you'd do with more time

# Context:

- Pitchside Data sells a fixture feed (matches, venues, kickoff times) to broadcasters, betting operators, and apps
- **problem**: when clubs and leagues move matches; bad for customers

# Functional Requirements:

- for each monitored fixture, the tool needs to be able to parse *all* evidence the collectors have pulled 
    - social posts, web / preview pages, ScoreFeed listings
- the tool then needs to be able to weight the evidence for each fixture
    - confidence measures for our source of informations (league, club, aggregator, blogs, fans etc.)
    - recency weighting (more recent >>)
    - relevancy filtering (is it about the fixture or not)
- other functionalities:
    - all time should be UTC normalised
- using the evidence, the tool should be able to provide a conclusion 
    - a concrete recommended action - one of:
        - CONFIRMED - feed time verified correct; no change
        - CHANGE_RECOMMENDED - feed time is wrong; propose the new kickoff for an analyst to apply
        - POSTPONED_OR_CANCELLED - match postponed/cancelled; flag with receipts, propose NO new time (reschedules re-enter via league resequencing)
        - NEEDS_REVIEW - credible but ambiguous (e.g. two fresh official sources clash); surface both candidate times for someone to confirm
        - INSUFFICIENT_EVIDENCE - too stale to act, nothing new; keep the feed time, don't spend a flag
        - COULD_NOT_ASSESS - evidence fetch failed after retries (infrastructure, not a judgement)
    - a confidence level for the verdict (HIGH / MEDIUM / LOW)
    - reasoning provided (cites the evidence used, how sources were weighted, what was dropped & why)
    - prioritised summary (of what needs to be updated first)

## Non-functional Requirements:

- it is a Node.js tool
- the results have to be deterministic
- some of the gateways are flaky; have to be resilient
- only advisory, not authoritative

# Plan:

## Input:

```
{
  "type": "social_post",
  "platform": "twitter",
  "account": { "handle": "@NorthgateAFC", "display_name": "Northgate AFC", "verified": true },
  "posted_at": "2026-06-15T18:00:00Z",
  "text": "Reminder: Saturday's home match now kicks off at 8:00 PM local — not 7:30 as previously listed."
}

{
  "type": "feed_listing",
  "provider": "ScoreFeed",
  "retrieved_at": "2026-05-30T05:00:00Z",
  "listed_kickoff_utc": "2026-06-20T18:30:00Z"
}
```
> the two types of evidence you might see from `Twitter` and `ScoreFeed`

---

# How it works:

One straight line per fixture:

```
fetch fixtures → for each fixture:
   fetch evidence → LLM extracts claims → relevance filter → score the source
   → resolve to UTC → weigh → verdict
→ rank everything → write REPORT.md + report.json + console
```

- LLM only translates; never decides
    - provides verbatim quotes so that it has real substring of the text
- each account only counts its latest claim, so it can never conflict with itself
    - (if it does conflict, we flag; we js only claim the latest one so we assume it doesnt)
- confidence score is additive:
    ```
    score = AUTHORITY + CORROBORATION + RECENCY − TENTATIVE − CONFLICT
    HIGH ≥ 4 · MEDIUM 2–3 · LOW ≤ 1
    ```
    meaning CORROBORATION + RECENCY maxes out at +3; you need to have AUTHORITY (proper club or league) to actually reach HIGH tier

# Assumptions we made:

- only used data from the 9 live fixtures
    - can't really extrapolate from cases that aren't in the data?
- ran out of time to ask questions  
    - thought 10 minutes was time quota; not how many questions you asked-
    - could've learnt more like what constitutes a fan account, gone through some edge cases, what counts as stale data etc. (**would've done with more time**)
- assumed that "fresh" data was within 7 days AND newer than `last_verified_at`
- if no timezone stated, used venue's timezone
- did not know what constitutes a fan account:
    - hard-filtered accounts; had a list of all the league and club accounts and used it to verify 
- a move larger than 6 hours is suspicious so has to get `REVIEW` status
- assuming that the club's latest claim is the most ACCURATE one

# With more time?

- polish a lot of the edge cases; i think there a lot of cases where i js flag because i do not have the best description of scope
    - (i thought we literally had 10 minutes of time to interview)
- extend with more forms of data, so the assistant can be more trustworthy

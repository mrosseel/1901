---
status: accepted
---

# ADR-045 — The DATC pass rate is a generated page

**Status:** accepted, r47 (research/platforms.md, steal 10). Built at r51.
`datc_test.go` runs godip's DATC corpus in CI already, and then throws the
number away. Every serious adjudicator publishes its pass rate, and it is the
first thing the community asks: jDip and webDiplomacy both have a table, and
mylootcave puts "167/167" in its own meta tags.

So the test writes a JSON result, and the server serves a page listing each
case with its verdict. It is about a day of work and it is the cheapest
credibility this project can buy.

Two rules go with it. The page states what was **not** run, because
webDiplomacy's table is honest about skipping the retreat and build cases and
ours can beat it by being honest in the same place. And the number is
generated, never typed. A hand-written claim goes stale the first time godip
moves, and a stale claim about correctness is worse than no claim.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r47, 2026-08-30** — ADR-045: the DATC pass rate the CI already computes becomes a generated page that also states what was not run.
- **r51, 2026-08-31** — Built, and the first number is 185 of 185: 167 of 167 on DATC v2.4 section 6, plus godip's 18 regression cases. `datc_test.go` writes `datcreport/report.json`, the binary embeds it, `/datc.json` publishes it and `/datc` draws it. The corpus lives in godip's module cache, so a build cannot recount at start-up; a tree whose test has never run serves "not run in this build" rather than a guess.
- **r51, 2026-08-31** — The report carries no timestamp. A file that stamps the clock changes on every run and says nothing new; this one changes only when an outcome does.

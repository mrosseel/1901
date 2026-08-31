---
status: accepted
---

# ADR-046 — Emit what the tournament pipeline already eats

**Status:** accepted, r47 (research/platforms.md, steal 9 and §1.12). Built
at r51. Extends ADR-028.
dipvis (GPL-3, running publicly as DipTV) already runs the face-to-face
tournament: registration, roll call, seeding, scoring, standings, and the
Classification CSV and Boards CSV the World Diplomacy Database ingests. It
gets its supply-centre counts by scraping Backstabbr's HTML, through an
"Import SC Counts from Backstabbr" action written against `game/` and
`sandbox/` URLs.

That scraper is the seam to attack. 1901 already publishes the whole position
at a stable address with no token (ADR-028), so a director's pipeline works the
day somebody points it here, and a scraper is replaced by an answer. This is
the cheapest route onto a real tournament table, and it costs us no scoring
code.

What to emit: supply-centre counts per power per year at
`/game/{id}/results.json`, the same as CSV, and the columns dipvis reads where
they have names already. Where they do not, keep ours and write them down.

We implement none of the 25 scoring systems in dipvis's catalogue. Somebody
else wrote them, with tests, and §1 says scoring is not our job.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r47, 2026-08-30** — ADR-046: publish supply-centre counts as JSON and CSV, because dipvis scrapes Backstabbr's HTML for exactly that and a stable address replaces a scraper.
- **r47, 2026-08-30** — Q-008 opened: whether to bring back a board with no players, which is Backstabbr's sandbox and the reason its links are the community's citation format.
- **r51, 2026-08-31** — Built as `/game/{id}/results.json` and `/game/{id}/results.csv`, public and token-free like the board they count. A year's count is read from the last phase the server holds for that year, so a finished year is final and the year being played says `final: false` rather than pretending to be settled.
- **r51, 2026-08-31** — The columns are ours — game, year, power, centres, final — because dipvis reads a site's HTML rather than a file and publishes no column names for an import. That is the case ADR-046 said to write down.

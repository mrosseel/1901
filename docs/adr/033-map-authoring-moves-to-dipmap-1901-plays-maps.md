---
status: accepted
---

# ADR-033 — Map authoring moves to dipmap; 1901 plays maps

**Status:** accepted, r25 (owner decision, final). Widened r28. Supersedes
the ownership half of ADR-030 and ADR-003.
1901 becomes the tool that plays maps. dipmap becomes the tool that makes
them. Moving out: `tools/placement/`, `tools/restyle/`, `web/src/mapeditor/`,
`mapeditor_dev.go`, `mapeditor_off.go` and the `/mapeditor` route. Staying:
every serve-time reader, meaning `placements.go`, `names.go`,
`mapstyles.go`, `styleplans.go` and `restyle.go`.

Widened r28: `tools/jdip-import/` moves as well. 1901 reads maps and never
produces one, by any route. The earlier reasoning kept the importer here
because dipmap draws from polygons and cannot ingest a jDip SVG; the owner
ruled that a second place which writes maps is worse than an importer in an
awkward home. One consequence follows: dipmap ends up owning the Playwright
dependency, because a style plan for art dipmap did not draw has to be
measured rather than written. It goes in a dependency group the server never
loads, the way `--group geo` already holds shapely.

The deletions happen on this side, once the ported code is proven. A style
plan and a placement table are committed data, so both keep working across the
move; only regenerating them needs the tool.

Two findings from the handover are worth keeping, because they outlast the
code that produced them. For a map dipmap drew, a style plan is written rather
than detected. The exporter already chose the literals and can hash the art it
just emitted, so confidence is 1 by construction and a plan cannot name the
hash of art it never measured. And a detector that derives verdicts by
hit-testing fails silently. When 1900's art failed to render, every hit-test
missed and the detector wrote a well-formed plan calling all 181 names land,
twenty-one seas among them. A plan writer must count the labels that land on
nothing and refuse rather than write.

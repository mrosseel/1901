---
status: accepted
---

# ADR-051 — Map authoring moves to dipmap; 1901 plays maps

**Status:** accepted, r25 (owner decision, final). Widened r28. Supersedes
the ownership half of ADR-030 and ADR-003.

Numbered ADR-033 until 2026-08-31. Two decisions carried that id: this one and
"map styles are named data", which had already been renumbered once, out of a
clash with the press mode at ADR-023. This one moved because only two code
comments cited it under the old number.
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

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r25, 2026-08-29** — ADR-033: map authoring moves to dipmap, 1901 plays maps (owner decision) — placement, restyle and the map editor leave; every serve-time reader and tools/jdip-import stay.
- **r28, 2026-08-30** — ADR-033 widened: `tools/jdip-import/` moves to dipmap as well, so 1901 never writes a map.

## Done, 2026-08-31

Every authoring tool has left this repository, and 14,727 lines with them:

| what | lines |
|---|---|
| `tools/restyle/` | 5238 |
| `tools/placement/` | 5809 |
| `web/src/mapeditor/` | 2138 |
| `tools/jdip-import/` | 1269 |
| `mapeditor_dev.go`, `mapeditor_off.go` | 147 |
| `names.go` and `names/` | 103 |
| `placements/`, routes, proxy line, gallery entry | 23 |

The `mapeditordev` build tag is gone, which was this record's own reason for
the move: code that has to hide from its own host is in the wrong repository.

**The detector moved as TypeScript, not as a Python port.** The measurement is
`getBBox`, `getComputedStyle` and hit-testing inside a rendered document, so it
drives a browser. Five thousand lines of measurement heuristics rewritten in
another language would be a way of introducing bugs, not of removing them.
dipmap's `EDITOR_PLAN.md` assumed a port; the move is better, because the code
that works is the code that runs.

It was proven before anything was deleted. Run against a 1901 server from its
new home, `plans.ts` reproduced `styleplans/classical.json` byte for byte.

**Two file kinds moved with it, and one did not.** A style plan now travels in
the variant package as `styleplan.json`, beside the art it measured, so a
variant cannot arrive carrying a plan for a different map; `styleplans/` and
its pin test are deleted. Province long names were always in `variant.json`,
so `names.go` and its empty `names/` directory were dead and are deleted.

`mapstyles/` stays. Pre-rendering the four styles in dipmap would let this
repository drop `restyle.go` and `mapstyles.go` — 1307 lines — and would cost
92 MB in the binary, because 26 maps use 23 MB of SVG. ADR-026 chose serve-time
composition, and the measurement agrees with it.

What this repository keeps is the code that **applies** map data: `restyle.go`,
`mapstyles.go`, `placements.go`, `variants.go`. What it lost is the code that
**makes** map data.

dipmap's `EDITOR_MOVE.md` is the other half of this record.

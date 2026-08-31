---
status: accepted
---

# ADR-003 — Maps: godip's SVGs

**Status:** accepted, r1
Use `variants/*/svg/*.svg` from godip as-is. Province click targets come from
hit-testing the 3-letter path ids. Unit and flag SVGs composited client-side.

Placement (amended r2 — the r1 "no placement metadata" premise was wrong,
see §2.3): generate the offline placement table (one JSON per variant:
province → unit x/y, dislodged x/y, SC x/y) from the `<abbr>Center` anchor
glyphs already present in every godip variant map. Dislodged position =
anchor + fixed offset (jDip's idea), hand-corrected where it lands badly.
No centroid computation needed.

Amended r3 — the anchors alone were not good enough. Measured against the
drawn map, 35 of classical's 81 markers left their own province and 77 covered
a province name; on a coast the anchor put `stp/nc` three map units from
`stp`, where neither reads as anything. `tools/placement` measures the real
geometry in a browser, re-places every marker under an ordered set of rules,
and hands the result to a person to correct by hand. Two of those rules came
back out of that correction pass:

- **Coast legibility.** A coast marker must be tellable from its base
  province and from its sibling coasts — 2.5 marker radii apart — and a base
  province may not stand on one of its own coast strips. It is applied as a
  filter before it is a preference, because a rule ranked below name overlap
  is otherwise defeated by name overlap.
- **Threshold clearance, then centre.** The margin a marker keeps from the
  nearest name or supply centre is not maximised. It is measured off the
  hand-corrected table, and clearing that median earns full credit and
  nothing further; among positions that clear it, the province's pole of
  inaccessibility decides. Centred stays the aesthetic.

File convention, one JSON per variant:

    placements/<key>.json       the approved table; the only one the server reads
    placements/<key>.hand.json  a hand-corrected table, an input to the tool

The server loads `placements/*.json` at startup and exposes the table as
`placements` in seat, GM and public state. The board prefers it over the map's
anchors and falls back per province, not per table, so a table missing one key
leaves that province on its anchor and serves the rest.

Amended r21 — the table gained a third position per province, `brief`, for the
three-letter code the board draws when brief labels are on. Brief mode hides
the full names, so a code is a different placement problem from a marker: the
label boxes that dominate every marker score are not on the board when a code
is drawn. A code is judged on four things instead, in this order.

1. Its middle is inside the province it names. A code in the wrong country
   tells a reader something false, which is worse than no code at all.
2. It is clear of its own marker and of its own dislodged ring.
3. It is clear of the neighbouring provinces' markers. A province is small and
   a marker is not, so the piece a code lands on is as often the neighbour's.
   Separate from its own marker because a neighbour's is only sometimes drawn,
   but next to it, because a marker is opaque either way.
4. It fits wholly inside its own province. Ranked below legibility for the
   same reason marker containment is ranked below name overlap. A province
   narrower than the code naming it still has to be named.
5. It is off the supply centre glyph. Last, and measured into that position:
   ranking the glyph above the neighbours made the search trade "off the dot"
   for "onto a piece" on every crowded map, which is the wrong way round.

Among positions that pass, the one below or beside the province's own marker
wins, so a reader pairs the code with the piece. The first rung of that ladder
is exactly where `renderBriefLabels()` already draws a code.

A position is stored only when it is no worse than the heuristic it would
replace, judged on those five faults in both board states. That test matters
more than it sounds. The heuristic draws the code at the anchor when the
province is empty and below the marker when a unit stands there, and being
able to switch is a real advantage: the anchor is the one spot in a province
that no other province's marker can occupy. On a map whose provinces are
smaller than the codes naming them, no single stored point beats that. Storing
one everywhere on twentytwenty put 95 codes on a marker where the heuristic
put 80; declining the ones that lose brought it back to 82 while keeping the
supply-dot gain, 29 down to 23. So 106 of its 215 provinces store nothing and
the board falls back, per province, exactly as it falls back to map anchors.

A jDip-converted map gets no codes at all: it ships its own `BriefLabelLayer`,
the board shows that layer instead of drawing anything, and those positions
are the map author's work.

The tool's `--brief-only` mode adds the field to an approved table and touches
nothing else in it, because an approved table can hold corrections a person
made by hand and the codes are a later question than the markers were. It
writes the codes as a replacement rather than a merge, so a province the tool
declines loses any code an earlier run left there.

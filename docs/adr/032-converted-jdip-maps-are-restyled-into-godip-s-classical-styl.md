---
status: accepted
---

# ADR-032 — Converted jDip maps are restyled into godip's classical style

**Status:** accepted, r3. Renumbered in r25: this decision and the jDip
translator both carried the id ADR-016.
A jDip map converted by `tools/jdip-import` is correct and unlovely: flat
`#B5DEF8` water, flat `#F7DB94` land, a black backdrop, and labels written
`font-size:150` — valid in jDip's own renderer, invalid CSS, so every browser
threw the declaration away and drew every name at the 16px default. On sailho,
whose map is 7300 units wide, that is a two-pixel smudge.

`tools/restyle` reads godip's classical map for its visual system — two paper
tones, a hairline border, a diagonal hatch, a paper grain, and Libre
Baskerville set bold for land and italic for water — and applies it to a jDip
map through that map's own semantic classes. It writes `map-<style>.svg`
beside `map.svg` (ADR-033 made the style itself data); the server serves the
default style, parchment, and the faithful original at `?style=original`.

The restyle may change fills, strokes and text presentation. It may not move a
coordinate, rename an id, or add an element to `#provinces`,
`#province-centers`, `#MapLayer` or the label layers. That is checked, not
promised, and the tool refuses to write a file that fails.

A second pass, opt-in per variant with `--fix-labels`, puts province names
back inside their own provinces: it measures each name against its province
shape, moves and if necessary shrinks the ones that escape, keeps them clear
of the unit and dislodged markers in `placements/<key>.json` by the RULE B
margin, and falls back to jDip's own three-letter brief label where a name
cannot fit at any size. sailho is the pilot; classical's labels wait.

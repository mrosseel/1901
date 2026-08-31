---
status: accepted
---

# ADR-024 — godip's own maps are styled by palette substitution

**Status:** accepted, r17
A jDip conversion is restyled through its classes (ADR-032). godip's twenty-three
own maps have no classes at all: classical paints its landmass as one path
with `style="fill:#f4d7b5"` over a sea-coloured rect, and the rest do the same
with more paths. `tools/restyle/restyle-godip.ts` styles them by substituting
fill VALUES, which is more fragile than painting by class, so the fragility is
made visible rather than hidden:

- **The palette is not guessed from the tone.** The adjudicator is asked which
  provinces are sea (`GET /variants/<key>/provinces.json`, new), each
  province's own hit shape is sampled against the art in a real renderer, and
  the tone is decided by a vote that has to carry two thirds. A named coast —
  `spa/nc` — votes for nothing: it is sea to the adjudicator and land on the
  map, and counting it lost classical, Cold War and Twenty Twenty their first
  vote. A map that cannot be classified is left in godip's own colours and
  named with the reason in the coverage table; honest partial coverage beats a
  silent hundred per cent.
- **Only what the vote identified is touched.** Black stays black: on these
  maps it is the coastline's drop shadow and the outlines round the names. A
  second land tone is carried rather than flattened — it keeps the lightness
  step it had from the base tone.
- Also restyled: the impassable hatch (the style's pattern replaces the
  insides of the map's, keeping the id, so no reference and no id changes),
  the strength of the paper grain, the province border strokes, and the
  typography of the names layer. A foreground carrying many times more dark
  strokes than the map has provinces is decoration — North Sea Wars draws a
  celtic knot — and is left exactly as drawn.
- Sizes and positions are not touched, and the applier adds no element, so it
  is held to a stricter lock than the jDip one: the layer lock of ADR-032 widened
  to godip's layer names, and then every drawing element in the document
  compared for tag, id and geometry.

**Where they are served from.** *Superseded by ADR-026 (r18). The styled files
are gone. A styled map is composed at serve time from the original art and a
style plan.* As written in r17: a godip map is embedded in the dependency and
is not a file in this checkout, so its styled art went to
`styledmaps/<key>/map-<style>.svg`, named by the URL key because there is no
Go package to name it after, and `variants.go` globbed that directory
alongside `variants1901/<package>/`.

The tool is a client, not a library: the maps and the province types come from
a running server (`--server`, default `http://localhost:8195`), because a
running server is the only thing that can hand over art that lives inside the
dependency.

---
status: accepted
---

# ADR-059 — The provinces layer is a hit layer, terrain is painted under it

**Status:** accepted, r58. Writes down what ADR-003 assumed and ADR-024,
ADR-026 and ADR-038 were built on. Binds dipmap, which writes the art
(ADR-051).

`#provinces` is where the board finds a province. It is not where a map paints
its terrain. Nothing said so, and the first map authored outside godip painted
its land onto that layer and came out as one flat sea.

## The contract

> **`#provinces` is a hit layer. Terrain is painted in a layer below it.
> Province edges go in `#foreground`. Names are records.**

`#provinces` holds one shape per province, the id being the province key. The
board makes every child transparent and paints its own highlights onto them:
hover, selection, legal moves, the ownership wash. A map may ship the layer
`style="display:none"`, as godip's own art does, and the board turns it on. Any
fill an author paints there is erased on the first render.

Terrain goes underneath. godip's art draws it in `#background`, a jDip map in
`#MapLayer`, and either is fine. What matters is that the paint is in a layer
the board does not own.

`#foreground` holds the province edges, strokes and no fill. The restyle
restrokes that layer and leaves the drop shadow under the coast alone, because
a soft dark edge under a coast is drawing rather than styling.

Names are records in `placements.json` and the board draws them (ADR-038). An
art-mode map keeps its names layer, and the art wins wherever it draws one.

## Why the terrain cannot live on the hit layer

A hit shape and a painted shape want opposite things. The board needs to set a
fill on every province, per player and per phase, and it needs to do that
without asking what the map painted there. If the two are the same element, one
of them loses: either the highlight is hidden under the map's own colour, or
the map's colour is destroyed the moment anything is highlighted.

Two layers cost bytes and settle it. The paint sits still, the highlight moves,
and neither has to know about the other.

## The restyle does not care which layer

Fills are substituted by value wherever they appear (ADR-024). `#background`,
`#MapLayer` and `#foreground` all restyle alike, so this contract adds no case
to `restyle.go`. That is the reason a new author can adopt godip's layering
without any change on this side.

## What this cost before it was written down

dipmap's exporter painted land, sea and the home tints onto the `#provinces`
polygons and wrote the edges into a layer of its own called `#coastline`. Every
one of the fourteen packages it had written showed on the 1901 board as flat
sea with coastline strokes over it. The data was exact: loading one of those
packages back and rebuilding its descriptor gave zero differences in provinces,
borders, units and placements. The whole fault was in which layer held the
paint.

The rule was in `board.css` from the first spike against classical, and nowhere
else. A rule enforced only by a stylesheet in one of two repositories is not a
contract. This entry is the contract, and `generated.go` now warns at startup
when a package has `#provinces` and neither `#background` nor `#MapLayer`, so
the next map written the old way says so instead of showing an empty sea.

The warning is a warning and not a refusal. Such a map is playable: every
province can still be clicked, ordered and highlighted, and it is a poor
picture rather than a broken board.

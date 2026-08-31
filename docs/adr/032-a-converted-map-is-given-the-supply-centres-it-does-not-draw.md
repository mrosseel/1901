---
status: accepted
---

# ADR-032 — A converted map is given the supply centres it does not draw

**Status:** accepted, r25. Implemented in the converter; port to master pending.
godip's own maps have drawn a glyph on every supply centre since the first
one. jDip's converted maps do not. `SupplyCenterLayer` ships empty, 1900's
source carries no centre coordinate at all (Sail Ho's has 21), and nothing
downstream draws one. `board.ts` has no supply-centre drawing code and
`placements.json` has no slot for one, so no style could show them. A player
could not see which provinces were worth taking.

The converter fills the layer that ships empty, one ring per centre named by
godip's `AllSCs()`, positioned at jDip's own `SUPPLY_CENTER` coordinate where
the source states one and at the province's unit anchor where it does not.
Radius is 10/1524 of map width, matching godip's classical.

The glyph is a ring, not a disc, drawn as an even-odd annulus. jDip's anchor
is often under the province name and a filled dot would swallow it. The id is
`sc-<key>`, deliberately not `<key>Center`, because `board.ts` matches
`[id$="Center"]` for anchors. `?style=original` gains nothing. It stays a
faithful copy.

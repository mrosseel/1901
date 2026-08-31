---
status: accepted
---

# ADR-025 — A per-province map has its own ground tone

**Status:** accepted, r17
A style's `terrain.ground` is the tone behind the art, and for classical it is
the sea tone: the art is one landmass over a sea-coloured rect, so anything
showing through IS sea. A converted jDip map is the other shape. Every
province is its own polygon, the polygons do not quite meet, and what shows in
the hairline gaps between them is the ground — which painted the sea tone
turned every inland border, down the middle of a continent, into a channel of
water.

Styles therefore carry a second tone, `terrain.groundInland`: a darkened land,
which reads as a seam rather than as water. It is what the jDip applier paints
the backdrop rect and the root background with; `ground` is unchanged and is
what a single-landmass map still uses. parchment's is derived rather than
typed — classical's own land, twelve per cent darker, by
`extract-parchment.ts` — so the house style stays the file's own.

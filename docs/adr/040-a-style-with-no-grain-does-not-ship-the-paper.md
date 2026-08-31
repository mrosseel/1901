---
status: accepted
---

# ADR-040 — A style with no grain does not ship the paper

**Status:** accepted, r33. Extends ADR-026 and point 4 of ADR-037.
Ten of godip's maps lay a paper texture over the finished art: a full-page
rect whose fill names a pattern, and inside that pattern a 29 KB photograph of
paper. `flat` and `print` want no texture. They used to get it at
`fill-opacity:0`, so every board shipped a photograph nobody sees.

A grainless style now drops the overlay's fill instead of dimming it. Nothing
then names the pattern, and the prune that already deletes unreferenced
definitions takes it away with the bitmap inside. No code anywhere knows about
bitmaps: the saving falls out of reachability, which is the only rule the
prune has.

1. The overlay ELEMENT stays. Seven of the ten maps give that rect a black
   two-unit stroke, which is the board's own hairline frame. Deleting the
   element costs 2003 pixels on classical. Only the fill goes.
2. The prune runs on the styled bytes, not on the art on disk, because it is
   the style that orphans the pattern. `?style=original` is untouched and
   stays byte-identical on all 26 variants.
3. The impassable hatch is passed as a root, the same id the export protects.
   A style may paint impassable ground as a flat colour, and the pattern is
   then held by the plan rather than by any shape.
4. 20 of the 130 map and style pairs change, each by 29.9 KB raw and 22.4 KB
   gzipped, 447 KB gzipped over the set. `pure` in `flat` goes from 57.0 KB to
   34.7 KB on the wire. No pixel changed in any of the 20.

Rejected: giving godip's maps their grain from the style's own asset. That
asset is classical's own bitmap, byte for byte, so the substitution replaces
the picture with itself. It buys nothing and makes parchment and midnight 581
bytes larger. No style is planned that ships its own texture.

Rejected: cutting the embedded image out of the pattern directly. It needs a
regex over markup for one element kind, and godip writes the bitmap as a pair
of tags. A cut that matches the opening tag alone leaves an orphan close tag
inside the pattern, which is not well-formed XML.

That last fault is worth stating on its own, because it was shipped once and
found late. A board loads through an `<img>`, which parses SVG as XML: one
unmatched close tag and the map does not draw at all. An HTML page forgives
the same file, so a check that renders the art inside a page cannot see it.
`TestAStyledMapIsWellFormedXML` parses the served bytes of every styleable map
in every style, and is the only thing here that catches it.

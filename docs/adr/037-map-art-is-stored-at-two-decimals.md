---
status: accepted
---

# ADR-037 — Map art is stored at two decimals

**Status:** accepted, r27.
Coordinates in the art are rounded to at most two decimal places. Nothing else
in the art is.

The drawing programs write eight decimals. On a board 1524 units wide the
third decimal is a five-thousandth of a province border, and the file pays six
bytes a number for it. The 22 arts go from 31.5 MB to 25.5 MB, and from 9.8 MB
to 7.5 MB gzipped.

1. Only a path's `d` and a polygon or polyline's `points` are rewritten. Two
   decimals is the wrong precision for the rest: an opacity, a gradient stop's
   offset and a transform's scale factor all live between 0 and 1, where a
   hundredth is a visible change or, at `scale(0.001)`, the drawing collapsing
   to nothing.
2. The viewBox is left alone for a second reason. Every placement table is
   quoted in the coordinate space it declares (ADR-003), so rescaling would
   invalidate all of them. Rounding inside the space keeps them valid.
3. A relative path command is a delta, so what is rounded is the ABSOLUTE
   position: the residual of each rounding carries into the next delta, and no
   drawn point sits more than half a hundredth from where the art put it.
4. A definition nothing references is deleted in the same pass. That changes
   the bytes of `?style=original` and not its picture: a pattern nothing points
   at is not part of the drawing. Measured across 26 variants in 5 styles, no
   pixel changed.
5. The art bytes change, so every style plan is re-pinned to the digest of
   what it was measured on (ADR-026).

---
status: accepted
---

# ADR-031 — Pan/zoom stays hand-rolled; Leaflet rejected, its math taken

**Status:** accepted, r23 (closes the Leaflet spike).
The spike proved Leaflet integrates cleanly with the island — taps reach
our province hit-paths through its panes, doubleClickZoom off reclaims
double-tap-hold, ADR-017 is untouched — and still loses on cost. 46 KB
gzipped replaces about 460 lines that work and carry their own tests
(the gesture layer is ~10% of board.ts), and Leaflet sizes the SVG
element to the zoomed map instead of the viewport, a 17k-px layout box
at 30x on a 2 MB map — a phone-performance risk our viewBox arithmetic
does not have.

What the spike prescribes instead, all in our own gesture code:
1. Wheel deltaMode normalisation — board.ts and MapLightbox read
   event.deltaY raw, so Firefox line-mode wheels (deltaY ~3 per notch)
   zoom at 1.0045x per notch: wheel zoom is effectively dead there.
2. Pan inertia — velocity from the last pointermove samples, decayed
   over ~250 ms (Leaflet's Draggable._onUp math).
3. Eased double-tap zoom — a ~200 ms ramp through zoomedView instead of
   the instant 1.8x jump.
4. Wheel debounce — accumulate deltas ~40 ms and apply one step;
   trackpads emit dozens of events and each runs a full render today.
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r23, 2026-08-29** — ADR-031: Leaflet rejected after a working spike — 46 KB gz for ~460 replaceable lines, plus a zoomed-SVG layout-box risk on phones.

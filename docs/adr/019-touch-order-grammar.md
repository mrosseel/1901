---
status: accepted
---

# ADR-019 — Touch order grammar

**Status:** accepted, r7. Refine from playtest; log changes here.
The phone UI's order entry follows a tap grammar rather than menus:

- **Tap your unit, tap an empty highlighted province** → Move. Two taps.
- **Double-tap your unit** → Hold. (Double-tap on empty map/sea zooms.)
- **Tap your unit, tap an occupied highlighted province** → genuinely
  ambiguous (attack it or support it), so a small chip anchored at the
  finger offers **Attack / Support**; when only one is legal, no chip.
  Support → the helped unit's destinations highlight; tap one for
  support-move, tap the unit again for support-hold. The grammar reads
  as speech: "I help him go there."
- A bottom bar always shows every order type from the godip options tree
  as buttons — the fallback and the path for order types with no
  gesture (Convoy today; retreats and builds later). The chip is built
  as a reusable anchored menu so Convoy and phase-specific actions can
  join it.

Rejected: long-press = support (undiscoverable, ~500 ms per order,
conflicts with pan) and arrow-dragging (paper metaphor, but drag already
means pan at phone precision). Long-press may return later as a shortcut
for the chip, not as the primary path.

Additions from testing (r9): highlight colors carry the grammar — green =
move target, amber = occupied (tap asks attack/support), pulsing blue =
the unit being supported (tap it again = back its hold). Every stage
shows a hint naming unit and province. Order list rows have Change and
Cancel; the server cancels an order on POST with empty parts.

Known debt: the frontend holds a PROVINCE_NAMES table (variant data in
the client). At M2 the server should serve names per variant from godip's
ProvinceLongNames instead.

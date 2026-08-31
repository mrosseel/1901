---
status: accepted
---

# ADR-029 — Illegal orders are allowed, and on by default

**Status:** accepted, r19 (closes Q-007)
Players may enter orders the engine knows are illegal — bluffing by
"misordering" is part of Diplomacy (Backstabbr allows it deliberately;
WDC reads sloppy paper orders leniently; the one field complaint about
the hot-seat competitor was the lack of it). A game setting
`illegalMoves`, DEFAULT ON for every press mode, controls it.

Semantics: an illegal order is stored and shown as the player's written
order; at adjudication it is excluded from the engine's order set, the
unit holds, and the review shows the order struck through as "illegal —
unit held" (the WDC misorder outcome). Entry UX: legal targets stay
highlighted, but with the setting on, taps outside the highlights are
accepted rather than refused; the tap grammar remains the guide, not a
cage. Turning the setting off restores strict legal-only entry.

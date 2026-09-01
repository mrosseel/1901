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
order; at adjudication it is excluded from the engine's order set and the
phase's ordinary failure rule applies. An invalid movement order holds; an
invalid retreat disbands; invalid adjustments fall through to the normal
build, waive and forced-removal rules. The review says which consequence
applied instead of claiming every invalid order becomes a hold. Entry UX: legal targets stay
highlighted, but with the setting on, taps outside the highlights are
accepted rather than refused; the tap grammar remains the guide, not a
cage. Turning the setting off restores strict legal-only entry.

The setting is described as “accept orders exactly as entered”, not as a
bluffing feature. The game permits diplomacy; the interface does not coach it.

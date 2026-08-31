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

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r19, 2026-08-29** — ADR-029: illegal orders are allowed and on by default (closes Q-007).
- **r19, 2026-08-29** — An order that parses but fails validation is stored as written, excluded from the engine, resolves as IllegalOrder, and the unit holds.
- **r19, 2026-08-29** — Own seat only; amber in the list.
- **r48, 2026-08-30** — ADR-029 and ADR-044 apply; press, deadlines, anonymity and handover have no second person to be about.
- **r48, 2026-08-30** — CONTEXT.md gains Sandbox.

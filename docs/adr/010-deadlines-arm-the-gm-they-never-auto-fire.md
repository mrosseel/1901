---
status: accepted
---

# ADR-010 — Deadlines arm the GM; they never auto-fire

**Status:** accepted, r2
A deadline passing changes nothing by itself. It unlocks the GM's
force-adjudication action (the gate already defined in ADR-007). When the GM
forces, a power with no commit is adjudicated with no orders (units hold)
and the event log records an NMR for that seat — the same terminal state as
ADR-009's grace path.

Rationale: at a physical table the late player is usually still negotiating
and the GM is by definition present. Silent auto-resolution mid-conversation
is a hosted-play instinct, not a table instinct. This also keeps a single
resolution path: all-revealed auto-advance (ADR-008) or GM force — never a
timer racing the GM.

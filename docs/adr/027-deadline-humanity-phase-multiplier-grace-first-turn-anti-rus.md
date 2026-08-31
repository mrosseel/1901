---
status: accepted
---

# ADR-027 — Deadline humanity: phase multiplier, grace, first turn, anti-rush

**Status:** accepted, r18 (research/platforms.md, steal 8). Extends ADR-022.
One deadline number is not enough for a real table. Every platform that has
run real games has learned the same four rules, and all four are now settings:
versioned, event-logged, and GM-editable before and after start like every
other setting under ADR-022.

`retreatBuildPercent` (default 50, Backstabbr's) gives a retreat or build
phase that share of the movement clock. Those phases are not negotiation
phases. Nobody is talking, the orders are forced or nearly so, and a table
waiting the full clock for two disbands is a table doing nothing. The result
is rounded up and never falls below a minute, because a phase with no clock is
a phase nobody can order in.

`graceMinutes` (default 0) keeps taking orders that long after the deadline.
The deadline the clock shows does not move, since a grace period that is
announced is not a grace period. What moves is the moment `canForce` turns
true for the GM.

`firstTurnExtraMinutes` (default 0) is added to the first movement phase only.
Spring 1901 is the one turn where everybody has to talk to everybody.

The **anti-rush rule** is Backstabbr's, copied exactly. A phase that resolves
early with `R` still on the clock, into a next phase of period `T`, gets
`R + T` when `R < T`, and `R` otherwise. Both are at least `T`, so finalizing
early never shortens the next phase for anybody. That is what makes ADR-008's
auto-advance safe once deadlines are long. A phase the GM forced carries
nothing, because its clock had run out or the GM chose to spend it.

Not taken here, and still worth taking later: the weekend skip, the per-game
timezone, and a wall-clock deadline that does not drift daily. None of them
matters for a table in a room. All of them matter for hosted mode (ADR-018).

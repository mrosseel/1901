---
status: accepted
---

# ADR-034 — A seat with nothing to order is finalized by the server

**Status:** accepted, r26. Extends ADR-008 and ADR-011.
When a phase opens, every claimed seat whose power has no legal order in it is
finalized without the player being asked.

The test is `Phase().Options(state, power)`, godip's nation-scoped legal-order
tree. An empty tree means the power cannot legally do anything this phase, and
the tree is fixed the moment the position resolved, so nothing can fill it in
later. The check runs on every path into a new phase: game start, every
adjudication, and the replay-based restore.

The reason is arithmetic. In a typical retreat phase one or two powers have a
dislodged unit. The
other five or six were tapping Finalize to confirm they had nothing to
confirm, and the table waited on all of them. This is not a choice being
declined, it is an empty option set. The same holds in an adjustment phase for
a power whose centre count already equals its unit count, and in a movement
phase for an eliminated power, which under the old rule could block the game
forever.

1. The rule applies in every phase type, not only retreats.
2. An unclaimed seat is unaffected; ADR-020 already leaves it out of the count.
3. A phase where every claimed seat locks resolves on through to the next one.
   Adjudication keeps the two paths of ADR-008 and ADR-010 and gains no third.
4. Force adjudication (ADR-007, ADR-010) counts only the seats the phase asked a
   player for. Without that, a retreat with a single dislodged unit would arm
   the GM's button the instant the phase opened.
5. A phase that asked nobody for anything does not become the seat screen's
   review of the last phase. Its empty review would push out the phase the
   table actually played. The per-phase history under /watch keeps it either
   way (ADR-013).
6. The seat screen says why it is locked and offers nothing to tap. A seat
   that finds itself finalized with no explanation reads as a bug, so the
   server sends `nothingToOrder` and the screen writes it out.
7. A seat the server locked cannot be unlocked. There is nothing to change,
   and re-finalizing (ADR-011) has nothing to replace.

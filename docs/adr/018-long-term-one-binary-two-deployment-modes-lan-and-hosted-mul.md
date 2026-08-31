---
status: accepted
---

# ADR-018 — Long-term: one binary, two deployment modes (LAN and hosted multi-game)

**Status:** accepted, r6. Direction-setting; nothing in M0–M5 is reordered.
The same Go binary must eventually serve two modes:

1. **LAN mode** — what v1 ships: a GM downloads one binary, runs it on a
   laptop, hosts one table's game offline (ADR-006). This stays the primary
   deployment and must never require the hosted features.
2. **Hosted mode** — a long-running internet instance with many concurrent
   games and user accounts.

What this changes *now* (cheap if done early, expensive to retrofit):

- Every table, endpoint, and in-memory structure is keyed by game id from
  M1 onward — no single-game assumptions anywhere. The §6 data model
  already complies.
- Auth is layered, not replaced: seat tokens (ADR-005) remain the only
  thing needed to *play*, in both modes. Accounts, when they come, attach
  to game management — creating games, claiming the GM role, listing your
  games — never to seat play. "No accounts" in §1 is thereby narrowed
  from a product-wide rule to a per-seat rule; the hard requirement that
  a player joins by QR with no login is untouched.
- SQLite stays until hosted-mode load proves it insufficient; the storage
  layer should not grow features that only make sense for one mode.

What this explicitly does not change: no account system, lobby, or
multi-tenancy work before M5 is accepted. Hosted mode gets its own
milestones after v1 ships.

---
status: accepted
---

# ADR-009 — Reveal is automatic; failure to reveal is civil disorder after a grace period

**Status:** accepted, r2
Closes the gap between ADR-004 and ADR-008: the server holds only a hash, so a
committed power whose client dies could stall the table forever.

1. The client keeps `orders || nonce` in localStorage. It reveals
   automatically — no player action — the moment the reveal window opens
   (all commits in, or deadline passed). SSE reconnect re-triggers the
   reveal check, so waking a locked phone is enough to unstick it.
2. If a committed power has not revealed shortly after the reveal window
   opens, the seat is flagged to the GM and the whole table
   ("committed but not revealed" in the event log). No timer resolves
   anything. The GM chooses: wait or extend the deadline (dead phone,
   player stepped out — ADR-007 already allows extend), or force resolution,
   in which case that power is adjudicated with no orders (civil disorder)
   and the event log records it.

At a table the social fix ("unlock your phone") resolves almost every case.
The GM decision path exists so the state machine has a defined terminal
state without a timer racing a human — same philosophy as ADR-010.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r2, 2026-08-28** — ADR-009: auto-reveal from client localStorage, civil disorder after grace period — closes the committed-but-never-revealed stall between ADR-004 and ADR-008.
- **r2, 2026-08-28** — ADR-009 amended: failed reveal flags the GM (wait/extend/force), no automatic civil-disorder timer.

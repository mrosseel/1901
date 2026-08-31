---
status: accepted
---

# ADR-004 — Order secrecy via commit-reveal

**Status:** accepted, r1
Server-side secrecy is only a policy when the GM operates the server, which
is exactly the FtF case (it's the GM's laptop; they can read the SQLite
file). Commit-reveal turns it into a property:

1. Client submits `hash(orders || nonce)`. Server stores the hash only.
2. When all commits are in, or the deadline fires, clients release
   `orders || nonce`.
3. Server verifies each hash, adjudicates, publishes everything at once.

This does not stop a GM reading revealed orders — but reveals are
simultaneous, so there is nothing left to gain. It kills the actual threat:
a playing GM peeking at submitted orders before writing their own.

~50 lines. Non-negotiable if the GM plays.

Fallback if this proves awkward in practice (log it as a revision if you take
it): server rejects the GM's own orders once any other player has submitted.
80% of the benefit, 10% of the code, but it is a policy again.

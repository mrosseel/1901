---
status: accepted
---

# ADR-004 — Order secrecy via commit-reveal

**Status:** accepted, r1. Built at r52 (M3) and rebuilt at r53 as a sealed
envelope. The signature half is still not built.
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
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r52, 2026-08-31** — The fallback the entry offered — refusing the game master's own orders once anybody else has submitted — was not needed and is not built.
- **r53, 2026-08-31** — The commitment is a sealed envelope, not a digest. The lock sends the orders encrypted under a key the phone holds, and the reveal sends the key. Owner's question, and it is the right one: a digest kept the orders off the server and lost them, because a phone that locked in and then went flat held the only copy and its power was an NMR. An envelope is on the server from the lock and only 32 bytes are missing.
- **r53, 2026-08-31** — XChaCha20-Poly1305, from `@noble/ciphers` on the phone and `golang.org/x/crypto` on the server. `crypto.subtle` is unavailable because run.sh serves plain HTTP on a LAN, so the cipher is vendored like the signatures already were. The game, the phase and the power are the associated data, so an envelope cannot be moved between phases, seats or games — the same three fields the digest hashed.
- **r53, 2026-08-31** — Removing the commitment entirely was considered and refused. The reveals are not simultaneous: they arrive one at a time and each is applied as it lands, so without a commitment the last seat to reveal chooses with knowledge, and the game master reads the orders off their own server as soon as the first phone sends.

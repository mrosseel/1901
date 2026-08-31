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

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r50, 2026-08-30** — Access and authorship are split: a signature buys an HttpOnly session cookie once, and the signature over a sealed order (ADR-004) is the half that is not built.
- **r50, 2026-08-30** — Sessions live in memory, so a restart signs every device back in and leaves no credential in a file.
- **r50, 2026-08-30** — No migration — a seat row holds a token or a key, old games keep tokens, and `seat.claimed()` is the only predicate allowed to ask whether a seat is taken.
- **r50, 2026-08-30** — The game master's own seat keeps its token, because the game master page already holds a stronger credential and is often the screen on the beamer.
- **r50, 2026-08-30** — CONTEXT.md gains Seat key and rewrites Seat.
- **r52, 2026-08-31** — Built, and it is about 400 lines rather than the 50 the entry guessed, because the client half is the work: the drafts had to leave the server, so the phone keeps them in storage, draws them itself and hashes them, and the board's one seam — `BoardApi.order` — answers locally instead of posting.
- **r52, 2026-08-31** — The lock is the commitment, so there is one button and one word (ADR-011). The message hashed is `<phaseIndex>\n<power>\n<prov> <parts>\n…\n<nonce>`, sorted, and the phase and the power are inside it so a digest cannot be lifted between phases or seats. The same two digests are pinned on both sides, in Go and in TypeScript, because a drift would refuse every reveal in a real game and tell the player their orders were not the ones they locked in.
- **r52, 2026-08-31** — A sealed game is a game and not a setting: it is decided at creation and never changes, and a game made before this keeps writing its drafts to the server. Migrating a game that is mid-phase at a table would lose the orders on the table, which is the same rule ADR-049 took for tokens and keys.
- **r52, 2026-08-31** — The fallback the entry offered — refusing the game master's own orders once anybody else has submitted — was not needed and is not built.
- **r53, 2026-08-31** — The commitment is a sealed envelope, not a digest. The lock sends the orders encrypted under a key the phone holds, and the reveal sends the key. Owner's question, and it is the right one: a digest kept the orders off the server and lost them, because a phone that locked in and then went flat held the only copy and its power was an NMR. An envelope is on the server from the lock and only 32 bytes are missing.
- **r53, 2026-08-31** — The key is derived from the seat seed (ADR-049) and the phase, so a second device holding that seed makes it again. A player whose phone died opens the seat on another device from their seat link and releases the key, and the orders they wrote reach the board. That is the whole reason to prefer an envelope, and it works only for a player who kept the link: a game master handover mints a fresh seed. The game master's own seat holds a token and no seed, so it makes a random key and keeps it beside the draft; a dead phone there is still an NMR.
- **r53, 2026-08-31** — XChaCha20-Poly1305, from `@noble/ciphers` on the phone and `golang.org/x/crypto` on the server. `crypto.subtle` is unavailable because run.sh serves plain HTTP on a LAN, so the cipher is vendored like the signatures already were. The game, the phase and the power are the associated data, so an envelope cannot be moved between phases, seats or games — the same three fields the digest hashed.
- **r53, 2026-08-31** — Removing the commitment entirely was considered and refused. The reveals are not simultaneous: they arrive one at a time and each is applied as it lands, so without a commitment the last seat to reveal chooses with knowledge, and the game master reads the orders off their own server as soon as the first phone sends.

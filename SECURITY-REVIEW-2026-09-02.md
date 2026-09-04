# Security review — WebSockets, full press, and order commit/reveal

**Date:** 2026-09-02  
**Scope:** WebSocket invalidations, full-press key management and encryption,
order commit/reveal, handovers, and the surrounding authorization boundaries.

This is an implementation handoff. Findings are ordered by priority and include
the expected security property, the present failure, a recommended repair, and
acceptance tests.

## Executive summary

Order commit/reveal remains substantially tighter than full press. Its keys are
never distributed through the server, envelopes are bound to the game, phase,
and power, and a commitment cannot be changed once revealing begins.

Full press encrypts message bodies, but its room-key distribution is not yet
authenticated end to end. An active server can construct a room with a key it
chose, wrap that key for honest members, and decrypt their replies. This works
even for devices that previously pinned the participants' signing keys because
no participant signature covers the room or its wraps.

The recommended order of work is:

1. Authenticate immutable room manifests and recipient-specific wraps.
2. Make signing-key changes fail closed pending an explicit handover decision.
3. Pad sealed orders and, separately, press messages.
4. State and, where practical, reduce full-press metadata exposure.
5. Separate anonymous and authenticated WebSocket capacity.

## Threat model used for this review

The relevant attacker is not only a stranger on the LAN. The application runs
on the game master's computer, and the game master may play. They can inspect,
copy, or edit SQLite and can substitute a modified server. This is already the
reason order commit/reveal exists.

The review distinguishes:

- an honest server whose database is merely readable;
- an active server that changes responses or stored rows;
- another authenticated power using a modified client;
- an unauthenticated network client consuming resources; and
- later compromise of a device seed plus a retained database.

## SR-1 — High: room-key wraps are not authenticated

### Expected property

A reader should accept a room key only when the declared opener created that
room for exactly those members. A server may transport the room description and
wrapped keys, but it must not be able to replace them with a room key it knows.

### Current behavior

`wrapAssociated` covers only `gameId` and the sorted member list:

- `web/src/press.ts`, around `wrapAssociated`, `wrapRoomKey`, and
  `unwrapRoomKey`.

The serialized wrap prefixes an arbitrary X25519 public key. Unwrapping trusts
that prefix and never checks that it is the declared opener's verified press
key. Nothing signs the thread ID, opener, members, creation time, or set of
wraps.

On the server, `handlePressOpen` verifies that there is exactly one non-empty
wrap for every required holder, but cannot authenticate their contents:

- `press.go`, `handlePressOpen`, particularly the holder checks and construction
  of `pressThread`.

### Attack

An active server can:

1. Read every member's public X25519 key.
2. Generate an attacker-controlled X25519 secret and room key.
3. Wrap that room key separately for each honest member, prefixing the
   attacker's public key.
4. Insert a `press_thread` and its `press_key` rows, claiming an honest power
   opened the room.
5. Present the room to its members. Every member can unwrap the attacker-known
   key because the embedded public key is trusted.
6. Decrypt every reply sent into the room.

Existing signing-key pins do not detect this because no signature is involved
in room creation. This is stronger than ADR-054's documented first-contact
identity substitution: it also works after honest signing keys have been seen
and pinned.

### Recommended repair

Introduce a signed, immutable room manifest.

The opener should generate a random thread ID on the client before wrapping.
The canonical signed manifest should include at least:

- protocol/version domain separator;
- game ID;
- thread ID;
- opener holder;
- opener X25519 public key;
- canonical sorted member list;
- creation timestamp, if it remains meaningful UI state; and
- a canonical mapping or digest of each holder to their exact wrapped key.

Each individual wrap's AEAD associated data should additionally bind:

- the manifest hash or all immutable manifest fields; and
- the intended holder.

The server must reject duplicate thread IDs and structurally invalid manifests.
Every client must verify the opener's Ed25519 signature against its pinned key
before showing the room as writable or attempting to unwrap it. Server-side
signature validation is useful consistency checking, but client validation is
the security boundary.

Historical verification across handovers requires retaining the signing-key
epoch used to open a room. Do not verify old rooms only against the seat's
current signing key.

### Acceptance tests

- Replacing the public-key prefix inside a wrap makes the room fail closed.
- Replacing any holder's wrap makes the manifest signature fail.
- Moving a wrap to another holder fails.
- Moving a wrap between two rooms with identical members fails.
- Changing the opener, members, thread ID, or creation time fails.
- A fully server-fabricated room using an attacker-known room key is rejected.
- A room opened before a legitimate handover remains verifiable against its
  old signing-key epoch but is not readable by the new holder.

## SR-2 — Medium: signing-key pins are fail-open and self-replacing

### Expected property

Once a device has pinned a holder's signing key, a different key must not become
trusted merely because the server repeated it. A legitimate handover needs an
explicit, auditable transition.

### Current behavior

`pinSignKeys` reports a changed key and immediately overwrites the stored pin:

- `web/src/press.ts`, `pinSignKeys`.

`PressPanel` then merges the server's current keys over the pinned keys and uses
the result for room creation and message verification:

- `web/src/components/PressPanel.tsx`, the `pinSignKeys` call, `signKeys` prop,
  and `wrapsFor` call.

The warning is transient. If the malicious key remains stable, the next
three-second poll reports no change and removes the warning. Encryption is not
blocked while the warning is visible.

### Recommended repair

- Keep the old pin authoritative after a mismatch.
- Put the new key in a pending state and block new rooms and verification under
  it.
- Require explicit confirmation tied to a visible handover event or seat epoch.
- Prefer a signed handover/key-transition record when feasible.
- Retain prior key epochs for verification of historical messages and room
  manifests.

There is also a classification bug in `verifyPress`: a missing message
signature is always returned as `unsigned`. When `senderSignPub` exists, a
missing signature should be `bad`; `unsigned` should be reserved for legacy or
token seats that genuinely have no signing identity.

### Acceptance tests

- A changed signing key remains pending over repeated polls.
- No new wrap is made for a pending key.
- Messages are not verified under a pending key.
- Explicit acceptance advances the pin once and records the new epoch.
- A missing signature from a holder with a signing key is `bad`.
- A missing signature from a genuine token/legacy holder remains `unsigned`.

## SR-3 — Medium: sealed orders and press leak plaintext length

### Expected property

The server should not be able to infer strategically useful order or message
content from ciphertext size.

### Current behavior

Order sealing encrypts canonical JSON without padding:

- `sealed.go`, `canonicalOrders` and `sealOrders`;
- `web/src/sealed.ts`, `canonicalOrders` and `sealOrders`.

AEAD adds a fixed overhead and otherwise preserves plaintext length. The server
therefore observes the serialized order-list length. For small retreat and
adjustment domains, and sometimes for movement orders, enumerating legal
plaintexts can identify or substantially narrow the committed order.

Press messages have the same length leak in `sealMessage`.

### Recommended repair

For orders, use a fixed-size padded plaintext. The existing 8 KiB server
envelope ceiling is affordable for seven seats. Put the true content length
inside the encrypted plaintext and reject invalid padding on open.

For press, fixed 16 KiB messages would be expensive. Use documented size
buckets, for example 256, 512, 1024, 2048, 4096, 8192, and 16384 bytes, with the
real length authenticated inside the plaintext. Exact bucket choices should be
based on expected table traffic.

Maintain Go/TypeScript cross-implementation fixtures for padded order envelopes.

### Acceptance tests

- Every valid order set produces the same wire length.
- Go opens TypeScript-padded envelopes and TypeScript opens Go envelopes.
- Invalid internal lengths and non-canonical padding are rejected.
- Press messages expose only their configured size bucket.

## SR-4 — Design gap: full press exposes traffic metadata

### Current exposure

The server permanently learns and stores:

- room membership and opener;
- exact sender, phase, timestamp, and sequence of every message;
- ciphertext length; and
- per-holder read receipts.

Relevant structures and tables are in `press.go` and the press schema in
`store.go`.

This means "the server cannot read press" is accurate only for message bodies.
It does not hide the social graph or communication cadence, both of which are
strategically meaningful in Diplomacy.

Full press also lacks forward secrecy. A later compromise of a seat seed plus a
copy of the database decrypts that seat's retained room history. This differs
from order envelopes: resolved orders become public, while old sealed envelopes
are cleared.

### Recommended repair

At minimum, make every user-facing and architectural claim say
"content-encrypted, metadata-visible." Do not imply that who talked to whom is
hidden from the server.

Then decide explicitly among these larger options:

- accept the social graph as part of the server model;
- replace explicit rooms with per-holder opaque mailboxes, accepting additional
  client complexity and traffic analysis that still remains;
- remove or coarsen read receipts and timestamps;
- pad message sizes as in SR-3;
- establish a retention/deletion policy at game end; and
- add room-key rotation or a ratchet if protection after later seed compromise
  is required.

## SR-5 — Low: anonymous WebSockets consume authenticated capacity

### Current behavior

`gameEvents` has one 64-subscriber pool for public, seat, and game-master
connections:

- `events.go`, `maxGameSubscribers` and `subscribe`.

The bare `/api/v1/game/{id}/events` route is public by design:

- `flow.go`, `serveFlowAPI`.

A raw client can open all slots without credentials. Legitimate clients then
fall back to polling, increasing HTTP load. There is no server-wide WebSocket
limit, so the per-game cap can still amount to thousands of connections across
the configured game limit.

The WebSocket library's default same-origin check is intact, and role handover
correctly revokes seat/GM sockets. Those parts should remain unchanged.

### Recommended repair

- Maintain separate public and authenticated quotas.
- Reserve enough authenticated slots for all seats and the GM.
- Add a global connection ceiling.
- Consider a small per-source limit for anonymous public sockets.
- Preserve polling fallback and coalesced invalidations.

### Acceptance tests

- Exhausting the public quota does not refuse a seat or GM connection.
- Exhausting one game's quota does not exceed the global cap.
- Handover still closes the previous holder's live connection.
- Slow clients still receive the newest coalesced version.

## Commit/reveal assessment

The core construction is sound:

- XChaCha20-Poly1305 binds an envelope to game, phase, and power.
- A commitment cannot be replaced once the reveal window is open.
- Reveal routes are role-authenticated and recheck province ownership.
- Forced adjudication removes orders belonging to unrevealed seats.
- Per-phase keys are derived separately from signing and press keys.
- A handover retains only the old current-phase reveal key, not the former
  holder's signing identity or future order keys.

The main confidentiality defect is SR-3's length leak.

Commitments are not signed into an independently verifiable transcript. An
active server can delete or corrupt an envelope and make the incident resemble
a failed player reveal. It still cannot silently choose or decrypt the player's
orders. If post-game dispute resolution is a product requirement, add signed
commitments plus a receipt or append-only transcript; this is hardening rather
than a prerequisite for the present confidentiality property.

## Verification performed

At the reviewed revision (`815c6db`):

- `nix develop path:. -c go test ./...` passed.
- Frontend Vitest passed: 32 files, 483 tests.
- The locked npm dependency set reported zero audited vulnerabilities.
- `nix develop path:. -c govulncheck ./...` found no reachable vulnerability.

The first frontend run used stale `node_modules` and could not resolve the newly
declared `@noble/curves` import. Refreshing from `package-lock.json` fixed the
environment; it was not a product defect.

## Definition of done

The high-priority work is complete when a server that controls SQLite and HTTP
responses cannot make an already-pinned client write into a room whose key the
server chose, and the test suite includes that attack as a negative fixture.

The full review is complete when SR-1 through SR-5 have either landed or are
recorded as explicitly accepted risks with accurate user-facing claims.

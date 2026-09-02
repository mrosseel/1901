---
status: accepted
---

# ADR-054 — The server cannot read press, and a referee who does not play may

**Status:** accepted, r56. Extends ADR-004, ADR-007, ADR-013, ADR-048,
ADR-049. Depends on ADR-053 for what a room is.

## Why this is not optional

ADR-004 seals orders for one reason: the server is usually the game master's
laptop and the game master usually plays, so "the server does not show your
orders to anybody" is a promise and not a property.

Press has the same problem and worse content. Who is talking to whom is most of
Diplomacy, and the message bodies are the rest of it. A build that sealed the
orders and stored the negotiations in the clear would be saying "your orders
are secret from me, your plans are not", which is not worth having.

> **The room key never reaches the server. It is made on a device, wrapped once
> per member under a key the two devices agree on, and the server stores
> ciphertext, a member list and a time.**

Backstabbr does the opposite, and its FAQ calls the game master reading all
press a perk. It can: a Backstabbr creator who takes a seat in a public game
keeps no game master powers, because "the risk of abuse is too high"
(research/platforms.md). Ours plays and keeps them. That difference is what
ADR-007 and ADR-013 already committed us to.

## The keys

`web/src/keys.ts` is the one place this app does cryptography, and it already
derives a named key from a secret. The seat seed of ADR-049 yields a signing
key under `1901 seat sign v1` and a per-phase order key under `1901 order key
v1`. Press adds a third name.

    1901 seat box v1     X25519, from the seat seed
    1901 gm box v1       X25519, from the game master's key (ADR-048)
    1901 press wrap v1   HKDF over the shared point, with both public halves,
                         sorted, in the info

X25519 and not Ed25519, because this key has to agree on a secret with another
seat and a signing key cannot. It comes from `@noble/curves`, the same author
as the three libraries already vendored, and it obeys the same rule the file
header states: nothing in this app may depend on `crypto.subtle`, because
`run.sh` serves plain HTTP on a LAN and that is not a secure context.

A message is XChaCha20-Poly1305 under the room key, with
`<gameId>|<threadId>|<seq>|<sender>|<phaseIndex>|<at>` as associated data:
every field the server stores in the clear beside the box. So no message can be
moved to another room, another game, another place in the order, another mouth,
another phase or another time. The phase and the time are in there because the
panel draws with them, ruling off where a phase resolved and sorting by time, so
a server free to change either could rearrange a conversation without touching a
word of it. Then the whole thing is signed, because inside a room of three the
room key alone does not say which of the three wrote a line.

A wrap is bound too, with `<gameId>|<members>`, so one lifted out of a stored
database cannot be replayed into another game or into a room with a different
membership.

## What this does not protect against, said first

The public keys come from the server. A server that lies about them — handing
out its own X25519 key in place of Italy's — reads everything wrapped for that
key. Two things narrow that and neither closes it:

- **A published press key is signed by its own seat**, with the Ed25519 key
  the seat already authenticates with. So the cheap lie, swapping one half,
  fails: the reader refuses to open a room with a key that does not check, and
  names the power.
- **Every device pins the signing keys it has seen.** A signing key changes
  when a seat is handed on and at no other time, so a change is either a
  handover the table knows about or a server inventing one. The panel names
  the powers whose key is new and says what that means, rather than deciding
  for the player.
- **A pin cannot be taken away.** A key simply missing from an answer counts
  as changed and keeps its pin, and the pin is what a wrap is then checked
  against. Otherwise the cheapest attack on the whole scheme would be to omit
  a signing key: with nothing to check against there is nothing to fail, and a
  device that had already seen the real one would never notice.
- **A pin does not refuse a change, only report one.** Where the server has a
  key, that key is what a message is checked against, and the pin moves to it.
  A handover changes a seat's key for real, so a pin that refused the new one
  would end that seat's press for the rest of the game. The warning is the
  defence and the table is what decides: only the room knows whether somebody
  handed a seat on.

What is left: a server that lies about both halves from the first request a
device ever makes is not detected. There is no out-of-band channel to check a
key against, and inventing one — a fingerprint read out at the table — is a
real answer that this decision does not take.

**So press is weaker than orders, and this is the sentence that says so.** An
order's key never leaves the device at all (ADR-004), so a sealed order is
safe even against a server that is actively lying. Press is safe against a
server that reads its own database, and against one that tampers after the
fact. It is not safe against one that lies about who is who from the start.
Nothing in the app may claim otherwise.

## The holes, said out loud

- **A seat holding a token cannot derive.** That is the game master's own seat
  and every seat of a game made before ADR-049. It makes 32 random bytes once
  and keeps them in this device's storage. If that phone dies its press is
  gone. `sealed.ts` has the same hole for the same reason, and this one is no
  worse.
- **A handover ends a conversation.** The recipient gets fresh bytes, because
  ADR-049 requires it, and cannot read what the previous player was told. That
  is correct rather than a bug: the promises were made to a person.
- **The server cannot check a wrap.** It can require that a wrap exists for
  every holder. It cannot know whether the bytes inside it are the room key. A
  modified client can send noise, and the reader is shown a room it cannot
  open rather than a room that looks empty. Nothing here pretends otherwise.

## The referee's mailbox

Full press with nobody able to read it means a dispute at a tournament board
has no record to settle it with. At a table the referee hears the talk; here
there is nothing to hear. So one setting exists.

> **`gmReadsPress` makes the game master a member of every room. It is
> offered only when `gmPlays` is off.**

A game master who plays can never be given it, at any point. `gmPlays` is
already fixed at start, so the pair holds for the whole game, and
`settings.normalised()` holds the invariant in one place rather than trusting a
form.

What it means in practice: **the sender wraps the room key for the game
master's key as well as for each member.** The referee is copied into every
message, and so the referee needs a mailbox.

- The mailbox reads. It does not write into a room the powers opened: a referee
  who could speak as the room is a referee the room cannot tell apart from
  itself. The game master may open a room of its own, for a ruling, and speak
  in that. It signs a ruling with the ADR-048 key, whose public half the server
  already publishes, so a ruling is checked against the same key that proves
  who the game master is.
- **A room the game master opened is not the same room as one the powers
  opened**, even with the same members. Otherwise a power asking for its own
  notepad would be handed a room the referee opened with that power in it, and
  the exemptions that belong to a notepad would apply to a referee's room.
- The game master's key comes from ADR-048, so the twelve words recover the
  mailbox with the game. A game whose game master declined a key cannot turn
  the setting on.
- The setting is fixed at start for a harder reason than agreement: every room
  key already handed out was wrapped for the holders this setting named.
  Turning it on later would promise a mailbox no existing room has a key for,
  and turning it off would not take back the keys already sent.
- It is on the join page, in one sentence, before anybody joins.

**ADR-013 gains one exception.** The game master view is secret-free and safe
on a shared screen, and the board still is. The mailbox is a different screen,
behind its own tap, and it is not projector-safe. The spectator view is the
game master view minus admin controls and reaches none of it, because it holds
no key.

## What is rejected

- **Plaintext press with a filter in the handler.** See ADR-004 and the
  endpoint discipline in DESIGN.md §5.
- **The server checking signatures.** That would be the server deciding who
  said what. Readers check, against public keys the server publishes and this
  device has pinned.
- **A fingerprint read out at the table.** It would close the first-contact
  hole above and it is the honest fix. It is not built, and the limit is
  written down instead of being implied away.
- **A game master who plays reading press under any condition.** There is no
  wording for the join page that makes it honest.

## Revisions

- **r56, 2026-09-02** — ADR-054 accepted and built. The key-distribution limit
  above was written after a review pointed out that the first draft claimed
  more than the code does.

---
status: accepted
---

# ADR-056 — A room is signed by whoever opened it

**Status:** accepted, r57. Extends ADR-049, ADR-054. Depends on ADR-053 for
what a room is.

ADR-054 said the server cannot read press, and it was half right. The room key
never reached the server. Nothing said the room the key belonged to was real.

## The hole

A room key travelled to each member wrapped under a key the two press keys
agreed on, and the wrap carried the opener's public key in front of it. The
reader took that public key out of the wrap it was about to open.

So a server could make up a room. It reads every member's published press key
already. It generates its own X25519 secret and a room key of its own, wraps
that room key once per member, puts its own public key in front of each wrap,
writes a `press_thread` row saying France opened the room, and hands it out.
Every member opens it, because the key they compute the wrap key from is the
one the server put there. Every reply goes into a room the server can read.

Pinned signing keys did not help. No signature covered the room, the members,
the opener or the wraps, so there was nothing for a pin to check. This is
worse than the first-contact hole ADR-054 wrote down, because it works against
a device that has seen and pinned the real keys for the whole game.

## The room is a signed thing now

> **The opener makes the room id, stamps the time, wraps the key once per
> holder, and signs a manifest over all of it. A reader checks that signature
> against the key it has pinned before it unwraps anything.**

The manifest is one string:

    1901 press room v1|<game>|<thread>|<opener>|<openerBoxPub>|<openedAt>
    |<members sorted, comma>|<holder=sha256(wrap), sorted, comma>

Each wrap is bound to the same room, plus the holder it was made for:

    1901 press wrap v2|<game>|<thread>|<opener>|<openerBoxPub>|<holder>
    |<members sorted, comma>

The wrap digests are what stop a wrap moving. Replace one and the manifest no
longer describes the room. Move one to another holder's mailbox and its own
associated data no longer matches. Lift one out of another room with the same
members and both checks fail, because the thread id is in each.

The opener's press key is in the manifest, so a reader takes it from something
the opener signed rather than from the wrap it is opening. That one change is
what kills the attack above; the digests and the id are what keep the rest of
the room from being rearranged afterwards.

### Who makes the id and the time

The device, because the opener signs them and cannot sign a value the server
has not sent yet. The server checks their shape, refuses an id a room already
has, and stores what it was given. It also checks the signature when it knows
the opener's signing key. That check is a courtesy to a buggy client and not a
defence: a server that wanted to hand out a room it made up would simply not
run it. The reading device is the boundary, which is the same rule ADR-054
already stated about message signatures.

### The key that opened the room is kept

A room stores the opener's signing key as it was at the time. A handover
replaces a seat's key (ADR-049), and without this every room opened before it
would fail its signature check. A reader accepts the pinned key or any key it
replaced, and never a key it has not accepted.

## Pins fail closed

ADR-054 wrote down that a pin reports a change and then moves to it, and gave
the reason: a handover changes a seat's key for real, so a pin that refused
the new one would end that seat's press. That reason was sound and the answer
was wrong. A server that kept sending the same invented key was believed from
the second poll onward, and the warning went away with it.

> **A pin keeps the key it has. A different key is held as pending: nothing is
> checked against it, and no room key is wrapped for that holder.**

Two things clear a pending key.

**A signed step.** The device taking a seat signs

    1901 handover v1|<game>|<power>|<oldSignPub>|<newSignPub>

with the key it is about to replace. It can, because the outgoing player's
link carries their seat seed in its fragment (ADR-049), which is the same
thing that already lets the recipient release an envelope the old device
locked in. The server stores the step and publishes it. A device holding the
old key as its pin checks the signature itself and advances, without asking
anybody. The server cannot forge one, so following it is safe.

**The table.** A link the game master minted carries no former seed, because
the server does not have one. That is the dead-phone case, and it is exactly
the case an attack imitates. There is nothing to check, so the panel names the
power and waits for somebody at the table to say the seat was handed on. This
is the one place the app asks a human, and it asks because the machine has run
out of evidence.

Keys a pin replaces are kept in a history and used for checking old messages
and old rooms. A handover must not turn everything a seat said before it into
a forgery.

## What is still not fixed

**First contact.** A device that has never seen a power's real signing key has
nothing to compare against, and a server that lies about both halves from the
first request is believed. ADR-054 said this and it is still true. The
fingerprint read out at the table is still the honest fix and is still not
built.

**An opener with no signing key.** The game master's own seat holds a token,
and so does every seat of a game made before ADR-049. Such an opener cannot
sign a manifest. The room opens and the panel says it could not be checked,
which is the same treatment an unsigned message gets.

**Metadata.** None of this hides who is talking to whom. See ADR-054.

## Migration

None. A game lasts an evening. A room opened before this has no manifest, and
a reader shows it as a room this version cannot check rather than opening it.
The three columns on `press_thread` are added to an existing database and are
empty on every old row.

## Revisions

- **r57, 2026-09-02** — accepted and built, after a security review found that
  a modified server could construct a room with a key it chose and read every
  reply to it.

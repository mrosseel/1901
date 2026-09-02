---
status: accepted
---

# ADR-057 — A length is a message too

**Status:** accepted, r57. Extends ADR-004, ADR-054.

XChaCha20-Poly1305 adds sixteen bytes for the tag and leaves the plaintext's
length alone. So the server read the size of every sealed order list and every
press message, and both sizes say something.

An adjustment phase is the clearest case. A power with two builds has few legal
order sets, and the serialized length of each one is different. The server does
not need the key; it needs a list of the legal sets and a ruler. A retreat is
nearly as bad. A movement phase is safer and not safe, because the length still
separates a board that ordered seven holds from one that ordered a supported
attack.

A press message is worse in the other direction. "No" and a paragraph of terms
are the same conversation to an AEAD and different news to anybody watching.

## The frame

Inside the box, in front of the content:

    byte 0      version, 0x01
    bytes 1..4  the content's length, big-endian
    bytes 5..   the content, then zero bytes to the target size

Opening checks the version, that the stated length fits, and that every padding
byte is zero. Anything else is refused rather than trimmed. A decoder that
repaired a frame would accept two spellings of the same message, which is the
thing the padding exists to prevent.

The frame is built in `pad.go` and `web/src/pad.ts`, and the two must not
drift. `TestTheServerOpensWhatThePhoneSealed` pins a padded envelope the
TypeScript side produced, so a Go side that framed differently fails.

## Orders get one size

**4096 bytes.** One size and not a bucket, because a phase's orders are small
and seven seats of them cost nothing. Every envelope in every game is now the
same length, which is the strongest statement available.

The worst case a classical board can produce is one power holding all 34 supply
centres, every unit giving the longest order the parser takes. That is about
2900 bytes of canonical JSON, and `TestEveryOrderSetFitsOnePlaintext` asserts
it fits. The envelope that comes out is 5515 base64url characters, inside the
8192 `maxEnvelope` already had.

## Press gets buckets

**256, 512, 1024, 2048, 4096, 8192, 16384 bytes.** A fixed 16 KiB message would
cost a table of seven a few megabytes an evening to hide a sentence, and a
tablet on a phone network pays for that. What the server sees is which bucket a
message fell in. Inside a bucket every message is the same length, and most of
a game's traffic is one bucket.

A message past the largest bucket is refused on the device that wrote it,
because the alternative is a message only that device can see. `maxPressBody`
is 32 KiB, which is the largest bucket on the wire plus its JSON.

The server checks that a message is one of these lengths and nothing else about
it. It is the one thing a process that cannot read a message can say about it,
and refusing an unpadded one stops a modified client spending the evening
telling the server how long every sentence was.

## The old format

An envelope or a message written before this opens without a frame. Both
decoders fall back: an order plaintext starting with `[` is the old canonical
JSON, and a press plaintext whose first byte is not the version byte is the old
raw text. This exists for a game that is mid-phase when the version changes,
which is the only kind of game that can have one.

**Remove both fallbacks in r59.** By then no game from before this release can
still be running, and keeping a second accepted format past that point is
keeping an attack surface for nothing.

## What this does not do

Padding hides a length. It does not hide that a message was sent, when, by whom,
to whom, or how often. See ADR-054.

## Revisions

- **r57, 2026-09-02** — accepted and built, after a security review pointed out
  that the server could narrow a committed order set from the size of its
  envelope.

---
status: accepted
---

# ADR-058 — A resolved phase keeps the envelope it came from

**Status:** accepted, r57. Extends ADR-004, ADR-009, ADR-049.

Commit-reveal keeps the orders off the server until every seat has committed.
It does not leave a record anybody can check afterwards. Once a phase resolves,
the orders on the page are there because this server put them there, and a
table arguing about what somebody committed has only the server's word.

The gap is narrow and real. An active server cannot read a sealed order and
cannot choose one, which is what ADR-004 exists for. It can delete an envelope
and make the seat look like a phone that never revealed, and nothing in the
game distinguishes the two.

## What is stored

> **A seat signs the envelope it locks in. When the phase resolves, the
> envelope and that signature are kept beside the orders.**

    1901 sealed v1|<game>|<phaseIndex>|<power>|<envelope>

The three fields are the ones the envelope's own associated data already binds,
so a signature cannot be moved anywhere the envelope cannot.

The signature is sent with the lock and replaced whenever the lock is. Nothing
is kept until the reveal: a commitment that can still be withdrawn is not a
record of anything, and a withdrawn one leaves nothing behind. On reveal, the
envelope and its signature go into `phase_commitment`, and the phase review
carries them from then on, live and after a restart alike.

## What it settles, and what it does not

It settles what a power committed. The signature is that seat's, the envelope
is what the signature covers, and the key that seat released opens that
envelope onto exactly the orders on the page. Anybody holding the phase record
can check all three without trusting this server.

It does not settle whether a commitment existed. A server that deletes an
envelope before the reveal produces a seat that looks like a dead phone, and
the game master forces the phase (ADR-009). No signature anybody holds can
prove a message the server refused to keep. Closing that needs a receipt the
committing device keeps and can show, or an append-only transcript, and neither
is built.

A seat holding a token has no key and signs nothing, which is the game master's
own seat and every seat of a game made before ADR-049. Such a commitment is
kept with an empty signature and is exactly as checkable as it was before,
which is not at all.

## Revisions

- **r57, 2026-09-02** — accepted and built. A security review called signed
  commitments hardening rather than a prerequisite, and this is that hardening.

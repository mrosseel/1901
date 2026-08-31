---
status: accepted
---

# ADR-007 — GM powers are enumerated and audited

**Status:** accepted, r1
Allowed: start game, choose variant, set/extend deadline, generate and
regenerate invites, force adjudication, pause, replace a player, edit board
state.

Forbidden at the API level (no endpoint exists): read unsubmitted or
uncommitted orders, edit another player's orders.

Constraints: force-adjudication is gated — only after the deadline has
passed, or when all but one power has submitted. Board-state editing is
allowed because tables make physical mistakes, but it is logged loudly.

Every GM action appends to a public, append-only event log visible to all
players in-game. The audit trail is what makes a playing GM socially
acceptable; it is a feature, not compliance theatre.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r44, 2026-08-30** — It is an enumerated, logged game master power (ADR-007), because a game master who can mint a link for any seat can take any seat; the record is what makes that visible rather than prevented.

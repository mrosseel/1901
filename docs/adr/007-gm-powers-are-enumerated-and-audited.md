---
status: accepted
---

# ADR-007 — GM powers are enumerated and audited

**Status:** accepted, r55
Allowed: start game, choose variant, set/extend deadline, generate and
regenerate invites, force adjudication, pause, replace a player, edit board
state.

Forbidden at the API level (no endpoint exists): read unsubmitted or
uncommitted orders, edit another player's orders.

Constraints: force-adjudication is gated — only after the deadline and any
grace period have passed. Everybody being ready may resolve normally, but
one remaining player is not permission for the referee to end their phase.
Board-state editing is
allowed because tables make physical mistakes, but it is logged loudly.

Every GM action appends to a public, append-only event log visible to all
players in-game. The audit trail is what makes a playing GM socially
acceptable; it is a feature, not compliance theatre.

## Revisions

- **r55, 2026-09-01** — Removed the all-but-one force shortcut. Early
  adjudication needs every required seat's readiness; otherwise the published
  deadline and grace period govern.

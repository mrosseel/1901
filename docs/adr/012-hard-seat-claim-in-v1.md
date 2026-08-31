---
status: accepted
---

# ADR-012 — Hard seat claim in v1

**Status:** accepted, r2. Amended r27 by ADR-034: a handoff no longer needs
the GM.
Upgrades ADR-005's "optional" claim to mandatory. The first device to open a
seat link claims the seat: the server issues a random device secret that
the client stores and presents thereafter. Any other device opening the
same link is blocked with "seat already claimed" and the attempt is logged
to the event log — a shoulder-surfed QR announces itself.

Moving a seat to a new device (dead phone, swapped handset) goes through
the GM: rotate the seat token (ADR-007 player replacement), player rescans
and re-enters orders. Rationale: ADR-009 makes the device load-bearing
(drafts and unrevealed orders live in its localStorage), so two devices
holding one seat with divergent state is exactly what commit-reveal cannot
tolerate.

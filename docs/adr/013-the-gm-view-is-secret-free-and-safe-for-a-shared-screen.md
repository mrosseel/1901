---
status: accepted
---

# ADR-013 — The GM view is secret-free and safe for a shared screen

**Status:** accepted, r2. Extended r18 by ADR-028 (public per-phase URLs).
The GM view may show who has committed or revealed, the deadline, the audit
feed, and admin controls — never order content and never any power's
`Options()` output. Invite QRs appear only in a pre-game seating screen and
are hidden once a seat is claimed (a lingering QR invites seat hijack).

Consequences: the GM can run the game from a laptop the whole table can
see while playing from their own phone seat, and the spectator/projector
view (Q-005) is this view minus the admin controls — no extra data model
work. This resolves Q-005's "do not make it hard" constraint.

Addition (r8): the spectator view gets layout variants chosen
in the URL — board only; board + move list (previous phase's orders and
resolutions); later possibly board + SC count. Same data, different
composition; still zero secret content. Post-v1 unless a playtest wants
it sooner.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r2, 2026-08-28** — ADR-013: GM view is secret-free and safe for a shared screen; resolves Q-005.
- **r8, 2026-08-28** — ADR-013 addition: beamer view gets URL-chosen layout variants (board only, board + move list, …).
- **r8, 2026-08-28** — M1 direction started in code: /g/{id} lazily-created games in the spike.
- **r10, 2026-08-28** — ADR-013's "beamer" renamed spectator view; spectator is strictly read-only for orders, annotations allowed later.
- **r45, 2026-08-30** — The old per-power list published the join order on a screen the whole table reads (ADR-013), against ADR-020's anonymous seats, and the player waiting screen already showed a count for that reason.

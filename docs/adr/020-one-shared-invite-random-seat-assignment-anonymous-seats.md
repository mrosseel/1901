---
status: accepted
---

# ADR-020 — One shared invite; random seat assignment; anonymous seats

**Status:** accepted, r11. Amends ADR-005's per-power QR model.
The GM shares ONE invite link/QR. Claiming it assigns a random
still-unassigned Power, transactionally (no double assignment under
concurrent scans). A device that claims again gets its existing seat back,
so re-scanning cannot re-roll; changing seats requires GM token rotation
(ADR-012). Seats carry no player name — the server never learns who is who.
At a face-to-face table identity is social anyway; for gunboat play the
app must not leak it. A later setting may add open identities; the default
is anonymous.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r11, 2026-08-28** — ADR-020 single shared invite with random anonymous seat assignment (amends ADR-005); ADR-021 GM power = the leftover, revealed at Start; ADR-022 settings fixed pre-invite, later changes versioned and broadcast.
- **r11, 2026-08-28** — M1 flow implementation begun (in-memory first; SQLite to follow within M1).
- **r13, 2026-08-28** — M1 flow implemented end-to-end (ADR-020/021/022) as React SPA + Go, verified live.
- **r13, 2026-08-28** — M0 sandbox and static/ deleted; / redirects to /new.
- **r13, 2026-08-28** — Still in-memory — SQLite persistence remains before M1 acceptance.

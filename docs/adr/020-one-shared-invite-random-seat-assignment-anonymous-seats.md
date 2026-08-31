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

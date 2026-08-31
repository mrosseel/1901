---
status: accepted
---

# ADR-005 — Auth: signed per-power tokens in the URL

**Status:** accepted, r1
`/g/{gameId}/{powerToken}`. GM screen shows one QR per power; players scan
their seat. Optional one-time claim step binds a token to a device so a
scanned-over-someone's-shoulder code can be detected.

No accounts, no email, no passwords, no login screen. Player replacement =
rotate that power's token and invalidate the old one.

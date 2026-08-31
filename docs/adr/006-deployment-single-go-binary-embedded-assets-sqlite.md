---
status: accepted
---

# ADR-006 — Deployment: single Go binary, embedded assets, SQLite

**Status:** accepted, r1
One static binary with the frontend and map assets embedded. Runs hosted, on
the GM's laptop, or on a Pi. SQLite for state. SSE for phase transitions
(not WebSocket — the traffic is one-directional and low-frequency).

**LAN mode is a first-class target, not a fallback.** mDNS advertisement,
works with all devices on the machine's hotspot, zero internet. This is the
thing Backstabbr structurally cannot do.

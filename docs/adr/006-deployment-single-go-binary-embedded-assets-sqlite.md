---
status: accepted
---

# ADR-006 — Deployment: single Go binary, embedded assets, SQLite

**Status:** accepted, r2

One static binary with the frontend and map assets embedded. Runs hosted, on
the GM's laptop, or on a Pi. SQLite for state. One WebSocket per game view for
live invalidations and press/chat; state-changing game commands remain HTTP.

Socket state frames contain only a monotonically increasing version. Each
view responds by reading its own public, seat, or game-master endpoint, so the
live channel cannot expose another power's pending orders. Slow clients may
drop intermediate versions because one current-state read subsumes them.

Connected clients receive joins, handovers, settings, lock/reveal changes,
adjudication, draw proposals and votes, and game results immediately. Private
draft edits do not publish. Clients reconnect with bounded backoff, refresh on
the initial frame, and use the existing HTTP poll while disconnected.

Press/chat uses the authenticated seat and game-master WebSockets. Its message
schema, recipient rules, persistence, and moderation belong to the press
feature rather than the transport.

**LAN mode is a first-class target, not a fallback.** mDNS advertisement,
works with all devices on the machine's hotspot, zero internet. This is the
thing Backstabbr structurally cannot do.

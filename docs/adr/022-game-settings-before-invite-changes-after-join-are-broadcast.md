---
status: accepted
---

# ADR-022 — Game settings before invite; changes after join are broadcast

**Status:** accepted, r11
The GM fixes settings (deadline length, gmPlays, future: variant,
identity mode) when creating the game, before invites go out, so joiners
see the rules up front. The GM may change settings later; every change
bumps a settings version and all seats are notified ("rules changed")
with the diff. Every change lands in the event log (ADR-007).

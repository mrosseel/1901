---
status: accepted
---

# ADR-023 — Press mode is a game setting: ftf, gunboat, fullpress

**Status:** accepted, r16
The GM chooses the press mode at creation, shown to players on the join
page as part of the rules (ADR-022):

- **ftf** (default): negotiation is verbal at the table; the app carries
  no messages. Identity is social.
- **gunboat**: no negotiation. App-identical to ftf today, but declared —
  and seat anonymity (ADR-020) is load-bearing rather than incidental.
- **fullpress**: in-app messaging between powers. Post-v1 (hosted-mode
  territory, ADR-018); selectable in the UI only when implemented — until
  then visible but disabled with a "later" note, so the model is
  established in data now.
- **rulebook** (added r18): press during movement phases, none during
  retreat and build. This is webDiplomacy's fourth mode, and it says this is
  how face-to-face Diplomacy is played. Backstabbr defaults to the same
  behaviour (research/platforms.md, steal 7). It is outside evidence for
  Q-004, that retreat and build phases are not negotiation phases and should
  not make the whole table wait.

Immutable after start, like gmPlays.

**Implementation (r18).** Data only. `settings.pressMode` is accepted at
creation and by the GM before start, validated against the four names,
event-logged, persisted in `game.press_mode` and returned in the GM, seat and
public views. No behaviour is attached to it, and the app carries no messages
in any mode.

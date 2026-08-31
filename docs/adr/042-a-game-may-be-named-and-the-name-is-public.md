---
status: accepted
---

# ADR-042 — A game may be named, and the name is public

**Status:** accepted, r45 (owner request). Extends ADR-022.
A game master running two tables needs to tell them apart, and a
ten-character id does not do it. `settings.name` is an optional line set when
the game is created, persisted in `game.name`, and returned on every state
answer. A game with no name is known by its id, which is what every game was
until now.

The name is public. It is on the game list, the game master page, the join
page and the seat waiting panel. It names a table, not a person, and nothing
binds it to a seat, so ADR-020's anonymity is untouched: no screen draws the name
beside a power. A game master who types a player's name into it has done
something social the app cannot prevent, and the same is true of the invite
link.

It is not a rule. Renaming does not bump the settings version and no seat sees
"the rules changed" over it, unlike every other setting under ADR-022. It is
still an enumerated, logged act (ADR-007). The server folds whitespace, drops
control characters and cuts the name to 60 runes, because it is drawn as one
line in a list beside other names.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r45, 2026-08-30** — ADR-042: a game may be named.
- **r45, 2026-08-30** — The New game screen puts the name, the rules and the create button above the map gallery, which was a screenful of scrolling between the choice and the act.

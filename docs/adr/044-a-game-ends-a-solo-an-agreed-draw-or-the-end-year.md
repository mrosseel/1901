---
status: accepted
---

# ADR-044 — A game ends: a solo, an agreed draw, or the end year

**Status:** accepted, r47 (research/platforms.md §1.3, §3.6). Not built.
Extends ADR-007, ADR-022, ADR-028.

Today the flow never asks who won. It adjudicates, starts the next phase, and
does that forever. A tournament board plays to a result, and the result is the
thing the room came for, so this is the largest hole left in the flow. It goes
before M3.

**A solo comes from godip.** Each variant carries `SoloWinner(*state.State)`.
The classical one is `SCCountWinner(18)`: it reads supply-centre ownership,
finds the clear leader, and returns that power when the leader holds the
variant's number and nobody ties them. Otherwise it returns the empty nation.
So the check is one call after every adjudication, and the number it uses is
already on the variant card as `soloSCCount`.

**A draw is an act, not a computation.** The table agrees out loud, and the
game master records what was agreed by naming the surviving powers. It is an
enumerated, logged game master power (ADR-007), like forcing adjudication and
for the same reason: nothing prevents a game master ending a game early, and
the log is what makes it visible.

Backstabbr's design is better and we cannot have it yet. There, every player
sets a victory condition of their own and may lie about it, so a draw is
negotiated inside the game rather than announced above it. That needs press
(ADR-023 `fullpress`), which does not exist.

**`settings.endYear`** (default 0, meaning none) ends the game after the last
phase of that year. Backstabbr has it, and a tournament round with a hard stop
at 17:00 needs it.

**What ending does.** The game freezes. No phase follows, no seat may order, no
deadline arms, and `canForce` is false forever. Seat, game master, public and
watch state gain

    result: {kind: "solo" | "draw" | "endYear", powers: [...],
             centres: {power: count}, year: 1908}

with `result` null while the game runs. The last phase keeps an ordinary watch
index, so a finished game is shareable at the same address as every other
phase (ADR-028), which is the whole point of having those addresses.

The result is public, because it is what the spectator screen shows and what
the tournament pipeline reads (ADR-046). We publish centre counts and declare
nothing else. Scoring stays a non-goal (§1); dipvis owns that job.

**Not decided here:** what happens to a game after it ends. A frozen game
sitting in the list is enough for a first tournament. Rematch, archive and
delete can wait for somebody to want them.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r47, 2026-08-30** — ADR-044: a game ends, by a solo read from godip's `SoloWinner`, by a draw the game master records, or at an end year, and an ended game freezes and publishes a result; the flow never asked who won.
- **r47, 2026-08-30** — Build order in §7 restated: ADR-044 before M3, then ADR-004 and ADR-041.

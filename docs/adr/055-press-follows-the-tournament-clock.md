---
status: accepted
---

# ADR-055 — Press follows the tournament clock

**Status:** accepted, r56. Implements the behaviour ADR-023 declared as data.
Extends ADR-027. Depends on ADR-053.

ADR-023 named `rulebook` after webDiplomacy's fourth press mode and recorded
that its own FAQ says "Face-to-face Diplomacy is generally played this way".
Now that the app carries messages, the mode has to do something. The rules it
has to keep are not ours; they are the ones a championship board runs on.

## The rules being kept

From the WDC 2019 official rules
(<http://diplomed.free.fr/eng/rules.htm>), the house rules of the World
Diplomacy Championship:

| Rule | What it says | What the server does |
| --- | --- | --- |
| 3b | "According to the rules, it is forbidden to negotiate during the retreats and adjustments." | `rulebook` refuses a message in any phase that is not a movement phase. |
| 3c | An eliminated player "is not allowed to negotiate with the other players of the board." | A power on zero centres can neither send nor be sent to. |
| 4b2, 4b4 | The writing phase lasts one minute and "the negotiation are not allowed". | Press closes `pressSilenceSeconds` before the deadline. Default 60. |
| 4d | "Failure to observe silence during the writing phase may be an immediate sanction." | Which is why the app closes it rather than printing a reminder. |

**Every one of these is enforced on the server.** A rule the panel merely hides
a button for is a rule that a second tab does not have.

## The two settings

- **`pressSilenceSeconds`**, default 60, capped at an hour. Zero means the app
  never closes press early, which is the right answer for a game with no
  deadline and for a table that would rather run its own silence. It is a clock
  setting, so like `deadlineMinutes` it may be changed after the start; the
  press mode may not.
- **`gmReadsPress`** belongs to ADR-054 and is fixed at start.

The silence is measured from the deadline, so a phase in its grace period is
silent too: the grace of ADR-027 is time to finish writing, and it was never
time to keep negotiating.

## The one exception, and why

A room with one member is that power's own notepad (ADR-053). Notes are not
negotiation. Nobody is being talked to, so 3b, 3c and the writing minute all
leave them alone — and writing your plan down is exactly what the writing
minute is for. Only the game ending closes the notepad.

## What the player is told

A refusal is never an error code on a screen. It is a sentence in the words of
the thing happening at the table. The two that hold for the whole phase, the
rulebook gate and the writing minute, replace the message box, because there is
nothing to type into. The two that depend on who is in the room appear when the
message is sent, because the panel does not know which room is being written in
until it is:

    no negotiation during retreats and builds
    writing time, no negotiation
    you are eliminated and may not negotiate
    Austria is eliminated and may not negotiate

And the panel counts down to the writing time rather than only refusing
afterwards. A player told about the silence one second before it lands has been
ambushed by their own app.

## What is rejected

- **Closing press when a seat locks in.** Locking is replaceable until the
  reveal (ADR-011), so a player who locked early and then talked their way into
  a better plan may still change it. The clock closes press, not readiness.
- **A per-phase press setting.** Two modes and one number cover every board
  anybody described. A third dial would be a rule nobody has asked for.

## Revisions

- **r56, 2026-09-02** — ADR-055 accepted and built.

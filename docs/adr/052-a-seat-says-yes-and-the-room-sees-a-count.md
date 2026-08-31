---
status: proposed
---

# ADR-052 — A seat says yes, and the room sees a count

**Status:** proposed. Extends ADR-044, ADR-007, ADR-013.

Today only the game master can end a game in a draw. The table agrees out loud.
The game master types the powers. The game ends (ADR-044).

A player who accepts a draw has one method. The player must speak first, in the
room. This costs the player. The other players learn that this player cannot
win. The two players who can attack this player learn it at the same time.

Every other Diplomacy site gives the player a button. This decision selects the
button. It also answers the larger question. How does a player tell the table
something without speech? How does the game master ask the table something
without a show of hands?

## Words used here

- **Survivor** — a power that holds one or more supply centres.
- **Draw** — the game ends with no winner. The survivors share the result.
- **DIAS** — draw includes all survivors. No survivor can be left out.
- **Concession** — one player gives the game to one other player. It is a draw
  with one name in it.

## What the other sites do

**Backstabbr.** Each player selects a private victory condition from a list.
The player selects the draw that the player accepts. No other player sees the
selection. The game ends when the board satisfies every selection. No player
speaks first. No player learns who moved first. The competitive scene uses this
site, and this design is the quietest of the four.

**webDiplomacy.** The site gives three buttons: draw, pause and cancel. A vote
needs all survivors. The site added a fourth button, *vote cancel*. A draw vote
costs the player information, and the players wanted a cheaper signal. The
pause button needed a written rule: "The Pause/Unpause feature is not a
diplomatic tool." Players used the pause to stop games. This is the argument
against unanimity.

**vDiplomacy.** A concede vote needs all players except one. An extend vote
needs two thirds of the active players, and adds four days to the clock. The
extend vote repeats and needs no moderator. A sitter system lends a seat to a
substitute player.

**PlayDiplomacy and the tournament scene.** DIAS is the usual rule. Most
tournament scoring systems divide the points between the survivors. A draw that
excludes a survivor needs an agreement that the room can hear.

## The difference at a table

The four sites solve a communication problem. Their players are in different
countries and different time zones. A button is the only channel.

Our players are in one room. They can speak. Thus we do not solve
communication. We solve two other problems:

1. **The cost of the first move.** Speech gives information to the other
   players. A private button gives no information.
2. **The count without the names.** The game master screen is often on a
   beamer. ADR-013 permits no secrets on it. A count that names the powers is
   read by all the players.

## The decision

**A seat holds standing answers.** Each answer is private. Each answer is one
field. The player can change an answer at any time from the player's own phone.
Version one has two answers:

    acceptsDraw   this seat accepts a draw of the survivors
    wantsTime     this seat asks for more time in this phase

**An acceptance names the board that it was given for.** A seat accepts a draw
of *this* set of survivors. The set changes when a power is eliminated. Each
acceptance for the old set then stops counting. This is Backstabbr's rule, and
it is correct. A player who accepts a four-way draw does not accept a
three-way draw.

**The game ends when all survivors accept.** The game master does not act. No
player speaks last. The game ends as a draw of all survivors, which is DIAS.
It ends through the `endGame` function of ADR-044, with the kind `draw`.

**Show counts. Do not show names.** Each seat and the game master read the same
line:

    4 of 6 seats accept a draw

No screen shows which four seats. The game master screen does not show it. The
public watch feed does not show the count while the game runs. A spectator
screen that shows "5 of 6" tells the room what the room must not know. The
result becomes public when the game ends, as ADR-044 specifies.

**More time needs a threshold, not unanimity.** The deadline extends when two
thirds of the seats that have not finalized ask for time. It extends one time
in each phase, by the grace period. The server logs the extension, as it logs
each game master act. Two thirds is vDiplomacy's number. We reject unanimity,
because webDiplomacy had to write a rule against it.

**The game master keeps the recorded draw.** The route of ADR-044 does not
change. It stays the only method to end a game with a draw that is not DIAS.
Two examples: a concession, and a three-way draw in a room where the fourth
player agreed out loud and then left. The button serves the quiet path. The
game master serves the room.

**A person calls a pause.** A player who wants a break stands up and asks. The
server needs no vote for this.

## What is rejected

- **A private victory number for each player**, which is Backstabbr's full
  design. It is built for players who cannot speak to each other. It needs
  press to be interesting (ADR-023). At a table it is slower than one sentence.
- **Unanimity for more time.** See webDiplomacy's written rule.
- **Names on any screen.** ADR-013 decides this.
- **A free-text question from the game master.** It sounds general. It is a
  chat feature with another name. The two answers above are what a table asks.
  Add a third answer when a player asks for it.

## Consequences

- The seat row gets two boolean fields, and the survivor set of an acceptance.
  The server writes them through to the database with each other seat fact, so
  a restart keeps them.
- The seat state and the game master state get the counts. The public watch
  JSON does not get them.
- The server logs a draw that ends by count as such. The audit feed (ADR-007)
  then shows whether the game master or the table ended the game.
- The check runs where `checkEnd` runs, after an adjudication. It also runs when
  a seat posts an acceptance. A game that becomes drawable between two phases
  must not wait for the next phase.
- The elimination of a power cancels the acceptances. The count on each screen
  falls. This is correct behaviour, and each screen must show it.

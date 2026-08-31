---
status: proposed
---

# ADR-052 — A seat says yes, and nobody is told

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

**BOUNCED, at dipbounced.com.** Built in 1999 for play over the web. The site
is now dead, so I read its help pages through a search engine and not from the
server. Its rule: "At any time players can agree upon the end of the game, and
if they do they share the points equally between survivors." DIAS is the
default. A draw that leaves a survivor out is a *conceded draw*, and it needs
the agreement of every surviving player.

**The judges, which came before all of these.** The email judges have run draw
votes since the 1990s, and the two of them disagree about one thing.

- The DPjudge keeps a vote standing. Each vote is private, the judge never
  tells the other players, and a player can change the vote at any time.
- The njudge clears every vote at the end of each phase. "All draw votes are
  cleared at the end of a phase, so you need to cast your vote again every
  phase."
- Both end the game at once when all survivors agree. Neither waits for the
  deadline.
- The njudge also solves the draw that is not DIAS. A player approves a list of
  powers. That approval also approves each smaller list that holds the player's
  own power. The largest approved draw wins.

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
2. **The players watch each other.** Online, a count of the votes tells a
   player little. In one room, the players see who looks at a phone, and who
   looks satisfied. A count starts a search for the players who did not accept.
   The game master screen is often on a beamer, and ADR-013 permits no secrets
   on it.

## The decision

**A seat holds standing answers.** Each answer is private. Each answer is one
field. The player can change an answer at any time from the player's own phone.
Version one has two answers:

    acceptsDraw   this seat accepts a draw of the survivors
    wantsTime     this seat asks for more time in this phase

**An acceptance stands until the board changes.** The DPjudge keeps a vote
standing. The njudge clears each vote at the end of each phase. We keep it
standing, because a table plays five to ten phases in one evening, and a player
who must vote again in each phase will stop voting. The event that changes the
deal is not the phase. It is the loss of a power.

**An acceptance names the board that it was given for.** A seat accepts a draw
of *this* set of survivors. The set changes when a power is eliminated. Each
acceptance for the old set then stops counting. This is Backstabbr's rule, and
it is correct. A player who accepts a four-way draw does not accept a
three-way draw.

**The game ends when all survivors accept.** The game master does not act. No
player speaks last. The game ends as a draw of all survivors, which is DIAS.
It ends through the `endGame` function of ADR-044, with the kind `draw`.

**No screen shows a draw count.** A seat sees its own answer. It sees no other
answer, and it sees no total. The game master screen shows no total. The public
watch feed shows no total. The result becomes public when the game ends, as
ADR-044 specifies.

This is the part of Backstabbr's design that makes the button work, and the
judges have done the same for 25 years. A total is webDiplomacy's design, and
webDiplomacy plays in a different place. Their
players are alone at a screen, so a total tells them little. Our players sit at
one table. A line that reads "4 of 6 accept a draw" starts a search for the
other two. The players then read faces, and the private button has given away
what the player did not say. A player who wants the room to know can speak, and
that stays the fastest method in a room.

The cost of no total is small. A player cannot see the game approach a draw.
The game simply ends. The audit feed (ADR-007) reports the ending after it
happens, which is where a game master looks anyway.

**A request for time is different, and it keeps a count.** A player can ask for
more time out loud at no cost, so a private answer protects nothing here. The
game master reads the number of requests, and never the names. The deadline
extends when two thirds of the seats that have not finalized ask for time. It extends one time
in each phase, by the grace period. The server logs the extension, as it logs
each game master act. Two thirds is vDiplomacy's number. We reject unanimity,
because webDiplomacy had to write a rule against it.

**The game master keeps the recorded draw, and it splits in two.** ADR-044 lets
the game master name any set of surviving powers and end the game. That is too
much, for one reason: the game master often plays a power. A game master who
plays can then end the game in a draw that holds their own power and drops a
rival. Backstabbr refuses this. A creator who takes a seat in a public game
keeps no game master power at all, because "the risk of abuse is too high".

So the route splits by who the draw leaves out.

- **A draw of all survivors: the game master acts alone.** This is DIAS. It
  leaves nobody out. It is the ending the room agrees to out loud, and it is
  ADR-044 as built.
- **A draw that excludes a survivor: each excluded seat must confirm.** The
  game master names the powers. Each excluded survivor gets one question on
  the phone. The game ends when the last one answers yes. A concession is the
  same rule: one power takes the game, and each other survivor confirms.
- **A seat that no device holds cannot block.** The game master may exclude a
  power that nobody claimed. The audit records that they did it.
- **The audit names the game master's power.** A game master who plays is
  recorded as a player in the entry that ends the game.

The judges and BOUNCED ask for the same agreement. A draw that is not DIAS
needs every surviving player. They collect it by email in days. We collect it
in the room in seconds.

**A person calls a pause.** A player who wants a break stands up and asks. The
server needs no vote for this.

## What is rejected

- **A private victory number for each player**, which is Backstabbr's full
  design. It is built for players who cannot speak to each other. It needs
  press to be interesting (ADR-023). At a table it is slower than one sentence.
- **Unanimity for more time.** See webDiplomacy's written rule.
- **A count of the draw acceptances**, on any screen, for any reader. See
  above. webDiplomacy shows one, and can hide it per game. We hide it always.
- **Names on any screen.** ADR-013 decides this.
- **A vote that clears at the end of each phase**, which is the njudge rule.
  It asks for the same answer again five times in one evening.
- **A vote for a draw that is not DIAS**, which is the njudge power list. It is
  a good design for players who cannot speak to each other. In a room, the
  game master records what the room agreed, and that is ADR-044.
- **A free-text question from the game master.** It sounds general. It is a
  chat feature with another name. The two answers above are what a table asks.
  Add a third answer when a player asks for it.

## Consequences

- The seat row gets two boolean fields, and the survivor set of an acceptance.
  The server writes them through to the database with each other seat fact, so
  a restart keeps them.
- The seat state gets one boolean: this seat accepts a draw. The game master
  state gets the count of the requests for time, and no draw count. The public
  watch JSON gets neither.
- The server logs a draw that ends by count as such. The audit feed (ADR-007)
  then shows whether the game master or the table ended the game.
- The check runs where `checkEnd` runs, after an adjudication. It also runs when
  a seat posts an acceptance. A game that becomes drawable between two phases
  must not wait for the next phase.
- The elimination of a power cancels the acceptances. The count on each screen
  falls. This is correct behaviour, and each screen must show it.

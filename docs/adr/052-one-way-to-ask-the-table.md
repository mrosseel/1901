---
status: proposed
---

# ADR-052 — One way to ask the table, and one way to tell it

**Status:** proposed. Extends ADR-044, ADR-007, ADR-013, ADR-022.

Three questions arrived together: how does the table agree a draw, how do the
players ask for more time, and how does the game master call a pause. Three
buttons would be three designs. This decision builds one mechanism and uses it
three times.

It also builds the smaller half. Sometimes the game master changes something
and needs no answer. The table must still be told.

## Words used here

- **Survivor** — a power that holds one or more supply centres.
- **Draw** — the game ends with no winner. The survivors share the result.
- **DIAS** — draw includes all survivors. No survivor can be left out.
- **Concession** — one player gives the game to one other player.
- **Prompt** — one thing the server puts on the phones. It is a question or a
  notice.

## What the other sites do

**Backstabbr.** Each player selects a private victory condition from a list.
No other player sees the selection. The game ends when the board satisfies
every selection. No player speaks first, and no player learns who moved first.
The competitive scene uses this site.

**webDiplomacy.** Buttons for draw, pause and cancel, and a vote needs all
survivors. The site added a cheaper button, *vote cancel*, because a draw vote
costs the player information. Its pause needed a written rule: "The
Pause/Unpause feature is not a diplomatic tool." Players used the pause to stop
games. Draw votes can be public or hidden, per game.

**vDiplomacy.** A concede vote needs all players except one. An extend vote
needs two thirds of the active players and adds four days. It repeats, and it
needs no moderator.

**BOUNCED, at dipbounced.com.** Built in 1999. The site is dead, so I read its
help pages through a search engine. DIAS is the default. "At any time players
can agree upon the end of the game, and if they do they share the points
equally between survivors." A draw that leaves a survivor out is a *conceded
draw*, and it needs every surviving player.

**The email judges, which came first.** They have run draw votes since the
1990s, and they disagree about one thing.

- The DPjudge keeps each vote standing. The vote is private, the judge never
  tells the other players, and the player can change it at any time.
- The njudge clears every vote at the end of each phase.
- Both end the game at once when all survivors agree.
- The njudge also solves the draw that is not DIAS. A player approves a list of
  powers, and that also approves each smaller list that holds the player's own
  power. The largest approved draw wins.

**PlayDiplomacy and the tournament scene.** DIAS is the usual rule. Tournament
scoring divides the points between the survivors.

## The difference at a table

The other sites solve a communication problem. Their players are in different
countries. A button is the only channel.

Our players sit in one room and can speak. We solve two other problems.

1. **The cost of the first move.** Speech gives information to the other
   players. A private button gives none.
2. **The players watch each other.** In one room, a total on a screen starts a
   search for the players who did not answer. The game master screen is often
   on a beamer, and ADR-013 permits no secrets on it.

## The mechanism

**A prompt is one thing on the phones.** It has two kinds.

    question   the seat answers it
    notice     the seat reads it

**A question carries six fields, and nothing else.**

    kind        which question this is, from a fixed list
    choices     the answers a seat may give. Yes and no, or a short list. A
                choice may carry a number, from a fixed list of steps
    audience    which seats may answer: all seats, or the survivors
    privacy     silent, count, or open
    threshold   all, two thirds, or none
    effect      what the server does when the threshold is met

**Privacy has three values, and each question gets one.**

    silent   no reader sees any answer or any total, ever
    count    the game master reads a total. No screen shows a name
    open     every seat reads the totals

**The effect is from a fixed list.** The server does the work, not the game
master, and it writes the act to the audit feed (ADR-007).

    endDraw    end the game as a draw of the survivors (ADR-044)
    extend     add the grace period to the deadline, one time in each phase
    hold       stop the deadline until a stated time
    none       tell the game master the total, and do nothing else

**A notice has a text and a life.** The server shows it on each seat until the
player dismisses it, or until the phase ends. A notice needs no answer and has
no effect. A notice may carry a time, which the seat page shows as a clock: the
game master writes "back at" and the table reads it.

**Answers stand until the board changes.** The DPjudge keeps a vote standing;
the njudge clears it each phase. We keep it standing. A table plays five to ten
phases in one evening, and a player who must answer again in each phase stops
answering. The event that changes the deal is not the phase. It is the loss of
a power.

## The first three questions

**The draw.** The server opens this question at the start of the game and never
closes it. The game master does not send it.

    kind=draw  audience=survivors  privacy=silent  threshold=all  effect=endDraw

An acceptance names the survivor set it was given for. The set changes when a
power is eliminated, and each acceptance for the old set stops counting. A
player who accepts a four-way draw has not accepted a three-way draw.

The privacy is `silent`, and this is the most important field in this document.
It is Backstabbr's design and the judges' design. It is not webDiplomacy's,
because their players sit alone at a screen where a total tells them little.
Ours sit at one table. A line that reads "4 of 6 accept a draw" starts a search
for the other two, and the players then read faces. The private button has then
given away what the player did not say.

The cost is small. A player cannot watch the game come near a draw. The game
ends, and the audit feed reports it after the fact.

**More time.**

    kind=time  audience=all  privacy=count  threshold=twoThirds  effect=extend

A player can ask for more time out loud at no cost, so privacy protects nothing
here. Two thirds is vDiplomacy's number. We reject unanimity, because
webDiplomacy had to write a rule against the hostage it invites.

**A pause.**

    kind=pause  audience=all  privacy=count  threshold=none  effect=none

The game master reads the total and calls the break. A break is a decision
about a room, and a server cannot see the room.

A pause answer has two parts, and both come from a list:

    reason    break | food | away | rules | other
    duration  5, 10, 15 or 30 minutes at a table. 1, 2, 3, 7 or 14 days in a
              slow game, where the server picks the list from the deadline

The lists exist because a free text from a seat is press, and a gunboat game
forbids press (ADR-023). A number is not press. It carries no message and it
tells the game master the one thing that decides the break: how long.

The game master reads one total for each reason, and the longest time asked.
"Three seats want food, the longest ask is 15 minutes." No screen shows a name.
"Four seats want food" is a different decision from "one seat is away", and the
game master must be able to tell them apart. `break` is the plain one: a rest,
with no reason given.

So a choice may carry a number, from a fixed list of steps. This is the one
place a seat sends more than a choice, and it stays a number. Free text from a
seat is press in every game, and this decision does not open that door.

The game master answers with a notice, and that text is free, because the game
master already speaks to the room. The notice carries a return time, and the
seat page shows both.

At a table the clock is not touched. The game master extends the deadline in
the usual way. A slow game is different, and the next section says how.

## The same mechanism online

ADR-018 keeps one binary and two modes. The hosted mode plays the same game in
different conditions: the players are apart, the deadline is in days, and press
may be on (ADR-023). Three things then change, and none of them changes the
shape of a question.

**The times come from the game's own clock.** A live table answers in minutes,
from 5, 10, 15 and 30. A game with a deadline in days answers in days, from 1,
2, 3, 7 and 14. The server picks the list from the deadline setting.
webDiplomacy draws the same line and calls anything at 10 minutes or under a
live game.

**A pause states when it ends, and it ends by itself.** Nobody votes to
unpause. This is the answer to the rule webDiplomacy had to write, "The
Pause/Unpause feature is not a diplomatic tool". An unpause that needs every
player is a hostage. A pause with an end time cannot be held by anybody.

**A slow game gives the pause a real effect.**

    kind=pause  audience=all  privacy=count  threshold=twoThirds  effect=hold

`hold` stops the deadline until the stated end. In a room the effect stays
`none`, because a person calls the break and the server cannot see the room.
Two thirds, not all, for the reason above.

**The game master goes away.** A game master who leaves for two weeks writes a
notice with the return date, and hands the role to somebody who stays (ADR-041).
Nothing in this decision needs the game master to be present: each threshold is
counted by the server, and each effect is done by the server.

**Press changes what a seat may write.** The fixed lists exist because free text
from a seat is press, and a gunboat game forbids it. A full-press game already
allows press, so a pause answer may carry a line of text there. The server acts
on the choice. It never acts on the text.

**One question this opens, for ADR-010.** A deadline arms the game master and
never fires by itself. In a room that is correct, because the game master is in
the room. In a slow game with the game master away for two weeks, the game
stops at the first missing order. ADR-008 already advances the turn
automatically. ADR-010 must say what a deadline does when nobody is there to
answer it. This decision does not answer it.

## The game master's own draw

ADR-044 lets the game master name any set of surviving powers and end the game.
That is too much, for one reason. The game master often plays a power. A game
master who plays can end the game in a draw that holds their own power and
drops a rival. Backstabbr refuses this: a creator who takes a seat in a public
game keeps no game master power, because "the risk of abuse is too high".

So the route splits by who the draw leaves out.

- **A draw of all survivors: the game master acts alone.** It leaves nobody
  out. It is ADR-044 as built.
- **A draw that excludes a survivor: each excluded seat confirms.** The game
  master names the powers, and the server asks each excluded survivor. The game
  ends when the last one answers yes. A concession is the same rule.
- **A seat that no device holds cannot block.** The game master may exclude an
  unclaimed power, and the audit records it.
- **The audit names the game master's power** when the game master plays.

The judges and BOUNCED ask for the same agreement, and collect it by email in
days. We collect it in the room in seconds.

## Telling the table without asking it

The game master changes a setting and needs no vote. ADR-022 already sends the
new settings to every seat, but a settings field is not a sentence, and a phone
in a pocket shows nothing.

The server writes a notice for each change the players must see: the deadline
minutes, the grace period, the end year, the press mode, illegal orders, and a
forced adjudication. The notice says what changed and who changed it. It is the
same prompt list the questions ride on, so a seat page reads one field.

The game master may also write a free notice, of one line. This is not press
(ADR-023). It goes one way, it goes to every seat, and it is in the audit feed.

## What is rejected

- **A count on the draw question.** webDiplomacy shows one, and can hide it per
  game. We hide it always. See above.
- **A free-text question.** A question with a free text has no threshold and no
  effect, so the server cannot act on it, and the game master must read the
  room anyway. The fixed list stays short and grows when somebody asks.
- **A vote that clears at the end of each phase**, which is the njudge rule. It
  asks for the same answer five times in one evening.
- **A vote for a draw that is not DIAS**, which is the njudge power list. It is
  built for players who cannot speak to each other. In a room the game master
  names it, and the excluded players confirm.
- **Unanimity for more time.** See webDiplomacy's written rule.
- **Names of the answerers, on any screen.** ADR-013 decides this.

## Consequences

- Two tables: one prompt row per question or notice, and one answer row per
  seat and question. The server writes them through like every other fact, so a
  restart keeps them.
- The seat state gets the open prompts and this seat's own answers. The game
  master state gets the totals, and never the names, and never the draw total.
  The public watch JSON gets none of it.
- One seat route accepts an answer. One game master route opens a question or
  writes a notice. The kinds are a fixed list, which is what ADR-007 asks of
  every game master power.
- The server tests each threshold when an answer arrives and after each
  adjudication. A game that becomes drawable between two phases must not wait
  for the next phase.
- The elimination of a power cancels the acceptances for the old survivor set.
- SSE already pushes the seat state, so a new prompt reaches a phone with no
  new transport (ADR-006).

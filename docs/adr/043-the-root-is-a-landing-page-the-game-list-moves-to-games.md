---
status: accepted
---

# ADR-043 — The root is a landing page; the game list moves to /games

**Status:** accepted, r46 (owner request).
The root address held the list of games this server happens to hold. That is
the right screen for the game master who just created one and the wrong screen
for everybody else: it opens on somebody else's Thursday table, or on nothing
at all, and it never says what this is.

So `/` is a landing page and `/games` is the list. The landing page states what
the app does in one sentence, shows the seat screen on the phone it is played
on, and carries one action, "Create a game", three times down the page. It is
the only screen written for a reader who has never seen a board.

It draws the app's own parts rather than lookalikes: the power card, the phase
words, the tick dots, the badge and the lock button are the rules the seat page
and the review already use, and the art is the Classical map served from the
address every other screen asks for. What a visitor sees here is what they get
when they press the button. The one thing that is not the app's is a serif for
the headings, because a page that has to say what this is gets a voice; Georgia
is on every machine and the app must run with no internet at all, which is why
there is no webfont.

**The list keeps the collection's address for a create.** `GET /games` is the
page, `POST /games` still creates a game, and only the JSON list moved, to
`/games/list`. A page and its data cannot share one address and answer the same
method, and a create was always a post to the collection.

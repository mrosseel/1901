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

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r46, 2026-08-30** — ADR-043: the root is a landing page and the game list moves to /games.
- **r46, 2026-08-30** — The list was the right screen for the game master who had just created a game and the wrong one for a stranger, who met somebody else's table or an empty page and was never told what this is.
- **r46, 2026-08-30** — The page borrows the app's own power card, phase words and lock button, and washes the Classical map behind the words, so nothing on it is a drawing of the product.
- **r46, 2026-08-30** — GET /games is the page, POST /games still creates, and the JSON list moved to /games/list.

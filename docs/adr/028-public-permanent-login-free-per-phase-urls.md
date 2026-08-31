---
status: accepted
---

# ADR-028 — Public, permanent, login-free per-phase URLs

**Status:** accepted, r18 (research/platforms.md, steal 1). Extends ADR-013.
Backstabbr's most valuable property is not a feature. It is that
`/game/<id>/<year>/<season>` renders the board, the orders and the results to
a signed-out visitor, forever. That is why it owns post-game analysis, why its
links are the community's citation format, and why the tournament pipeline
scrapes it rather than asking for an API.

Our spectator view was already secret-free by ADR-013, so the data model was
done. What was missing was the URL:

    /watch/{gameId}/                 the page, at the phase being played
    /watch/{gameId}/{phaseIndex}     the page, at one phase of the past
    /game/{id}/watch                 the JSON behind the first
    /game/{id}/watch/{phaseIndex}    the JSON behind the second

A resolved phase shows everything: the position it was played from, every
applied order with the power that gave it, every resolution, what was
dislodged, and the NMR list. All of that is public the moment the phase
resolves, since it is what the players see in their own review. There is
nothing there to leak.

The current phase shows the board, the phase, the deadline, the grace and who
has finalized. It shows no order of any kind. This endpoint carries no token
and cannot know who is asking, so it may never carry a draft.

**Where the history comes from.** Not a table of its own. The snapshots are
built by the same replay that rebuilds a game from its order rows after a
restart (ADR-011's write-through store). Each phase records what it saw on the
way past, on the live path and on the restore path alike. A historical URL is
therefore a function of the stored orders, which is why it is stable forever
and survives a `kill -9`. That was verified by killing the server and diffing
the JSON before and after. Only the `now` field differed.

Still open, and cheap once wanted: the layout variants ADR-013 asked for (board
only, board plus move list), and the referee guide of steal 2.

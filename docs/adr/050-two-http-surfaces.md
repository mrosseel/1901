---
status: accepted
---

# ADR-050 — The app's transport and the published data are two surfaces

Everything this server answers is JSON over HTTP, so "the API" has meant two
unrelated things: the app talking to itself, and data we publish to people who
are not in the room. They need opposite promises, so they get different
addresses. The app's transport moves under `/api/`, where nothing is promised
and the shape may change in any commit — its only caller is the JavaScript the
same build shipped. The published reads keep bare, citable addresses, and every
one of them is a promise to keep working.

## What goes where

**`/api/…` — the app's transport.** Seat state, options, orders, lock, the
seat session, the game master's state, settings, start, adjudicate, extend,
handover minting and claiming, the recovery challenge, the game list behind
the games page. Token in the address where there is one. No promises: a future
commit may rename any of it, because the client that reads it ships alongside.

**Bare addresses — published data.** `/game/{id}/public`, `/game/{id}/watch`
and `/game/{id}/watch/{n}` (D-013, D-028), and D-046's `results.json` and
`results.csv` when they exist. These are what a spectator screen shows, what a
tournament director's pipeline reads instead of scraping Backstabbr's HTML, and
what somebody pastes into a browser to cite a board. The list is short on
purpose: every address on it is a commitment.

The page addresses themselves are neither. `/`, `/games`, `/new`, `/faq`,
`/recover`, `/join/…`, `/watch/…`, `/handover/…`, `/game/{id}/seat/{tok}/` and
`/game/{id}/gm/{tok}/` serve the app shell, and `parseRoute()` in `web/src/api.ts`
is their definition.

## Why now, and why not a prefix from the start

The addresses interleave: `/game/{id}/seat/{tok}/` is a page and
`/game/{id}/seat/{tok}/state` is an endpoint inside it. That falls out of D-012
— the address is the seat — and it is what lets a QR code hand somebody a
working board with no account. It also means the usual `/api/` split was never
free, and the development proxy in `web/vite.config.ts` became a hand-written
third copy of "which addresses are pages", which drifted four features behind
and failed by answering JSON requests with the app's HTML.

Nothing is live yet: five test games on one personal server, no printed codes
in anyone's pocket, no pipeline reading anything. The cost of this move only
rises from here, and after a playtest it becomes a migration.

D-012 is untouched. The token stays in both halves of the address; the data
half gains four characters.

## Consequences

- `web/vite.config.ts` proxies `/api` and the short published list, and stops
  enumerating endpoints. A new endpoint needs no proxy change.
- A JSON request answered with HTML is reported as "the wrong server answered
  this", not as a parse error in an unrelated file. That failure mode cost real
  time and must never present as a mystery again.
- Rejected: no exceptions, everything under `/api`. Cleaner rule, but `/api/`
  in a link handed to a spectator or a tournament director reads as "not for
  you", and those links are exactly the ones we want people to use.
- Not enforcement. `curl` reaches anything either way. Tokens and seat keys
  (D-048, D-049) are what keep a seat private; this split is about what we
  promise to keep working.

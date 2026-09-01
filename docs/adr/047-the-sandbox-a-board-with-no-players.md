---
status: accepted
---

# ADR-047 — The sandbox: a board with no players

A sandbox is a Diplomacy board you play alone, with no other players, so
you can set up any position and try things out.

**Status:** accepted, r48 (owner decision, closes Q-008). Extends ADR-028.
Not built.

A sandbox is a game with no seats. Nobody joins it, no deadline runs, and one
person drives every power and presses adjudicate. It is Backstabbr's most
copied object and the reason its links are the community's citation format: a
tournament publishes one sandbox per board, dipvis scrapes those URLs, and an
analysis post cites one. We are building the addresses anyway (ADR-028), so the
missing half is a board somebody may drive.

This is not a revival of the M0 spike that r13 deleted. That was the whole app
in one screen. This is the ordinary game with the seat layer taken off.

**It is a flag on a game, not a second kind of object.** `settings.sandbox`,
set at creation and immutable after it. Zero seats, no invite, no lock, no
deadline, no press. Everything else stays: the same variants, the same map and
styles, the same adjudication, the same review, and the same watch addresses
under ADR-028. Reusing the game is the point; a parallel object would give us a
second adjudication path to keep correct.

**Who may drive it.** One `sandboxToken` in the URL, minted at creation. The
holder of the link may order any power, adjudicate, and edit. The bare game id
stays read-only for everybody, exactly as a real game's watch address is. A
link and not a cookie, because a tournament hands the laptop to the next
round's operator, and a director wants to give the job away without giving
away their browser.

**There are no secrets in a sandbox, and that is deliberate.** ADR-004's
commit-reveal and the no-leak discipline exist to stop one player reading
another's orders. A sandbox has one driver and no other player, so there is
nobody to hide from. Nothing here weakens a real game: sandbox routes reject a
game whose flag is off, and the seat routes reject a sandbox, so the two
authorization paths never meet. Write that as a test, not as a comment.

**Editing the position is the part that costs.** Backstabbr's editable
sandbox, Patreon-only since about 2023, places or removes units and reassigns
supply centres, then commits an arbitrary board. That is what makes it useful
for the case we care about, which is typing in a board that is already halfway
through a round.

It breaks replay. ADR-028's history is a function of the stored orders: a game
rebuilds by replaying them from the start, which is why a watch URL survives a
`kill -9`. An edit is not an order and cannot be replayed. So an edit writes a
**position checkpoint** and replay starts at the last one. The checkpoint is
the whole position, units, dislodged units and centre ownership, because a
partial one is a merge and a merge is a bug waiting for a variant with coasts.

An edited phase is marked as edited in the watch JSON and on the page. A board
somebody typed in is not a board that was played, and a reader citing the link
is entitled to know which one they are looking at.

**What still applies.** ADR-029, so an illegal order is stored and struck rather
than refused; the sandbox is where a player checks a move, and refusing to
draw the bad one defeats it. ADR-044, so a sandbox declares a solo like any
other board, which is what a director replaying a finished round wants to see.

**What does not.** ADR-023 press, ADR-027 deadlines, ADR-020 anonymity, ADR-041
handover. None of them has a second person to be about.

**Where it sits.** After ADR-044, because a board that cannot end is not worth
publishing. Independent of M3: with no secrets to keep, commit-reveal has
nothing to say here.
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r48, 2026-08-30** — Editing the position breaks ADR-028's replay-from-orders, so an edit writes a whole-position checkpoint and replay starts there, and an edited phase says so on the page.

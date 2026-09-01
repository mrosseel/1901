---
status: accepted
---

# ADR-041 — A power can be handed to another person, by link

**Status:** accepted, r42 (owner design). Built. Extends ADR-012 and ADR-020.
This entry said "not built" until r51, by which time it had been for a while:
handover.go, its tests, the seat menu and the handover page.

Every seat carries a player icon. Tapping it opens that seat's own menu, which
holds what the seat is and what can be done with it.

What it says: the power, how many turns have been played, how long the game
has run.

What it does: hand this power to somebody else. The menu shows a QR code and
the link behind it. The next person scans it or opens it and the power is
theirs.

**The link is signed, not stored.** The server holds one salt. A handover link
carries `HMAC(salt, power, game id, epoch)`. Nothing about a handover needs a
row in a table, and a link cannot be forged without the salt.

**A handover invalidates the seat it came from.** When the new person opens the
link, the server replaces the seat token or public key, drops every open
session and device claim for the power, and raises its epoch. The epoch kills
every link minted before the transfer; the replaced credential stops the old
phone signing back in. That is the point: a power belongs to one person at a
time, and the previous holder must not keep a live seat.

This is the mechanism ADR-012's hard claim was missing. A seat could be claimed
and never released, so a phone that died took a power with it.

**The game master has two entries, and they are different acts.**
1. Hand over the game master rights. The taker may be somebody new, or a
   person already holding a power. The rights travel; a power does not.
2. Hand over the power the game master plays, if they play one (ADR-021). That is
   an ordinary handover and behaves exactly like any other seat's.

Keeping them apart matters because they fail differently: a game master who
gives away their power still runs the game, and a game master who gives away
the rights and keeps their power becomes an ordinary player.

**The game master can mint a link for any power.** A phone that dies takes its
menu with it, so the holder cannot hand the seat over themselves. That is the
case this exists for, and it is the common one.

The link the game master mints is the same signed value and behaves the same
way: opening it raises the epoch, and the dead phone's token would stop working
if it ever came back.

This is a game master power and is enumerated and logged like the others
(ADR-007). It has to be, because it is the one that could be abused: a game
master who can mint a link for any power can take any seat, or give it to
anyone. Nothing prevents that and nothing should pretend to. What the log does
is make it visible afterwards, which is the same answer ADR-007 gives for forcing
adjudication. A game master is trusted with the game; the record is what keeps
the trust honest.

**What this does not do.** It does not name anybody. A handover moves a seat
between devices and the game stays anonymous (ADR-020). The menu shows the
holder nothing about who the other players are.

**Orders written before the handover stand.** In an old unsealed game they are
already server state. In a sealed game, a player-issued handover carries the
old seat seed in the URL fragment. The taking phone derives and retains only
the current phase's order key from it, then generates a fresh seed for seat
authentication. The former holder still knows the envelope key, but the
server no longer accepts their signatures, so they cannot reveal or change
anything after the transfer.

So the new holder inherits the seat exactly as it stands, orders included, and
may change them like any other holder while the phase is open (ADR-011). A
handover is usually a dead phone, and the person taking over wants the seat as
it was, not an empty one.

A handover minted by the game master for a dead phone cannot carry that seed,
because the server has never held it. The new holder gets the power but cannot
recover an envelope the dead device locked in; forcing the phase makes that
power an NMR. That is the unavoidable edge of keeping draft keys off the
server.

Player-facing wording calls the ordinary operation “move this seat to another
device”. A game-master-minted replacement is labelled for device recovery or
a substitution permitted by the table's tournament or house rules; the app
does not silently normalize player swaps where tournament policies differ.
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r43, 2026-08-30** — The signed value authenticates commands, so an order the server accepted was accepted under a valid epoch and is server state from that moment.
- **r43, 2026-08-30** — Raising the epoch stops the old holder sending anything further and reaches back into nothing.
- **r43, 2026-08-30** — The new holder inherits the seat as it stands, orders included.
- **r53, 2026-08-31** — A handover minted by the seat carries that seat's seed, appended by the phone in the fragment and never by the server, which has none (ADR-049). The taking phone retains only the current phase's derived order key, then makes a fresh signing seed. Reusing the carried seed for authentication let the former holder sign back in after the handover; separating the two jobs preserves the locked envelope while actually revoking the old seat.
- **r53, 2026-08-31** — A link the game master mints for a dead phone cannot carry a seed, because the server has never held one. That link returns the power and not the orders locked in under it. It is the one case commit-reveal cannot recover, and it follows from the server being unable to read anything.
- **r55, 2026-09-01** — Replacement wording distinguishes device recovery
  from a player substitution and defers the latter to the applicable rules.

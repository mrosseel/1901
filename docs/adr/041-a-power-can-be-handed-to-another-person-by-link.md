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

**A handover invalidates the seat it came from.** The epoch is a counter per
seat. When the new person opens the link the server raises it, and every link
and every token minted under the old epoch stops working, including the phone
that just gave the power away. That is the point: a power belongs to one person
at a time, and the previous holder must not keep a live seat.

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

**Orders written before the handover stand, and there is nothing to decide.**
The signed value is what authenticates a command to the server, so an order the
server accepted was accepted under an epoch that was valid at the time. It is
server state from that moment. Raising the epoch stops the old holder sending
anything further; it does not reach back into what the server already holds.

So the new holder inherits the seat exactly as it stands, orders included, and
may change them like any other holder while the phase is open (ADR-011). A
handover is usually a dead phone, and the person taking over wants the seat as
it was, not an empty one.

This is also why the epoch belongs on the command path rather than on the
orders. There is no draft living on a device to rescue or discard: a device
holds a token, and the orders are already here.
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r43, 2026-08-30** — The signed value authenticates commands, so an order the server accepted was accepted under a valid epoch and is server state from that moment.
- **r43, 2026-08-30** — Raising the epoch stops the old holder sending anything further and reaches back into nothing.
- **r43, 2026-08-30** — The new holder inherits the seat as it stands, orders included.
- **r53, 2026-08-31** — A handover minted by the seat carries that seat's seed, appended by the phone in the fragment and never by the server, which has none (ADR-049). Without it the taking phone made a fresh key and could not open orders the seat had already sealed under the old one (ADR-004), so handing a power over mid-phase turned it into an NMR — against the line above. The epoch still stops the old device ordering; what the seed changes is what the new one can read.
- **r53, 2026-08-31** — A link the game master mints for a dead phone cannot carry a seed, because the server has never held one. That link returns the power and not the orders locked in under it. It is the one case commit-reveal cannot recover, and it follows from the server being unable to read anything.

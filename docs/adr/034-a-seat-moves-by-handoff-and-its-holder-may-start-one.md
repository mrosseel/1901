---
status: accepted
---

# ADR-034 — A seat moves by handoff, and its holder may start one

**Status:** accepted, r27. Amends ADR-012. Built, as ADR-041's signed
handover link. This entry said "not implemented" until r51.
ADR-012 sends every device change through the GM. A table does not work that
way. A phone dies, a player leaves at midnight and hands their power to
somebody else, two people share one handset. The seat has to move without
the GM being the bottleneck.

**Who may start a handoff.** The seat's own holder, from the game view, and
the GM for any power. The player case is the common one and it costs the GM
nothing. The GM case is for a power that cannot act: the phone is off, the
player is gone, the seat was never claimed. That is ADR-007's player
replacement, kept and widened.

Giving a seat away is not a privilege the app can protect. Whoever holds the
phone can already play the power. The handoff only makes the transfer
survive the phone.

**Where it lives.** A person icon in the game view opens what the server
knows about this seat: the power name, the finalize state, the phase count.
It also holds "Show replacement URL", which draws a QR another phone scans.
The power name is the only identity shown, so ADR-020 is untouched. The server
still never learns who is who.

**One-shot.** Scanning the replacement URL clears the old device claim,
issues a new seat token, and binds the scanning device. The old phone is
logged out at that moment, and the old URL is dead. This is the point of the
mechanism: two devices holding one seat with divergent local state is what
commit-reveal cannot tolerate (ADR-012's rationale, unchanged). Showing the QR
does not yet move anything, so a GM who displays one and thinks better of it
can cancel.

**Tokens.** A seat token is `HMAC(serverSalt, gameID | power | role | epoch)`,
with `role` separating the seat from the GM rights and `epoch` a counter the
seat carries. Bump the epoch and every URL issued before it stops verifying,
which is what makes a handoff one-shot and a rotation cheap. The server
stores a small integer per seat rather than a list of live tokens.

Public and private keys were considered and rejected. The phone verifies
nothing; it presents a bearer string and the server checks it. That is ADR-005,
and HMAC is the whole of what it needs. A derivation without the epoch was
rejected for the same reason it looked attractive: it is deterministic, so
the same URL comes back forever and nothing can be revoked.

**The GM has two URLs.** The GM's power and the GM rights are separate
handoffs, because they are separate things to give away. The GM can hand the
referee role to somebody else and keep playing, hand the power away and keep
refereeing, or move either to a second device. This also answers the laptop
and phone case: the GM creates the game on a laptop and moves the power to a
phone, with the referee view left where it is.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r26, 2026-08-30** — ADR-034: a seat whose power has no legal order this phase is finalized by the server, in every phase type, so an empty retreat never reaches a screen.
- **r26, 2026-08-30** — Force adjudication counts only the seats a phase asked a player for; the seat screen says why it is locked; an auto-locked seat cannot be unlocked.
- **r26, 2026-08-30** — Move the pieces became a checklist.

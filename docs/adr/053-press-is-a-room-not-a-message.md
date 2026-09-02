---
status: accepted
---

# ADR-053 — Press is a room, not a message

**Status:** accepted, r56. Implements the `fullpress` half of ADR-023.
Extends ADR-022. Depends on ADR-054 for what the server may read.

ADR-023 declared four press modes and built none of them. Two of them,
`fullpress` and `rulebook`, mean the app carries messages between powers, and
until now it carried none in any mode. This decides what a message is.

## The question that had to be answered first

Can a power write to more than one power at once, and if so, what is that?

The rulebook is clear that the negotiation itself is open: "Negotiations
during Diplomacy are open-ended and without restriction. Players may elect to
discuss their plans in groups of two, three, four, or even all seven players.
They may negotiate in secret or in public." There is no rule that a
conversation has two people in it.

So it is legal. The question is what shape to give it, and there are two:

- **A CC.** A message names its recipients. The next message names its own.
  This is the postal metaphor, and it brings a BCC with it.
- **A room.** A conversation has a member list. Everything said in it is said
  to everybody in it, including every reply.

At a table three players walk into a corridor, and all three hear all three.
The corridor has no BCC. It has no way for one of the three to answer only one
of the others without the third seeing them leave. So:

> **A press thread is a room. Its member list is fixed when it opens, and
> every message in it goes to every member.**

Wanting to say something different to France alone is not a missing feature.
It is a second room with France in it, which is exactly what a player at a
table does by walking away from the other two.

**Two rooms with the same members are the same room.** A player who picks the
same three powers again gets the conversation that is already running. Without
this rule a seven-power game ends with forty threads that are all the same
people, and a player looking for what Italy promised has to search. A room the
game master opened is outside that rule and is its own room (ADR-054): it is a
ruling addressed to those powers, not a conversation between them.

Two exceptions, and both come from a handover. A seat handed on gets new bytes
(ADR-049), so every room its previous holder was in stops opening for it. The
device that cannot open one asks for a fresh room with the same members, and
the rule looks for the **newest** match from then on. Otherwise those powers
would be handed a dead room for ever and could never talk again.

## What the table settles for nothing

- **No anonymous press and no grey press.** Everybody at the board can see who
  is speaking. Grey and black press are postal inventions, and no house rule at
  a face-to-face board has any use for them.
- **No forged press.** A message is signed by the seat that wrote it, and the
  signature is checked on the reading device, never on the server (ADR-054).
  Inside a room of three, the room key alone does not say which of the three
  wrote a line; the signature does. A seat holding a token has no signing key
  and sends none, and the panel marks that line `unsigned` rather than drawing
  it as checked: honest and unprovable is a third state, not the first one.
- **A room with one member is a notepad.** It costs no new idea, no new table
  and no new screen, and webDiplomacy's private notes tab is the most reused
  thing in its press UI (research/platforms.md §1.1). Notes are not
  negotiation, so ADR-055's gates leave them alone.

## What the wire carries

The client sends ciphertext and a member list. The server stores:

    press_thread    the room: its members, who opened it, when
    press_key       the room key, wrapped once per holder
    press_message   seq, sender, phase index, the box, the signature, the time
    press_read      how far each holder has read

`phase_index` is on every message so a room can draw a line where each phase
resolved. A promise made before the orders came off and one made after are
different promises, and running the seasons together hides that. It is covered
by the sender's signature along with the sequence and the time, because the
panel draws with all three (ADR-054).

**The sender says where the message goes, and the server checks it.** The
sequence, the phase and the time come from the device, are sealed into the
box, and are refused if they do not match the room the server holds. Two
members writing at once would each seal against the sequence they last read,
so the second is refused and told to read the room again — storing it under
another number would make it unreadable to everybody, including its writer.

Six routes, all under the seat scope, all 404 in a game whose press mode
carries nothing:

    press          the rooms this power is in, with no bodies
    press/key      publish this seat's public press key
    press/open     open a room, or get back the one with these members
    press/thread   one room's messages
    press/send     one boxed, signed message
    press/read     move this holder's read marker

**The no-leak property is which endpoints exist, not what a handler filters**
(DESIGN.md §5). Every route takes the power from the credential, and no route
takes a thread id without also taking the credential that must be a member of
it. A leak has to be a new endpoint, not a bug in a condition.

## Nothing about press is in the event log

The first build logged each room's members, reasoning that a member list is
not a secret from the audit. It is. The game master view returns the whole
event log, and a game master who plays holds that view, so one line naming a
room's members would hand that player exactly what press exists to keep: who
is talking to whom.

ADR-007 audits the game master's enumerated powers. Opening a room is not one
of them, so there is nothing here the audit is owed.

## A message wakes nobody over the socket

Every other change to a game publishes a version on the live socket, and every
view of the game reads it — including the public one, which is unauthenticated
by design (ADR-013, ADR-028). A bump on every message would let anybody holding
a game's address watch private conversations happen: not what was said and not
by whom, but that somebody is talking, and exactly when. At a table, with seven
people in the room, that is most of the information.

So press publishes nothing. The panel polls for its own messages, and the bar's
unread count rides on the seat state the phone already polls.

## What rides on the seat state

`pressUnread` and `pressOpen`, and nothing else. The top bar shows a badge, and
it must not cost a request of its own on a phone that is already polling.
Bodies are fetched only while the panel is open. No message ever appears in a
seat state, a game master state, or the public watch JSON.

## What is rejected

- **A subject line.** Nobody at a table titles a conversation. A room is named
  by the powers in it.
- **Adding a member to a running room silently.** The current build does not
  add members at all: a corridor conversation that gains a person starts again.
  If it is ever added, the addition is a message in the room.
- **Press in a sandbox.** A sandbox has one driver and no seats (ADR-047), so
  there is nobody to send to.

## Revisions

- **r56, 2026-09-02** — ADR-053 accepted and built. The event log lost its
  room lines after a review found that a playing game master could read them.

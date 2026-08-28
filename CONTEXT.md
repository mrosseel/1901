# 1901

A face-to-face Diplomacy adjudicator: players enter orders on their own
phones at a physical table; the server adjudicates. This glossary fixes the
project's language. UI copy, code identifiers, docs, and API fields follow
it.

## Language

### People, slots, countries

**Power**:
A playable country in a variant (Austria, France, …). The only word for
this concept that game-facing UI may use — and prefer the power's actual
name over the word. godip calls this `Nation`; that word stays confined to
the godip boundary.
_Avoid_: nation (outside godip calls), country, faction

**Seat**:
One Power in one game, together with its join state: token, device claim,
GM rights. What a QR code hands out and what token rotation replaces.
Backstage term (code, docs, API) — never shown in game UI.
_Avoid_: slot, position

**Player**:
The human. Players occupy Seats; Seats belong to Powers. Backstage term;
the UI addresses the player as "you" or by their Power.
_Avoid_: user (in game context)

### Order lifecycle

**Order**:
One instruction for one unit in one phase (Move, Hold, Support, Convoy —
plus retreat and build orders). "Move" names only the order type, never
the collection.
_Avoid_: move (as the generic word), command

**Finalize**:
The player-facing act of locking in this phase's orders. UI word only:
"Finalize orders", "England has finalized". Re-finalizing before the
reveal replaces the earlier commit (D-011).
_Avoid_: submit (banned — ambiguous between draft, commit, and reveal),
lock in, ready up

**Commit**:
The mechanism behind Finalize: the hash of `orders || nonce` the client
sends, stored server-side (D-004). Backstage term — code, docs, protocol,
`commit` table.

**Reveal**:
The client releasing the actual `orders || nonce` for verification once
every power has finalized or the GM forces resolution. Backstage term.

### Views

**Spectator view**:
The secret-free public screen: the GM view minus admin controls (D-013),
shown on a projector or shared laptop, with URL-chosen layout variants.
Strictly read-only with respect to the game: nothing done here can create
or change an Order. It may later allow Annotations.
_Avoid_: beamer, projector view

**Annotation**:
A commentator's hypothetical marking drawn on the spectator view (a
possible move arrow, a highlight), as in chess commentary. Never touches
game state and is never an Order.
_Avoid_: suggestion, ghost order

### Outcomes

**NMR**:
"No moves received": a power resolved with no orders because nothing was
committed or revealed in time; its units hold. Event-log and GM-view term;
player-facing text says "no orders — units hold".
_Avoid_: civil disorder (reserved for the real rulebook state, which we do
not implement)

**Adjudicate**:
The act of processing a phase: verifying reveals, applying orders,
advancing the game. The GM's gated action is "force adjudication" (D-010).
_Avoid_: resolve (as the verb for the whole phase)

**Resolution**:
The per-order outcome of an adjudication (`OK`, `ErrBounce:tri`).

## Example dialogue

> **Dev:** When a phone dies mid-game, what changes hands?
> **Domain expert:** The Seat. The GM rotates its token, the same Player
> claims it from a new device. The Power never notices — Austria is still
> Austria.
> **Dev:** And what does the new device's screen say?
> **Domain expert:** "You are Austria." Never "your seat" or "your nation".
> **Dev:** England taps Finalize but their phone dies before the reveal.
> **Domain expert:** Their commit is on the server, their orders are not.
> The GM waits, extends, or forces adjudication — then England is an NMR:
> no orders, units hold, one line in the event log.
> **Dev:** Can the commentator at the spectator screen sketch England's
> best move?
> **Domain expert:** As an Annotation, yes. It draws on the glass, never
> on the game.

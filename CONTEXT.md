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

**Lock**:
The act of declaring this phase's orders done. One word front and back:
the button says "Lock in my orders", the seat list says "Locked in", the
JSON field is `locked`, the route is `POST .../lock`, the column is
`seat.locked`.

Locking again before the reveal replaces the earlier commit (D-011), and
that is why the word is Lock and not Finalize. Nothing is final here. The
button's own subtitle says the orders can still change, and a lock is a
thing you can open again.

The word was Finalize until 2026-08-30. Old commits, `D-008`, `D-011`,
`D-034` and the rest of DESIGN.md still say it, and they were true when
they were written. Read "finalize" there as "lock".
_Avoid_: submit (banned — ambiguous between draft, commit, and reveal),
finalize, ready up

**Commit**:
The mechanism behind Lock: the hash of `orders || nonce` the client
sends, stored server-side (D-004). Backstage term — code, docs, protocol,
`commit` table.

**Reveal**:
The client releasing the actual `orders || nonce` for verification once
every power has locked or the GM forces resolution. Backstage term.

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

**Sandbox**:
A game with no seats (D-047). One person holds the link, orders every
power, adjudicates, and may edit the position. Public to read at the
same addresses as any other game. Game-facing word, kept because the
community already says "sandbox link" and means this.
_Avoid_: scratch game, practice game, private board

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
> **Dev:** England locks in but their phone dies before the reveal.
> **Domain expert:** Their commit is on the server, their orders are not.
> The GM waits, extends, or forces adjudication — then England is an NMR:
> no orders, units hold, one line in the event log.
> **Dev:** Can the commentator at the spectator screen sketch England's
> best move?
> **Domain expert:** As an Annotation, yes. It draws on the glass, never
> on the game.

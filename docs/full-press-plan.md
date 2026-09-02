# Full press — plan

**Status:** proposal, not yet decided. Nothing here is built.
**Date:** 2026-09-01
**Touches:** ADR-023 (press mode), ADR-004 (commit-reveal), ADR-007 and
ADR-013 (the game master sees nothing secret), ADR-049 (the seat key).

Full press means the app carries messages between powers. Today it carries
none, in any mode, and ADR-023 says so on purpose. This plan says what the
rules allow, what the app must not be able to read, and what the screen looks
like.

---

## 1. What the rules allow

Two documents decide the shape, and they answer the CC question between them.

**The rulebook.** Negotiation is open. Players may talk in twos, threes, or
all seven, in secret or in the open, and nothing they agree binds them.
There is no rule that a conversation has two people in it.

**WDC 2019 official rules** (diplomed.free.fr/eng/rules.htm), the house rules
a championship board runs on:

| Rule | Text | What it means for us |
| --- | --- | --- |
| 3b | "it is forbidden to negotiate during the retreats and adjustments" | Press is a movement-phase thing. This is exactly ADR-023's `rulebook` mode. |
| 3c | an eliminated player "is not allowed to negotiate with the other players of the board" | A power on zero centres loses press. |
| 4b2, 4b4 | the writing phase is one minute, and "the negotiation are not allowed" | Press closes before the deadline, and stays closed. |
| 4d | "failure to observe silence during the writing phase may be an immediate sanction" | The silence is enforced, not advisory. So the app enforces it. |
| 4g1 | an end-of-game vote "can only be done during a negotiation phase" | The draw ask of ADR-052 belongs in the same window as press. |

### So: can a power write to several powers at once?

Yes, and not as a CC. At a table three players walk into a corridor and all
three hear all three. That is a **room**, and everything said in it is said to
everybody in it. A CC is the postal metaphor and it brings a BCC with it,
which the table has no equivalent of.

The rule that falls out of this:

> **A press thread has a member list, fixed at the moment it opens. Every
> message goes to every member. There is no BCC, no reply-to-one, and no
> silent addition.**

Wanting to say a different thing to France alone is not a feature. It is a
second room with one member in it, which is what a player would do at the
table by walking away.

Two more things the table settles for free:

- **No anonymous press and no forged press.** Everyone at the board can see
  who is speaking. Grey and black press are postal inventions. Every message
  is signed by the seat that wrote it, and the signature is checked on the
  reading device, not on the server.
- **No press to a power that is out.** WDC 3c, and `result.go` already knows
  which powers are eliminated.

---

## 2. The hard part: the server must not be able to read it

ADR-004 exists because the server is usually the game master's laptop and the
game master usually plays. Orders are sealed for that reason. Press has the
same problem and worse content: knowing who is talking to whom is most of the
game, and the message bodies are the rest of it.

Shipping plaintext press would say "your orders are secret from me, your
negotiations are not". That is not worth having. So:

> **Press is end-to-end encrypted between the seats in the thread. The server
> stores ciphertext, member lists, and timestamps.**

Backstabbr does the opposite (its game master reads all press and the FAQ
calls it a perk), and it can, because a Backstabbr game master who plays
loses their powers. Ours plays and keeps them. ADR-007 and ADR-013 already
committed us to this side.

### The keys

The parts are all in the repo already.

- `web/src/keys.ts` derives a named key from a secret. The seat seed
  (ADR-049) already yields a signing key under `1901 seat sign v1` and a
  per-phase order key under `1901 order key v1`.
- Add a third: an X25519 key under `1901 seat box v1`. The device publishes
  the public half when it claims, beside `sign_pub`. New column `seat.box_pub`.
- A thread has one random 32-byte **room key**, made by the opener. For each
  member, the opener does X25519 with that member's `box_pub`, runs the shared
  bytes through HKDF, and wraps the room key with XChaCha20-Poly1305. One
  wrapped copy per member is stored.
- A message is XChaCha20-Poly1305 under the room key. Associated data is
  `gameId|threadId|seq|senderPower`, so a message cannot be moved between
  threads, games, or senders. It is then signed with the seat's Ed25519 key.
- A member added later gets a wrap made by whoever adds them, and the addition
  is a message in the room, so nobody is added silently.

`@noble/ciphers` and `@noble/ed25519` are already dependencies. X25519 needs
`@noble/curves`, same author, same no-`crypto.subtle` rule (`keys.ts` header).
Adding it changes `package.nix`.

### What this costs, honestly

- **A seat that holds a token, not a seed, cannot derive.** That is the game
  master's own seat and every seat of a game made before ADR-049. It makes a
  random box key once and keeps it in local storage. If that phone dies, its
  press is gone. `sealed.ts` already has this exact hole and documents it.
- **A handover ends a conversation.** The new holder gets new bytes (ADR-049
  makes sure of it) and cannot read what the previous player was told. That is
  correct, not a bug, but the seat menu should say it before the handover.
- **Moderation costs a declared setting.** A game master who does not play may
  be read into every room. One who plays never can. §5 has the rule and §3.1
  has the mechanism.

---

## 3. Server model

Four tables, following the existing style (write-through, migration by added
column, nothing updated in place except the read marker).

```sql
CREATE TABLE press_thread (
    game_id   TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    opened_by TEXT NOT NULL,      -- power
    members   TEXT NOT NULL,      -- powers, sorted, comma-joined
    opened_at TEXT NOT NULL,
    PRIMARY KEY (game_id, thread_id)
);

CREATE TABLE press_key (       -- the room key, wrapped once per member
    game_id TEXT NOT NULL, thread_id TEXT NOT NULL, power TEXT NOT NULL,
    wrapped TEXT NOT NULL,
    PRIMARY KEY (game_id, thread_id, power)
);

CREATE TABLE press_message (
    game_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL, sender TEXT NOT NULL,
    phase_index INTEGER NOT NULL, -- so the log can show where a phase fell
    box TEXT NOT NULL, sig TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (game_id, thread_id, seq)
);

CREATE TABLE press_read (
    game_id TEXT NOT NULL, thread_id TEXT NOT NULL, power TEXT NOT NULL,
    last_seq INTEGER NOT NULL,
    PRIMARY KEY (game_id, thread_id, power)
);
```

Routes, all under the seat scope in `seatRoutes` and therefore under
`/api/v1/game/{id}/seat/{token}/…`:

| Route | Does |
| --- | --- |
| `press` GET | This power's threads: id, members, last message time, unread count. |
| `press/open` POST | Member list plus one wrap per member. Returns the thread id. |
| `press/thread` GET | Messages of one thread, `?since={seq}`. |
| `press/send` POST | One boxed, signed message. |
| `press/read` POST | Move this power's `last_seq`. |

**Endpoint discipline** (DESIGN.md §5). Every one of these takes the power
from the credential and filters on membership in SQL. There is no route that
takes a thread id alone, and no route the game master scope answers. A leak
must require a new endpoint, not a bug in a filter.

**What the server refuses without reading anything:**

- `pressMode` is `ftf` or `gunboat` → all five routes are 404.
- `pressMode` is `rulebook` and the phase is retreat or adjustment → `open`
  and `send` are 409. Reading old threads stays open, because WDC 3b forbids
  negotiating, not remembering.
- The sender or any member is eliminated → 409 (WDC 3c).
- Now is inside the silence window → 409 (WDC 4b2, 4d).
- The sender is not a member → 404.

**Unread count rides on the seat state.** `handleSeatState` gains
`pressUnread` and `pressOpen` (a boolean for whether sending is allowed right
now). The seat page already polls state every 3s. The top bar needs no
request of its own, and message bodies are fetched only while the press panel
is open.

**The event log stays honest and blind.** One line per thread opened, with
the member list, and none per message. The member list is not secret from the
audit (ADR-007 is about accountability), the content is.

---

## 4. The screen

### 4.1 The top bar

One row above the divider, spanning map and panel, on the seat page only. It
is the answer to "what do I need to know without looking for it".

```
┌──────────────────────────────────────────────────────────┐
│ ● AUSTRIA │ Spring 1901 │ 3/4 orders │ 11:42 │ ✉ 2       │
└──────────────────────────────────────────────────────────┘
│                                                          │
│                      map                                 │
│                                                          │
├────────────────────── divider ───────────────────────────┤
│              orders  ·or·  press                         │
└──────────────────────────────────────────────────────────┘
```

Left to right, in the order a player asks for them:

1. **The power chip.** Its own colour, its own name. It is the button that
   opens the seat menu (handover, links, game master view), which `SeatMenu`
   already is. This moves out of the panel header.
2. **The phase.** `PhaseName`, moved out of the panel header.
3. **Orders in.** `3/4`, from the counts `SeatPage` already computes
   (`orderRows.length`, `expectedOrders`). Amber while short, plain when
   complete, and it reads `locked` once this seat has locked in.
4. **Time remaining.** `Clock`, moved out of the panel header. It is already
   the thing that must never be hunted for.
5. **The envelope.** Unread count as a badge. Zero unread shows the envelope
   with no badge, never a "0".

Rules for the bar:

- 44px tall on a phone in portrait, 36px in landscape, where every pixel of
  height is fought over.
- Nothing in it is a link away from the page. It is status plus two controls.
- It never wraps to two lines. At 320px the phase drops to `S1901M` and the
  power chip to its three-letter form before anything is hidden.
- The map island refits itself when its box changes (`board.ts`), so adding
  the row above `SplitLayout` costs no map code.

The panel header keeps what is left: the variant line, the duty line ("two
units must retreat"), the review links, and the rules-changed banner.

### 4.2 The press panel

The envelope swaps what the panel below the divider shows. The map does not
move, the divider does not move, and dragging it still works. Two views, one
level of depth:

**Thread list.**

```
  ✎ New message
  ┌────────────────────────────────────────┐
  │ ● FRA ● ITA            2 new     14:05 │
  │ "then Piedmont is yours, but only if…" │
  ├────────────────────────────────────────┤
  │ ● GER                            13:51 │
  │ "I have no interest in Belgium."       │
  ├────────────────────────────────────────┤
  │ ✎ Notes to myself                13:12 │
  └────────────────────────────────────────┘
```

- A row is named by the powers in it, as colour chips. Never by a subject
  line. Nobody at a table titles a conversation.
- Sorted by last message.
- **Notes to myself** is a thread with one member, encrypted to that seat, and
  it costs nothing extra. webDiplomacy's private notepad is the single most
  reused thing in its press UI (research/platforms.md §1.1) and is worth
  taking.

**Thread view.** Messages oldest to newest, sender chip in the power's colour,
the input pinned at the bottom. Phase changes are drawn as a rule across the
thread ("Spring 1901 adjudicated"), which is what `phase_index` on each row is
for. Back arrow returns to the list.

**Composing.** Tap "New message", tap the power chips you want, write. If a
thread with exactly that member set already exists, the message goes there.
That one rule is what stops a game ending with forty threads in it.

**When press is shut.** The input is replaced by the reason, in the app's own
words, not an error: "Writing time. No negotiation." / "No negotiation during
retreats and builds." / "Austria is eliminated." The list stays readable
throughout.

**Alerts.** The badge, and a vibration if the device allows it. No sound. The
room is full of people who are also playing.

### 4.3 What the other views show

- **Game master view:** nothing, unless `gmReadsPress` is on, which needs a
  game master who does not play (§5.1). Otherwise not the bodies, not the
  member lists, not the counts. Who is talking to whom is the game.
- **Watch and public views:** nothing, for the same reason. Backstabbr never
  exposes press either.
- **After the game ends:** the devices could release their room keys the same
  way they release order keys, and the press archive would become public with
  the board. webDiplomacy publishes one and it is the best thing about its
  archive. Later, and only with every player's tap.

---

## 5. Settings

`pressMode` stops being data only (ADR-023's r18 implementation note):

- `ftf` — unchanged, still the default. No messages.
- `gunboat` — unchanged. No messages.
- `rulebook` — press in movement phases only. Now carries behaviour.
- `fullpress` — press in every phase. Now selectable in the two forms that
  hide it today (`NewGame.tsx`, `GmPage.tsx`).

Two new settings, both immutable after start, both on the join page:

- **`pressSilenceSeconds`**, default 60. WDC's writing minute. Press closes
  this long before the deadline. Zero turns it off.
- **`gmReadsPress`**, default off, and **selectable only when `gmPlays` is
  off**. A game master who plays can never be given it, at any point, because
  the whole reason orders are sealed is that this person is at the board.
  `gmPlays` is already fixed at start, so the pair holds for the whole game.

  When it is on, the game master is a member of every room: the sender wraps
  the room key for the game master's key as well as for each power. So yes,
  the game master is copied into every message, and the game master needs a
  mailbox. It is the referee's seat at the table, and it is declared on the
  join page before anybody joins.

### 5.1 The game master's mailbox

- The game master's box key comes from the ADR-048 key, under
  `1901 gm box v1`. The twelve words recover the mailbox with the game.
  A game whose game master declined a key cannot turn `gmReadsPress` on.
- The mailbox is **read-only in rooms the powers opened**. A referee who could
  write into a private room could impersonate the room.
- The game master may **open a room** of its own with any set of powers, for
  rulings and announcements. Its messages are marked as the game master, in
  the game master's own colour, and a power cannot open a room with the game
  master.
- The mailbox is **a screen of its own, and not projector-safe**. ADR-013 says
  the game master view is safe on a shared screen; that stays true for the
  board, and this screen is behind its own tap with a plain warning. The
  spectator view is the game master view minus admin controls and never
  reaches this, because it holds no key.
- The server refuses to open a room without a wrap for the game master while
  the setting is on. It cannot check that the wrap is a *correct* one. A
  modified client could send noise, and the mailbox would show the room as
  unreadable rather than pretend. Say so where the setting is, and do not
  claim more.

---

## 6. Order of work

Each step is shippable and testable on its own.

1. **Keys.** `1901 seat box v1` in `keys.ts`, `seat.box_pub` column, publish
   on claim and on handover. Add `@noble/curves`, update `package.nix`.
   Tests: derive, wrap, unwrap, and a wrap made for the wrong seat fails.
2. **Store and routes.** The four tables, the five routes, membership filtering
   in SQL, the refusals of §3. Tests: a non-member gets 404 on every shape of
   the request, a `ftf` game 404s the whole set, replay leaves press alone.
3. **The top bar.** Move phase, clock, power chip and the order count up. No
   press yet: the envelope appears in step 5. This step is worth having on its
   own, and it shrinks the panel header on a phone.
4. **Client crypto.** `press.ts` beside `sealed.ts`: open a room, wrap, box,
   sign, verify, unbox. Pure functions, no fetch, tested without a browser,
   the same way `sealed.ts` is.
5. **The press panel.** List, thread, compose, the shut states, the badge.
   Fixtures in `web/src/dev/fixtures/` and screens in the gallery, which is
   how every other screen in this app is reviewed.
6. **The gates.** `rulebook` phase gating, the silence window, elimination,
   and the settings forms. The countdown to silence belongs in the panel, not
   only in the refusal.
7. **Later.** The press archive at game end. The draw ask moved inside the
   negotiation window (WDC 4g1).

---

## 7. Open questions

- **Q-P1. Does full press belong at a physical table at all?** A table where
  seven people are typing at each other has stopped being face-to-face
  Diplomacy, and this app is named for the table. My answer: build it, ship
  it off by default, and expect its real users to be the hosted mode (ADR-018)
  and tables with one remote player. The rules gating is what keeps it from
  turning an FTF board into an online board by accident.
- **Q-P2.** *decided.* `gmReadsPress` exists and is offered only to a game
  master who does not play. §5.1 has the mailbox.
- **Q-P3. Does a thread's member list change?** This plan allows adding a
  member, visibly, with the addition written into the room. Forbidding it
  entirely is simpler and closer to a corridor conversation, which does not
  gain people without starting again.
- **Q-P4. Do press messages survive a handover for the table's sake?** This
  plan says no. A tournament might want the replacement player to read what
  was promised.

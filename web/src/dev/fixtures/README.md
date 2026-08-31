# Fixtures

Canned server answers for the design gallery at `/dev/screens`. Every file here
came off a running server, unedited: one classical game was played through
Spring and Fall 1901 and snapshotted at each moment worth designing against.
Two more games supply the two game-master moments the first one cannot hold at
the same time.

Nothing here is hand-written. If a fixture looks wrong, it is because the
server answered that way.

When the server grows a field, the captures that predate it are migrated
rather than replayed: the new key is filled with what that game's server would
have answered, and nothing else in the file is touched. `joinedCount` and
`seatsOnOffer` arrived that way — every game behind these captures had all its
powers claimed, so both are the power count.

A rename is migrated the same way. On 2026-08-30 `finalized`, `youFinalized`
and `finalizedCount` became `locked`, `youLocked` and `lockedCount`, and the
event lines these captures carry were rewritten to the words the server now
writes. No value changed.

`settings.name` arrived the same day and is empty in every capture that
predates it: none of those games was ever named, so an empty string is what
that server would have answered.

## The game behind them

Seven players, no game master seat, a 30-minute deadline, the classical
variant.

- **Spring 1901.** Munich and Paris both order Burgundy and bounce. Vienna and
  Warsaw both order Galicia and bounce. Turkey gives no orders and never locks
  in, so the forced adjudication writes an NMR against it.
- **Spring 1901 retreat.** Nothing was dislodged, so no power is asked for
  anything.
- **Fall 1901.** Burgundy bounces again, Turkey takes a second NMR, and Italy
  walks from Tyrolia into Trieste with Venetian support — the Austrian fleet
  there is dislodged.
- **Fall 1901 retreat.** Austria retreats the fleet to Albania.
- **Fall 1901 adjustment.** France holds Spain and Portugal on top of its three
  home centres and owes two builds. Austria has lost Trieste and owes one
  disband.

## The files

### Seat states — `SeatState`

| File | The moment |
| --- | --- |
| `seat-not-started.json` | France, all seven claimed, the game master has not started it |
| `seat-waiting-partial.json` | Austria, four of seven claimed — a table still filling up. Its own game: the one above cannot be half-claimed and full at the same time |
| `seat-movement.json` | France mid-Spring-1901, three drafted orders drawn on the map |
| `seat-locked.json` | England with its orders locked |
| `seat-retreat.json` | Austria in the Fall 1901 retreat, its Trieste fleet dislodged. Its `previousPhase` is the Fall 1901 movement — the bounce, the dislodge and the NMR in one review |
| `seat-adjustment-build.json` | France owing two builds, Brest and Marseilles open |
| `seat-adjustment-disband.json` | Austria owing one disband |
| `seat-idle.json` | Germany in the Spring 1901 retreat, asked for nothing and locked by the server (ADR-034) |
| `seat-ended-draw.json` | France in the game above, after the draw: the result, the powers in it and every power's final count |
| `seat-sealed-locked.json` | Austria in a sealed game (ADR-004), locked in with six of seven powers in. It carries no `orderParts` at all, and that is the capture rather than a gap: the draft is on the phone and the server holds a digest |

### Option trees — `Record<string, OptionTree>`

The seat page asks the server which provinces can carry an order in a retreat
or adjustment phase, and the answers decide the highlights and the build and
disband counts. Without them those screens look empty, so they are captured
beside their state.

| File | Goes with |
| --- | --- |
| `options-retreat.json` | `seat-retreat.json` |
| `options-build.json` | `seat-adjustment-build.json` |
| `options-disband.json` | `seat-adjustment-disband.json` |

### Game master states — `GmState`

| File | The moment |
| --- | --- |
| `gm-prestart.json` | A second game where the game master plays: six seats on offer, three joined, invite and QR open. Unnamed, and no power is listed — the count is all the page shows while seats are open |
| `gm-lobby-full.json` | A fourth game, named "Thursday table at the Ostend", with all six seats claimed and the game not started. The one moment the list of powers appears before the start |
| `gm-midphase.json` | Spring 1901 running, the clock counting down |
| `gm-force-armed.json` | Six of seven locked in, so the forced adjudication is live |
| `gm-deadline-passed.json` | A third game with a one-minute deadline, snapshotted after it ran out with nobody locked in |
| `gm-adjustment.json` | After Fall 1901, with the event log filled in |
| `gm-ended-draw.json` | A fifth game, played through 1901 and then drawn among England, France and Russia (ADR-044). The clock is gone and `canForce` is false for good |

### Spectator states — `WatchState`

| File | The moment |
| --- | --- |
| `watch-prestart.json` | A game that has not started: two of six seats filled, no clock, the opening position on the board |
| `watch-live.json` | The live Spring 1901 movement: a board and a clock, no orders public yet |
| `watch-phase-0.json` … `watch-phase-4.json` | The five resolved phases, so the page's earlier and later buttons really walk them |
| `watch-ended.json` | A sixth game created with `endYear: 1901`, frozen the moment the board left that year (ADR-044). Its own history was not captured, so the earlier button finds nothing — the screen this is here for is the result |

### The DATC report — `DatcReport`

| File | The moment |
| --- | --- |
| `datc-report.json` | What `/datc.json` served (ADR-045). It is generated output rather than a game state, and the copy here is a picture of the page, not a claim about the build the gallery is running in |

## Capturing another one

A dev build puts one function on the window:

```js
await __1901capture()          // guesses from the address: seat, gm or watch
await __1901capture("options") // the option trees this seat could be asked about
await __1901capture("watch", 2) // one resolved phase of the spectator feed
```

Run a real server and `npm run dev`, play until the screen is the one worth
keeping, then call it in that tab's console. It reads the page's own endpoint
with the page's own tokens, copies the sorted JSON to the clipboard, and
returns it. Save it as `src/dev/fixtures/<name>.json` and add an entry to the
catalogue in `../Gallery.tsx`.

`src/dev/fixtures.test.ts` walks every file here through the structural guards
in `../guards.ts`, so a capture taken against a server whose shapes have moved
fails the test run rather than the gallery.

## What the gallery does not do

The stub answers writes with the state as captured: an order, a lock or a
forced adjudication comes back unchanged. The gallery is for looking at states,
not for playing one. Maps are the exception — they are fetched from the real
server, so the map style control shows real art.

- `seat-illegal.json` — France vs Austria game: Austria drafted `bud Move adr`
  (an army into a sea) with illegalMoves on; the mark rides in `illegal`.
- `seat-review-illegal.json` — the same game after adjudication: `bud`
  resolved `IllegalOrder`, `vie Move gal` resolved `OK`.

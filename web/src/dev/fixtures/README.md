# Fixtures

Canned server answers for the design gallery at `/dev/screens`. Every file here
came off a running server, unedited: one classical game was played through
Spring and Fall 1901 and snapshotted at each moment worth designing against.
Two more games supply the two game-master moments the first one cannot hold at
the same time.

Nothing here is hand-written. If a fixture looks wrong, it is because the
server answered that way.

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
| `seat-not-started.json` | France, all seven joined, the game master has not started it |
| `seat-movement.json` | France mid-Spring-1901, three drafted orders drawn on the map |
| `seat-locked.json` | England with its orders finalized |
| `seat-retreat.json` | Austria in the Fall 1901 retreat, its Trieste fleet dislodged. Its `previousPhase` is the Fall 1901 movement — the bounce, the dislodge and the NMR in one review |
| `seat-adjustment-build.json` | France owing two builds, Brest and Marseilles open |
| `seat-adjustment-disband.json` | Austria owing one disband |
| `seat-idle.json` | Germany in the Spring 1901 retreat, asked for nothing |

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
| `gm-prestart.json` | A second game where the game master plays: six seats on offer, three joined, invite and QR open |
| `gm-midphase.json` | Spring 1901 running, the clock counting down |
| `gm-force-armed.json` | Six of seven locked in, so the forced adjudication is live |
| `gm-deadline-passed.json` | A third game with a one-minute deadline, snapshotted after it ran out with nobody locked in |
| `gm-adjustment.json` | After Fall 1901, with the event log filled in |

### Spectator states — `WatchState`

| File | The moment |
| --- | --- |
| `watch-live.json` | The live Spring 1901 movement: a board and a clock, no orders public yet |
| `watch-phase-0.json` … `watch-phase-4.json` | The five resolved phases, so the page's earlier and later buttons really walk them |

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

The stub answers writes with the state as captured: an order, a finalize or a
forced adjudication comes back unchanged. The gallery is for looking at states,
not for playing one. Maps are the exception — they are fetched from the real
server, so the map style control shows real art.

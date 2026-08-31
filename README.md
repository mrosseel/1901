# 1901

A Diplomacy adjudicator for face-to-face play. Everyone at the table enters
orders on their own phone, at the same time, and the server resolves the turn.

Tournament Diplomacy in 2026 still runs on paper. Orders go into a box, someone
reads them out, someone pushes the pieces, and a third volunteer retypes the
whole game into Backstabbr so the room can follow along. 1901 removes that
third job. The players put the game into the system themselves, phase by
phase, because entering orders *is* playing.

What that looks like in practice:

- The GM creates a game and shares one QR code. Scanning it assigns a random
  power. No accounts, no names, no passwords.
- Each player sees only their own orders. Tap your unit, tap where it goes.
  Supports and convoys build the same way. Illegal orders are allowed by
  default, since claiming you misordered is a time-honoured way to lie.
- When everyone has locked in, the turn resolves. A review screen shows every
  order with failures struck in red, and a "Move the pieces" list tells
  whoever keeps the physical board what to do.
- A login-free spectator URL exists for every phase, forever, for beamers and
  bystanders.
- Games end. A solo at eighteen centres, a draw or a concession the game
  master records, or an end year for a round with a hard stop. The result and
  the supply centre counts stay on the spectator link.
- `results.csv` and `results.json` per game, so a tournament director's scoring
  tool reads the counts instead of scraping a web page for them.
- 26 variants (Classical through Sail Ho!), four map styles, and it all runs
  offline on a laptop, because tournament venue wifi is what it is.

The interesting technical bit is that the server cannot read your orders while
you are writing them. They stay on your phone. Locking in sends them encrypted
under a key the phone keeps, and the key goes up only once every power has
locked in. So a game master who runs the server on their own laptop, and plays
a power, cannot read anybody's orders before writing their own — not as a
promise, but because they hold seven envelopes and no key to any of them. No
other Diplomacy platform does this.

The key comes from your seat, so it can be made again. If your phone dies
after you lock in, open your seat link on another one and your orders still
count.

The design notes live in [DESIGN.md](DESIGN.md) and [docs/adr/](docs/adr/),
which record every decision this project has made and why.

## Running it

You need Go 1.26+ and Node 24+. With nix, `nix develop` provides both, or
build the whole thing with `nix build`.

Start it with the script in the repository root:

```
./run.sh
PORT=8001 ./run.sh
```

It builds the frontend, builds the server, and serves on port 8000. It
refuses to start when the port is taken and names what holds it, because the
server prints "listening" before it learns the bind failed.

Or do the same by hand:

```
cd web && npm install && npm run build && cd ..
go run .
```

That serves everything on `:8190`. Open `/` for the game list, create a game,
scan the invite QR from the phones. Useful environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | Port `run.sh` serves on |
| `HOST` | every interface | Interface `run.sh` binds to |
| `ADDR` | `:8190` | Listen address, when running the binary directly |
| `DB` | `1901.db` | SQLite file; delete it for a clean slate |
| `BASE_URL` | derived from the request | Pin the origin used in invite links (set this behind a proxy) |

A link to `localhost` cannot open on a phone. When `BASE_URL` is unset and the
GM reaches the server on localhost, the server puts its own LAN address in the
generated links instead, keeping the port. It asks the kernel which address a
packet would leave from, so a laptop running docker still gets the right one.
It takes IPv4 only. With no default route it reads the interfaces instead, and
it declines when that leaves more than one candidate. The startup log states
which address it will hand out. Set `BASE_URL` when it declines.
| `MAX_GAMES` | `100` | Cap on live games |

## One file for a table

A release binary carries the frontend, the generated variants and the
placement tables inside it, so a game master downloads one file and runs it
with no toolchain and no internet (ADR-051):

```
cd web && npm run build && cd ..
CGO_ENABLED=0 go build -tags standalone -o 1901 .
```

Without the tag the server reads `web/dist`, `variants/generated` and
`placements` from the working directory, which is what a development session
wants. `SPADIR`, `GENERATED_VARIANTS` and `PLACEMENTS` override either build.

The published binaries come from the Release workflow: Actions, Release, Run
workflow, type the version. It builds seven platforms from one runner and
publishes them with their checksums.

## Developing

Run the Go server and the vite dev server side by side:

```
go run .                                  # API on :8190
cd web && npm run dev                     # UI on :5173, proxied to :8190
```

The frontend hot-reloads. `npm run dev` also enables the design gallery at
`/dev/screens`, which renders every game-state screen (mid-movement, retreats,
builds, reviews, GM views, spectator pages) from captured fixtures, so you can
iterate on any screen without creating or joining a game. Playing a real game
under the dev server, `await __1901capture()` in the console snapshots the
current state as a new fixture.

An empty server opens on an empty list, so there is a seeder:

```
go run ./tools/seed -url http://localhost:8000
```

It makes six Classical games over HTTP, each named after the opening it
plays — the Blitzkrieg, the Juggernaut, the Lepanto, the Maginot, the Northern
Opening, the Hedgehog — joins seven seats, plays Spring 1901 and leaves each
game at Fall 1901, so the spectator pages have a real board on them. An opening
is a named idea rather than a transcript, and the tool states one standard
version of each; nothing in it reproduces a game anybody played.

Tests:

```
go test ./...
cd web && npx vitest run
```

CI runs both suites plus govulncheck and godip's DATC corpus on every push.
The DATC run writes `datcreport/report.json`, which the binary embeds and
serves at `/datc`. Do not edit that file: the number is generated, and a typed
claim about correctness goes stale the first time godip moves.

## Legal

GPL-3.0, inherited from [godip](https://github.com/zond/godip), which does the
actual adjudication and has survived a decade of real games.

Diplomacy is a trademark of Hasbro / Avalon Hill, and the game's rules are
their copyright. This project is free, is not affiliated with or endorsed by
Hasbro, ships no Hasbro artwork, and assumes you own a copy of the board game.
The maps are community-drawn, credited in-app to their authors.

# Variants

Every map the server can play. It reads them from disk at startup; nothing is
compiled in.

Variants used to be Go packages in a compile-time slice. That works for a
curated set, because each map arrives through code review. It cannot work for a
procedurally generated map: a fresh map per game needs a recompile per game. So
the format took over, and godip's own variants crossed into it —
`tools/variant-export` wrote them, and `variants_equivalence_test.go` holds each
one against the Go package it came from.

godip is still the adjudicator, and still the source of the rule profiles a
descriptor names. It is no longer a second way for a board to reach a game.

## Layout

One subdirectory per variant. The directory name is the variant key. It must
match the `key` field in the descriptor.

    variants/generated/<key>/variant.json     the province graph and start
    variants/generated/<key>/map.svg          the board art
    variants/generated/<key>/placements.json  marker positions, optional

The server stops when a file is malformed. A half-parsed variant would put games
on a board nobody described.

## Sharing art

A directory that holds its own `map.svg` is self-contained, and a single
directory is all a variant needs to be served. That is what makes an export of
one variant a complete thing: dipmap writes three files and nothing else has to
be there.

A directory may instead say which other variant it is drawn on:

    "map": "classical"

and ship no `map.svg` at all. Five of godip's variants are played on the
classical board, and each carried a byte-identical 2.2 MB copy of it. The
reference says out loud what five identical files only implied.

Use a reference when a variant is drawn on art another variant in this
directory already holds, byte for byte. Write your own `map.svg` in every other
case, including every export of a single variant: an exporter that writes one
is doing the right thing, and `tools/variant-export` always does.

The value is a KEY, never a path. `../`, a slash, a dot, an absolute path and an
upper-case letter are all refused at load, because a descriptor may not name a
file outside this directory. A key nothing loaded, or a chain of references that
comes back to where it started, is refused too, and the error names the chain.
Nothing falls back to a blank board.

`map` is not part of the variant's hash. The hash covers what decides play, and
art does not, so a variant that stops carrying its own copy of a picture keeps
its identity and every game on it keeps loading.

Two directories holding byte-identical art is a mistake the tests catch: one of
them should name the other instead.

## The descriptor

    schema             1
    key                the directory name
    name               what a player sees
    map                another variant's key, when this one is drawn on its art
    rules.profile      the compiled rule set, by name
    rules.text         the variant's own rules prose
    soloSupplyCenters  centres needed for a solo
    nations            the powers, in their own order
    provinces          [key, long name, supply centre owner or null]
    regions            [province, coast or null, terrain]
    borders            [regionA, regionB, terrain]
    onewayBorders      [from, to, terrain]
    start              year, season, phase, units, supplyCenters

Terrain is `land`, `sea`, `coast`, or `archipelago` — land a fleet may hold and
an army may be convoyed through.

A border is mutual. `borders` states one once, and the loader adds both
directions, which is why the two halves cannot disagree the way they can in
hand-written Go. `onewayBorders` is the exception godip's maps need: a sea that
names a multi-coast province which does not name it back, or a province reached
by coast and left by land. Direction is the point of those rows, so their ends
keep their order.

`start` opens in Spring 1901 when it says nothing. It does not have to: Cold War
opens in 1960, Hundred in 1425 in a season called Year, and Chaos in an
adjustment phase with no units on the board at all.

## Rule profiles

`rules.profile` names behaviour that genuinely needs code. Everything else in a
descriptor is data. The profiles this build carries are in `variantjson`:

    classical                classical's phase cycle and orders
    classical-buildanywhere  classical's phases, build-anywhere orders
    buildanywhere            build-anywhere phases and orders
    buildanywhere-neutrals   the same, plus neutral units that move themselves
    chaos                    opens with every centre building an army
    hundred                  one season a turn, five years a turn
    twentytwenty             victory is a lead that shrinks each year
    pure                     armies only

A descriptor naming a profile this build does not carry is refused.

## Producing one

`tools/variant-export` writes descriptors for godip's variants. It refuses
anything it cannot state faithfully, rather than rounding it to the nearest
thing the format can say:

    go run ./tools/variant-export --out variants/generated

It writes every variant self-contained, so re-running it puts the five copies of
the classical board back. Which variant owns a shared picture is a judgement no
tool can make, so it stays a person's: restore the `map` lines by hand. The
duplicate-art test fails until you do.

dipmap writes a generated map's three files:

    dipmap export-variant <key> --out variants/generated --players 7

dipmap refuses to export a map that failed balance validation. Pass `--force`
to override that.

## What happens on load

The loader validates the descriptor and reports every problem at once. It
rejects borders that name unknown regions, duplicate borders with conflicting
terrain, an opening phase the profile's cycle never reaches, units of a type the
profile does not have, unknown nations, and a win condition nobody can reach. It
warns about what is legal but usually a mistake: a region no unit can reach,
unequal starts, home centres belonging to powers that are not playing.

The loader then sanitises the art against an allowlist in `svgsafe.go`. It
removes scripts, event handlers, `foreignObject`, remote references and `data:`
URLs, then logs what it removed. One `data:` URL survives: a bitmap on an
`<image>`, which is how real map art paints its paper.

Finally the loader hashes the descriptor. Every game created on that variant
records the hash. A game replays its order history against the variant's
starting position, so an edited descriptor would replay the game onto a board
its players never saw. The server refuses to load such a game and names the
problem.

The hash covers only what decides play: provinces, regions, borders in both
tables, the opening position and phase, the win condition and the rules profile.
Rename the variant, correct its description or reflow its JSON and every game
survives. Move one border and they all stop.

## What this is not

The server has no upload route. Files arrive here the way the binary does:
someone with access to the checkout puts them there. An endpoint that accepts a
variant over the network needs its own design, because it would let a stranger
choose what the sanitiser has to withstand.

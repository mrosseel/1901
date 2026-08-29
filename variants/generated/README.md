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

## The descriptor

    schema             1
    key                the directory name
    name               what a player sees
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

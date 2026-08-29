# Generated variants

Maps the server reads from disk at startup, instead of compiling into the
binary.

Every other variant is a Go package in a compile-time slice. That works for a
curated set, because each map arrives through code review. It cannot work for a
procedurally generated map: a fresh map per game needs a recompile per game.

## Layout

One subdirectory per variant. The directory name is the variant key. It must
match the `key` field in the descriptor.

    variants/generated/<key>/variant.json     the province graph and start
    variants/generated/<key>/map.svg          the board art
    variants/generated/<key>/placements.json  marker positions, optional

The server starts normally when the directory is absent. It stops when a file
is malformed. A half-parsed variant would put games on a board nobody
described.

## Producing one

dipmap writes all three files. It has one output format, because a Go package
would need a build:

    dipmap export-variant <key> --out variants/generated --players 7

dipmap refuses to export a map that failed balance validation. Pass `--force`
to override that.

## What happens on load

The loader validates the descriptor and reports every problem at once. It
rejects borders that name unknown regions, duplicate borders with conflicting
terrain, regions no unit can reach, units standing on centres they do not own,
unknown nations, a win condition nobody can reach, and unequal starts.

The loader then sanitises the art against an allowlist in `svgsafe.go`.
Compiled art passed through code review. This art did not, and SVG can run
scripts. The loader removes scripts, event handlers, `foreignObject`, remote
references and `data:` URLs, then logs what it removed.

Finally the loader hashes the descriptor. Every game created on that variant
records the hash. A game replays its order history against the variant's
starting position, so an edited descriptor would replay the game onto a board
its players never saw. The server refuses to load such a game and names the
problem.

The hash covers only what decides play: provinces, regions, borders, the
opening position, the win condition and the rules. Rename the variant, correct
its description or reflow its JSON and every game survives. Move one border and
they all stop.

## What this is not

The server has no upload route. Files arrive here the way the binary does:
someone with access to the checkout puts them there. An endpoint that accepts a
variant over the network needs its own design, because it would let a stranger
choose what the sanitiser has to withstand.

# Generated variants

Maps loaded from disk at startup rather than compiled into the binary.

Every other variant here is a Go package in a compile-time slice, which is the
right shape for a curated set that arrives through code review. It is the wrong
shape for a procedurally generated map: a fresh map per game would mean a
recompile per game.

## Layout

One subdirectory per variant. The directory name is the variant key, and it
must match the descriptor's `key`.

    variants/generated/<key>/variant.json     the province graph and start
    variants/generated/<key>/map.svg          the board art
    variants/generated/<key>/placements.json  marker positions, optional

A missing directory is fine. A malformed one stops the server, because serving
a half-parsed variant would mean games played on a board nobody described.

## Producing one

dipmap writes all three files:

    dipmap export-godip <key> --out variants/generated --players 7

It refuses to export a map that failed balance validation unless forced.

## What happens on load

The descriptor is validated: borders naming unknown regions, duplicate borders
with conflicting terrain, stranded regions, units on centres they do not own,
unknown nations, an unreachable win condition, unequal starts. Every problem is
reported at once.

The art is sanitised against an allowlist (`svgsafe.go`). Compiled art passed
through code review; this did not, and SVG executes. Scripts, event handlers,
`foreignObject`, remote references and `data:` URLs are removed, and what went
is logged.

The descriptor is hashed, and the hash is recorded on every game created on it.
A game replays its whole order history against the variant's starting position,
so a descriptor edited under a running game would replay onto a different
board. A changed descriptor makes that game refuse to load and says so, rather
than corrupting it quietly.

## What this is not

There is no upload route. Files arrive here the way the binary does: someone
with access to the checkout puts them there. Adding an endpoint that accepts a
variant from the network is a separate decision with a separate threat model.

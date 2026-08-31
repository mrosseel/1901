---
status: accepted
---

# ADR-033 — Map styles are named data, chosen per device

**Status:** accepted, r16. Renumbered in r25: this decision and the press
mode both carried the id ADR-023.
A style is a JSON file in `mapstyles/`, which is where they moved in r18
(ADR-026) once the server read them too. It says what the two terrain tones are,
what a border looks like, whether there is a grain, how the two kinds of name
are set, and how a supply centre is painted. Nothing a style can say is
anything but a presentation property, and every length in it is quoted against a reference width, so a
style knows nothing about the map it lands on.

The first style is not written by hand. `extract-parchment.ts` reads godip's
classical map and writes `parchment.json` plus the three assets it shares —
the embedded Libre Baskerville faces, the hatch, the paper grain — so the
house style stays the file's own rather than someone's memory of it. Three
more are designed: **midnight** (dark sea, muted land, haloed light names, for
a phone in a dim room), **print** (light greys, black hairlines, no texture,
for a projector) and **flat** (saturated sea, soft land tints, the modern web
manner). Legibility is the constraint every style is held to, and the halo —
a stroke painted under the glyph with `paint-order` — is how a dark or
saturated ground is paid for without touching a label's size, which the
placement tables were measured against.

`restyle --style <name> --variant <key>` writes `map-<style>.svg` beside
`map.svg`, and the structural-equality check of ADR-032 runs on every
style × map pair. The server loads them all and serves
`?style=<name>`; unknown answers 404 rather than falling back, because a
silent fallback makes a typo in a saved preference look like a style.
`?style=original` and the default are unchanged.

The choice is per DEVICE, in localStorage, never in the game: it changes what
one screen draws and nothing anyone else sees. One table can have the game
master on parchment, a player on midnight, and the projector on print.

**Superseded limit.** This decision first said that only maps converted from
jDip could be styled, because the restyle works through the semantic classes
those maps carry (`nopower`, `seapoly`, `neutral`) and no godip map has any.
ADR-024 built the second applier and every map is now styled. Classical's
blurred coastline is still carried in every style and applied by neither
applier: it needs a single landmass path, and a per-province map would draw it
along every inland border too.

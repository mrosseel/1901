---
status: accepted
---

# ADR-026 — A styled map is composed at serve time from a style plan

**Status:** accepted, r18. Supersedes the storage half of ADR-024 and ADR-032.
Every map in every style used to be generated ahead of time and kept as a
file. That was 156 MB under `styledmaps/` plus 3.3 MB checked in under
`variants1901/`, regenerated in full whenever a style changed one colour. The
files are gone. What is kept instead is the measurement.

A restyle has two halves and only one of them is expensive.

**Detection** loads the art in a real rendering engine and asks what is
painted under each province, what each label stands on, how much of the board
each tone covers, and whether a foreground layer holds province borders or
drawing. It needs a browser, takes seconds per map, and depends on the map
alone. It gives the same answer for every style.

**Application** substitutes fill values, swaps a pattern's insides, and sets a
stroke and a typography. It is string work, it takes milliseconds, and it
depends on the style.

`tools/restyle/plans.ts` writes the detection half to
`styleplans/<key>.json`, 120 KB for all 26 maps, checked in. `restyle.go`
does the application half in Go, at serve time, and caches the result in
memory per map and style. The style tokens moved to `mapstyles/` at the top of
the repository and are embedded in the binary with `go:embed`, because two
programs read them now and they belong to neither.

**What a plan holds.** For a godip map: the sea and land fill values the
palette vote settled on with their confidences, the extra tones with the base
each one is carried from, the impassable-hatch and paper-grain pattern ids and
the element that lays the grain, the border decision (how many dark strokes
the foreground holds, how many provinces the map has, and whether that ratio
makes it decoration), and one land or water verdict per name. For a converted
jDip map: the label metrics jDip wrote without a CSS unit, the classes that
paint power-owned ground, and the class each label is given. Nothing in a plan
is a style decision. Everything in it is a measurement.

**A length belongs to a layer, not to a map.** Every length a style names
crosses onto a map as a fraction of its width, then divides by the scale of
the layer it lands in. A converted jDip map has more than one such scale.
1900 draws its art at a tenth and its names beside it at full size, so a plan
records the scale of the art layer and of the label layers separately.
Carrying a tracking or a halo at the art's scale made it ten times too wide on
exactly the labels that could least afford it, which is how 1900's six-pixel
names became smudges while its fourteen-pixel names looked fine.

The art decides the value. Where a plan states no label scale, `restyle.go`
reads it from the name layers' own transforms, so an old plan renders
correctly with no edit and a stated value cannot drift from the picture it was
measured on; a test holds every stated value to what its art draws.

Two faults in the same rules are recorded here rather than fixed, because
either one alone makes the other invisible. The lengths are emitted without a
CSS unit, so every `letter-spacing` in a jDip stylesheet is inert in Chrome
and Firefox. And `#FullLabelLayer text { stroke:none }` outranks
`.map-landname`, so the halo never applies on a converted map. This is why
correcting the scale changes no pixel today. Correcting the units first, with
the scale still wrong, would have made 1900's names unreadable.

**A name has a smallest readable size.** A converted map's label sizes are
jDip's own, with one exception. jDip grades 1900's classes from 6 to 14 units
on a map 761 units wide, and the board fits that map to a pane about 1072px
wide, so a 6-unit name lands at 8.5 screen pixels before any zoom. Those were
the unreadable province names, and the sea names beside them looked fine
because they were drawn at 14. Any class under 1.15% of the map's width is
drawn at 1.15% instead, which puts the smallest name near 12 screen pixels at
the default fit. On 1900 that lifts 6 and 8 to 8.752 and leaves 10, 12 and 14
exactly as measured.

It is a floor and not a rescale, and that difference is the whole decision.
Rescaling the band onto a legible minimum grows the names that already fit,
and the Low Countries and the German coast turn into overlapping text. A class
above the floor keeps the box its placement was measured against.

`restyle.go` computes the floor from the map's own viewBox width and the scale
of the layer the rule lands in, so it cannot drift from the art and no plan
records it. Sail Ho's smallest class is 120 units on a 7300-unit map against a
floor of 83.95, so both Sail Hos come out byte-identical in all four styles,
as does every godip map. Of 130 served SVGs, only 1900's four styles change.

**Staleness is loud.** A plan names the SHA-256 of the art it was measured on.
A godip upgrade that redraws a map makes its plan stale, because a fill value
measured on the old picture may paint something else in the new one. Such a
map is served in godip's own colours with a logged warning, which is how a map
with no plan at all is treated. It is never styled from measurements of a
picture that no longer exists.

**Verified against what it replaced.** Before the pregenerated files were
deleted, the Go applier's output was compared byte for byte with them. Eight
godip maps came out identical (classical in all four styles, North Sea Wars,
Pure, Cold War, Twenty Twenty), and so did 1900 in midnight once the
provenance comment matched. Sail Ho differs only in the attribute order of
four repaired labels. `restyle_test.go` keeps the standing promise, that
element count, ids and geometry are unchanged in the document and in each
locked layer, and it checks the cache for byte stability.

**One consequence worth knowing.** The label repair that `restyle.ts
--fix-labels` applied to sailho's styled output is now baked into
`variants1901/sailho/map.svg` itself. It has to be. The repair is
style-independent and there is no styled file left to hold it. The tools still
write styled SVGs under `tools/restyle/out/styled/`, but those are renderings
for a person to look at, not assets the server reads.

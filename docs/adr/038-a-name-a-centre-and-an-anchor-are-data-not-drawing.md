---
status: accepted
---

# ADR-038 — A name, a centre and an anchor are data, not drawing

**Status:** accepted, r28. Agreed with the map exporter before writing.
Extends ADR-003 and ADR-026. Moves the storage half of ADR-032.

A map SVG carries province geometry. The province name, the supply-centre
glyph and the unit anchor leave the art and become records in
`placements.json`, beside the `brief` position that is already there.

    "dal": {
      "unit": [546.62, 209.58],
      "scale": 1,
      "dislodged": [559.35, 196.85],
      "brief": [563.11, 209.76],
      "label": { "at": [563.11, 171.85], "size": 19.93,
                 "width": 71.4, "height": 14.35, "rot": -62 },
      "centre": [561.4, 180.2],
      "centreRadius": 10.97
    }

`rot` is the label's rotation in degrees, omitted when zero. It is not a
nicety. Classical rotates 73 of its 90 names, Canton 72 of 99, Twenty Twenty
100 of 219. Portugal is set at -62 degrees, running down the coast; drawn flat
at the same anchor it runs across Spain. Twenty bytes a row, and the map is
wrong without it.

`at` is the CENTRE of the name's ink box, across and down. It is not the
baseline. SVG text sits on its baseline, so the board computes
`baseline = at.y + height / 2` and sets `text-anchor: middle`. A reader that
treats `at` as the baseline draws every name half a cap height too high, which
on the record above is 7.2 units, and it looks like a fault in the placement
search rather than a fault in the reading.

The height is in the record rather than derived, although it is the size times
a cap-height fraction. That fraction lives in the exporter, in another
language and another repository, and a constant copied across a boundary
drifts. Six bytes buys the box being stated rather than reconstructed, and the
box is what the whole guarantee is about.

One file, one digest, one thing to keep in step. A name and a three-letter
code are two labels for one province, and both come out of the same placement
search in the same coordinate space. Records are per province, never per
region: a coast has no name and no centre, which is why the table already
omits `brief` on a coast key.

**The reserved width is the whole point.** The placement search gives each
name a box, then keeps the unit marker, the dislodged ring and the code clear
of it. The exporter writes `textLength` with `lengthAdjust="spacing"`, so the
browser draws the string at exactly the width that was reserved. That is what
makes the box on the screen the box the server measured. So a label record
carries three numbers, not two: where it sits, how big it is, and how wide it
is allowed to be, and the board sets `textLength` from the width. A board that
picked its own size or typeface would draw a box nobody measured, and a marker
would sit on a name.

**Two kinds of map, chosen per map.** A map whose names are data draws them
from the records. A map whose names must stay in the art keeps its names
layer. The choice is a flag the exporter sets when it stops drawing the
layers, carried in the style plan as `dataMode`, and it is never inferred from
the records: through the transition a map has records and still draws them.

The flag belongs to the plan because it is a fact about the art, and the plan
is the document that already describes the art. It is not in the descriptor,
because five variants are drawn on classical's art and their descriptors could
then disagree about one file. It is not `names.found` either: that says
whether the art draws names, and six maps have it false while none of them can
be drawn from records.

It cannot choose per province. A province may legitimately carry no label,
because a name whose fitted size falls under the exporter's floor is dropped
in favour of the code, which says the same thing and can be read. A missing
label means "this province draws no name", not "this map uses its art".

**Why a map keeps its art, and it is not the alphabet.** The reserved width is
not script-neutral: the exporter's average glyph advance is 0.55, which is a
mixed-case Latin string in a humanist sans, while a full-width CJK glyph
advances about 1.0. A width computed that way is roughly half what such a name
needs, and `lengthAdjust="spacing"` closes the gap by shrinking the spaces
until the characters overlap. The art already draws those names correctly and
is the only thing that does.

The measured test is not the script either. Five of our maps draw their names
as outlined paths rather than text, so they carry no string at all: Vietnam
War 108 shapes, North Sea Wars 58, Canton 14, Coldwar 9, Sengoku 5,
Gateway West 4. Those are art-mode maps until an importer recovers both the
string and the position.

**The anchors layer goes in the same step as the centres.** `placements.json`
already carries a unit position for every province, so `#province-centers`
duplicates it. It cannot be dropped separately: the supply-centre glyph and
the anchor both use the id `<key>Center`, and the board selects `[id$="Center"]`
across both layers, so a document holding one of each would have the board
read a glyph as an anchor.

**The art wins where it has drawn the glyph.** A map whose SVG carries a
supply-centre layer keeps it, and the board draws nothing. A map without one
takes the position and the radius from the record. This is the same rule as
for names, and it is decided per map by what the art holds.

That is why a drawn ring may never use the id `<key>Center`. ADR-032 already
fixes `sc-<key>` for it. The board matches `[id$="Center"]` to find anchors,
so a ring with that id in a map that also has an anchors layer would be read
as an anchor.

**The glyph carries a radius and a stroke.** `centreRadius` is the radius of
the circle's path. `centreStroke` is the width of its outline, in map units.
The stroke is a line weight and not a fraction of the radius: a fraction makes
a small province's centre a smudge and a large one's a doughnut.

Both are needed because a stroke straddles the path it is drawn on. The ink
reaches `centreRadius + centreStroke / 2`, and that is the circle the names
and the markers were fitted around. An exporter that reserved `2 * radius`
fitted every name to a box half a stroke too small on each side.

**The glyph carries a radius for the same reason a name carries a width.**
The supply-centre glyph is not only drawn, it is an obstacle. The exporter
places the glyphs first, fits every name around them, then places every marker
around both. So the glyph's size is load-bearing, and a board that drew it at
a size of its own choosing would draw an obstacle nobody measured, and a name
could sit on it. The stroke, the fill and the opacity stay godip's. The radius
comes from the record.

**A centre record names the province, not the owner.** The art cannot do this.
It is drawn once, so a home centre captured in 1905 still shows its first
owner's mark. The board knows the true owner from the game state, so drawing
the glyph from data corrects a fault as well as saving bytes. The glyph itself
is godip's: a stroked circle, no fill, black at 0.47 opacity.

**The plan's name kinds change shape.** A style plan records one land-or-sea
verdict per name as a LIST in document order, so position in the list is the
key. With no names layer there is nothing to align to, and it becomes a map
from province key to verdict. The exporter moves its plan version to 2 and
1901 moves the version it refuses on, in one step. `found` keeps its meaning
and nothing more: it says whether the art draws names. In data mode it is
false while the map certainly has names, so it is not the mode flag. The mode
is `dataMode` in the plan, and only that. A map has records before it stops
drawing its layers, so the presence of a record cannot be the mode without
changing every map's picture on a release that changed nothing.

**The name string is not stored twice.** The descriptor already writes
province rows as `[key, longName, supplyCenter]`, so a variant carries every
long name. `names.json` stays as the per-variant override layer only, and the
descriptor wins where both speak.

**`?style=original` keeps its layers.** That route bypasses restyling so the
bytes are the art's own, and ADR-032 promises it stays a faithful copy.
Stripping it would make that untrue. The stripped art is served on the styled
paths only, at the cost of a second cached copy per map.

**Which face a name takes is derived, not stored.** The plan's list of
land-or-sea verdicts dies with the names layer, and the verdict does not move
into the placement table. godip's own graph already knows land from sea, so
the board asks the variant, not a second copy that can drift.

**During the transition the mode is a flag, not an inference.** While the
exporter writes records and still draws the layers, a server that inferred
"has records, therefore hide the layer" would change the picture on a
data-only release. The flag is set when the exporter stops drawing them.

**Four things the entry did not settle, found while building the reader.**
A run's `at` is in unrotated map space, like every other coordinate in the
file. `rot` on the parent label turns the whole block about `label.at`. A run
carries no rotation of its own: a wrapped name is parallel lines of one block,
and letting each line turn separately expresses something no map draws while
making every reader handle it. `label` stays the union box and the obstacle;
`labelRuns` says only how the text is broken up. No fixture exercises it yet.

The glyph's stroke was not in the record and had to be guessed from godip's
ratio, which was wrong by more than a factor of two against a real exporter.
It is now `centreStroke`. Where a record does not state one, the ratio stands
as the fallback.
The typography cannot be resolved to one face on the server, because the style
is a device preference carried in the map URL and not a property of the game,
so all four styles travel together at about a kilobyte. And `?style=original`
keeps its layers only while a map has them: once a map is authored without
them there is no original to be faithful to. The plan answers instead: it
carries `names.typography` beside `names.kinds`, the face, the inks and the
halo the art drew its own names in, measured before the layer was dropped.
`?style=original` on a data-mode map takes that, and falls back to the default
style's faces only where a plan states none.

**Name styling moves to the board, and the two style paths do not collapse.**
Today the server rewrites each `<text>` in the art before sending it, choosing
the face from the plan's land-or-sea verdict for that name. In data mode there
is no names layer to rewrite, so that pass has nothing to work on and a name
the board draws would arrive unstyled.

So three things travel with the board state, and the server resolves them once
rather than the board guessing: the per-province land-or-sea verdict, which is
the plan's `kinds` after this change; the style's name typography, meaning the
face and the two inks; and the halo, a pale stroke under the fill drawn with
`paint-order="stroke"`, without which a name over a coastline cannot be read.
The board already draws its brief codes with a halo through a CSS class, so
the mechanism exists.

This is a move, not a saving. `restyle.go` keeps its two paths for art-mode
maps, and loses only the name pass for data-mode ones. The paths do collapse
eventually, but for a different reason: ADR-039 ends jDip art altogether, and
one of the two kinds stops existing.

**Comparing a record to the art needs a tolerance, and a comparison.** The art
writes one decimal and a record two, so the two disagree by up to half the
art's step. An exact check reports almost every row as broken: 72 of 73
labels, on the first attempt made here.

The tolerance is half the art's rounding step, and it must be applied to a
comparison of two numbers, never to a lookup by formatted string. The two
roundings do not commute. A true 66.6549 becomes 66.7 in the art and 66.65 in
the record, and 66.65 printed to one decimal is 66.6, so a string lookup
misses. That cost a fifth of the rows on the second attempt made here, and it
reads as a missing element rather than as rounding, which is why it is written
down.

**A name broken across lines gets a sibling, not a list.** Sail Ho sets
"Village of / Aeolus" as two elements, 105 elements for 60 provinces, and
Europe 1939, Twenty Twenty, Western World 901 and Youngstown Redux put several
lines on most labels. The exporter never wraps: it shrinks a name until one
line fits and drops it below seven map units in favour of the code. So this is
an imported-map problem only.

`at` does not become a list. That would make every reader handle a list to
serve one case in twenty, and it would confuse two different things: the box
markers were kept clear of, and the runs the text is drawn in. Instead an
optional `labelRuns` sits beside `label`, each run carrying its own anchor,
size, width, height and text. `label` keeps one meaning on every map: the box
the search reserved, which on an imported map is the union of the runs.

A run carries its own text, and that is the one place a name is stored twice.
There is no way round it: the descriptor holds "Village of Aeolus" as one
string and nothing in it says where the break falls, and a line-breaking rule
in the reader would be a second author of the map. So a run's text wins for
DRAWING only. The descriptor still wins for hints, order prose and search.

The other thing the record cannot express is hand-kerning: classical
carries per-label letter-spacing on 30 names, italic on 49 and bold on 28. A
drawn label with one style rule will be legible and flatter.

**Four arts cannot make the crossing at all.** Gateway West, North Sea Wars,
Sengoku and Vietnam War draw their names as outlined shapes carrying no
string. An automatic pass was tried: clustering the glyphs into lines and
matching each to its nearest anchor recovered 39 labels for Vietnam War's 53
provinces, merging some two-word names and splitting others. That is proof the
idea works and proof it cannot ship. Those four keep their layers. So do
Ancient Mediterranean and Unconstitutional, which have never drawn names.

Nothing in the catalogue needs the hybrid for its alphabet. Two arts hold any
non-ASCII at all: one degree sign in Coldwar, five accented letters in
Unconstitutional. Sengoku and Canton spell Japanese and Chinese places in
romaji and pinyin. The test is whether the string exists, not which script it
is in.

**What it saves.** Across the 22 arts we hold, the three layers are 2,498,170
bytes, 27.3%: names 21.8%, centres 2.4%, anchors 3.0%. On a map the
exporter draws they are 61.5%.

The raw figure overstates the win, because responses are gzipped (ADR-036) and
the records are not free. Measured on one 73-territory map: art with every
layer is 36,242 raw and 5,691 gzipped; art with geometry alone is 13,984 raw
and 2,587 gzipped. That is 61.4% raw but 54.5% gzipped, and the label and
centre records add about 6.7 KB raw, roughly 1.3 KB gzipped, to the placement
table. So the net on the wire is about 1.8 KB a board load, not 3.1 KB. Still
worth doing. The saving is much larger for maps made from now on than for the
ones we already have.

Positions in a record are rounded to two decimals, like every other position
in the table, so the file stays diffable and consistent with ADR-037.

**Do not do this for the bytes on the maps we already hold.** Stripping all
four layer kinds across the 22 arts cuts 28.4% raw but only 14.5% gzipped, and
most of that is one map. Measured on three of different kinds: classical loses
12.0% raw and 1.8% gzipped, because a names layer is text that gzip already
crushes while the file's weight is a noise texture that will not compress;
Vietnam War loses 51.4% raw and 40.8% gzipped, because an outlined name is
thousands of unique digits gzip cannot help; Sail Ho barely moves either way. So the
compressed win sits almost entirely in the four maps that cannot be migrated
automatically.

An earlier draft of this entry said moving a short label out of jDip art makes
the payload bigger. That was a formatting artefact, not a property of the
format. Both sides wrote JSON with every array element on its own line, so a
coordinate pair cost four lines. Collapsed, a label pair is 30 bytes against
the jDip element's 38. The tables keep one line per field, so a moved marker
is still a one-line diff, but an array and an innermost object go on one line.
That takes 30.1% off our own placement tables raw, and 4.3% gzipped.

The reasons to do it are that a name in a record can be translated, restyled,
searched and read aloud, and that 61.5% is the figure for every map made from
now on.

**One blocker to clear first.** 1800 Empires and Coalitions carries an empty
long name for all 96 provinces, while its art draws 96 of them. Move that map
to records and it goes blank. Three more descriptors each miss one or three
names. Fix the descriptors before touching the art.

**What breaks outside the board.** The gallery card and the map lightbox draw
the art as a plain image, with no board and no records, so a stripped map
shows there with no names and no centres. There is no mitigation in the
current code. The map editor loses more: it scores marker collisions against
the label and centre layers it reads out of the art, so it would stop
reporting a marker sitting on a name, and it edits a brief position as a point
while a label is a point plus four numbers and needs a different control.

**Order of work.** The exporter writes the records and keeps the layers, which
breaks nothing. Then the server prefers the records where it finds them. Then
the exporter stops writing the layers and the plan version moves. The reader
must be built so a map without records falls back, which is also exactly what
the two-kinds rule needs.

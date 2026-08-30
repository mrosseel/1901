# Face-to-Face Diplomacy Adjudicator — Execution Brief

**Status:** M1 flow live (React SPA + Go, in-memory). M0 sandbox removed.
**Owner:** Mike (Ghent, BE)
**Document revision:** r27 — 2026-08-30
**Audience:** an agent or developer picking this up cold.

---

## 0. How to use and maintain this document

This file is the project's single source of truth until code exists. It is
meant to be edited, not just read.

Rules for whoever works on this:

1. **Bump the revision** at the top (`r1` → `r2`) and add a line to
   §11 Revision Log for every substantive change. One line, dated, what
   changed and why.
2. **Decisions go in §3 with an ID** (`D-001`, `D-002`, …). Never delete a
   decision. If it is reversed, set `Status: superseded by D-0NN` and leave
   the original text and rationale in place. The reasoning behind a
   discarded option is the most expensive thing to reconstruct later.
3. **Open questions go in §4 with an ID** (`Q-001`, …). When one is closed,
   move it to §3 as a decision and mark the question `resolved → D-0NN`.
4. **Do not silently change acceptance criteria** in §8. If a milestone
   turns out to be wrong, revise it explicitly and log it.
5. Facts in §2 were measured directly from the repositories on 2026-08-28.
   If you re-measure and get different numbers, update them and note the
   date — upstream moves.

---

## 1. Goal

A Diplomacy adjudicator built for **face-to-face play at a physical table**,
where each player enters orders on their own phone and a game master runs
the session. Server-side adjudication, browser frontend, no accounts.

The gap this fills (restated r17 after the platform survey,
research/platforms.md): tournament tables today run paper orders plus a
human "sandboxer" typing the game into Backstabbr; diplomacy.mylootcave.com
(July 2026, godip-derived PWA) serves FtF tables but is HOT-SEAT — one
device passed around, a queue that cannot fit a 15-minute tournament
season. avieth/diplomacy-server (2015) described our model and died for
want of a client. The unserved thing, precisely: **seven players entering
orders in parallel, each on their own device**. The pitch: we delete the
sandboxer role. Also confirmed: no platform anywhere does commit-reveal —
D-004 is this project's strongest novel claim (Backstabbr's answer to a
playing GM is stripping GM powers instead).

### Hard requirements

- Server adjudicates; clients never adjudicate.
- A player can never see another player's orders before adjudication.
- A GM can start and administer a game **and play in it**, without that
  giving them an information advantage.
- Works on a LAN with no internet. Tournament venues have bad wifi.
- Join by link or QR code. No accounts, no email, no password.

### Non-goals (v1)

- Online/asynchronous play with long deadlines. That market is served.
  (Long-term direction changed in r6 — see D-018: a hosted multi-game
  service with logins is a post-v1 target. Still out of v1.)
- Press/messaging. People are sitting at a table talking to each other.
  (Narrowed r16 by D-023: a pressMode game setting exists; the
  "fullpress" mode, which implies in-app messaging, is a post-v1 /
  hosted-mode feature.)
- AI players.
- Tournament scoring, ratings, brackets.
- Mobile app stores. It's a PWA.

---

## 2. Prior research — measured facts

Measured 2026-08-28 by cloning the repositories. Re-verify if stale.

### 2.1 jDip (the existing FtF tool)

- Live repo: `gitlab.com/jdip/jdip`, GPLv3, 369 commits, created 2018-10, no
  tags. GitHub mirror used for measurement: `github.com/fsufitch/jdip`
  (last upstream merge 2018-12).
- Website still advertises 1.7.0 Preview 1, June 2005.
- ~79,000 LOC Java. Swing GUI 34,400. Batik SVG rendering 8,500.
  `world` 13,000 (of which 4,267 is variant XML parsing). `order` 9,800.
  `process` 3,375 — the adjudicator proper is `StdAdjudicator.java`, 1,839
  lines.
- F2F mode: `F2FOrderDisplayPanel.java` (734 lines) + `F2FGUIGameSetup.java`
  (104) + hooks in ClientFrame, ClientMenu, PersistenceManager,
  UndoRedoManager. Per-power tabs, hidden orders, submit + review mode.
- 18 variants, 31 SVG maps, 4.5 MB resources.
- DATC corpus: 11,197 lines of test-case text with a JUnit 5 runner.
- Its SVG maps carry a `jdipNS:PROVINCE_DATA` namespace in the internal DTD
  subset, giving explicit x/y for unit, dislodged unit, and supply centre
  **per province**. Measured on the standard map
  (`resource/variants/stdVariants/egdipmap.svg`, 201 KB,
  `viewBox="0 0 1835 1360"`): 82 PROVINCE entries including the six split
  coasts (`stp-nc`, `stp-sc`, `bul-ec`, `bul-sc`, `spa-nc`, `spa-sc`), plus
  `<path id="_stp">`-style province hit paths. Extracting the data is a
  small script (strip the DTD subset, parse `jdipNS:PROVINCE`, map
  `stp-sc` → godip's `stp/sc`). **The coordinates only apply to jDip's own
  art** — they do not transfer to godip's differently drawn maps — so
  jDip's maps are a possible alternative art set (GPL, 10× smaller than
  godip's), not a data source for godip's. The one idea to take
  regardless: a distinct dislodged-unit position per province (godip's
  anchors give a single point; see D-003).
- Modernization blockers if anyone ever wants to revive it: dead `jcenter()`,
  Gradle `compile` config, ~20 Batik import renames (`dom.svg` →
  `anim.dom`), `javax.help` (2 imports), `javax.jnlp` (2 refs), and
  **JSX 2.0.9.6**, a dead XML object-serializer that the entire save format
  depends on (`World.java:88-113`). That last one is the real risk.

**We are not reviving jDip.** It is documented here as the reference
implementation for FtF UX and as a source of ideas, not as a codebase.

### 2.2 godip (chosen engine)

- `github.com/zond/godip`, GPL-3.0, 25,351 LOC across 98 Go files, last push
  2025-11-14. Powers Diplicity / Droidippy.
- 26 variants.
- Test corpus 5,201 lines: `datc_v2.4_06.txt` (3,945), `real.txt` (418
  regressions from actual played games), `dipai.txt` (685),
  `droidippy_errors.txt` (130), `diplicity_errors.txt` (23). The non-DATC
  files are a decade of bugs found by real players — more valuable than DATC
  alone.
- API surface that matters:
  - `State.SetOrders(map[Province]Adjudicator)`
  - `State.Next() error` — adjudicate and advance phase
  - `State.Options(orders []Order, nation Nation) Options` — legal-order
    tree **scoped to one nation**. Drives click-to-order UI without leaking.
  - `State.Corroborate(nation) []Inconsistency` — per-nation missing/illegal
    order warnings, also scoped.
  - `State.Phase()`, `SetUnits`, `SetDislodgeds`, `SetSupplyCenters`,
    `PreviouslyAppliedOrders`, `Load`
- **godip is a library, not a server.** The `gae/` directory is two files and
  only serves a variant listing. Sessions, auth, persistence, deadlines, GM
  roles are all ours to write.

### 2.3 Map assets

- godip ships 119 SVG files. `variants/classical/svg/`:
  - `map.svg` — 2.2 MB Inkscape output, `viewBox="0 0 1524 1357"`, 75
    province paths with 3-letter ids (`tun`, `sev`, `pie`), plus named
    layers (`Albania`, `Constantinople`, `BOT`, `GOL`). Split coasts have
    their own hit paths with ids of the form `stp/sc`, `bul/ec`.
  - Separate `army.svg`, `fleet.svg`, and one flag SVG per power. Composable,
    not baked in. Exactly the shape a web client wants.
  - **Placement anchors exist** (r2 correction; r1 claimed they did not).
    Every province and named coast has a `<path id="<abbr>Center">` marker
    glyph (81 in classical, e.g. `parCenter`, `stp/scCenter`) whose path
    data starts at the unit placement point (`m 411.9,880.2 …`). All 17
    variant maps with an `svg/` dir carry them (measured 2026-08-28:
    classical 81, ancientmediterranean 79, hundred 45, twentytwenty 241,
    pure 7, …). godip's `variants/generator/generate.py` writes them
    (`addCenterPath`). A placement table can therefore be generated from
    the SVGs and only hand-corrected, for every variant.
- **No Diplomacy map is public domain.** The board art is Hasbro's.
- Permissive-ish alternatives, both worse for our purposes:
  - `File:Diplomacy.svg` by Martin Asal on Wikimedia Commons — CC BY-SA 3.0,
    33 KB, drawn for illustration. No usable per-province id/layer
    scaffolding; we'd add it all.
  - `github.com/elespike/diplomacy_maps` — CC BY-SA 4.0, derived from the
    above, but the author states the derivatives are intended for printing
    rather than digital implementations.

### 2.4 Artwork comparison godip vs jDip (r3, rendered 2026-08-28)

Both asset sets rendered to PNG with librsvg and compared side by side.

- **Overlap** — variants with both a godip engine and art on both sides:
  classical, ancient med, hundred, pure. **godip's art wins all four,
  clearly.** godip maps are styled (parchment palette, sea textures,
  province and sea labels, SC markers drawn in). jDip maps render as flat
  fills with no labels: their label layers exist but ship
  `visibility="hidden"` (`FullLabelLayer`, `BriefLabelLayer`) because the
  Swing app toggled them at runtime, and the base art is plain clip-art
  fills.
- **Every godip variant already has art.** The classical-board variants
  without an `svg/` dir (chaos, fleetrome, franceaustria, italygermany)
  return `classical.Asset("svg/map.svg")` in code. There is no godip
  variant that needs a map converted from jDip.
- **jDip-only variants** (map but no godip engine, 11): 1900, aberration,
  asia, imperium, loeb9, milan, modern, octarine, renaissance, rootz,
  sailho. Converting their maps to godip's format (rename `_abc` ids,
  extract PROVINCE_DATA, unhide labels) is a mechanical script — but
  useless alone: the map is the cheap half of a variant. The expensive
  half is the godip engine code, and there jDip's real convertible asset
  is `*_adjacency.xml` — a full typed adjacency graph per variant
  (army/fleet/coast edges, e.g. `<ADJACENCY type="xc" refs="apu ven tri
  bos mac-wc ion"/>`) plus starting positions in `variants.xml`. A
  translator from that XML to a godip variant `.go` file would make
  adding a jDip-only variant mostly mechanical: graph + starts generated,
  special rules and tests hand-written, map converted and restyled.
- Consequence for Q-003: the jDip fallback map is fast (201 KB) but
  markedly uglier; treat it as a performance escape hatch, not an option
  of equal standing.

### 2.5 Other engines considered

| Project | Lang | License | State |
|---|---|---|---|
| zond/godip | Go | GPL-3 | Active, 26 variants, map assets. **Chosen.** |
| TedDriggs/diplomacy | Rust | MIT | Active, DATCv3, library only, no variants/maps |
| diplomacy/diplomacy | Python | — | DATC-compliant + React UI, last push 2024-02 |
| taparkins/pydip | Python | — | Library, simplified civil disorder |
| tckmn/stpsyr | Rust | GPL-3 | Partial DATC |

---

## 3. Decisions

### D-001 — Engine: godip, running server-side
**Status:** accepted, r1
Take `zond/godip` as a vendored Go library. Rationale: 26 variants and 119
map SVGs available immediately; `Options()` and `Corroborate()` are already
nation-scoped, which makes the no-leak property structural rather than
something we enforce by hand; the regression corpus from real games is worth
more than a cleaner API.

Rejected: TedDriggs/diplomacy (Rust, MIT). Better license and type system,
but no variants and no map assets — several months of work we'd be adding to
get back to parity. Revisit only if D-002 (GPL) becomes a blocker.

Rejected: porting jDip's adjudicator to Rust/Zig. ~15–20k LOC of subtle
rules code, 2–4 months to DATC-green, reimplementing what godip already
proved against 5,000 real games. No upside.

### D-002 — License: GPL-3
**Status:** accepted, r1
godip is GPL-3 and its map assets ship with it. The whole project is
therefore GPL-3. This is a consequence of D-001, not an independent choice.
If a permissive license is later required, both D-001 and D-003 must be
reopened together.

### D-003 — Maps: godip's SVGs
**Status:** accepted, r1
Use `variants/*/svg/*.svg` from godip as-is. Province click targets come from
hit-testing the 3-letter path ids. Unit and flag SVGs composited client-side.

Placement (amended r2 — the r1 "no placement metadata" premise was wrong,
see §2.3): generate the offline placement table (one JSON per variant:
province → unit x/y, dislodged x/y, SC x/y) from the `<abbr>Center` anchor
glyphs already present in every godip variant map. Dislodged position =
anchor + fixed offset (jDip's idea), hand-corrected where it lands badly.
No centroid computation needed.

Amended r3 — the anchors alone were not good enough. Measured against the
drawn map, 35 of classical's 81 markers left their own province and 77 covered
a province name; on a coast the anchor put `stp/nc` three map units from
`stp`, where neither reads as anything. `tools/placement` measures the real
geometry in a browser, re-places every marker under an ordered set of rules,
and hands the result to a person to correct by hand. Two of those rules came
back out of that correction pass:

- **Coast legibility.** A coast marker must be tellable from its base
  province and from its sibling coasts — 2.5 marker radii apart — and a base
  province may not stand on one of its own coast strips. It is applied as a
  filter before it is a preference, because a rule ranked below name overlap
  is otherwise defeated by name overlap.
- **Threshold clearance, then centre.** The margin a marker keeps from the
  nearest name or supply centre is not maximised. It is measured off the
  hand-corrected table, and clearing that median earns full credit and
  nothing further; among positions that clear it, the province's pole of
  inaccessibility decides. Centred stays the aesthetic.

File convention, one JSON per variant:

    placements/<key>.json       the approved table; the only one the server reads
    placements/<key>.hand.json  a hand-corrected table, an input to the tool

The server loads `placements/*.json` at startup and exposes the table as
`placements` in seat, GM and public state. The board prefers it over the map's
anchors and falls back per province, not per table, so a table missing one key
leaves that province on its anchor and serves the rest.

Amended r21 — the table gained a third position per province, `brief`, for the
three-letter code the board draws when brief labels are on. Brief mode hides
the full names, so a code is a different placement problem from a marker: the
label boxes that dominate every marker score are not on the board when a code
is drawn. A code is judged on four things instead, in this order.

1. Its middle is inside the province it names. A code in the wrong country
   tells a reader something false, which is worse than no code at all.
2. It is clear of its own marker and of its own dislodged ring.
3. It is clear of the neighbouring provinces' markers. A province is small and
   a marker is not, so the piece a code lands on is as often the neighbour's.
   Separate from its own marker because a neighbour's is only sometimes drawn,
   but next to it, because a marker is opaque either way.
4. It fits wholly inside its own province. Ranked below legibility for the
   same reason marker containment is ranked below name overlap. A province
   narrower than the code naming it still has to be named.
5. It is off the supply centre glyph. Last, and measured into that position:
   ranking the glyph above the neighbours made the search trade "off the dot"
   for "onto a piece" on every crowded map, which is the wrong way round.

Among positions that pass, the one below or beside the province's own marker
wins, so a reader pairs the code with the piece. The first rung of that ladder
is exactly where `renderBriefLabels()` already draws a code.

A position is stored only when it is no worse than the heuristic it would
replace, judged on those five faults in both board states. That test matters
more than it sounds. The heuristic draws the code at the anchor when the
province is empty and below the marker when a unit stands there, and being
able to switch is a real advantage: the anchor is the one spot in a province
that no other province's marker can occupy. On a map whose provinces are
smaller than the codes naming them, no single stored point beats that. Storing
one everywhere on twentytwenty put 95 codes on a marker where the heuristic
put 80; declining the ones that lose brought it back to 82 while keeping the
supply-dot gain, 29 down to 23. So 106 of its 215 provinces store nothing and
the board falls back, per province, exactly as it falls back to map anchors.

A jDip-converted map gets no codes at all: it ships its own `BriefLabelLayer`,
the board shows that layer instead of drawing anything, and those positions
are the map author's work.

The tool's `--brief-only` mode adds the field to an approved table and touches
nothing else in it, because an approved table can hold corrections a person
made by hand and the codes are a later question than the markers were. It
writes the codes as a replacement rather than a merge, so a province the tool
declines loses any code an earlier run left there.

### D-032 — Converted jDip maps are restyled into godip's classical style
**Status:** accepted, r3. Renumbered in r25: this decision and the jDip
translator both carried the id D-016.
A jDip map converted by `tools/jdip-import` is correct and unlovely: flat
`#B5DEF8` water, flat `#F7DB94` land, a black backdrop, and labels written
`font-size:150` — valid in jDip's own renderer, invalid CSS, so every browser
threw the declaration away and drew every name at the 16px default. On sailho,
whose map is 7300 units wide, that is a two-pixel smudge.

`tools/restyle` reads godip's classical map for its visual system — two paper
tones, a hairline border, a diagonal hatch, a paper grain, and Libre
Baskerville set bold for land and italic for water — and applies it to a jDip
map through that map's own semantic classes. It writes `map-<style>.svg`
beside `map.svg` (D-033 made the style itself data); the server serves the
default style, parchment, and the faithful original at `?style=original`.

The restyle may change fills, strokes and text presentation. It may not move a
coordinate, rename an id, or add an element to `#provinces`,
`#province-centers`, `#MapLayer` or the label layers. That is checked, not
promised, and the tool refuses to write a file that fails.

A second pass, opt-in per variant with `--fix-labels`, puts province names
back inside their own provinces: it measures each name against its province
shape, moves and if necessary shrinks the ones that escape, keeps them clear
of the unit and dislodged markers in `placements/<key>.json` by the RULE B
margin, and falls back to jDip's own three-letter brief label where a name
cannot fit at any size. sailho is the pilot; classical's labels wait.

### D-033 — Map styles are named data, chosen per device
**Status:** accepted, r16. Renumbered in r25: this decision and the press
mode both carried the id D-023.
A style is a JSON file in `mapstyles/`, which is where they moved in r18
(D-026) once the server read them too. It says what the two terrain tones are,
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
`map.svg`, and the structural-equality check of D-032 runs on every
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
D-024 built the second applier and every map is now styled. Classical's
blurred coastline is still carried in every style and applied by neither
applier: it needs a single landmass path, and a per-province map would draw it
along every inland border too.

### D-024 — godip's own maps are styled by palette substitution
**Status:** accepted, r17
A jDip conversion is restyled through its classes (D-032). godip's twenty-three
own maps have no classes at all: classical paints its landmass as one path
with `style="fill:#f4d7b5"` over a sea-coloured rect, and the rest do the same
with more paths. `tools/restyle/restyle-godip.ts` styles them by substituting
fill VALUES, which is more fragile than painting by class, so the fragility is
made visible rather than hidden:

- **The palette is not guessed from the tone.** The adjudicator is asked which
  provinces are sea (`GET /variants/<key>/provinces.json`, new), each
  province's own hit shape is sampled against the art in a real renderer, and
  the tone is decided by a vote that has to carry two thirds. A named coast —
  `spa/nc` — votes for nothing: it is sea to the adjudicator and land on the
  map, and counting it lost classical, Cold War and Twenty Twenty their first
  vote. A map that cannot be classified is left in godip's own colours and
  named with the reason in the coverage table; honest partial coverage beats a
  silent hundred per cent.
- **Only what the vote identified is touched.** Black stays black: on these
  maps it is the coastline's drop shadow and the outlines round the names. A
  second land tone is carried rather than flattened — it keeps the lightness
  step it had from the base tone.
- Also restyled: the impassable hatch (the style's pattern replaces the
  insides of the map's, keeping the id, so no reference and no id changes),
  the strength of the paper grain, the province border strokes, and the
  typography of the names layer. A foreground carrying many times more dark
  strokes than the map has provinces is decoration — North Sea Wars draws a
  celtic knot — and is left exactly as drawn.
- Sizes and positions are not touched, and the applier adds no element, so it
  is held to a stricter lock than the jDip one: the layer lock of D-032 widened
  to godip's layer names, and then every drawing element in the document
  compared for tag, id and geometry.

**Where they are served from.** *Superseded by D-026 (r18). The styled files
are gone. A styled map is composed at serve time from the original art and a
style plan.* As written in r17: a godip map is embedded in the dependency and
is not a file in this checkout, so its styled art went to
`styledmaps/<key>/map-<style>.svg`, named by the URL key because there is no
Go package to name it after, and `variants.go` globbed that directory
alongside `variants1901/<package>/`.

The tool is a client, not a library: the maps and the province types come from
a running server (`--server`, default `http://localhost:8195`), because a
running server is the only thing that can hand over art that lives inside the
dependency.

### D-025 — A per-province map has its own ground tone
**Status:** accepted, r17
A style's `terrain.ground` is the tone behind the art, and for classical it is
the sea tone: the art is one landmass over a sea-coloured rect, so anything
showing through IS sea. A converted jDip map is the other shape. Every
province is its own polygon, the polygons do not quite meet, and what shows in
the hairline gaps between them is the ground — which painted the sea tone
turned every inland border, down the middle of a continent, into a channel of
water.

Styles therefore carry a second tone, `terrain.groundInland`: a darkened land,
which reads as a seam rather than as water. It is what the jDip applier paints
the backdrop rect and the root background with; `ground` is unchanged and is
what a single-landmass map still uses. parchment's is derived rather than
typed — classical's own land, twelve per cent darker, by
`extract-parchment.ts` — so the house style stays the file's own.

### D-026 — A styled map is composed at serve time from a style plan
**Status:** accepted, r18. Supersedes the storage half of D-024 and D-032.
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

### D-027 — Deadline humanity: phase multiplier, grace, first turn, anti-rush
**Status:** accepted, r18 (research/platforms.md, steal 8). Extends D-022.
One deadline number is not enough for a real table. Every platform that has
run real games has learned the same four rules, and all four are now settings:
versioned, event-logged, and GM-editable before and after start like every
other setting under D-022.

`retreatBuildPercent` (default 50, Backstabbr's) gives a retreat or build
phase that share of the movement clock. Those phases are not negotiation
phases. Nobody is talking, the orders are forced or nearly so, and a table
waiting the full clock for two disbands is a table doing nothing. The result
is rounded up and never falls below a minute, because a phase with no clock is
a phase nobody can order in.

`graceMinutes` (default 0) keeps taking orders that long after the deadline.
The deadline the clock shows does not move, since a grace period that is
announced is not a grace period. What moves is the moment `canForce` turns
true for the GM.

`firstTurnExtraMinutes` (default 0) is added to the first movement phase only.
Spring 1901 is the one turn where everybody has to talk to everybody.

The **anti-rush rule** is Backstabbr's, copied exactly. A phase that resolves
early with `R` still on the clock, into a next phase of period `T`, gets
`R + T` when `R < T`, and `R` otherwise. Both are at least `T`, so finalizing
early never shortens the next phase for anybody. That is what makes D-008's
auto-advance safe once deadlines are long. A phase the GM forced carries
nothing, because its clock had run out or the GM chose to spend it.

Not taken here, and still worth taking later: the weekend skip, the per-game
timezone, and a wall-clock deadline that does not drift daily. None of them
matters for a table in a room. All of them matter for hosted mode (D-018).

### D-028 — Public, permanent, login-free per-phase URLs
**Status:** accepted, r18 (research/platforms.md, steal 1). Extends D-013.
Backstabbr's most valuable property is not a feature. It is that
`/game/<id>/<year>/<season>` renders the board, the orders and the results to
a signed-out visitor, forever. That is why it owns post-game analysis, why its
links are the community's citation format, and why the tournament pipeline
scrapes it rather than asking for an API.

Our spectator view was already secret-free by D-013, so the data model was
done. What was missing was the URL:

    /watch/{gameId}/                 the page, at the phase being played
    /watch/{gameId}/{phaseIndex}     the page, at one phase of the past
    /game/{id}/watch                 the JSON behind the first
    /game/{id}/watch/{phaseIndex}    the JSON behind the second

A resolved phase shows everything: the position it was played from, every
applied order with the power that gave it, every resolution, what was
dislodged, and the NMR list. All of that is public the moment the phase
resolves, since it is what the players see in their own review. There is
nothing there to leak.

The current phase shows the board, the phase, the deadline, the grace and who
has finalized. It shows no order of any kind. This endpoint carries no token
and cannot know who is asking, so it may never carry a draft.

**Where the history comes from.** Not a table of its own. The snapshots are
built by the same replay that rebuilds a game from its order rows after a
restart (D-011's write-through store). Each phase records what it saw on the
way past, on the live path and on the restore path alike. A historical URL is
therefore a function of the stored orders, which is why it is stable forever
and survives a `kill -9`. That was verified by killing the server and diffing
the JSON before and after. Only the `now` field differed.

Still open, and cheap once wanted: the layout variants D-013 asked for (board
only, board plus move list), and the referee guide of steal 2.

### D-004 — Order secrecy via commit-reveal
**Status:** accepted, r1
Server-side secrecy is only a policy when the GM operates the server, which
is exactly the FtF case (it's the GM's laptop; they can read the SQLite
file). Commit-reveal turns it into a property:

1. Client submits `hash(orders || nonce)`. Server stores the hash only.
2. When all commits are in, or the deadline fires, clients release
   `orders || nonce`.
3. Server verifies each hash, adjudicates, publishes everything at once.

This does not stop a GM reading revealed orders — but reveals are
simultaneous, so there is nothing left to gain. It kills the actual threat:
a playing GM peeking at submitted orders before writing their own.

~50 lines. Non-negotiable if the GM plays.

Fallback if this proves awkward in practice (log it as a revision if you take
it): server rejects the GM's own orders once any other player has submitted.
80% of the benefit, 10% of the code, but it is a policy again.

### D-005 — Auth: signed per-power tokens in the URL
**Status:** accepted, r1
`/g/{gameId}/{powerToken}`. GM screen shows one QR per power; players scan
their seat. Optional one-time claim step binds a token to a device so a
scanned-over-someone's-shoulder code can be detected.

No accounts, no email, no passwords, no login screen. Player replacement =
rotate that power's token and invalidate the old one.

### D-006 — Deployment: single Go binary, embedded assets, SQLite
**Status:** accepted, r1
One static binary with the frontend and map assets embedded. Runs hosted, on
the GM's laptop, or on a Pi. SQLite for state. SSE for phase transitions
(not WebSocket — the traffic is one-directional and low-frequency).

**LAN mode is a first-class target, not a fallback.** mDNS advertisement,
works with all devices on the machine's hotspot, zero internet. This is the
thing Backstabbr structurally cannot do.

### D-007 — GM powers are enumerated and audited
**Status:** accepted, r1
Allowed: start game, choose variant, set/extend deadline, generate and
regenerate invites, force adjudication, pause, replace a player, edit board
state.

Forbidden at the API level (no endpoint exists): read unsubmitted or
uncommitted orders, edit another player's orders.

Constraints: force-adjudication is gated — only after the deadline has
passed, or when all but one power has submitted. Board-state editing is
allowed because tables make physical mistakes, but it is logged loudly.

Every GM action appends to a public, append-only event log visible to all
players in-game. The audit trail is what makes a playing GM socially
acceptable; it is a feature, not compliance theatre.

### D-008 — Turn advance is automatic by default
**Status:** accepted, r1
Adjudicate as soon as all powers have revealed. The deadline is a fallback
for an AFK player, not the primary mechanism. At a table, everyone finishing
early is the common case.

### D-009 — Reveal is automatic; failure to reveal is civil disorder after a grace period
**Status:** accepted, r2
Closes the gap between D-004 and D-008: the server holds only a hash, so a
committed power whose client dies could stall the table forever.

1. The client keeps `orders || nonce` in localStorage. It reveals
   automatically — no player action — the moment the reveal window opens
   (all commits in, or deadline passed). SSE reconnect re-triggers the
   reveal check, so waking a locked phone is enough to unstick it.
2. If a committed power has not revealed shortly after the reveal window
   opens, the seat is flagged to the GM and the whole table
   ("committed but not revealed" in the event log). No timer resolves
   anything. The GM chooses: wait or extend the deadline (dead phone,
   player stepped out — D-007 already allows extend), or force resolution,
   in which case that power is adjudicated with no orders (civil disorder)
   and the event log records it.

At a table the social fix ("unlock your phone") resolves almost every case.
The GM decision path exists so the state machine has a defined terminal
state without a timer racing a human — same philosophy as D-010.

### D-010 — Deadlines arm the GM; they never auto-fire
**Status:** accepted, r2
A deadline passing changes nothing by itself. It unlocks the GM's
force-adjudication action (the gate already defined in D-007). When the GM
forces, a power with no commit is adjudicated with no orders (units hold)
and the event log records an NMR for that seat — the same terminal state as
D-009's grace path.

Rationale: at a physical table the late player is usually still negotiating
and the GM is by definition present. Silent auto-resolution mid-conversation
is a hosted-play instinct, not a table instinct. This also keeps a single
resolution path: all-revealed auto-advance (D-008) or GM force — never a
timer racing the GM.

### D-011 — Commit is a replaceable finalize
**Status:** accepted, r2
A re-commit replaces the seat's previous hash until the reveal window
opens; the server keeps only the latest hash per seat per phase, and the
event log records each re-commit without content. There is no draft state
on the server — drafts live only in the client.

Commit means finalize: the moment the last power commits, the reveal window
opens (D-008) and auto-reveal fires (D-009). The UI must label the action
accordingly ("Finalize orders — the turn resolves when all powers have
finalized"), because the last committer ends editing for the whole table.

### D-012 — Hard seat claim in v1
**Status:** accepted, r2. Amended r27 by D-034: a handoff no longer needs
the GM.
Upgrades D-005's "optional" claim to mandatory. The first device to open a
seat link claims the seat: the server issues a random device secret that
the client stores and presents thereafter. Any other device opening the
same link is blocked with "seat already claimed" and the attempt is logged
to the event log — a shoulder-surfed QR announces itself.

Moving a seat to a new device (dead phone, swapped handset) goes through
the GM: rotate the seat token (D-007 player replacement), player rescans
and re-enters orders. Rationale: D-009 makes the device load-bearing
(drafts and unrevealed orders live in its localStorage), so two devices
holding one seat with divergent state is exactly what commit-reveal cannot
tolerate.

### D-013 — The GM view is secret-free and safe for a shared screen
**Status:** accepted, r2. Extended r18 by D-028 (public per-phase URLs).
The GM view may show who has committed or revealed, the deadline, the audit
feed, and admin controls — never order content and never any power's
`Options()` output. Invite QRs appear only in a pre-game seating screen and
are hidden once a seat is claimed (a lingering QR invites seat hijack).

Consequences: the GM can run the game from a laptop the whole table can
see while playing from their own phone seat, and the spectator/projector
view (Q-005) is this view minus the admin controls — no extra data model
work. This resolves Q-005's "do not make it hard" constraint.

Addition (r8): the spectator view gets layout variants chosen
in the URL — board only; board + move list (previous phase's orders and
resolutions); later possibly board + SC count. Same data, different
composition; still zero secret content. Post-v1 unless a playtest wants
it sooner.

### D-014 — v1 ships classical as supported, all other variants behind an experimental flag
**Status:** accepted, r2 (closes Q-006)
The placement-table generator (D-003) runs over all godip variants with an
`svg/` dir (17 as of 2026-08-28). Classical is hand-checked, playtested,
and presented as supported. The rest are selectable at game creation.
UI presentation (changed r15, owner call): supported variants show a
green checkmark; unverified ones show nothing — no experimental badge or
warning text. The supported flag itself remains in the API and still
gates the checkmark. Promoting a
variant to supported is data work only: check its generated table, remove
the flag.

### D-015 — Working name: "1901"
**Status:** accepted, r2 (closes Q-001)
The opening year of the classical game: instantly legible to Diplomacy
players, contains no Hasbro mark, works as a binary name and a domain
(e.g. spring1901.app). Revisit only if a collision search before going
public turns something up. The Realpolitik-style disclaimers from §8 still
apply regardless of name.

### D-017 — Frontend: React + Vite, with the map as an imperative DOM island
**Status:** accepted, r5 (closes Q-002). Amended r12: applies from M1, not
M2 — the M1 flow pages are exactly the component-heavy chrome React was
chosen for, and building them twice (vanilla, then ported) buys nothing.
TypeScript. The M0 sandbox at /g/{id}/ stays vanilla until the React seat
board fully replaces it. Only the board core moves from static/app.js into
the island module — everything it learned (gestures, graphics, integration
fixes) carries over.
React with Vite for dev server/HMR and production build; build output is
embedded in the Go binary per D-006. Owner preference: familiarity,
component ecosystem, and the amount of chrome UI ahead (order panels, seat
views, GM view, audit feed).

Non-negotiable constraint that answers Q-002's performance worry: the map
SVG never enters the React tree. It is injected once into a ref'd
container and driven imperatively — unit overlay, highlight classes, and
viewBox pan/zoom by direct DOM manipulation, as the M0 spike does. React
renders around the map, not through it. If this rule is ever broken,
Q-002's VDOM-overhead concern returns with it.

Considered: Svelte and SolidJS — equally capable here and equally served
by Vite; rejected on familiarity, not on merit. Note autoreload was no
tiebreaker: Vite HMR works for all three.

### D-018 — Long-term: one binary, two deployment modes (LAN and hosted multi-game)
**Status:** accepted, r6. Direction-setting; nothing in M0–M5 is reordered.
The same Go binary must eventually serve two modes:

1. **LAN mode** — what v1 ships: a GM downloads one binary, runs it on a
   laptop, hosts one table's game offline (D-006). This stays the primary
   deployment and must never require the hosted features.
2. **Hosted mode** — a long-running internet instance with many concurrent
   games and user accounts.

What this changes *now* (cheap if done early, expensive to retrofit):

- Every table, endpoint, and in-memory structure is keyed by game id from
  M1 onward — no single-game assumptions anywhere. The §6 data model
  already complies.
- Auth is layered, not replaced: seat tokens (D-005) remain the only
  thing needed to *play*, in both modes. Accounts, when they come, attach
  to game management — creating games, claiming the GM role, listing your
  games — never to seat play. "No accounts" in §1 is thereby narrowed
  from a product-wide rule to a per-seat rule; the hard requirement that
  a player joins by QR with no login is untouched.
- SQLite stays until hosted-mode load proves it insufficient; the storage
  layer should not grow features that only make sense for one mode.

What this explicitly does not change: no account system, lobby, or
multi-tenancy work before M5 is accepted. Hosted mode gets its own
milestones after v1 ships.

### D-023 — Press mode is a game setting: ftf, gunboat, fullpress
**Status:** accepted, r16
The GM chooses the press mode at creation, shown to players on the join
page as part of the rules (D-022):

- **ftf** (default): negotiation is verbal at the table; the app carries
  no messages. Identity is social.
- **gunboat**: no negotiation. App-identical to ftf today, but declared —
  and seat anonymity (D-020) is load-bearing rather than incidental.
- **fullpress**: in-app messaging between powers. Post-v1 (hosted-mode
  territory, D-018); selectable in the UI only when implemented — until
  then visible but disabled with a "later" note, so the model is
  established in data now.
- **rulebook** (added r18): press during movement phases, none during
  retreat and build. This is webDiplomacy's fourth mode, and it says this is
  how face-to-face Diplomacy is played. Backstabbr defaults to the same
  behaviour (research/platforms.md, steal 7). It is outside evidence for
  Q-004, that retreat and build phases are not negotiation phases and should
  not make the whole table wait.

Immutable after start, like gmPlays.

**Implementation (r18).** Data only. `settings.pressMode` is accepted at
creation and by the GM before start, validated against the four names,
event-logged, persisted in `game.press_mode` and returned in the GM, seat and
public views. No behaviour is attached to it, and the app carries no messages
in any mode.

### D-029 — Illegal orders are allowed, and on by default
**Status:** accepted, r19 (closes Q-007)
Players may enter orders the engine knows are illegal — bluffing by
"misordering" is part of Diplomacy (Backstabbr allows it deliberately;
WDC reads sloppy paper orders leniently; the one field complaint about
the hot-seat competitor was the lack of it). A game setting
`illegalMoves`, DEFAULT ON for every press mode, controls it.

Semantics: an illegal order is stored and shown as the player's written
order; at adjudication it is excluded from the engine's order set, the
unit holds, and the review shows the order struck through as "illegal —
unit held" (the WDC misorder outcome). Entry UX: legal targets stay
highlighted, but with the setting on, taps outside the highlights are
accepted rather than refused; the tap grammar remains the guide, not a
cage. Turning the setting off restores strict legal-only entry.

### D-030 — In-app map editor at /mapeditor
**Status:** implemented, r22 (accepted r20).
The placement editor graduates from generated standalone HTML files into
an app route: pick a variant, drag unit / dislodged / brief-code markers
with live violation feedback (the audit geometry), edit province display
names, and export the result — a placements/{key}.json plus a
per-variant name-override file layered over godip's ProvinceLongNames.
On a dev server the editor may save directly; production builds carry
the route read-only or not at all (decide at build time). This screen is
also the verification act behind D-014: a variant whose table was
reviewed here is promotable to supported.

Convergence goal: the optimizer gets good enough that no human touches
it. Every hand drag is treated as a scoring bug — diff the hand position
against the optimizer's, name the rule that would have produced the hand
one, encode it (the Gascony → lexicographic and clearance-threshold
history is the pattern). When the audit reports zero violations, the
variant auto-promotes; the editor's end state is an audit viewer whose
drag count is zero.

**Implementation (r22).** The route is `/mapeditor` in every build: a
variant picker, the board island mounted with an invented unit in every
province, and a handle layer in map units so pan and zoom carry the grab
targets along. The three fields are draggable per province and the
violation list resorts under the finger.

Scoring is shared code, not a second copy. The browser-free half of
tools/placement moved into tools/placement/rules.ts, and the web app
imports it and geometry.ts directly. The DOM half could not follow:
browser.ts asks its questions inside page.evaluate, which cannot see an
imported module, so web/src/mapeditor/measure.ts re-measures the map on
an off-screen copy. Both halves now take terrain from
/variants/{key}/provinces.json. The editor did from the start. The tool
guessed it from fill colours until r24, and the guess was worthless:
measureMap hides every layer before the probe runs, so the probe read
the map's background and called almost every land province sea. All 26
variants were affected, 164 provinces on twentytwenty alone. With no
land anywhere the coast rule could not fire, and the audit passed
markers the editor was already flagging: ank, bod and bul on
twentytwenty, bul/ec and bul/sc on classical. classifyTerrain is gone.
cli.ts fetches the endpoint and threads one TerrainKind through place()
and every audit, so the tool and the editor cannot disagree about a
coast. godip's "coast" is land a fleet may also sit on, and every map
paints it as land, so that is what the tool calls it. Re-derivation
under real terrain took containment faults across the 24 generated
tables from 93 to 10, and dislodged markers outside their province from
71 to 1. Classical was not re-derived; its bul/ec and bul/sc entries
were corrected on their own.

Three variant-level endpoints carry it, all reachable without a game:
/variants/{key}/placement.json, /names.json and the existing
/provinces.json. Display names are godip's ProvinceLongNames with a
per-variant names/{key}.json layered over them, read at startup like
the placement tables.

Export is a download or a clipboard copy of the amended table, written
exactly as tools/placement writes it, so a session that moved nothing
produces no diff. The drag log and the name overrides go with it. On a
server built with `-tags mapeditordev` the editor may also save straight
to disk, into placements/{key}.hand.json, names/{key}.json and
mapeditor/{key}.drags.json. The amended table lands in the .hand file
the server never loads, so a save cannot put a half-finished table on a
board. An ordinary build has no such route, and the save button is
behind import.meta.env.DEV as well.

Where it stands: pure reports zero violations today. Classical reports
145, of which 79 are the name and glyph overlaps the audit already
counts. twentytwenty reports 1336.

### D-031 — Pan/zoom stays hand-rolled; Leaflet rejected, its math taken
**Status:** accepted, r23 (closes the Leaflet spike).
The spike proved Leaflet integrates cleanly with the island — taps reach
our province hit-paths through its panes, doubleClickZoom off reclaims
double-tap-hold, D-017 is untouched — and still loses on cost. 46 KB
gzipped replaces about 460 lines that work and carry their own tests
(the gesture layer is ~10% of board.ts), and Leaflet sizes the SVG
element to the zoomed map instead of the viewport, a 17k-px layout box
at 30x on a 2 MB map — a phone-performance risk our viewBox arithmetic
does not have.

What the spike prescribes instead, all in our own gesture code:
1. Wheel deltaMode normalisation — board.ts and MapLightbox read
   event.deltaY raw, so Firefox line-mode wheels (deltaY ~3 per notch)
   zoom at 1.0045x per notch: wheel zoom is effectively dead there.
2. Pan inertia — velocity from the last pointermove samples, decayed
   over ~250 ms (Leaflet's Draggable._onUp math).
3. Eased double-tap zoom — a ~200 ms ramp through zoomedView instead of
   the instant 1.8x jump.
4. Wheel debounce — accumulate deltas ~40 ms and apply one step;
   trackpads emit dozens of events and each runs a full render today.

### D-020 — One shared invite; random seat assignment; anonymous seats
**Status:** accepted, r11. Amends D-005's per-power QR model.
The GM shares ONE invite link/QR. Claiming it assigns a random
still-unassigned Power, transactionally (no double assignment under
concurrent scans). A device that claims again gets its existing seat back,
so re-scanning cannot re-roll; changing seats requires GM token rotation
(D-012). Seats carry no player name — the server never learns who is who.
At a face-to-face table identity is social anyway; for gunboat play the
app must not leak it. A later setting may add open identities; the default
is anonymous.

### D-021 — The GM's power is the leftover, revealed at start
**Status:** accepted, r11
When the GM plays, joiners are assigned from the pool at random and the
GM's Power is whatever remains when the GM presses Start — revealed to the
GM only then. The GM never draws from the pool, so there is nothing to
re-roll by refreshing. A `gmPlays` game setting covers the GM-only case
(all powers go to joiners).

### D-034 — A seat moves by handoff, and its holder may start one
**Status:** accepted, r27. Amends D-012. Not implemented.
D-012 sends every device change through the GM. A table does not work that
way. A phone dies, a player leaves at midnight and hands their power to
somebody else, two people share one handset. The seat has to move without
the GM being the bottleneck.

**Who may start a handoff.** The seat's own holder, from the game view, and
the GM for any power. The player case is the common one and it costs the GM
nothing. The GM case is for a power that cannot act: the phone is off, the
player is gone, the seat was never claimed. That is D-007's player
replacement, kept and widened.

Giving a seat away is not a privilege the app can protect. Whoever holds the
phone can already play the power. The handoff only makes the transfer
survive the phone.

**Where it lives.** A person icon in the game view opens what the server
knows about this seat: the power name, the finalize state, the phase count.
It also holds "Show replacement URL", which draws a QR another phone scans.
The power name is the only identity shown, so D-020 is untouched. The server
still never learns who is who.

**One-shot.** Scanning the replacement URL clears the old device claim,
issues a new seat token, and binds the scanning device. The old phone is
logged out at that moment, and the old URL is dead. This is the point of the
mechanism: two devices holding one seat with divergent local state is what
commit-reveal cannot tolerate (D-012's rationale, unchanged). Showing the QR
does not yet move anything, so a GM who displays one and thinks better of it
can cancel.

**Tokens.** A seat token is `HMAC(serverSalt, gameID | power | role | epoch)`,
with `role` separating the seat from the GM rights and `epoch` a counter the
seat carries. Bump the epoch and every URL issued before it stops verifying,
which is what makes a handoff one-shot and a rotation cheap. The server
stores a small integer per seat rather than a list of live tokens.

Public and private keys were considered and rejected. The phone verifies
nothing; it presents a bearer string and the server checks it. That is D-005,
and HMAC is the whole of what it needs. A derivation without the epoch was
rejected for the same reason it looked attractive: it is deterministic, so
the same URL comes back forever and nothing can be revoked.

**The GM has two URLs.** The GM's power and the GM rights are separate
handoffs, because they are separate things to give away. The GM can hand the
referee role to somebody else and keep playing, hand the power away and keep
refereeing, or move either to a second device. This also answers the laptop
and phone case: the GM creates the game on a laptop and moves the power to a
phone, with the referee view left where it is.

### D-022 — Game settings before invite; changes after join are broadcast
**Status:** accepted, r11
The GM fixes settings (deadline length, gmPlays, future: variant,
identity mode) when creating the game, before invites go out, so joiners
see the rules up front. The GM may change settings later; every change
bumps a settings version and all seats are notified ("rules changed")
with the diff. Every change lands in the event log (D-007).

### D-019 — Touch order grammar
**Status:** accepted, r7. Refine from playtest; log changes here.
The phone UI's order entry follows a tap grammar rather than menus:

- **Tap your unit, tap an empty highlighted province** → Move. Two taps.
- **Double-tap your unit** → Hold. (Double-tap on empty map/sea zooms.)
- **Tap your unit, tap an occupied highlighted province** → genuinely
  ambiguous (attack it or support it), so a small chip anchored at the
  finger offers **Attack / Support**; when only one is legal, no chip.
  Support → the helped unit's destinations highlight; tap one for
  support-move, tap the unit again for support-hold. The grammar reads
  as speech: "I help him go there."
- A bottom bar always shows every order type from the godip options tree
  as buttons — the fallback and the path for order types with no
  gesture (Convoy today; retreats and builds later). The chip is built
  as a reusable anchored menu so Convoy and phase-specific actions can
  join it.

Rejected: long-press = support (undiscoverable, ~500 ms per order,
conflicts with pan) and arrow-dragging (paper metaphor, but drag already
means pan at phone precision). Long-press may return later as a shortcut
for the chip, not as the primary path.

Additions from testing (r9): highlight colors carry the grammar — green =
move target, amber = occupied (tap asks attack/support), pulsing blue =
the unit being supported (tap it again = back its hold). Every stage
shows a hint naming unit and province. Order list rows have Change and
Cancel; the server cancels an order on POST with empty parts.

Known debt: the frontend holds a PROVINCE_NAMES table (variant data in
the client). At M2 the server should serve names per variant from godip's
ProvinceLongNames instead.

### D-016 — New variants come via a jDip adjacency-XML translator, not by hand
**Status:** accepted, r4. Post-v1; nothing in M0–M5 depends on it.
When a variant that godip lacks is wanted (1900, Modern, Renaissance, …),
the route is a one-shot translator from jDip's variant data to a godip
variant package, not a hand-written port. Per variant, jDip ships:

- `*_adjacency.xml` — the full typed adjacency graph: one `PROVINCE` per
  province with `ADJACENCY` edges typed for army/fleet/coast movement
  (e.g. `<ADJACENCY type="xc" refs="apu ven tri bos mac-wc ion"/>`).
- `variants.xml` — starting units, supply centres, powers, victory
  conditions.
- A map SVG with `_abc` hit paths and `jdipNS:PROVINCE_DATA` placement
  coordinates (§2.1).

The translator generates the mechanical 80% of a godip variant: the graph
(`graph.go`-style edge declarations), starting positions, SC ownership,
and nation list, plus a converted map (ids renamed to godip's scheme,
`stp-sc` → `stp/sc`, label layers unhidden, placement table emitted).
Hand work remains for what XML cannot express: variant-specific rules,
phase oddities, and a DATC-style test file per variant. Restyling the flat
jDip art to godip's visual standard (§2.4) is a separate, optional effort.

Scope guard: build the translator the first time a concrete variant is
actually wanted, not speculatively. *Activated r14:* pilot variants are
**1900** (few special rules, popular) and **Sail Ho** (owner favorite).
Sources copied into `tools/jdip-import/source/`. Phase 1: translator +
map conversion (ids, labels, Center anchors generated from
PROVINCE_DATA) + registration as experimental variants. Phase 2:
LLM-assisted restyle to godip's visual style — deterministic script for
palette/pattern injection, vision model (via OpenRouter) for shape
classification and before/after QA; needs an OpenRouter key. Rejected alternative: porting variants
by hand from rulebooks — retypes an adjacency graph that already exists in
machine-readable form, and typos in adjacency data are exactly the bugs
that surface mid-game at a table.

---

## 4. Open questions

- **Q-001 — Name.** *resolved → D-015.* Working name "1901". The
  Realpolitik precedent (ship free, "you must own a copy", no Hasbro art)
  is recorded in §8 and stands.
- **Q-002 — Frontend framework.** *resolved → D-017.* React + Vite, map
  kept out of the React tree as an imperative DOM island.
- **Q-003 — Does the 2.2 MB classical `map.svg` perform acceptably on a
  mid-range Android phone?** Unknown. If not: strip Inkscape metadata,
  simplify paths, or pre-render a raster base layer with SVG only for the
  interactive province hulls. **Test this in M0** — it can invalidate the
  whole frontend approach and it costs an hour to check. A measured
  fallback now exists (r2): jDip's `egdipmap.svg` is 201 KB with its own
  hit paths and full placement data (§2.1) — swapping art, not
  architecture.
  *M0 phone finding (2026-08-28):* the full map loads and renders on a
  phone over LAN; no raster fallback needed so far. The blocker is not
  performance but scale — at screen width the provinces are untappable,
  so pan/zoom (viewBox manipulation, pinch + drag) is a hard requirement
  for the phone UI, not a nice-to-have. Perf verdict stays open until
  tested zoomed-in on a mid-range device.
- **Q-004 — Retreat and build phases in the FtF flow.** These are fast and
  often only involve one or two powers. Does the whole table wait on
  commit-reveal, or do these phases run in the open? Decide from playtest,
  not from theory.
- **Q-005 — Spectator view.** *resolved → D-013.* The spectator view is the
  GM view minus admin controls; still out of scope for v1 as a shipped
  feature.
- **Q-006 — Which variants ship in v1?** *resolved → D-014.* Classical
  supported; all other generated variants behind an experimental flag.
- **Q-007 — Illegal and bluff orders (r17).** *resolved → D-029.* The tap grammar builds from
  godip's Options() and cannot express an illegal order. Backstabbr
  allows illegal orders deliberately (bluffing is part of the game), WDC
  house rules mandate lenient interpretation, and the main field
  complaint about mylootcave was exactly this. Decide whether (and how)
  a player can enter an order the engine will fail. Evidence in
  research/platforms.md.

---

## 5. Architecture

```
┌─ Go binary ────────────────────────────────────────────┐
│                                                        │
│  HTTP/SSE handlers                                     │
│    ├─ /g/{game}/{token}       player view              │
│    ├─ /g/{game}/gm/{token}    GM view                  │
│    ├─ /api/…                  JSON                     │
│    └─ /events/{game}          SSE, phase transitions   │
│                                                        │
│  Session layer      ← ours: games, seats, tokens,      │
│                       deadlines, commit-reveal, audit  │
│                                                        │
│  godip (vendored)   ← adjudication only                │
│                                                        │
│  SQLite             ← state + event log                │
│                                                        │
│  embed.FS           ← frontend + map SVGs + placement  │
└────────────────────────────────────────────────────────┘
```

Frontend responsibilities: render `map.svg`, overlay units from the
placement table, build orders from `Options()`, commit, reveal, re-render on
SSE. It never adjudicates and never receives another power's pending orders.

### Endpoint discipline

The no-leak property must be enforced by *which endpoints exist*, not by
filtering inside a handler. There should be no code path that can return
another power's uncommitted or unrevealed orders, so that a future bug in
authorization logic cannot leak them.

---

## 6. Data model sketch

Deliberately thin. Refine in M1, log the result as a revision.

- `game` — id, variant, phase, created, deadline policy, gm_seat_id (nullable
  if GM does not play), state blob (godip serialization)
- `seat` — id, game_id, nation, token_hash, claimed_at, device_fingerprint
- `commit` — game_id, phase_ordinal, seat_id, hash, committed_at
- `reveal` — game_id, phase_ordinal, seat_id, orders_json, nonce, revealed_at
- `event` — game_id, seq, actor_seat_id, kind, payload, at. Append-only.
  Every GM action and every phase transition lands here. This table is the
  audit log from D-007 and should never be updated or deleted from.

---

## 7. Milestones

Each milestone has an acceptance criterion. Do not proceed to the next until
it is met. If a criterion turns out to be wrong, revise it in this document
first (see §0.4).

### M0 — Spike: prove the interaction loop *(target: one weekend)*
godip behind a trivial HTTP wrapper. One hardcoded classical game. No auth,
no persistence, no GM, no commit-reveal. Serve `map.svg`, click a province,
build an order from `Options()`, POST it, adjudicate, re-render.

**Accept when:** a full Spring 1901 movement phase can be played through the
browser for all seven powers from one screen, and Q-003 has an answer.

This milestone exists to derisk the frontend, which is where the real effort
is. Do not skip it and do not gold-plate it.

### M1 — Sessions, seats, tokens
SQLite persistence. Game creation. Per-power tokens (D-005). QR generation.
Player view restricted to their own power. Event log table.

**Accept when:** seven phones can join one game by scanning codes and each
sees only their own orders, and killing and restarting the server loses
nothing.

### M2 — Real map rendering
Placement tables (D-003). Units, dislodged units, supply centre ownership,
retreat and build phases rendered correctly. Frontend framework chosen
(Q-002).

**Accept when:** a full game runs to a solo or draw with correct rendering at
every phase, including retreats and builds.

### M3 — Commit-reveal
D-004. Deadline handling. Auto-advance (D-008).

**Accept when:** an observer with full read access to the SQLite file cannot
learn any power's orders before the reveal, verified by inspecting the
database mid-phase.

### M4 — GM mode
D-007. GM view, enumerated actions, gated force-adjudication, player
replacement, public audit feed. GM plays a power.

**Accept when:** a GM who is also a player can run a complete game, and the
audit feed shows every administrative action they took.

### M5 — LAN packaging
Single binary, embedded assets, mDNS, hotspot mode. Offline start-to-finish.

**Accept when:** a game runs end to end on a laptop with networking to the
internet physically disabled.

### Then
Playtest at a table with real players before adding anything. Q-004 and
Q-006 should be answered by that playtest, not before it. Timing
acceptance (r17, from tournament reality): seven seats finalize a
movement phase in under 3 minutes.

---

## 8. Licensing and trademark summary

- Project is GPL-3 (D-002), inherited from godip and its assets.
- "Diplomacy" is a Hasbro / Avalon Hill registered trademark. Do not use it
  as the product name (Q-001).
- Do not reproduce Hasbro's printed board art. godip's community-drawn SVGs
  are what we ship.
- Follow the Realpolitik precedent: distribute free, state that the user must
  own a copy of the game, note that the rules are Hasbro's copyright.
- Attribution: godip (Martin Bruse / zond) and the individual variant map
  authors must be credited in-app and in the repo.

---

## 9. Things not to do

Recorded so nobody re-derives them.

- Do not write a new adjudicator. Three DATC-compliant ones already exist.
- Do not port jDip. The GUI is 34k lines of Swing that cannot port; the
  engine port duplicates godip; the save format depends on a dead library.
- Do not adjudicate client-side, even partially, even "just for preview".
  `Options()` gives legal moves without exposing resolution.
- Do not add accounts. The token-in-URL model is the product, not a shortcut.
- Do not build press/messaging. The players are in the same room.
- Do not make LAN mode a compile flag or a later port. It is the primary
  deployment.

---

## 10. Reference links

- godip — https://github.com/zond/godip
- godip-influence — https://github.com/Wulfheart/godip-influence — computes
  per-province influence (webDiplomacy-style territory control) on top of
  godip. EUPL-1.2 (GPLv3-compatible). Tiny and dormant; candidate for the
  board/spectator province-shading feature — vendor or reimplement.
- jDip (live repo) — https://gitlab.com/jdip/jdip
- jDip site / DATC compliance notes — https://jdip.gitlab.io/
- TedDriggs/diplomacy (Rust, MIT fallback) — https://github.com/TedDriggs/diplomacy
- diplomacy/diplomacy (Python, DATC + React) — https://github.com/diplomacy/diplomacy
- Martin Asal's CC BY-SA map — https://commons.wikimedia.org/wiki/File:Diplomacy.svg
- elespike/diplomacy_maps (CC BY-SA 4.0, print-oriented) — https://github.com/elespike/diplomacy_maps

---

## 11. Revision log

| Rev | Date | Change |
|---|---|---|
| r1 | 2026-08-28 | Initial brief. Research on jDip, godip, alternative engines and map licensing completed and recorded in §2. Decisions D-001 through D-008 taken. Q-001 through Q-006 open. No code written. |
| r2 | 2026-08-28 | Grilling session. D-009: auto-reveal from client localStorage, civil disorder after grace period — closes the committed-but-never-revealed stall between D-004 and D-008. D-010: deadlines arm the GM's force-adjudication and never auto-fire; forced no-commit powers hold, logged as NMR. D-009 amended: failed reveal flags the GM (wait/extend/force), no automatic civil-disorder timer. D-011: commit is a replaceable finalize; last hash wins, no server-side drafts. D-012: hard seat claim in v1; second device blocked and logged, seat moves via GM token rotation. D-013: GM view is secret-free and safe for a shared screen; resolves Q-005. Fact correction in §2.3: godip maps carry `<abbr>Center` placement anchors in all 17 SVG variants; D-003 amended to generate the placement table from them. §2.1: jDip's `egdipmap.svg` PROVINCE_DATA measured; usable only with jDip's own art. D-014: classical supported in v1, other variants behind an experimental flag; closes Q-006. Q-003 gains jDip's 201 KB map as a measured art fallback. D-015: working name "1901"; closes Q-001. |
| r3 | 2026-08-28 | Artwork deliberation recorded as §2.4: godip art beats jDip on all 4 overlapping variants; every godip variant already has art; jDip-only variants need engines, not maps — their `*_adjacency.xml` is the convertible asset. §2.5 renumbered from 2.4. |
| r4 | 2026-08-28 | D-016: jDip-only variants are added via a generated translation of jDip's adjacency XML + variants.xml into a godip variant package; translator built on first concrete need, post-v1. |
| r5 | 2026-08-28 | D-017: React + Vite from M2 with the map as an imperative DOM island; closes Q-002. Q-003 gains the M0 phone finding: renders fine over LAN, pan/zoom is a hard requirement. |
| r6 | 2026-08-28 | D-018: long-term target is one binary with two modes — LAN (primary, unchanged) and hosted multi-game with accounts for game management only; seat play stays login-free in both. Non-goals updated to point at it. |
| r7 | 2026-08-28 | D-019: touch order grammar — two-tap move, double-tap hold, attack/support chip on occupied targets, bottom-bar fallback. From phone testing of the M0 spike. |
| r8 | 2026-08-28 | D-013 addition: beamer view gets URL-chosen layout variants (board only, board + move list, …). M1 direction started in code: /g/{id} lazily-created games in the spike. |
| r9 | 2026-08-28 | D-019 additions: highlight color grammar (green/amber/pulsing blue), staged hints, order Change/Cancel; server-side order cancellation. Debt noted: province names table in the client, move server-side at M2. |
| r10 | 2026-08-28 | Terminology session; CONTEXT.md created (Power/Seat/Player, Finalize/Commit/Reveal, Spectator view + Annotation, NMR, Adjudicate/Resolution). D-013's "beamer" renamed spectator view; spectator is strictly read-only for orders, annotations allowed later. |
| r11 | 2026-08-28 | D-020 single shared invite with random anonymous seat assignment (amends D-005); D-021 GM power = the leftover, revealed at Start; D-022 settings fixed pre-invite, later changes versioned and broadcast. M1 flow implementation begun (in-memory first; SQLite to follow within M1). |
| r12 | 2026-08-28 | D-017 amended: React + Vite + TypeScript from M1 (owner call — build the flow pages correctly once). web/ scaffolded; board core ported to the imperative island; M0 sandbox stays vanilla meanwhile. |
| r13 | 2026-08-28 | M1 flow implemented end-to-end (D-020/021/022) as React SPA + Go, verified live. M0 sandbox and static/ deleted; / redirects to /new. Still in-memory — SQLite persistence remains before M1 acceptance. |
| r14 | 2026-08-28 | D-016 activated: pilot port of 1900 and Sail Ho from jDip (translator + map conversion phase 1; LLM-assisted restyle phase 2, needs OpenRouter key). Sources vendored to tools/jdip-import/source. |
| r15 | 2026-08-28 | D-014 presentation: checkmark for supported, no experimental badge. Restyle shipped as scripted theming (no LLM needed); style system with four named themes underway. Placement pipeline (audit/optimize/editor/serving) complete for classical + sailho. |
| r16 | 2026-08-28 | D-023: pressMode setting (ftf default / gunboat / fullpress-later); §1 press non-goal narrowed accordingly. Map styles as named JSON data (parchment extracted from classical, plus midnight, print and flat), applied to any converted map, served at `?style=`, chosen per device. Gallery map previews open in a pan-and-zoom lightbox; the pan/zoom arithmetic is shared with the board. Experimental badge removed per D-014 presentation (r15). |
| r17 | 2026-08-28 | Platform survey (research/platforms.md). §1 gap restated: parallel per-device entry, delete-the-sandboxer pitch; mylootcave (hot-seat) and avieth/diplomacy-server noted; commit-reveal confirmed novel. Q-007 opened (illegal/bluff orders). Playtest gains a 3-minute finalize criterion. D-023 may later gain a 'rulebook' press mode. Stale facts flagged: godip variant count, diplomacy/diplomacy status. |
| r18 | 2026-08-28 | D-026: styled maps composed at serve time from a style plan (styleplans/*.json) plus embedded style tokens (mapstyles/), with an in-memory cache; styledmaps/ (156 MB) and the checked-in map-<style>.svg files deleted after a byte-for-byte comparison against them; sailho's label repair baked into its own map.svg. D-027: deadline humanity — retreatBuildPercent (50), graceMinutes, firstTurnExtraMinutes, and Backstabbr's anti-rush rule. D-028: public per-phase watch URLs, /watch/{id}/{phaseIndex}, snapshots derived from replay and stable across a hard kill. D-023 gains the rulebook press mode and is implemented as data. |
| r19 | 2026-08-29 | D-029: illegal orders are allowed and on by default (closes Q-007). An order that parses but fails validation is stored as written, excluded from the engine, resolves as IllegalOrder, and the unit holds. Own seat only; amber in the list. |
| r20 | 2026-08-29 | D-030: in-app map editor at /mapeditor, with the convergence goal — every hand drag is a scoring bug to encode; zero audit violations auto-promotes the variant to supported. |
| r21 | 2026-08-29 | Placement tables generated for every variant, not only classical and Sail Ho: 24 more written by `tools/placement --all --skip`, shipped as generated. D-003 amended: the table gained a `brief` position per province for the three-letter code, judged against the province own marker, the neighbours markers, the dislodged ring, the supply glyph and the province border, with the full names off because brief mode hides them. A code is stored only where it measures no worse than the board offset heuristic in both board states, so a map whose provinces are smaller than their codes keeps the heuristic. The board reads the field and falls back per province. `--brief-only` adds codes to an approved table without re-deriving it, which is how classical kept its hand corrections. The jDip maps keep their own BriefLabelLayer; their codes were measured and not moved. |
| r22 | 2026-08-29 | D-030 implemented: /mapeditor in-app — variant picker, draggable unit/dislodged/brief markers, live violation audit sharing tools/placement rules (rules.ts split out), drag telemetry, province display-name overrides (names/{key}.json over ProvinceLongNames), stable-diff export, disk save only under -tags mapeditordev into .hand files the server never loads. Editor reads terrain from godip, exposing colour-guess faults in the offline audit (open item). |
| r23 | 2026-08-29 | D-031: Leaflet rejected after a working spike — 46 KB gz for ~460 replaceable lines, plus a zoomed-SVG layout-box risk on phones. Four gesture fixes adopted instead: wheel deltaMode normalisation (Firefox wheel zoom was dead), pan inertia, eased double-tap zoom, wheel debounce. |
| r24 | 2026-08-29 | Placement optimizer terrain bug: the fill-colour probe measured a hidden map and called almost all land sea on every variant, so coast rules never fired. Terrain now comes from /variants/{key}/provinces.json in tool and editor alike; 22 tables re-derived (containment faults 93 to 10, dislodged-outside 71 to 1), classical patched on bul/ec and bul/sc only. |
| r25 | 2026-08-30 | Decision ids repaired. Two ids were each used twice: the jDip restyle decision and the translator both said D-016, and the map-style decision and the press mode both said D-023. The restyle decision is now D-032, the map-style decision is now D-033. D-016 keeps the translator, D-023 keeps the press mode, because the revision log gave those two the id first (r4 and r16). References updated in DESIGN.md, research/platforms.md, and the source comments in restyle.go, mapstyles.go, variants.go and tools/restyle/. |
| r26 | 2026-08-30 | Links to localhost are useless to the phones they are meant for. Without BASE_URL the server now swaps a loopback host for its own LAN address, keeping the port and the scheme. The address comes from the kernel: a UDP dial to TEST-NET-1 sends nothing and fixes a route, and its source address is what a phone would reach. That beats reading the interfaces, which gives a laptop with docker three answers and no way to rank them. The interface scan stays as the fallback for a table with a switch and no uplink, and it declines when more than one address qualifies. IPv4 only, because a bracketed IPv6 address in a QR code is hard to retype. |
| r27 | 2026-08-30 | D-034: a seat moves by handoff. The holder may start one from a person icon in the game view, and the GM may start one for any power, which covers a player who has gone offline. Scanning the replacement URL clears the old device claim and kills the old URL, so one seat is never live on two phones. Seat tokens become HMAC over game, power, role and a per-seat epoch; bumping the epoch revokes every URL issued before it. Public and private keys rejected: the phone verifies nothing, it presents a bearer string. The GM gets two handoffs, one for the power and one for the referee rights. Amends D-012, which sent every device change through the GM. Design only, no code yet. |

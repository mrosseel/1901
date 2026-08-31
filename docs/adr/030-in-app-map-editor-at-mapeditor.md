---
status: superseded by ADR-033
---

# ADR-030 — In-app map editor at /mapeditor

**Status:** implemented r22, superseded r25 by ADR-033. The editor works and
ships today; its ownership moves to dipmap.
The placement editor graduates from generated standalone HTML files into
an app route: pick a variant, drag unit / dislodged / brief-code markers
with live violation feedback (the audit geometry), edit province display
names, and export the result — a placements/{key}.json plus a
per-variant name-override file layered over godip's ProvinceLongNames.
On a dev server the editor may save directly; production builds carry
the route read-only or not at all (decide at build time). This screen is
also the verification act behind ADR-014: a variant whose table was
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

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r20, 2026-08-29** — ADR-030: in-app map editor at /mapeditor, with the convergence goal — every hand drag is a scoring bug to encode; zero audit violations auto-promotes the variant to supported.
- **r22, 2026-08-29** — ADR-030 implemented: /mapeditor in-app — variant picker, draggable unit/dislodged/brief markers, live violation audit sharing tools/placement rules (rules.ts split out), drag telemetry, province display-name overrides (names/{key}.json over ProvinceLongNames), stable-diff export, disk save only under -tags mapeditordev into .hand files the server never loads.
- **r22, 2026-08-29** — Editor reads terrain from godip, exposing colour-guess faults in the offline audit (open item).
- **r25, 2026-08-29** — ADR-030 superseded in ownership.

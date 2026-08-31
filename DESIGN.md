# Face-to-Face Diplomacy Adjudicator — Execution Brief

**Status:** M1 flow live (React SPA + Go, in-memory). M0 sandbox removed.
**Owner:** Mike (Ghent, BE)
**Document revision:** r50 — 2026-08-30
**Audience:** an agent or developer picking this up cold.

---

## 0. How to use and maintain this document

This file is the project's single source of truth until code exists. It is
meant to be edited, not just read.

Rules for whoever works on this:

1. **Bump the revision** at the top (`r1` → `r2`) and add a line to
   §11 Revision Log for every substantive change. One line, dated, what
   changed and why.
2. **Decisions go in §3 with an ID** (`ADR-001`, `ADR-002`, …). Never delete a
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
ADR-004 is this project's strongest novel claim (Backstabbr's answer to a
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
  (Long-term direction changed in r6 — see ADR-018: a hosted multi-game
  service with logins is a post-v1 target. Still out of v1.)
- Press/messaging. People are sitting at a table talking to each other.
  (Narrowed r16 by ADR-023: a pressMode game setting exists; the
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
  anchors give a single point; see ADR-003).
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


Each decision is one file under [docs/adr/](docs/adr/), numbered to match
its name: ADR-041 is `docs/adr/041-*.md`. They were one long section of this
document until 2026-08-31; the numbers did not change, so every reference in
the code still resolves.

| Decision | Status |
| --- | --- |
| [ADR-001 — Engine: godip, running server-side](docs/adr/001-engine-godip-running-server-side.md) | accepted |
| [ADR-002 — License: GPL-3](docs/adr/002-license-gpl-3.md) | accepted |
| [ADR-003 — Maps: godip's SVGs](docs/adr/003-maps-godip-s-svgs.md) | accepted |
| [ADR-004 — Order secrecy via commit-reveal](docs/adr/004-order-secrecy-via-commit-reveal.md) | accepted |
| [ADR-005 — Auth: signed per-power tokens in the URL](docs/adr/005-auth-signed-per-power-tokens-in-the-url.md) | accepted |
| [ADR-006 — Deployment: single Go binary, embedded assets, SQLite](docs/adr/006-deployment-single-go-binary-embedded-assets-sqlite.md) | accepted |
| [ADR-007 — GM powers are enumerated and audited](docs/adr/007-gm-powers-are-enumerated-and-audited.md) | accepted |
| [ADR-008 — Turn advance is automatic by default](docs/adr/008-turn-advance-is-automatic-by-default.md) | accepted |
| [ADR-009 — Reveal is automatic; failure to reveal is civil disorder after a grace period](docs/adr/009-reveal-is-automatic-failure-to-reveal-is-civil-disorder-afte.md) | accepted |
| [ADR-010 — Deadlines arm the GM; they never auto-fire](docs/adr/010-deadlines-arm-the-gm-they-never-auto-fire.md) | accepted |
| [ADR-011 — Commit is a replaceable finalize](docs/adr/011-commit-is-a-replaceable-finalize.md) | accepted |
| [ADR-012 — Hard seat claim in v1](docs/adr/012-hard-seat-claim-in-v1.md) | accepted |
| [ADR-013 — The GM view is secret-free and safe for a shared screen](docs/adr/013-the-gm-view-is-secret-free-and-safe-for-a-shared-screen.md) | accepted |
| [ADR-014 — v1 ships classical as supported, all other variants behind an experimental flag](docs/adr/014-v1-ships-classical-as-supported-all-other-variants-behind-an.md) | accepted |
| [ADR-015 — Working name: "1901"](docs/adr/015-working-name-1901.md) | accepted |
| [ADR-016 — New variants come via a jDip adjacency-XML translator, not by hand](docs/adr/016-new-variants-come-via-a-jdip-adjacency-xml-translator-not-by.md) | accepted |
| [ADR-017 — Frontend: React + Vite, with the map as an imperative DOM island](docs/adr/017-frontend-react-vite-with-the-map-as-an-imperative-dom-island.md) | accepted |
| [ADR-018 — Long-term: one binary, two deployment modes (LAN and hosted multi-game)](docs/adr/018-long-term-one-binary-two-deployment-modes-lan-and-hosted-mul.md) | accepted |
| [ADR-019 — Touch order grammar](docs/adr/019-touch-order-grammar.md) | accepted |
| [ADR-020 — One shared invite; random seat assignment; anonymous seats](docs/adr/020-one-shared-invite-random-seat-assignment-anonymous-seats.md) | accepted |
| [ADR-021 — The GM's power is the leftover, revealed at start](docs/adr/021-the-gm-s-power-is-the-leftover-revealed-at-start.md) | accepted |
| [ADR-022 — Game settings before invite; changes after join are broadcast](docs/adr/022-game-settings-before-invite-changes-after-join-are-broadcast.md) | accepted |
| [ADR-023 — Press mode is a game setting: ftf, gunboat, fullpress](docs/adr/023-press-mode-is-a-game-setting-ftf-gunboat-fullpress.md) | accepted |
| [ADR-024 — godip's own maps are styled by palette substitution](docs/adr/024-godip-s-own-maps-are-styled-by-palette-substitution.md) | accepted |
| [ADR-025 — A per-province map has its own ground tone](docs/adr/025-a-per-province-map-has-its-own-ground-tone.md) | accepted |
| [ADR-026 — A styled map is composed at serve time from a style plan](docs/adr/026-a-styled-map-is-composed-at-serve-time-from-a-style-plan.md) | accepted |
| [ADR-027 — Deadline humanity: phase multiplier, grace, first turn, anti-rush](docs/adr/027-deadline-humanity-phase-multiplier-grace-first-turn-anti-rus.md) | accepted |
| [ADR-028 — Public, permanent, login-free per-phase URLs](docs/adr/028-public-permanent-login-free-per-phase-urls.md) | accepted |
| [ADR-029 — Illegal orders are allowed, and on by default](docs/adr/029-illegal-orders-are-allowed-and-on-by-default.md) | accepted |
| [ADR-030 — In-app map editor at /mapeditor](docs/adr/030-in-app-map-editor-at-mapeditor.md) | superseded by ADR-033 |
| [ADR-031 — Pan/zoom stays hand-rolled; Leaflet rejected, its math taken](docs/adr/031-pan-zoom-stays-hand-rolled-leaflet-rejected-its-math-taken.md) | accepted |
| [ADR-032 — A converted map is given the supply centres it does not draw](docs/adr/032-a-converted-map-is-given-the-supply-centres-it-does-not-draw.md) | accepted |
| [ADR-032 — Converted jDip maps are restyled into godip's classical style](docs/adr/032-converted-jdip-maps-are-restyled-into-godip-s-classical-styl.md) | accepted |
| [ADR-033 — Map authoring moves to dipmap; 1901 plays maps](docs/adr/033-map-authoring-moves-to-dipmap-1901-plays-maps.md) | accepted |
| [ADR-033 — Map styles are named data, chosen per device](docs/adr/033-map-styles-are-named-data-chosen-per-device.md) | accepted |
| [ADR-034 — A seat moves by handoff, and its holder may start one](docs/adr/034-a-seat-moves-by-handoff-and-its-holder-may-start-one.md) | accepted |
| [ADR-034 — A seat with nothing to order is finalized by the server](docs/adr/034-a-seat-with-nothing-to-order-is-finalized-by-the-server.md) | accepted |
| [ADR-036 — Text responses are served compressed, and the maps only once](docs/adr/036-text-responses-are-served-compressed-and-the-maps-only-once.md) | accepted |
| [ADR-037 — Map art is stored at two decimals](docs/adr/037-map-art-is-stored-at-two-decimals.md) | accepted |
| [ADR-038 — A name, a centre and an anchor are data, not drawing](docs/adr/038-a-name-a-centre-and-an-anchor-are-data-not-drawing.md) | accepted |
| [ADR-039 — There will be no jDip maps, only 1901 maps](docs/adr/039-there-will-be-no-jdip-maps-only-1901-maps.md) | accepted |
| [ADR-040 — A style with no grain does not ship the paper](docs/adr/040-a-style-with-no-grain-does-not-ship-the-paper.md) | accepted |
| [ADR-041 — A power can be handed to another person, by link](docs/adr/041-a-power-can-be-handed-to-another-person-by-link.md) | accepted |
| [ADR-042 — A game may be named, and the name is public](docs/adr/042-a-game-may-be-named-and-the-name-is-public.md) | accepted |
| [ADR-043 — The root is a landing page; the game list moves to /games](docs/adr/043-the-root-is-a-landing-page-the-game-list-moves-to-games.md) | accepted |
| [ADR-044 — A game ends: a solo, an agreed draw, or the end year](docs/adr/044-a-game-ends-a-solo-an-agreed-draw-or-the-end-year.md) | accepted |
| [ADR-045 — The DATC pass rate is a generated page](docs/adr/045-the-datc-pass-rate-is-a-generated-page.md) | accepted |
| [ADR-046 — Emit what the tournament pipeline already eats](docs/adr/046-emit-what-the-tournament-pipeline-already-eats.md) | accepted |
| [ADR-047 — The sandbox: a board with no players](docs/adr/047-the-sandbox-a-board-with-no-players.md) | accepted |
| [ADR-048 — A key the game master holds, and twelve words to recover it](docs/adr/048-a-key-the-game-master-holds-and-twelve-words-to-recover-it.md) | accepted |
| [ADR-049 — A seat is a key the device holds, not a token in the address](docs/adr/049-a-seat-is-a-key-the-device-holds-not-a-token-in-the-address.md) | accepted |
| [ADR-050 — The app's transport and the published data are two surfaces](docs/adr/050-two-http-surfaces.md) | accepted |

## 4. Open questions

- **Q-001 — Name.** *resolved → ADR-015.* Working name "1901". The
  Realpolitik precedent (ship free, "you must own a copy", no Hasbro art)
  is recorded in §8 and stands.
- **Q-002 — Frontend framework.** *resolved → ADR-017.* React + Vite, map
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
- **Q-005 — Spectator view.** *resolved → ADR-013.* The spectator view is the
  GM view minus admin controls; still out of scope for v1 as a shipped
  feature.
- **Q-006 — Which variants ship in v1?** *resolved → ADR-014.* Classical
  supported; all other generated variants behind an experimental flag.
- **Q-007 — Illegal and bluff orders (r17).** *resolved → ADR-029.* The tap grammar builds from
  godip's Options() and cannot express an illegal order. Backstabbr
  allows illegal orders deliberately (bluffing is part of the game), WDC
  house rules mandate lenient interpretation, and the main field
  complaint about mylootcave was exactly this. Decide whether (and how)
  a player can enter an order the engine will fail. Evidence in
  research/platforms.md.
- **Q-009 — A key for the game master, and twelve words to recover it (r48).**
  *resolved → ADR-048.*
- **Q-008 — A board with no players (r47).** *resolved → ADR-047.*
  Backstabbr's sandbox is a
  private adjudicating board with no seats, no deadline and no clock. One
  person drives all seven powers and presses adjudicate; since 2023 they can
  also edit it to any position. It is public at a permanent URL, its developer
  built it for face-to-face adjudication, and the tournament scene turned it
  into the community's citation format. Our M0 spike was one of these and r13
  deleted it. ADR-028 gives us half of it back, a permanent public board, and
  the missing half is a board anybody may drive. That is a second product
  mode, not a feature, which is why this was a question. It was going to the
  playtest; the owner answered it first, at r48, and it is ADR-047.

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
  audit log from ADR-007 and should never be updated or deleted from.

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
SQLite persistence. Game creation. Per-power tokens (ADR-005). QR generation.
Player view restricted to their own power. Event log table.

**Accept when:** seven phones can join one game by scanning codes and each
sees only their own orders, and killing and restarting the server loses
nothing.

### M2 — Real map rendering
Placement tables (ADR-003). Units, dislodged units, supply centre ownership,
retreat and build phases rendered correctly. Frontend framework chosen
(Q-002).

**Accept when:** a full game runs to a solo or draw with correct rendering at
every phase, including retreats and builds.

### M3 — Commit-reveal
ADR-004. Deadline handling. Auto-advance (ADR-008).

**Accept when:** an observer with full read access to the SQLite file cannot
learn any power's orders before the reveal, verified by inspecting the
database mid-phase.

### M4 — GM mode
ADR-007. GM view, enumerated actions, gated force-adjudication, player
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

**Build order, restated r47.** ADR-044 moves ahead of M3: a table cannot finish
a game that has no ending, and the playtest is meant to end in a result. After
it, the two unbuilt decisions that block a real tournament board are ADR-004
(commit-reveal, M3) and ADR-041 (handover), in that order, because a dead phone
is the commoner failure but a playing game master is the claim. ADR-045 and
ADR-046 are a day each and belong beside the playtest, since they are what a
tournament director is shown. ADR-047, the sandbox, sits with them and not
ahead of ADR-044; it needs no part of M3, having no secrets to keep. Q-008 was
going to the playtest and the owner answered it at r48 instead. No acceptance
criterion above changes.

---

## 8. Licensing and trademark summary

- Project is GPL-3 (ADR-002), inherited from godip and its assets.
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
| r1 | 2026-08-28 | Initial brief. Research on jDip, godip, alternative engines and map licensing completed and recorded in §2. Decisions ADR-001 through ADR-008 taken. Q-001 through Q-006 open. No code written. |
| r2 | 2026-08-28 | Grilling session. ADR-009: auto-reveal from client localStorage, civil disorder after grace period — closes the committed-but-never-revealed stall between ADR-004 and ADR-008. ADR-010: deadlines arm the GM's force-adjudication and never auto-fire; forced no-commit powers hold, logged as NMR. ADR-009 amended: failed reveal flags the GM (wait/extend/force), no automatic civil-disorder timer. ADR-011: commit is a replaceable finalize; last hash wins, no server-side drafts. ADR-012: hard seat claim in v1; second device blocked and logged, seat moves via GM token rotation. ADR-013: GM view is secret-free and safe for a shared screen; resolves Q-005. Fact correction in §2.3: godip maps carry `<abbr>Center` placement anchors in all 17 SVG variants; ADR-003 amended to generate the placement table from them. §2.1: jDip's `egdipmap.svg` PROVINCE_DATA measured; usable only with jDip's own art. ADR-014: classical supported in v1, other variants behind an experimental flag; closes Q-006. Q-003 gains jDip's 201 KB map as a measured art fallback. ADR-015: working name "1901"; closes Q-001. |
| r3 | 2026-08-28 | Artwork deliberation recorded as §2.4: godip art beats jDip on all 4 overlapping variants; every godip variant already has art; jDip-only variants need engines, not maps — their `*_adjacency.xml` is the convertible asset. §2.5 renumbered from 2.4. |
| r4 | 2026-08-28 | ADR-016: jDip-only variants are added via a generated translation of jDip's adjacency XML + variants.xml into a godip variant package; translator built on first concrete need, post-v1. |
| r5 | 2026-08-28 | ADR-017: React + Vite from M2 with the map as an imperative DOM island; closes Q-002. Q-003 gains the M0 phone finding: renders fine over LAN, pan/zoom is a hard requirement. |
| r6 | 2026-08-28 | ADR-018: long-term target is one binary with two modes — LAN (primary, unchanged) and hosted multi-game with accounts for game management only; seat play stays login-free in both. Non-goals updated to point at it. |
| r7 | 2026-08-28 | ADR-019: touch order grammar — two-tap move, double-tap hold, attack/support chip on occupied targets, bottom-bar fallback. From phone testing of the M0 spike. |
| r8 | 2026-08-28 | ADR-013 addition: beamer view gets URL-chosen layout variants (board only, board + move list, …). M1 direction started in code: /g/{id} lazily-created games in the spike. |
| r9 | 2026-08-28 | ADR-019 additions: highlight color grammar (green/amber/pulsing blue), staged hints, order Change/Cancel; server-side order cancellation. Debt noted: province names table in the client, move server-side at M2. |
| r10 | 2026-08-28 | Terminology session; CONTEXT.md created (Power/Seat/Player, Finalize/Commit/Reveal, Spectator view + Annotation, NMR, Adjudicate/Resolution). ADR-013's "beamer" renamed spectator view; spectator is strictly read-only for orders, annotations allowed later. |
| r11 | 2026-08-28 | ADR-020 single shared invite with random anonymous seat assignment (amends ADR-005); ADR-021 GM power = the leftover, revealed at Start; ADR-022 settings fixed pre-invite, later changes versioned and broadcast. M1 flow implementation begun (in-memory first; SQLite to follow within M1). |
| r12 | 2026-08-28 | ADR-017 amended: React + Vite + TypeScript from M1 (owner call — build the flow pages correctly once). web/ scaffolded; board core ported to the imperative island; M0 sandbox stays vanilla meanwhile. |
| r13 | 2026-08-28 | M1 flow implemented end-to-end (ADR-020/021/022) as React SPA + Go, verified live. M0 sandbox and static/ deleted; / redirects to /new. Still in-memory — SQLite persistence remains before M1 acceptance. |
| r14 | 2026-08-28 | ADR-016 activated: pilot port of 1900 and Sail Ho from jDip (translator + map conversion phase 1; LLM-assisted restyle phase 2, needs OpenRouter key). Sources vendored to tools/jdip-import/source. |
| r15 | 2026-08-28 | ADR-014 presentation: checkmark for supported, no experimental badge. Restyle shipped as scripted theming (no LLM needed); style system with four named themes underway. Placement pipeline (audit/optimize/editor/serving) complete for classical + sailho. |
| r16 | 2026-08-28 | ADR-023: pressMode setting (ftf default / gunboat / fullpress-later); §1 press non-goal narrowed accordingly. Map styles as named JSON data (parchment extracted from classical, plus midnight, print and flat), applied to any converted map, served at `?style=`, chosen per device. Gallery map previews open in a pan-and-zoom lightbox; the pan/zoom arithmetic is shared with the board. Experimental badge removed per ADR-014 presentation (r15). |
| r17 | 2026-08-28 | Platform survey (research/platforms.md). §1 gap restated: parallel per-device entry, delete-the-sandboxer pitch; mylootcave (hot-seat) and avieth/diplomacy-server noted; commit-reveal confirmed novel. Q-007 opened (illegal/bluff orders). Playtest gains a 3-minute finalize criterion. ADR-023 may later gain a 'rulebook' press mode. Stale facts flagged: godip variant count, diplomacy/diplomacy status. |
| r18 | 2026-08-28 | ADR-026: styled maps composed at serve time from a style plan (styleplans/*.json) plus embedded style tokens (mapstyles/), with an in-memory cache; styledmaps/ (156 MB) and the checked-in map-<style>.svg files deleted after a byte-for-byte comparison against them; sailho's label repair baked into its own map.svg. ADR-027: deadline humanity — retreatBuildPercent (50), graceMinutes, firstTurnExtraMinutes, and Backstabbr's anti-rush rule. ADR-028: public per-phase watch URLs, /watch/{id}/{phaseIndex}, snapshots derived from replay and stable across a hard kill. ADR-023 gains the rulebook press mode and is implemented as data. |
| r19 | 2026-08-29 | ADR-029: illegal orders are allowed and on by default (closes Q-007). An order that parses but fails validation is stored as written, excluded from the engine, resolves as IllegalOrder, and the unit holds. Own seat only; amber in the list. |
| r20 | 2026-08-29 | ADR-030: in-app map editor at /mapeditor, with the convergence goal — every hand drag is a scoring bug to encode; zero audit violations auto-promotes the variant to supported. |
| r21 | 2026-08-29 | Placement tables generated for every variant, not only classical and Sail Ho: 24 more written by `tools/placement --all --skip`, shipped as generated. ADR-003 amended: the table gained a `brief` position per province for the three-letter code, judged against the province own marker, the neighbours markers, the dislodged ring, the supply glyph and the province border, with the full names off because brief mode hides them. A code is stored only where it measures no worse than the board offset heuristic in both board states, so a map whose provinces are smaller than their codes keeps the heuristic. The board reads the field and falls back per province. `--brief-only` adds codes to an approved table without re-deriving it, which is how classical kept its hand corrections. The jDip maps keep their own BriefLabelLayer; their codes were measured and not moved. |
| r22 | 2026-08-29 | ADR-030 implemented: /mapeditor in-app — variant picker, draggable unit/dislodged/brief markers, live violation audit sharing tools/placement rules (rules.ts split out), drag telemetry, province display-name overrides (names/{key}.json over ProvinceLongNames), stable-diff export, disk save only under -tags mapeditordev into .hand files the server never loads. Editor reads terrain from godip, exposing colour-guess faults in the offline audit (open item). |
| r23 | 2026-08-29 | ADR-031: Leaflet rejected after a working spike — 46 KB gz for ~460 replaceable lines, plus a zoomed-SVG layout-box risk on phones. Four gesture fixes adopted instead: wheel deltaMode normalisation (Firefox wheel zoom was dead), pan inertia, eased double-tap zoom, wheel debounce. |
| r24 | 2026-08-29 | Placement optimizer terrain bug: the fill-colour probe measured a hidden map and called almost all land sea on every variant, so coast rules never fired. Terrain now comes from /variants/{key}/provinces.json in tool and editor alike; 22 tables re-derived (containment faults 93 to 10, dislodged-outside 71 to 1), classical patched on bul/ec and bul/sc only. |
| r25 | 2026-08-29 | ADR-026 amended: a converted label class under 1.15% of the map's width is lifted to that floor, which is what made 1900's province names readable. Classes already above it keep the size their placement was measured against. A length is now carried onto the scale of the layer it lands in rather than the map's, and `jdipPlan` gains `labelScale`, derived from the art when a plan omits it. Two dormant faults recorded: jDip label lengths are emitted unitless and inert, and the label layer's `stroke:none` outranks the halo rule. ADR-033: map authoring moves to dipmap, 1901 plays maps (owner decision) — placement, restyle and the map editor leave; every serve-time reader and tools/jdip-import stay. ADR-030 superseded in ownership. ADR-032: converted maps are given supply-centre rings they never carried. ADR-026 amended: a length belongs to the layer it lands in, not to the map, which is why 1900's small labels rendered as smudges. |
| r26 | 2026-08-30 | ADR-034: a seat whose power has no legal order this phase is finalized by the server, in every phase type, so an empty retreat never reaches a screen. Force adjudication counts only the seats a phase asked a player for; the seat screen says why it is locked; an auto-locked seat cannot be unlocked. Move the pieces became a checklist. |
| r27 | 2026-08-30 | ADR-036: text responses are gzipped for clients that offer it, with `Vary: Accept-Encoding` on everything compressible; the map art is compressed once per style and cached beside the composed bytes, 64% off the wire. ADR-037: map art is stored at two decimals, 19% off disk and 24% off the gzipped bytes, touching only `d` and `points` so the viewBox and every placement table stay valid. Dead definitions are pruned from the art, which changes the bytes of `?style=original` but not its picture. |
| r28 | 2026-08-30 | ADR-038: the province name, the supply-centre glyph and the unit anchor become records in `placements.json`; the art keeps geometry. A label record carries position, size and reserved width, so the drawn box is the measured box. A map is in data mode if it has any label record, and maps whose names are outlined shapes keep their art. ADR-033 widened: `tools/jdip-import/` moves to dipmap as well, so 1901 never writes a map. |
| r29 | 2026-08-30 | ADR-038 corrected after review by the map exporter: `at` is stated as the ink box centre and the record gains `height`, because a reader that took it for the baseline would draw every name half a cap height high; the centre glyph gains a radius, since it is an obstacle the name search fits around; `found` is not the mode flag; name styling moves to the board with the verdict, the typography and the halo travelling with the board state, so the two restyle paths do not collapse; the saving is restated gzipped and net of the records, about 1.8 KB a board load. |
| r30 | 2026-08-30 | ADR-038 corrected again after scoping. The record gains `rot`: classical rotates 73 of 90 names and a flat Portugal runs across Spain. `?style=original` keeps its layers. The land-or-sea verdict is derived from the variant graph, not stored. The layers are 27.3% of the art, not 10.4%, but only 14.5% gzipped and almost all of that is in the four maps whose names are outlined shapes and cannot be migrated automatically. 1800 Empires and Coalitions has no long names at all and blocks its own migration. Multi-line names and the gallery card have no answer yet. |
| r31 | 2026-08-30 | ADR-039: the jDip importer is a one-time migration and the end state has no jDip maps, only 1901 maps. Once the last jDip art is gone, the second style applier and everything only it reads is deleted, and a style plan stops having two shapes. The hybrid in ADR-038 is a stage, not a resting place. Four maps whose names are outlined shapes need re-authoring by a person, not a recovery pass. |
| r32 | 2026-08-30 | ADR-039 refined: the importer may outlive the migration, in dipmap, because what it produces is an ordinary 1901 map. The jDip format still ends in this repository, and no code here is kept alive against the chance of another jDip map appearing. |
| r33 | 2026-08-30 | ADR-040: a style with no grain drops the overlay's fill instead of dimming it, so the paper pattern is orphaned and the existing prune takes the 29 KB bitmap with it. 20 of 130 map and style pairs get 22.4 KB smaller gzipped, 447 KB over the set, with no pixel changed and `?style=original` byte-identical. The overlay element stays: on seven of the ten maps it carries the board's hairline frame. Styled art is now checked to parse as XML, which is how a board's `<img>` reads it. |
| r34 | 2026-08-30 | ADR-038: the supply-centre glyph follows the same rule as the name. Where the art draws the layer, the art wins. Where it does not, the board draws from the record. A drawn ring keeps the id from ADR-032 and never `<key>Center`, which the board matches to find anchors. |
| r35 | 2026-08-30 | ADR-038: a wrapped name gets an optional `labelRuns` beside `label` rather than turning `at` into a list, and a run's text wins for drawing only. The claim that moving a short label makes the payload bigger is withdrawn: it was JSON pretty-printing, not the format. Tables collapse arrays and innermost objects onto one line, 30.1% off raw and 4.3% gzipped, keeping one line per field so a moved marker stays a one-line diff. |
| r36 | 2026-08-30 | The reader lands, inert. The board can draw a name, a code and a supply-centre glyph from records, and does not, because every map still draws its own and the art wins. ADR-038 corrected: it said the mode was inferred from the presence of a record and also that it was an explicit flag. It is the flag, `dataMode` in the style plan. The land-or-sea verdict is derived from godip's graph and agrees with the art's own measurement on 73 of 73. With the flag off, 130 renders are byte-identical to master. |
| r37 | 2026-08-30 | ADR-038: the supply-centre record gains `centreStroke`. Asking what stroke width a glyph uses found that it is a line weight in map units and not a fraction of the radius, so the reader's derivation from godip's ratio was wrong by more than a factor of two, and that the exporter reserved `2 * radius` when the ink reaches `radius + stroke / 2`. A `labelRuns` anchor is in unrotated space and a run carries no rotation of its own. |
| r38 | 2026-08-30 | The demo7 fixture carries `centreStroke`, verified independently: 31 records against 31 stroked circles, worst deviation 0.0500, every stroke 1.10. ADR-038 gains the rule that a record is compared to the art with a tolerance of half the art's rounding step, and never looked up by formatted string, because the two roundings do not commute. |
| r39 | 2026-08-30 | The server reads a version-2 style plan. The gate is a range, 1 to 2, because every checked-in plan is version 1 until its map is re-authored. `kinds` is a list in one version and a map in the other, and neither is converted into the other: a list is keyed by position and a map has no document order. `names.typography` answers `?style=original` on a map with no original names layer. ADR-038 corrected: the sentence saying the mode is the presence of a label record is struck, having been overturned at r36. With no plan in data mode, 130 of 130 served SVGs are byte-identical. |
| r40 | 2026-08-30 | Lock is the word for the act ADR-008, ADR-011 and ADR-034 call finalize. It runs front and back: the button, the JSON, the routes and `seat.locked`. Finalize was never true, because ADR-011 makes the commit replaceable until the phase resolves, and a lock is a thing you can open again. Commit and Reveal keep their names. The decision entries above are left as they were written; CONTEXT.md carries the retired word. |
| r41 | 2026-08-30 | The invite link reaches the table. Without BASE_URL the server swaps a loopback host for its own LAN address, keeping the port and the scheme, because a QR code that says localhost opens on no phone. It asks the kernel for the address with a UDP dial that sends nothing, so a laptop running docker gets the right one of its several addresses, and it declines rather than guesses when there is no default route. |
| r42 | 2026-08-30 | ADR-041: a power can be handed to another person by a signed link, `HMAC(salt, power, game id, epoch)`, with the epoch raised on use so the previous holder's access dies with it. Every seat gets an icon and a menu carrying the power, the turns played, the time elapsed, and the handover. The game master has two entries, one for the rights and one for the power, because they fail differently. Designed, not built. |
| r43 | 2026-08-30 | ADR-041's open question is closed and was malformed. The signed value authenticates commands, so an order the server accepted was accepted under a valid epoch and is server state from that moment. Raising the epoch stops the old holder sending anything further and reaches back into nothing. The new holder inherits the seat as it stands, orders included. |
| r44 | 2026-08-30 | ADR-041: the game master can mint a handover link for any power. A dead phone takes its own menu with it, which is the case this exists for. It is an enumerated, logged game master power (ADR-007), because a game master who can mint a link for any seat can take any seat; the record is what makes that visible rather than prevented. |
| r45 | 2026-08-30 | The game master's waiting room shows the joined count only until every power is claimed, then the list of powers appears. The old per-power list published the join order on a screen the whole table reads (ADR-013), against ADR-020's anonymous seats, and the player waiting screen already showed a count for that reason. That list is where ADR-041's per-power actions will live. ADR-042: a game may be named. The New game screen puts the name, the rules and the create button above the map gallery, which was a screenful of scrolling between the choice and the act. |
| r46 | 2026-08-30 | ADR-043: the root is a landing page and the game list moves to /games. The list was the right screen for the game master who had just created a game and the wrong one for a stranger, who met somebody else's table or an empty page and was never told what this is. The page borrows the app's own power card, phase words and lock button, and washes the Classical map behind the words, so nothing on it is a drawing of the product. GET /games is the page, POST /games still creates, and the JSON list moved to /games/list. |
| r47 | 2026-08-30 | Read back against research/platforms.md, most of the survey's steal list is built and the gaps are elsewhere. ADR-044: a game ends, by a solo read from godip's `SoloWinner`, by a draw the game master records, or at an end year, and an ended game freezes and publishes a result; the flow never asked who won. ADR-045: the DATC pass rate the CI already computes becomes a generated page that also states what was not run. ADR-046: publish supply-centre counts as JSON and CSV, because dipvis scrapes Backstabbr's HTML for exactly that and a stable address replaces a scraper. Q-008 opened: whether to bring back a board with no players, which is Backstabbr's sandbox and the reason its links are the community's citation format. Build order in §7 restated: ADR-044 before M3, then ADR-004 and ADR-041. |
| r48 | 2026-08-30 | ADR-047: the sandbox, a game with no seats, one `sandboxToken` link that may drive every power and adjudicate, and the ordinary watch addresses for everybody else. It closes Q-008 ahead of the playtest, on the owner's call. It is a flag on a game rather than a second object, so there is one adjudication path; a sandbox route refuses a real game and a seat route refuses a sandbox, which is a test and not a comment. Editing the position breaks ADR-028's replay-from-orders, so an edit writes a whole-position checkpoint and replay starts there, and an edited phase says so on the page. ADR-029 and ADR-044 apply; press, deadlines, anonymity and handover have no second person to be about. CONTEXT.md gains Sandbox. |
| r49 | 2026-08-30 | ADR-048 accepted and built, closing Q-009. The game master's browser makes an Ed25519 key, the server keeps the public half, and twelve BIP-39 words are the copy that outlives the device: typing them at /recover signs a challenge and buys a fresh game master address, which rotates the token and drops the referee cookie exactly as a role handover does. The key is write-once, because the token is not the credential it protects. Alternative 1 shipped beside it: the game master page shows its own address, folded and guarded like every other secret there. HKDF-SHA256 and not BIP-39's PBKDF2 seed, a vendored curve and not crypto.subtle, because run.sh serves plain http on a LAN. Nothing changes for a player, and no seat has a key. |
| r50 | 2026-08-30 | ADR-049: a seat is a key the joining device makes, not a token in its address. The device sends the public half, keeps the seed in its own storage, and moves it between devices in a URL fragment, which no browser ever sends. Access and authorship are split: a signature buys an HttpOnly session cookie once, and the signature over a sealed order (ADR-004) is the half that is not built. Sessions live in memory, so a restart signs every device back in and leaves no credential in a file. No migration — a seat row holds a token or a key, old games keep tokens, and `seat.claimed()` is the only predicate allowed to ask whether a seat is taken. The game master's own seat keeps its token, because the game master page already holds a stronger credential and is often the screen on the beamer. CONTEXT.md gains Seat key and rewrites Seat. |

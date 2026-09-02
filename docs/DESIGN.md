# Face-to-Face Diplomacy Adjudicator — Execution Brief

**Status:** M1 flow live (React SPA + Go, in-memory). The M0 one-screen spike
was removed at r13; the sandbox of ADR-047 is a different thing and is live.
**Owner:** Mike (Ghent, BE)
**Document revision:** r56 — 2026-09-02
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
  (Narrowed r16 by ADR-023: a pressMode game setting exists. Narrowed again
  at r56: the app now carries messages in the `fullpress` and `rulebook`
  modes, off by default, end-to-end encrypted, and gated by the WDC rules —
  ADR-053, ADR-054, ADR-055. `ftf` is still the default and still carries
  nothing.)
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
| [ADR-030 — In-app map editor at /mapeditor](docs/adr/030-in-app-map-editor-at-mapeditor.md) | superseded by ADR-051 |
| [ADR-031 — Pan/zoom stays hand-rolled; Leaflet rejected, its math taken](docs/adr/031-pan-zoom-stays-hand-rolled-leaflet-rejected-its-math-taken.md) | accepted |
| [ADR-032 — A converted map is given the supply centres it does not draw](docs/adr/032-a-converted-map-is-given-the-supply-centres-it-does-not-draw.md) | accepted |
| [ADR-032 — Converted jDip maps are restyled into godip's classical style](docs/adr/032-converted-jdip-maps-are-restyled-into-godip-s-classical-styl.md) | accepted |
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
| [ADR-051 — Map authoring moves to dipmap; 1901 plays maps](docs/adr/051-map-authoring-moves-to-dipmap-1901-plays-maps.md) | accepted |
| [ADR-053 — Press is a room, not a message](docs/adr/053-press-is-a-room-not-a-message.md) | accepted |
| [ADR-054 — The server cannot read press, and a referee who does not play may](docs/adr/054-the-server-cannot-read-press.md) | accepted |
| [ADR-055 — Press follows the tournament clock](docs/adr/055-press-follows-the-tournament-clock.md) | accepted |
| [ADR-056 — A room is signed by whoever opened it](docs/adr/056-a-room-is-signed-by-whoever-opened-it.md) | accepted |
| [ADR-057 — A length is a message too](docs/adr/057-a-length-is-a-message-too.md) | accepted |
| [ADR-058 — A resolved phase keeps the envelope it came from](docs/adr/058-a-resolved-phase-keeps-the-envelope-it-came-from.md) | accepted |

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
│  HTTP/WebSocket handlers                               │
│    ├─ /game/{id}/seat/{token} player view              │
│    ├─ /game/{id}/gm/{token}   GM view                  │
│    ├─ /api/v1/…               JSON commands/state      │
│    └─ /api/v1/game/…/events   live invalidations       │
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
WebSocket invalidation. It never adjudicates and never receives another
power's pending orders.

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

*Met at r52, rebuilt at r53.* A sealed game holds one envelope per seat and no
key to any of them until the window opens.
`TestASealedGameHoldsNoOrderUntilEveryoneHasLocked` is the criterion in code:
with six of seven locked in it reads the board, the engine's order set and
every seat's own state answer, finds no order anywhere, and checks that an
all-zero key does not open what is stored. The two implementations are pinned
against each other: the Go tests open an envelope the TypeScript tests
produced.

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

**Where that stands, r54.** ADR-004 is built, so every decision between here
and a tournament board is. What is left before a table is the playtest itself,
and the two questions it is meant to answer, Q-004 and Q-006. ADR-047, the
sandbox, is built except for its position editor, which is the half that
breaks ADR-028's replay and wants a checkpoint before it can be written.

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

## 11. Project log

What happened to this document that is not one decision: research recorded,
the glossary written, the code scaffolded. Everything that revised a single
decision now lives in that decision, under its own Revisions heading.

| Rev | Date | What |
| --- | --- | --- |
| r1 | 2026-08-28 | Initial brief. Research on jDip, godip, alternative engines and map licensing completed and recorded in §2. |
| r2 | 2026-08-28 | Grilling session. |
| r3 | 2026-08-28 | Artwork deliberation recorded as §2.4: godip art beats jDip on all 4 overlapping variants; every godip variant already has art; jDip-only variants need engines, not maps — their `*_adjacency.xml` is the convertible asset. §2.5 renumbered from 2.4. |
| r10 | 2026-08-28 | Terminology session; CONTEXT.md created (Power/Seat/Player, Finalize/Commit/Reveal, Spectator view + Annotation, NMR, Adjudicate/Resolution). |
| r17 | 2026-08-28 | Platform survey (research/platforms.md). §1 gap restated: parallel per-device entry, delete-the-sandboxer pitch; mylootcave (hot-seat) and avieth/diplomacy-server noted; commit-reveal confirmed novel. Q-007 opened (illegal/bluff orders). Playtest gains a 3-minute finalize criterion. |
| r21 | 2026-08-29 | Placement tables generated for every variant, not only classical and Sail Ho: 24 more written by `tools/placement --all --skip`, shipped as generated. |
| r24 | 2026-08-29 | Placement optimizer terrain bug: the fill-colour probe measured a hidden map and called almost all land sea on every variant, so coast rules never fired. Terrain now comes from /variants/{key}/provinces.json in tool and editor alike; 22 tables re-derived (containment faults 93 to 10, dislodged-outside 71 to 1), classical patched on bul/ec and bul/sc only. |
| r36 | 2026-08-30 | The reader lands, inert. The board can draw a name, a code and a supply-centre glyph from records, and does not, because every map still draws its own and the art wins. |
| r38 | 2026-08-30 | The demo7 fixture carries `centreStroke`, verified independently: 31 records against 31 stroked circles, worst deviation 0.0500, every stroke 1.10. |
| r39 | 2026-08-30 | The server reads a version-2 style plan. The gate is a range, 1 to 2, because every checked-in plan is version 1 until its map is re-authored. `kinds` is a list in one version and a map in the other, and neither is converted into the other: a list is keyed by position and a map has no document order. `names.typography` answers `?style=original` on a map with no original names layer. |
| r41 | 2026-08-30 | The invite link reaches the table. Without BASE_URL the server swaps a loopback host for its own LAN address, keeping the port and the scheme, because a QR code that says localhost opens on no phone. It asks the kernel for the address with a UDP dial that sends nothing, so a laptop running docker gets the right one of its several addresses, and it declines rather than guesses when there is no default route. |
| r45 | 2026-08-30 | The game master's waiting room shows the joined count only until every power is claimed, then the list of powers appears. |
| r47 | 2026-08-30 | Read back against research/platforms.md, most of the survey's steal list is built and the gaps are elsewhere. |
| r51 | 2026-08-31 | A game can end, and the numbers leave the building. ADR-044, ADR-045 and ADR-046 are built; the flow had never asked who won, so every board ran forever. Two stale status lines corrected: ADR-041 and ADR-034's handoff both said they were not built, and both had been for some time. |
| r52 | 2026-08-31 | Commit-reveal, which is M3 and the project's one novel claim. The drafts left the server: a phone keeps them in storage, draws them itself, and sends a digest when the player locks in; the orders go up only once every seat has locked in, and the phone sends them unasked. So a game master reading their own SQLite file mid-phase finds seven hashes. A sealed game is decided at creation and a game made before this keeps its server-side drafts, on ADR-049's rule about tokens and keys. The two hashers are pinned against each other in Go and TypeScript, and a third implementation played a phase end to end over HTTP. |
| r53 | 2026-08-31 | The commitment is a sealed envelope and not a digest, on the owner's question. A digest kept the orders off the server and lost them: a phone that locked in and then went flat held the only copy, so its power was an NMR. The lock now sends the orders encrypted, the reveal sends the 32-byte key, and a second device holding the seat seed derives the same key and can release a dead phone's orders. XChaCha20-Poly1305 on both sides, with the game, the phase and the power as associated data. Dropping the commitment altogether was refused: the reveals are not simultaneous, so the last seat to reveal would choose knowing everybody else's orders. |
| r54 | 2026-09-01 | The sandbox (ADR-047): a board with no players, driven from one link. It is a flag on an ordinary game and not a second object, so the variants, the map, the adjudication, the review and the public per-phase addresses are the ones a played game has; what comes off is the seat layer. Its seats stay as unclaimed rows, which is what keeps every count and the persistence untouched, and its scope rejects a table exactly as the seat scope rejects a sandbox. A phase no power can order is walked past, ADR-034's rule read off the position rather than off the seats. Not built: editing the position, which is the part that needs a checkpoint because an edit cannot be replayed. One bug fell out of it — an illegal-order mark survived the adjudication that spent it, and only the sandbox's own state answer ever drew one. |
| r56 | 2026-09-02 | Full press (ADR-053, ADR-054, ADR-055). A message is a **room**: the member list is fixed when it opens and every reply goes to everybody in it, which is what a corridor conversation is and what a CC is not. The rulebook allows groups of any size, so multi-power press needed no excuse; the shape did. The server holds ciphertext, a member list and a time and no key to any of it — the same reason the orders are sealed, since the server is the game master's laptop and the game master usually plays. The WDC 2019 house rules are enforced rather than printed: no press in retreat and build phases under `rulebook` (3b), none for an eliminated power (3c), and none in the writing time before the deadline (4b2, 4d), which is a new setting defaulting to WDC's minute. A power's own notepad is a room with one member and is exempt from all three, because writing your plan down is what that minute is for. One setting lets a game master who does **not** play be wrapped into every room, declared on the join page and fixed at start; a game master who plays can never have it. The seat screen gains a top bar — power, phase, orders in, deadline, unread — so the four things read in glances are not below a map that is fighting for pixels. |

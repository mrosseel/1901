# Face-to-Face Diplomacy Adjudicator — Execution Brief

**Status:** M1 flow live (React SPA + Go, in-memory). M0 sandbox removed.
**Owner:** Mike (Ghent, BE)
**Document revision:** r14 — 2026-08-28
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

The gap this fills: jDip has the only real desktop face-to-face mode, but it
means passing one laptop around the table. Backstabbr's sandbox is the de
facto tournament tool but is a single shared screen with no per-player
secrecy, and is closed and hosted. Nothing currently does per-player order
entry at a physical table.

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
**Status:** accepted, r2
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
**Status:** accepted, r2
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
and presented as supported. The rest are selectable at game creation behind
an explicit "experimental — placement not verified" warning. Promoting a
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
Playtest at a table with real players before adding anything. Q-004 and Q-006
should be answered by that playtest, not before it.

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

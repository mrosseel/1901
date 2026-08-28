# Diplomacy platform survey

**Date:** 2026-08-28
**For:** 1901 (face-to-face Diplomacy adjudicator). See `DESIGN.md` §1, D-018, D-023 and `CONTEXT.md`.
**Status:** research only. `DESIGN.md` is not modified by this document. §6 lists the amendments I think it needs.

---

## 0. Method and confidence

Everything below came from the live web on 2026-08-28. Where I could, I read the
primary artifact: the site's own HTML, its client JavaScript, a tournament
rulebook, or the GitHub API. Where I could only read a search snippet or a
secondary write-up, the line says so.

Three numbers are worth stating up front, because they set the scale of the
market. They come from the footers the sites render on every page.

| Site | Registered | In a game now | Active games | Finished games |
|---|---|---|---|---|
| webdiplomacy.net | 412,955 | 7,655 | 414 | 1,418,123 |
| vdiplomacy.com | 28,324 | 1,087 | 330 | 39,588 |

Measured 2026-08-28 from the page footers of
<https://webdiplomacy.net/points.php> and <https://vdiplomacy.com/>.
Backstabbr and PlayDiplomacy publish no equivalent figure.

---

## 1. Platform profiles

### 1.1 webDiplomacy: webdiplomacy.net

The biggest site by a wide margin, and the only large one that is open source.

- **Started** 2004 as phpDiplomacy, renamed webDiplomacy in September 2009
  because "the 'php' prefix wasn't widely recognizable to players". Non-profit
  and ad-free for twenty years. Site version 1.81. Owner Kestas J. Kuliukas.
- **Play modes.** Async and live in the same system. Phase length runs from
  **5 minutes to 10 days** in fixed steps (5, 7, 10, 15, 20, 30 minutes, then
  hours, then days). Anything at 10 minutes or under is a live game, and live
  games start at their scheduled time whether or not they filled. **Retreat and
  build phases can carry a shorter clock than movement**; listings show it as
  "1 day/16 hrs".
- **Missing orders is a per-game dial.** The creator picks 0 to 4 excused
  missed turns per player before forced civil disorder. Two consecutive NMRs
  normally trigger it, but merely viewing the board between them prevents it.
- **Pause needs unanimous agreement**, and the site rules treat refusing to
  unpause as a rules violation, not a tactic: "The Pause/Unpause feature is not
  a diplomatic tool." There is also a **vote cancel**, a low-commitment way to
  signal willingness to draw without the tactical cost of a formal draw vote.
  Draw votes can be public or hidden per game.
- **Press modes.** Four, and the fourth matters to us:
  `all` (full press), `global only` (public press), `no messaging` (gunboat),
  and **`per rulebook`**, which is full press during movement phases and no
  press at all during retreat and build phases. webDiplomacy's own FAQ says
  "Face-to-face Diplomacy is generally played this way."
  Source: <https://webdiplomacy.net/faq.php>
  The press UI is one tab per power. **Your own power's tab is a private
  notepad** that nobody else can see, written exactly like press. Zero extra UI
  for real utility. Players can also mute an individual opponent inside a game.
  No grey press. Anonymity is a separate game flag that hides display names.
- **Variants.** 11 active, with per-variant game counts published:
  Classic (1,345,050 games), France vs Austria (41,437), Germany vs Italy
  (24,665), Ancient Mediterranean (14,769), Modern Diplomacy II (4,622),
  World Diplomacy IX (3,173), Fall of the American Empire IV (2,955),
  Cold War (1,334), Chaos (367), Zeus 5 (82), Known World 901 (26).
  Four more are present but disabled. New variants arrive rarely and are
  reviewed by hand. Source: <https://webdiplomacy.net/variants.php>
- **Two map systems live side by side, and this is the most instructive
  technical fact about the site.**
  The legacy path is a **server-rendered PNG** built with PHP GD:
  `map/drawMap.php` loads an indexed PNG per variant, recolours territories by
  palette index with `imagecolorat` and `imagecolorset`, composites name and
  unit overlays, draws order arrows as rotated filled polygons, and writes one
  PNG per turn plus a 300x300 thumbnail. Browsing history swaps the `<img>` src.
  Colourblind modes (Protanope, Deuteranope, Tritanope) are applied client-side.
  The modern path is **real inline SVG in React**
  (`beta-src/src/components/map/WDMap.tsx`), with filter defs for selection
  glow, pattern fills for land and sea texture, and separate containers for
  arrows, builds and flyouts. It was built by Codazen with Meta FAIR and it is
  genuinely good on a tablet.
  **The catch: `beta-src/.../map/variants/` contains only `classic/`.** Every
  non-Classic variant still renders as a GD PNG, and that limitation has stood
  since the beta launched in June 2022.
- **Order entry.** The legacy UI is cascading dropdown selects, one row per
  unit, with the server sending the legal-option tree so each select narrows the
  next. Point-and-click on the SVG board replaced it as the default for Classic;
  the dropdowns remain and are still the only path for variants. Users pick
  their default in account settings, which is why a signed-out profile carries
  `mapUI: "Point and click"`. Validation runs three times: client option tree,
  server order check, then the adjudicator.
- **There is a sandbox**, added 2023-03-10. "Start a Sandbox Game" from the
  Games menu, or "Copy to sandbox" from any game you are in. Inside it you can
  **step the position back a turn**. It is exposed on the API as
  `sandbox/create`, `sandbox/copy`, `sandbox/moveTurnBack`, `sandbox/delete`.
- **Save versus Ready.** Two separate buttons. Save stores a draft the player
  can still change. Ready declares the orders final and lets the phase resolve
  early once everyone has readied. Unsaved order choices render red. This is
  the same distinction `CONTEXT.md` draws between a draft and Finalize, and
  webDiplomacy solved the naming problem the same way we did.
- **Scoring.** A points economy, not a tournament scorer. Every game has a
  pot; players bet a minimum of 5 points; a floor of 100 total points stops
  anyone from being locked out. Two systems: Draw-Size Scoring (default,
  formerly Winner-Takes-All) and Sum-of-Squares. Points-Per-Supply-Centre was
  removed because it produced "strong seconds", players who help someone solo
  in exchange for centres. Unranked games refund the bet.
  webDiplomacy's own note on Sum-of-Squares: it "is often used in
  face-to-face Diplomacy tournaments where games may be time sensitive."
  Source: <https://webdiplomacy.net/points.php>
- **Ratings.** Ghost Ratings, a modified zero-sum Elo by TheGhostmaker.
  Everyone starts at 100. It is weighted by **opponent strength rather than pot
  size**, and normalised so a DSS result and an SoS result move your rating
  identically. Seven categories: overall, gunboat, full press, live, and three
  1v1 splits. Source: <https://webdiplomacy.net/ghostRatings.php>
- **Reliability Rating is separate and orthogonal.** Take the fraction of turns
  without an NMR, take the fraction of games without a civil disorder, average
  the two, then cube the result. It is public, and a game can require a minimum
  reliability to join.
- **Tournaments.** Run as a moderated process with real director tooling rather
  than as a scoring engine: a "Wait for Orders" mode, player lists and
  positions, authority to have moderators contact participants, and the ability
  to post reminders inside anonymous games. Directors may not play in their own
  tournaments, and approval must precede advertising. Separately there is a
  standing league with six divisions and promotion and relegation.
  Source: <https://webdiplomacy.net/tournamentInfo.php>
- **Accounts and integrity.** Email registration, one account per person, second
  accounts are a permanent-ban offence. The **registration captcha is a
  Diplomacy question**: click France's three supply centres on a map. It filters
  bots and non-players in one step. Anonymous games hide display names, and
  discussing usernames inside an anonymous tournament game is forbidden. There
  is a "Lodge cheating suspicion" button in-game, automated cheater detection
  whose method is not published, and a way to exclude suspected cheaters from
  your own games. Public accusations are themselves a rules violation. Private
  games use an invite code, and the rules require one for any game among people
  who know each other offline.
- **Bots.** webDiplomacy was the first Diplomacy site to host AI opponents. Its
  game data trained DeepMind's and Meta's work; CICERO was trained on 125,261
  webDiplomacy games and played on the live site. You can create a no-press
  game against bots on Classic and both 1v1 maps.
- **Replay and spectating.** Finished games are fully public with no login.
  `board.php?gameID=X&viewArchive=Orders` gives a phase-by-phase order log with
  a season index and per-turn large-map links; `viewArchive=Messages` gives the
  press archive. That is proper turn scrubbing, built out of static per-turn
  PNGs rather than a replay player. DATC results are published at
  <https://webdiplomacy.net/datc.php>, with the honest caveat that only
  movement-phase tests are run; retreat and build tests were never attempted.
- **Mobile.** Responsive, with an "Enable Desktop Mode" toggle in the footer.
  No native app. A service worker and Web Push code exist in the repo; whether
  it is installable as a PWA is unconfirmed.
- **Open source.** AGPL-3.0. `github.com/kestasjk/webDiplomacy`, PHP, 209 stars,
  115 forks, 3,522 commits, last push 2026-08-12, with commits as recent as
  2026-07-19. Live, but effectively a one-person project since 2021; recent
  pull requests are almost entirely Dependabot. No framework, MySQL with `wD_`
  prefixed tables, Redis, a standalone Node.js SSE server for live updates, and
  phpBB 3.3 vendored for the forum. The React beta builds to `beta/`.
  The maintainer keeps a `CLAUDE.md` in the repo root.
  `github.com/webdiplomacy/webDiplomacy` returns 404; that org exists with zero
  repos and was last touched in 2022.
- **There is a public REST API**, at `api.php`, with bearer-token auth and
  per-key permission rows. Roughly 20 endpoints: `game/status`, `game/data`,
  `game/orders`, `game/members`, `game/sendmessage`, `game/getmessages`,
  `game/setvote`, `game/join`, `game/leave`, `players/cd`,
  `players/missing_orders`, `players/active_games`, the four `sandbox/*` calls,
  `push/*` and `sse/authentication`. One key can drive several seats through a
  `multiplexOffset` that encodes the account into the game id, which is how the
  seven-bot Docker image works. Keys are granted rather than self-service, and
  the API exists mainly for research bots.
  Docs: <https://webdiplomacy.net/doc/webDiplomacy%20API%20-%20Quick%20start.pdf>
- **How it is funded, which changed recently.** The site sells redacted,
  anonymised press corpora to AI research organisations under NDA, and says so:
  the donations page explains this "helps fund the project, and is what lets us
  run our full-press AI bots (including the two very expensive 4090 GPUs
  required to run them)". A footnote dated 2025-06-02 retracts the twenty-year
  no-ads, no-charges promise. CICERO played 40 anonymous games in a blitz league
  there between 2022-08-19 and 2022-10-13, scoring 25.8% mean against 12.4% for
  its 82 opponents.

**Worth stealing:** the `per rulebook` press mode, the save/ready split, the
Reliability Rating formula, the private notes tab, and the supply-centre
captcha.

### 1.2 vDiplomacy: vdiplomacy.com

A webDiplomacy fork run by Oliver Auth, for variant players. The footer reads
"based on webDiplomacy version 1.66 -vDip. 74", so it is a fork that has drifted
about fifteen minor versions behind upstream and gained its own feature set.

Auth is also credited on webdiplomacy.net as the author of several of its own
variants. This is a testbed, not a schism: the repo was created one day after
kestasjk's. The site says so plainly: "The main webdiplomacy.net is very careful
about adding new variants, so this is a place where developers can test their
ideas." Source: <https://www.vdiplomacy.com/features.php>

- 28,324 registered users, 330 active games, 39,588 finished. A fourteenth of
  webDiplomacy by registration, but **80% of its active game count**. Games here
  carry more players each, so that overstates the player base, and it is still a
  healthier site than the account number suggests.
- **197 active variants**, against webDiplomacy's 11. Machiavelli, Known World
  901, Fantasy World, Mars, Chesspolitik, Sengoku, Divided States at 50 players,
  World War IV at 35 to 36, several Fog of War Classics. Per-variant pages give
  games finished, average duration in turns, a land/coast/sea breakdown, the
  solo threshold, and credit to both the original designer and the adapter.
  That is what makes a 197-variant library navigable rather than overwhelming.
- **What it adds over upstream**, all listed on its features page:
  pregame chat during the fill phase;
  **order preview on the map before you save**, plus a toggle to hide move
  arrows;
  **country selection at join time**, first come first served, instead of random
  assignment only;
  a **sitter system** that hands a seat to a substitute temporarily;
  a **concede vote**, where all but one player can end a game early;
  an **extend vote**, where two thirds of active players add four days to a
  phase, repeatable, with no moderator involved;
  an NMR civil-disorder phase that extends the clock so a replacement can be
  found;
  user blocking from a profile;
  anonymous forum posting tied to anonymous games;
  custom supply-centre targets and turn limits per game;
  downloadable variant code from the variant pages.
- **No sandbox.** A forum thread asking for one is answered by pointing people
  at Backstabbr, "it has a sandbox, it's only for the Classic variant though",
  and at gamesbyemail.com. Source:
  <https://vdiplomacy.com/forum.php?viewthread=86868>
- Maps use the old GD PNG pipeline. No React frontend, no SSE server. The fork
  has `Map2/` and `interactiveMap/` directories upstream lacks, unread, so its
  rendering approach is not fully known.
- AGPL-3.0, version 1.66-vDip.74 against upstream's 1.81, so roughly five
  versions behind. Last repo push 2025-04-21, nothing in 2026. Whether it
  carries webDiplomacy's `api.php` is unconfirmed; the API postdates 1.66.
- No face-to-face features at all.

### 1.2b The rest of the webDiplomacy family

Small, and mostly dead. Included because it shows how thin the field really is.

- **webdiplomacy.ru.** Alive and being worked on in 2026, which surprised me.
  Descends from vDiplomacy (its footer credits "webDiplomacy & vDip"). 139
  active variants installed, roughly 4,000 users, 3 open and 14 active games, a
  running tournament. Russian interface, recent source comments in Ukrainian.
  The only fork shipping features this year.
- **webdiplomacy.it.** Frozen. Version 1.80, but the front page says game
  processing last ran 2025-11-28 and the server is in admin-only maintenance.
- **diplomacy-network.com.** German, effectively dead. 3,665 registered, one
  active game, processing stopped in July 2026.
- Dead outright: webdip.info, phpdiplomacy.net, diplomacynexus.com,
  diplomacy.s-website.de, dipbounced.com.
- **The French sites are not forks.** diplomania2.fr is live and runs a Brython
  app, Python compiled to the browser, built by the Association Francophone des
  Joueurs de Diplomacy. It replaced 18centres.com and diplomatie-online.net,
  both down since 2020.
- **The AI research forks all went quiet.** `adamlerer/webDiplomacy` (Meta FAIR,
  last push 2022-11-18, five days before the CICERO paper),
  `SHADE-AI/webDiplomacy` (DARPA), `c-flaherty/webDiplomacy`,
  `jataware/webDiplomacy`, `ppaquette/webDiplomacy` (MILA). A burst in 2022 and
  nothing since.

I found no Chinese-language platform. `webdiplomacy.org` has never been a
Diplomacy site; the domain does not resolve and its only archive captures are an
Italian spam blog.

The living ecosystem is **two English sites plus one small Russian one**.

### 1.3 Backstabbr: backstabbr.com

Not the biggest, but the one the competitive and tournament scene actually uses.
Built by Tile Games, Seattle. Public since at least October 2014. Free, closed,
funded by a Patreon showing 20 paid members. A hobby project carrying the
competitive scene.

- **Play modes.** Async only, but the deadline floor is every 15 minutes, which
  fakes a live game. Settings, read from the unauthenticated
  `/game/<slug>/<id>/ajax/info` endpoint:
  - adjudication cadence from every 15 minutes to once per week
  - a **per-phase multiplier**: build and retreat phases run at 50% or 100% of
    the movement phase length
  - grace periods for late orders, on or off
  - **fast adjudication**, opt-in per player per turn, with an anti-rush rule.
    With period `T` and remaining time `R`, if `R < T` the next deadline becomes
    `R + T`; otherwise `R` is unchanged. Resolving early never shortens the next
    turn for anyone.
  - weekend skip
  - a first-turn extension, defaulting to a week, for Spring 1901 negotiation
  - a per-game time zone
  - an End Year that auto-ends the game in a chosen Winter
- **Civil disorder.** Unordered units hold. Unordered retreats disband. Forced
  disbands take the unit furthest from a home centre first.
- **Press.** Effectively binary: full press, or gunboat. Press is off during
  retreat and build phases unless the creator opts in. There is no grey press,
  no anonymous press, no public broadcast channel. A game literally named
  "Public Press" enforces the rule with description text and the honour system.
  Messaging is threaded and email-like. **The Gamemaster reads all press**, and
  the FAQ frames that as a perk.
- **Variants: none.** Classic only, since 2014. The FAQ names variants as the
  most requested feature and explains the blocker honestly: the clickable map
  was built by hand. The board is a JavaScript object with, per province, a
  traced SVG path string, a label centre, a unit centre, a supply-centre dot,
  split-coast sub-paths, and separate land and sea adjacency maps. Twelve years
  of no variants trace back to that one data-model decision.
- **Map rendering.** Raphaël.js over real SVG, with an IE VML fallback still
  shipping in 2026. A raster `map_background.png` at 610x560 underneath; one
  invisible SVG path per province on top as the hit target; SVG text labels
  suppressed below 0.8 scale; army as a circle, fleet as a triangle.
  The order drawing is the good part:
  - move: a line inset 10px from each unit centre, plus a computed arrowhead
  - support of a move: a **dotted quadratic Bézier**, bent through a control
    point offset perpendicular by 0.05 of the span, so parallel supports do not
    collapse onto one line, ending in a small circle at the three-quarter point
  - support of a hold: a straight dotted line
  - convoy: a small wave glyph above the fleet
  - hold: a circle around the unit
  - build: a dotted ghost of the unit shape; disband: a red X
  - retreat: the same arrow renderer in orange
  - after adjudication, **black means the order succeeded, red means it failed**
  Order type, and success or failure, are carried by colour, dash pattern and
  glyph at the same time. A resolved turn is readable without a legend.
- **Order entry.** A four-state machine, `WAITING / SELECTED / SUPPORT /
  CONVOY`, with live hint text under the map. Click a unit to select. Click a
  different province to move. Click the same province again to hold. Press `s`
  for support, then click the supported unit, then click its destination, or
  click it again for support-hold. Press `c` for convoy. Keys: `s`, `c`, `h`,
  `m`, `Esc`. Every shortcut has a mirror button below the map, and that button
  row is the documented mobile path. Builds and disbands leave the map entirely
  for a radio-button table; retreats use a `<select>` per dislodged unit.
- **Illegal orders are accepted on purpose.** From the FAQ: "Diplomacy is a game
  of deceit and being able to claim that you unintentionally submitted bad moves
  is one way to lie... This is why we encourage players to use the sandbox to
  test out their moves in advance." There is no validation and no legality
  highlighting. Source: <https://www.backstabbr.com/faq>
- **The sandbox.** A private, adjudicating board with no players and no
  deadlines. You drive all seven powers and press adjudicate. Editable sandboxes
  arrived via Patreon around 2023 and add an Edit tab: place or remove armies,
  fleets and supply-centre ownership, then commit an arbitrary position. So a
  sandbox can be teleported to any board state, not only played forward from
  1901.
  **Sandboxes are public and readable without an account**, at a stable URL,
  with per-season history. Example, live and signed out: the European Diplomacy
  Championship 2024 top board,
  <https://www.backstabbr.com/sandbox/EDC-2024-Top-Board/6314920668168192>.
  Backstabbr's developer has described the sandbox as designed for
  "adjudication and showing the orders in a face-to-face game"
  (Diplomacy Games podcast, episode 57).
- **Gamemaster powers.** Pause and alter adjudication, edit settings, invite
  replacements, force adjudication, read all press. **The GM cannot submit
  orders and cannot alter the board.** In a public game a creator who takes a
  seat keeps none of the GM powers, "the risk of abuse is too high"; in a
  private game they keep pause and replace but not order or press visibility.
  This is close to our D-007 split, arrived at independently.
- **Scoring: none.** Games end on 18 centres, on an agreed draw through a
  per-player victory-condition dropdown, or on the End Year. Profiles show
  reliability and win/draw/loss only, in the form
  `Turns Made: 229 (90.2%) · Turns Missed: 25 (9.8%)`. No Elo, no ladder.
- **Accounts.** Google login only, since February 2020. Usernames carry a
  Discord-style `#NNNN` discriminator. 2 to 7 players plus an optional GM.
  Anonymity is a separate setting from press; the confirmed level hides which
  power each player holds until the game ends.
- **Spectating and replay.** Strong. Any public game renders fully to a signed
  out visitor: map, supply centres, per-turn orders, results, winner. Press is
  never exposed. Canonical URLs are
  `/game/<slug>/<id>/<year>/<season>` and `/sandbox/<id>/<year>/<season>`, so
  every phase is permanently deep-linkable. That property, not any feature, is
  why sandbox links are the community's standard citation format.
- **Mobile.** Responsive Bootstrap 5. Hover handlers are skipped entirely when
  `"createTouch" in document`, so touch users get click-only with no highlight
  preview. A PWA manifest exists but the service worker is actively
  unregistered, gated behind a `pwa_beta` flag, with a code comment calling it
  "the pre-incident PWA attempt". No native app.
- **Integrity.** Order submissions carry a browser fingerprint, hashing the
  WebGL renderer, a canvas fingerprint, audio, screen, timezone and hardware
  concurrency. That is anti-multi-accounting infrastructure.
- **API: none, and staying none.** The FAQ says opening the source is not
  planned. But every game page embeds full state as inline JavaScript literals
  (`unitsByPlayer`, `territories`, `orders`, `stage`, `season`), so the site is
  trivially scrapable, and the tournament ecosystem scrapes it.
- **Community.** Not published. Low thousands of actives is the best guess,
  small next to webDiplomacy, but disproportionately the tournament core.

### 1.4 PlayDiplomacy: playdiplomacy.com

Commercial, owned by Volo Media Ltd, Malta. Launched December 2007.

- Alive but not developed. 106 active games listed publicly. The homepage
  carries a notice about "games crashing on deadline"; the blog now runs SEO
  filler about casinos and CS skins.
- **Play modes.** Async, with separate deadlines for orders, retreats and
  builds, from 12 hours to 7 days. Early resolution when all finalise, unless
  the creator picks fixed deadlines. A "No Weekend" rule pushes a Friday
  midnight deadline to Sunday, then randomly into Monday. Live games are one
  sitting with 15 minutes per movement phase and 5 for retreats and builds, and
  they are **premium only**.
- **Press.** Full press, public press only, gunboat, anonymous, and "anonymous
  countries" where players are known but power assignment is hidden.
- **Variants.** Rule variants (Fleet Rome, Winter 1900, Build Anywhere, Age of
  Empires, Chaos, Fog of War, Stuff Happens, Escalation) and maps (Milan,
  Ancient Mediterranean, 1900, Versailles, Hundred, War in the Americas). Most
  are premium.
- **Order entry.** Click the map, or type written orders as a fallback. Mobile
  is the weak point. A dropdown-based mobile order interface was built and never
  shipped. A reviewer notes you cannot tell whether a tap registered, because
  only the text updates.
- **Scoring.** A deliberately secret modified Elo, split by category, plus a
  points-staking economy. Player classes gate access: an "Ambassador" finished
  their last three games and entered orders 97% or more of the time, and
  "Ambassadors only" games exclude everyone else. "NMR Protect" auto-surrenders
  a player who misses phase one and resets the game.
- **Monetisation.** Premium is a one-time payment, priced inconsistently across
  the site's own pages (25 USD on one, 12 EUR per year on another). Single-game
  credits at 5 USD.
- Closed source, no public API. On-site tournaments for premium members. School
  games with a teacher moderator.

**Worth stealing:** the reliability class, not the Elo. A "97% of orders entered
on time" badge does more for game quality than any rating.

### 1.5 Diplicity, godip, dipact, Droidippy

The godip family, which matters to us because D-001 vendors godip.

The important correction to `DESIGN.md`'s picture: **the zond stack is dead and
the project has changed hands.**

1. **Droidippy** (2011), Android native, by Martin Bruse (zond). Unpublished
   from Google Play on 2017-12-01.
2. **`zond/diplicity`**, the Go App Engine REST service. Last commit
   2024-06-17. GPL-3.0, 22 stars.
3. **`zond/dipact`**, the React PWA at diplicity.com. Its last two commits, in
   May and June 2024, are titled "Add shutting down warning" and "Update
   shutting down message". GPL-3.0, 12 stars.
4. **`johnpooch/diplicity-react`** is the live successor, a Django plus React
   rebuild by John McDowell. Pushed **2026-08-28**, the day I measured. This is
   what diplicity.com serves now.
5. An **iOS app** shipped 2026-04-23 and is at version 1.11.
   <https://apps.apple.com/us/app/diplicity/id6759169536>

- **godip itself.** GPL-3.0, last push 2025-11-14. I counted the variant
  directories directly through the GitHub API: **21 variant packages** on disk
  (ancientmediterranean, canton, chaos, classical, classicalcrowded, coldwar,
  empiresandcoalitions, europe1939, fleetrome, franceaustria, hundred,
  italygermany, northseawars, pure, sengoku, twentytwenty, unconstitutional,
  vietnamwar, westernworld901, year1908, youngstownredux), plus `beta`,
  `common`, `generator` and `testing`. `DESIGN.md` §2.2 says 26. One of the two
  numbers needs re-measuring, and the discrepancy is probably registered
  aliases versus directories.
- **Play modes.** Async only. Deadlines from 1 hour to 2 weeks. Two deadline
  models: a duration, or a **fixed wall-clock time plus a timezone and a
  frequency**, so deadlines land at the same hour every day instead of drifting.
  Zero, one or two automatic extensions for a missed deadline. A single-player
  sandbox with no timers.
- **Press.** Standard, gunboat, sandbox. The channel model survives from the old
  design: conference (everyone), private (exactly two), group (anything
  between), created by any player over members they choose. **Phase resolutions
  are interleaved into the press log**, so you can see what happened in the
  middle of a conversation.
- **Map rendering.** The most interesting engineering in this survey. Maps are
  authored as DSVG, an SVG carrying `data-*` attributes for province type,
  adjacency, supply-centre status, home nation and starting units, so one file
  is both the picture and the rules graph. The parser splits it into a base
  layer, rasterised once per phase for speed, and an overlay layer of units and
  order arrows kept as vector and repainted on interaction. **Leaflet** hosts
  the whole thing and owns pan and zoom. Province hit testing is polygon ring
  collision against decimated, flattened paths, not SVG hit targets. Zoom caps
  at 4x. Hover is enabled only on non-touch platforms.
- **Order entry.** A wizard state machine, `source → orderType → target → aux →
  namedCoast`. Only orderable provinces respond to a tap. Tap your unit, and a
  **floating menu opens at the tap location** listing the legal order types,
  each showing its keyboard shortcut on desktop. Each subsequent step
  re-highlights only the legal choices and advances on tap. A banner shows
  running progress ("Army Hold"). Closing the menu resets the whole wizard;
  there is no per-step undo. A separate orders list view shows an accordion per
  power with each unit's order or "Order not provided", a per-order trash icon,
  and one footer button toggling "Confirm orders" and "Orders confirmed".
- **Ratings gone.** Old Diplicity gated games on Glicko rating, reliability
  (phases without an NMR) and quickness. The new user profile has no rating
  field at all, only a categorical `commitment` value shown as a badge, with a
  "committed players only" filter.
- **API and licence.** The old service exposed a public HATEOAS-flavoured
  REST/JSON API. The new Django service uses `drf-spectacular`, so an OpenAPI
  schema is generated; I did not confirm it is publicly reachable.
  **`johnpooch/diplicity-react` has no licence file.** godip and the old repos
  are GPL-3.0. Do not copy code from the new client.
- **Community.** Small. 12 stars, 10 App Store ratings.
- There is a `packages/variant-creator` and a `docs/variants/` series aimed at
  letting a non-programmer author a variant in Inkscape and generate the Go
  code, the migrations and the client geometry from one SVG. Two of the
  documents are still marked "To Be Written". It is the same idea as our D-016
  translator, from the other end.

### 1.6 diplomacy/diplomacy: the research engine

<https://github.com/diplomacy/diplomacy>. AGPL-3.0, Python, 179 stars.
**Frozen.** Last real code change April 2020; last commit on master 2020-06-01.
30 open pull requests nobody is merging. `DESIGN.md` §2.5 lists it as
"last push 2024-02" and that appears to be wrong.

Not a place to play. It is the reference engine behind Facebook's no-press work
and CICERO. Worth knowing for two things:

- **Replay is the best of any platform I looked at.** Left and right arrows, a
  dropdown of every past phase, keyboard navigation with arrows plus Home and
  End, and a checkbox to overlay the orders on any historical phase.
- **Order entry is order-type-first**, the opposite of Diplicity and Backstabbr:
  pick H/M/V/S/C/R/D/A/F, then click provinces to fill a path, with per-step
  legality checks. On touch this is worse, and it is a useful negative result
  for D-019.

Each variant map is a hand-converted React JSX component. Four maps only.

### 1.7 diplomacy.mylootcave.com: the direct competitor

**This is the finding that most affects `DESIGN.md`.** It did not exist when
the brief was written.

A free web Diplomacy adjudicator by Juan Sebastián Sanabria Barreto (BGG user
Mohevius, Colombia), posted to BoardGameGeek on 2026-07-15. I fetched the page
directly: it is a single 699 KB HTML file, version `v1.2.0 20260803.0517`, with
a web app manifest.

Its own meta description: "Free online Diplomacy adjudicator **for
face-to-face games**. DATC-compliant order resolution, **hot-seat secret
orders**, war-room timer and referee guide. ES · EN · PT · FR".
Its Open Graph description: "Seal your orders in secret, let the engine resolve
the turn, and read every betrayal in the dispatches. 167/167 DATC. EN · ES · PT
· FR. **No accounts, no install.**"

Confirmed from the source:

- Hot-seat. The string "Pass the device to" is in the file. One device goes
  round the table and each player seals their orders in turn.
- No accounts, no install, PWA manifest, `localStorage`, and an
  "OFFLINE-FRIENDLY" badge.
- Four languages.
- Retreats, builds and convoys are all implemented. Order arrows are drawn.
- A phase history and replay (`G.history[hi]`, `replay-${hi}` element ids).
- Export and import of a game.
- A negotiation timer, and an "Edit time" control.
- A **"Referee guide: move the pieces"** screen. After adjudication it tells the
  human piece pusher what to physically do to the board.
- A **"Winter projection"** screen, showing where supply-centre counts are
  heading before the adjustment phase.
- An "Invalid orders" screen and a "Situation map".
- Resolution logic derived from godip; claims 167 of 167 DATC cases.
- Closed source as far as I can tell; the whole app is one minified HTML file.

Feedback on the BGG thread was thin. Two responses. One thanks. One from a
player in Italy raising two objections: **you cannot enter a deliberately wrong
order**, and **click-based entry may be too slow.**

Sources: <https://diplomacy.mylootcave.com/> and
<https://boardgamegeek.com/thread/3737951/free-web-based-diplomacy-adjudicator-datc-complian>

### 1.8 avieth/diplomacy-server: dormant prior art for our exact idea

<https://github.com/avieth/diplomacy-server>. Haskell, BSD-3-Clause, 6 stars,
45 commits, last push **2017-11-11**. Dead.

Its README describes our model almost word for word: "Play the board game
Diplomacy over HTTP", where "players may participate via their own private
devices, so long as they have network capabilities and a good web browser".
It has an HTTPS server, administrator controls, game creation, player
management, automatic advancement, and manual pause and resume. The author
calls the client "not-so-user-friendly" and says an improved interactive map
would be valuable.

So the idea has been had, in 2015, and abandoned for want of a client. That is
the useful lesson: the server is not the hard part.

### 1.9 Conspiracy: dead

An Android-only Diplomacy client by Badfrog, a three-person French team.
Public from around 2017, **shut down at the end of September 2024** after "10
years, including more than 7 years online". Async with deadlines, full press
through an in-app messenger, 9 UI languages, and **9 maps** sourced from the
vDiplomacy variant community. Elo scoring extended past two players. 50,000+
Play Store installs, 4.1 to 4.2 stars from roughly 1,200 raters, and reviews
complaining about low player counts.

Two lessons. A three-person team shipped 9 variants where Backstabbr has shipped
none in twelve years, so the variant wall is a data-model problem, not a
resourcing one. And a good client dies anyway without a player base.

The premise that Conspiracy was Discord-integrated does not hold. Badfrog ran a
community Discord with no gameplay integration. `conspiracy.gg` is unrelated.

The closest live thing to a Discord-native platform is
<https://github.com/felixludos/digi-diplo>, Python tooling built to run games
through a Discord bot or a human GM.

### 1.10 Official Hasbro / Avalon Hill / Renegade

**There is no official digital Diplomacy on sale anywhere, and none announced.**

- Renegade Game Studios licensed Diplomacy from Hasbro on 2022-10-06. The
  announcement names hobby, mass and specialty markets. Physical tabletop only.
  No digital, video game or app rights are mentioned.
  Products since: Diplomacy (Aug 2023, $55), Diplomacy: Era of Empire (Sep 2025,
  $60), Diplomacy: The Golden Blade card game (Sep 2026 pre-order, $30), a
  neoprene deluxe map and a token pack (both Sep 2026). No app, no companion
  app, no Steam release.
- **Paradox's Diplomacy (2005)** is delisted everywhere. Metacritic 58. It had a
  **sandbox mode for adjudicating external play-by-email and face-to-face
  games**, which is the Backstabbr sandbox idea twenty years early. Only the
  demo survives, on the Internet Archive.
- Earlier official versions: Computer Diplomacy (Avalon Hill, 1984) and Avalon
  Hill's Diplomacy (Hasbro Interactive / MicroProse, 1999, panned).
- No official mobile app has ever existed.
- **No online Diplomacy site has ever been licensed**, and I found no record of
  a cease-and-desist against any of them. The exposure is the trademark on the
  name, not the rules. That is consistent with `DESIGN.md` §8 and D-015.

Also empty: Board Game Arena has no Diplomacy (only a locked 2018 feature
request). Vassal and Tabletop Simulator have community modules, but they push
pieces and do not adjudicate.

### 1.11 Historical desktop tools

- **jDip.** Last real release 1.7.0 Preview 1, June 2005. The GitLab revival
  page still shows the 2005 content. Its DATC compliance table is still the
  reference format. It remains the only tool with a real face-to-face mode, and
  that mode means passing one laptop around the table.
- **Realpolitik.** SourceForge shows 1.6.6 from 2013-04-09, C++, Artistic
  Licence. Point-and-click adjudicator with game history and text plus bitmap
  reports for GMs. Effectively dead. Two revival repos exist,
  `Tesseractcubed/Realpolitik-CE` (last touched 2026-01-08) and
  `Realpolitik-CE_py`, both at zero stars.
- **DPjudge.** <https://diplom.org/dpjudge/>. Manus Hand's web front end, 30+
  maps, Payola, Blind and Garrison rule sets, GameMaster status files. Still up,
  frozen; the copyright line reads 1995 to 2008.
- **nJudge / USDP email judges.** The Judge User's Manual is still online at
  <https://diplom.org/~njudge/docs/manual-all.htm> and remains the best
  reference for order syntax and GM commands.
- **DATC**, by Lucas Kruijswijk. v3.0 at <https://webdiplomacy.net/doc/DATC_v3_0.html>,
  v3.2 at <https://petermc.net/diplomacy/datc_v3_2.html>. 167 cases in the
  numbering mylootcave quotes.

### 1.12 The tournament stack: dipvis / DipTV

The piece of infrastructure `DESIGN.md` does not mention and probably should.

**dipvis** (<https://github.com/UEWBot/dipvis>, Django, GPL-3.0, by Chris Brand)
runs publicly as **DipTV** (<https://diplomacytv.com/>). It handles registration,
roll call, board seeding, scoring, live standings, score graphs, awards and
best-country tracking, and it emits **Classification CSV and Boards CSV** in the
format the World Diplomacy Database ingests, with a Tournament Director's user
guide. It distinguishes `FTF` from `vFTF` as tournament formats.

It also **scrapes Backstabbr**. `visualiser/tournament/backstabbr.py` uses
requests and BeautifulSoup, handles both `game/` and `sandbox/` URLs, and gives
tournament directors an "Import SC Counts from Backstabbr" action. Tournament
pages publish links to every board's sandbox. Verified on WDC at Whipping 2025
(117 players, 51 boards, FtF) and WDC Athens 2026.

Its `game_scoring/` directory is the best public catalogue of what tournaments
actually run, each with tests: `carnage`, `sum_of_squares`, `cdiplo`,
`cdiplo_namur`, `bangkok`, `bangkok_pike`, `tribute`, `open_tribute`,
`detour09`, `manorcon`, `whipping`, `haight`, `draw_size`, `your_draw_size`,
`world_classic`, `southern_sun`, `sydney_league`, `vulcan`, `maxonian`,
`mischief`, `duct_tape_v2`, `base3`, `solos`, `ranked_classic`,
`open_mind_the_gap`.

So the real 2026 pipeline for a face-to-face tournament is:

```
paper orders → physical board → one Backstabbr sandbox per board
  → dipvis scrapes supply-centre counts → scores and standings
  → CSV → World Diplomacy Database / World Diplomacy Reference
```

Backstabbr sits in the middle of that pipeline and knows nothing about it.

Also worth knowing: **Backstabbr Extras** (<https://backstabbr-extras.com/>,
MIT, browser extension plus an Android app) is a community-written list of
everything Backstabbr lacks. It adds illegal-move detection with red province
outlines, order drafts, auto-save, per-country order filtering in history, press
notes and pinned chats, supply-centre graphs with HTML and PDF export, and seven
themes.

### 1.13 How face-to-face tournaments actually run in 2026

I read the rulebooks rather than the forums.

**WDC 2026, Athens, 22 to 24 May 2026, 97 players.**
<https://athensdiplomacy.club/wdc2026/rules-and-code-of-conduct/>

- Orders go on paper into a physical box. No player may touch another player's
  orders. Only the writer may retrieve their own sheet before the deadline.
- **Spring phases are 17 minutes. Fall phases are 15.** That budget covers order
  writing, reading, adjudication, retreats, centre counts and adjustments. The
  whole mechanical overhead of a season has to fit inside it, alongside the
  negotiation.
- Every board names three roles: an **order reader**, a **piece pusher**, and a
  **sandboxer**.
- "Games are sandboxed in Backstabbr where possible. Where there is any
  discrepancy between the board and the sandbox, **the board state will
  prevail**."
- Order interpretation is **deliberately lenient**. A misorder only counts as
  one when the writing is genuinely ambiguous, a coast is missing where it
  matters, or the province named bears no resemblance to a reasonable order.
- Scoring: an Olympic-method variant. In a draw, 1 point per centre plus a
  shared 12-point dominance bonus plus 3 for survival. A solo is 46 to the
  winner and zero to everyone else.

**ManorCon.** <https://manorcon.org.uk/diplomacy-tournament/> Paper. "Get your
orders in the box by the deadline." "Do not mark order sheets while
adjudicating." No software mentioned at all.

**Carnage.** <https://carnagecon.com/diplomacy/> Looser. No central clock,
boards agree their own timing, 15 minutes per season by default. Carnage
scoring, lead-based with a centre tiebreaker and a prohibitively large solo.

Same picture at EDC 2025, DixieCon and WDC 2027 (18 minute Spring, 14 minute
Fall on a central clock).

**Nobody is entering orders on a phone at any of these events.** I searched
specifically for it and found nothing: no tournament doing it, no documented
experiment, no forum thread proposing it. Reddit and Discord index poorly, so
treat "nobody has tried this" as probable rather than proven.

### 1.14 Scoring systems, briefly

Two families, per the North American Diplomacy Federation
(<https://www.thenadf.org/play/>): draw-based, where your score depends on how
many people share the draw, and centre-based, usually with a board-top bonus.

Draw-based: Calhamer / Draw-Size Scoring, Armada/Regatta, Dragonfly.
Centre-based: PPSC, **Sum of Squares** (each survivor's centre count squared, as
a share of the total; common at face-to-face events because it works under a
time limit and does not drag games out to farm eliminations), **C-Diplo** (per
centre plus 38/14/7 placement bonuses), **Carnage** (lead-based), **Tribute**
and **OpenTribute** (survivors pay the board topper), **Bangkok**.
Board-topping is a modifier, not a system.

Existing open implementations to fork rather than re-derive: dipvis
`game_scoring/` (GPL-3.0), and
<https://gitlab.com/diplomacy-things/diplomacy-score-calculators>.

Ghost Ratings is a separate thing: an Elo-derived player rating by TheGhostmaker,
used on webDiplomacy and vDiplomacy, weighted by opponent strength and weighted
down for limited press and variants.

---

## 2. Feature matrix

`Y` yes, `N` no, `~` partial or awkward, `?` not verified.

| | webDip | vDip | Backstabbr | PlayDip | Diplicity 2026 | diplomacy/py | mylootcave | jDip | 1901 (planned) |
|---|---|---|---|---|---|---|---|---|---|
| Async deadlines | Y | Y | Y | Y | Y | Y | N | N | ~ (GM-armed) |
| Live / real-time | Y | Y | ~ (15 min floor) | premium | N | N | Y (table) | N | Y |
| Face-to-face at a table | N | N | ~ (sandbox, 1 screen) | N | N | N | Y (hot-seat) | Y (1 laptop) | **Y (per player)** |
| Per-player device order entry | N | N | N | N | N | N | **N** | N | **Y** |
| Full press | Y | Y | Y | Y | Y | Y | N | N | later (D-023) |
| Public / broadcast press | Y | Y | N | Y | Y (conference) | Y (global) | N | N | N |
| Grey / anonymous press | N | N | N | Y (anon) | N | N | N | N | N |
| Gunboat | Y | Y | Y | Y | Y | N | n/a | n/a | Y (D-023) |
| Press off in retreat/build | Y (`per rulebook`) | Y | Y (default) | ? | ? | N | n/a | n/a | open (Q-004) |
| Variants | 11 | **197** | **0** | ~14 | 3 live of 21 in godip | 4 | 1 | 18 | 21+ (D-014) |
| Map tech | GD PNG, SVG for Classic only | GD PNG | Raphaël SVG on raster | JS map | DSVG + Leaflet, raster base | inline JSX SVG | inline SVG | Batik SVG | SVG island (D-017) |
| Order arrows with success/fail colour | Y | Y | **Y (best)** | Y | Y | Y | Y | Y | planned |
| Order entry | click (Classic) or dropdowns | dropdowns + map preview | unit-first + keys | click or written | unit-first floating menu | **type-first (worse)** | click | menus | tap grammar (D-019) |
| Illegal orders allowed | N | N | **Y (deliberate)** | N | N | N | **N (complained about)** | N | **N (open question)** |
| Sandbox / free board | Y (2023, step back) | N | **Y, editable, public** | N | Y (solo) | N | n/a | n/a | n/a |
| Spectator, no login | ~ | ~ | **Y** | N | ~ | N | n/a | n/a | Y (D-013) |
| Permanent per-phase URL | ~ | ~ | **Y** | N | Y | N | N | N | not yet |
| Replay / history | Y | Y | Y | Y | Y | **Y (best)** | Y | Y | not yet |
| Mobile | responsive | responsive | responsive, no PWA | poor | **native iOS + PWA** | none | PWA | none | PWA (D-006) |
| Accounts | email | email | **Google only** | email | email + Google | username | **none** | n/a | **none for seats** |
| Anonymity | Y | Y | ~ | Y | Y (gunboat) | N | n/a | n/a | Y (D-020) |
| Commit-reveal secrecy | N | N | N | N | N | N | ~ (hot-seat seal) | ~ | **Y (D-004)** |
| Scoring systems | 2 | 2 | **0** | Elo | 0 | 0 | 0 | 0 | 0 (non-goal) |
| Ratings | Ghost Ratings | Ghost Ratings | none | secret Elo | none | none | none | none | none |
| Reliability stat | Y | Y | Y | Y (classes) | ~ (badge) | N | n/a | n/a | none |
| Tournament support | Y (TD tools + league) | ~ | N | premium | N | N | N | N | N |
| Public API | **Y (`api.php`, keys granted)** | ? | N | N | ~ (OpenAPI) | Y (WebSocket) | N | n/a | JSON |
| Open source | AGPL-3 | AGPL-3 | **N** | N | **no licence file** | AGPL-3 | N | GPL-3 | GPL-3 (D-002) |
| Offline / LAN | N | N | N | N | N | Y (self-host) | Y | Y | **Y (D-006)** |
| Registered users | 413k | 28k | ? (low k) | ? | ~10s | n/a | new | n/a | 0 |

---

## 3. Table stakes for hosted mode (D-018)

These are the things every surviving async platform has, which a hosted 1901
would be judged against. Nothing here is needed for v1.

1. **Accounts for game management only.** D-018 already says this and it is
   right. Backstabbr's Google-only login is a recognised barrier; offer
   email plus an OAuth option, not OAuth alone.
2. **Deadline machinery richer than a single duration.** The minimum set, all
   of which exist somewhere today: a per-phase multiplier so retreats and builds
   get half the movement clock (Backstabbr), a grace period, a weekend skip
   (Backstabbr and PlayDiplomacy), a longer first turn for Spring 1901
   negotiation, a per-game timezone, and a fixed wall-clock deadline that does
   not drift daily (Diplicity).
3. **Ready-based early resolution with anti-rush arithmetic.** Backstabbr's rule
   is worth copying exactly: with period `T` and remaining time `R`, if `R < T`
   the next deadline becomes `R + T`, otherwise `R` stands. Resolving early
   never shortens the next turn. Our D-008 auto-advance has the same problem the
   moment deadlines are long.
4. **Reliability on the public profile, and as a join filter.** Every surviving
   async platform has some version of it. Backstabbr shows raw counts
   ("Turns made 229 (90.2%), turns missed 25 (9.8%)"). webDiplomacy computes a
   number: average the fraction of turns without an NMR and the fraction of
   games without a civil disorder, then cube it, publish it, and let a game
   require a minimum. PlayDiplomacy turns it into classes and lets a game
   exclude everyone below "Ambassador". Abandonment is the failure mode of async
   Diplomacy and this is what manages it without moderator time. Diplicity
   dropped its reliability metric for a self-declared badge, which looks like a
   regression.
5. **Absence handled by the players, not the moderators.** Three mechanisms,
   all cheap. Excused missed turns as a per-game dial from 0 to 4
   (webDiplomacy). An extend vote where two thirds of active players add four
   days, repeatable (vDiplomacy). A sitter system that hands a seat to a
   substitute temporarily (vDiplomacy). Note that webDiplomacy's unanimous
   pause needed a written rule ("the Pause/Unpause feature is not a diplomatic
   tool") to stop it being weaponised, which is an argument for the vote
   threshold rather than unanimity.
6. **Draw voting.** Solo at 18, plus an agreed draw. Backstabbr's design, where
   every player sets a victory-condition value and may lie about it, is neat.
   webDiplomacy's separate **vote cancel**, a way to signal willingness to draw
   without the tactical cost of a draw vote, is neater. Add an end-year rule for
   timed games.
7. **Richer press modes than v1.** Full, public-only, gunboat, and webDiplomacy's
   `per rulebook`. Grey and anonymous press is a real gap on Backstabbr, which
   is the site the competitive scene uses.
8. **Public, permanent, login-free game URLs with per-phase history.** See §5.1.
   This is not a nice-to-have. It is Backstabbr's entire competitive position.
   webDiplomacy has the data (`board.php?gameID=X&viewArchive=Orders`) but not
   the shareable per-phase URL, which is why people cite Backstabbr instead.
9. **Private games by invite code**, plus a rule requiring one for games among
   people who know each other offline. webDiplomacy's anti-collusion policy is
   the mature answer.
10. **Collusion and multi-account detection.** Backstabbr fingerprints the
    browser on order submission. webDiplomacy runs a trained moderator team, a
    "Lodge cheating suspicion" button, a rule against public accusation, and a
    supply-centre captcha at registration that filters non-players. Pick some
    of these; a hosted service with none will be gamed.
11. **An API, designed in rather than bolted on.** webDiplomacy's `api.php` is
    the only real one in the field, and its `multiplexOffset` trick, one key
    driving seven seats, is what makes bot play possible. Everything else in
    this survey gets scraped instead. If 1901 ever wants bots, tools, or a
    tournament integration, this is where they attach.

**Not table stakes.** Ratings: Backstabbr has none and owns the competitive
core. In-app tournaments: nobody does them well and dipvis already owns the
job. AI opponents: interesting, expensive, and orthogonal. A large variant
catalogue: Backstabbr has zero variants and 12 years of survival.

---

## 4. Is per-player order entry at a physical table really unserved?

**The premise holds, but `DESIGN.md` §1 states it in a way that is now out of
date, and the strongest version of the argument is not the one it makes.**

### What is confirmed

- No platform in this survey offers per-player order entry at a physical table.
  Not one.
- Face-to-face tournaments run on paper. WDC 2026, ManorCon, Carnage, EDC and
  DixieCon all specify written orders into a box. Every rulebook I read says so
  explicitly.
- Backstabbr has no face-to-face mode and never claimed one. Its sandbox is one
  shared screen driven by one volunteer, exactly as `DESIGN.md` describes. Its
  own developer confirms the sandbox is used for face-to-face adjudication, and
  the WDC rules formalise that volunteer as a named role.
- jDip's face-to-face mode still means passing one laptop.

### What has changed, and what `DESIGN.md` should absorb

**A hot-seat competitor shipped six weeks ago.** `diplomacy.mylootcave.com`
(v1.0 July 2026, v1.2 on 2026-08-03) is a free, no-account, offline-friendly
PWA aimed explicitly at face-to-face tables, in four languages, claiming 167 of
167 DATC, with a referee guide, a negotiation timer, replay and export. It is
not a toy.

It is also **hot-seat**. One device is passed around and each player seals
orders in turn. That is a queue. Seven sequential handoffs do not fit inside a
15-minute WDC season, and the two objections raised on its BoardGameGeek thread
were both about entry speed and entry fidelity.

So the unserved space is narrower and sharper than "face-to-face Diplomacy
software". It is:

> **Seven people entering orders at the same time, each on their own device,
> with no device seeing another's orders.**

Parallelism is the differentiator, not the phone.

**And the idea is not new.** `avieth/diplomacy-server` described exactly this
model in 2015 and was abandoned in 2017 with a barebones client. Nobody
finished it. That is a warning as much as a validation: the server is easy and
the client is the whole product, which is what `DESIGN.md` M0 already says.

### The stronger pitch

`DESIGN.md` frames the gap as order entry. The WDC rules suggest a better frame.
Every board at a face-to-face tournament assigns three human roles: an order
reader, a piece pusher, and a **sandboxer** who types the board into Backstabbr.

1901 does not replace the reader. Reading orders aloud is the theatre of the
game and players want it. It does not replace the piece pusher either; the
physical board is the authority, and WDC says so in as many words.

**It deletes the sandboxer.** The board is already in the system, because the
players put it there. That is a concrete job removed from every table, and it is
a much easier sell to a tournament director than "phones instead of paper".

### The counter-pressure, which is real

Face-to-face culture wants sloppy orders honoured. WDC's rules go out of their
way to say so, and they are not alone. Backstabbr accepts illegal orders **on
purpose**, because being able to claim you misordered is a legitimate way to
lie. The one substantive complaint on the mylootcave thread was that you cannot
enter a deliberately wrong order.

Our tap grammar (D-019) builds orders from `Options()`, so it can only express
legal orders. That is a genuine adoption risk for tournament play, not a
theoretical one. It needs a decision. See Q-007 in §6.

---

## 5. Ten things worth stealing, ranked

Ranked by value to us, not by cost.

### 1. Public, permanent, login-free position URLs with per-phase history
**From:** Backstabbr.
**Touches:** D-013 (spectator view), post-v1 / hosted mode.

`/game/<slug>/<id>/<year>/<season>` renders the full board, orders and results
to a signed-out visitor, forever. That single property, not any feature, is why
Backstabbr owns analysis, why sandbox links are the community's citation format,
and why dipvis scrapes it. Our spectator view is already secret-free by D-013,
so the data model is done; what is missing is a stable public URL per phase.
Cheap, and it is the thing that would make 1901 spreadable.

### 2. The referee guide: tell the piece pusher what to move
**From:** mylootcave ("Referee guide: move the pieces").
**Touches:** D-013, `CONTEXT.md` spectator view, M2.

After adjudication, render the list of physical actions to perform on the board:
move this, bounce that, remove that. At WDC the piece pusher is a named role and
the season budget is 15 minutes. This is the single highest-value screen for a
real table and almost nobody has it. It falls out of `PreviouslyAppliedOrders`
plus resolutions, so it is nearly free.

### 3. Order semantics drawn into the map
**From:** Backstabbr.
**Touches:** D-003 (placements), D-023 (map styles), M2.

Specifically: black for a successful order and red for a failed one, orange for
retreats, a dotted line for a support, a wave glyph for a convoy, a circle for a
hold, a dotted ghost for a build, a red X for a disband. And the detail that
makes it work at density: **support lines are quadratic Béziers bent by a
perpendicular offset of 0.05 of the span**, so two supports of the same move do
not draw on top of each other. Our style system (D-023) should carry these as
style tokens, not hardcode them.

### 4. Decide what to do about illegal and bluff orders
**From:** Backstabbr's deliberate permissiveness, WDC's lenient interpretation
rules, and the one real complaint about mylootcave.
**Touches:** D-019, Q-004, needs a new decision.

Three options, in increasing cost: keep legal-only entry and accept the risk;
add an "allow illegal orders" game setting that switches the bottom bar into a
free-form order builder; or accept typed free-form orders as a first-class input
path alongside the tap grammar. Also encode WDC's tie-breaks: last written order
wins, a valid order beats an invalid one.

I would not build this for the first playtest, but I would ask about it there.

### 5. Split map layers, and let a map library own pan and zoom
**From:** Diplicity 2026 (DSVG plus Leaflet).
**Touches:** D-017, Q-003, M2.

Rasterise the static board once per phase and keep only units and order arrows
as vector, repainting those on interaction. Hit-test against decimated polygon
rings rather than SVG paths. Hosting the map in Leaflet gives momentum panning
and pinch zoom for free, which is exactly the Q-003 blocker the M0 phone test
found. This does not violate D-017: the map still never enters the React tree.
Worth a spike before hand-writing more pan/zoom arithmetic.

### 6. Every gesture has a keyboard shortcut and a mirror button
**From:** Backstabbr (`s`, `c`, `h`, `m`, `Esc`, each with a button below the
map) and Diplicity (shortcuts shown inside the floating order menu).
**Touches:** D-019 (the bottom bar is already the fallback path).

D-019 already has the bottom bar. Add the shortcut labels to it, and add key
handling for the GM laptop and the spectator screen. Backstabbr's live hint text
under the map ("Selected Ber. You may now: ...") is also better than our staged
hints, because it enumerates the options rather than naming the state.

Two more order-entry details worth taking, both from vDiplomacy:
**draw the pending orders on the map before the player finalizes**, so they
check a picture rather than a list; and give them a **toggle to hide the
arrows**, because a board covered in your own arrows is hard to read when you
are deciding. Neither exists upstream on webDiplomacy.

### 7. `per rulebook` press, and what it implies for retreats and builds
**From:** webDiplomacy.
**Touches:** D-023, Q-004.

webDiplomacy has a fourth press mode: press during movement phases, none during
retreat and build phases, and it says this is how face-to-face Diplomacy is
played. Backstabbr defaults to the same behaviour. This is external evidence for
Q-004: retreat and build phases are not negotiation phases. They should be fast
and they probably should not make the whole table wait on commit-reveal.

### 8. Deadline humanity: multipliers, weekend skip, anti-rush
**From:** Backstabbr; fixed wall-clock deadlines from Diplicity.
**Touches:** D-008, D-010, hosted mode.

Retreat and build phases at 50% of the movement clock. Weekend skip. A longer
first turn. Deadlines anchored to a wall-clock time in a timezone rather than
drifting by a few minutes each day. And the anti-rush formula from §3.3. None of
these matter for a LAN table; all of them matter the day hosted mode ships.

### 9. Emit what the tournament pipeline already eats
**From:** dipvis / DipTV and the World Diplomacy Database.
**Touches:** post-v1, distribution.

Tournament directors already run dipvis. It ingests Classification CSV and
Boards CSV, and it currently gets its supply-centre counts by **scraping
Backstabbr's HTML**. If 1901 emits those CSVs, or simply publishes clean JSON at
a stable URL, a tournament director's scoring pipeline works on day one and we
replace a scraper with an API. This is the cheapest route to adoption at a real
event, and it does not require us to implement any scoring ourselves.

### 10. Publish a DATC compliance table
**From:** jDip, webDiplomacy, and mylootcave's "167/167" in its own meta tags.
**Touches:** M2 and M3 acceptance criteria, trust.

Every serious tool states its DATC pass rate, and it is the first thing the
community asks. godip already carries the corpus (`DESIGN.md` §2.2). Running it
in CI and rendering the result as a page is a day of work and it is the cheapest
credibility we can buy. webDiplomacy's own table is honest about not running the
retreat and build tests; ours can beat that.

**Honourable mentions.** Interleaving phase resolutions into the press log
(Diplicity) for whenever fullpress lands. Keyboard-navigable replay with an
order overlay on any past phase (diplomacy/diplomacy, the best replay I saw).
Backstabbr's `/ajax/info` settings sheet, a plain complete shareable statement
of a game's rules, which is what our D-022 join page should aspire to.
webDiplomacy's private notes tab, where your own power's press tab is a notepad
only you can see. Its vote cancel, distinct from a draw vote. And its
registration captcha, which asks you to click France's three supply centres:
useless to us with no accounts, but the right instinct about who a product is
for.

---

## 6. What this suggests for `DESIGN.md`

Nothing here invalidates a decision. Several things date one, and one open
question is now under-specified.

### Amend §1, the gap statement
It currently reads "Nothing currently does per-player order entry at a physical
table." Still true. But the paragraph's picture of the field is now incomplete
in two ways:

- `diplomacy.mylootcave.com` (July 2026) is a serious free face-to-face
  adjudicator that is hot-seat. It should be named, and the claim should be
  narrowed from "face-to-face" to "**per-player devices, in parallel**".
- `avieth/diplomacy-server` (2015 to 2017, BSD-3) proposed our exact model and
  died for want of a client. Worth one line in §2 as prior art and as a warning.

### Amend §2.2, the godip variant count
`DESIGN.md` says 26 variants. I counted **21 variant packages** in
`zond/godip/variants` on 2026-08-28 via the GitHub API, excluding `beta`,
`common`, `generator` and `testing`. Re-measure and fix whichever number is
wrong. `DESIGN.md` §0.5 asks for exactly this.

### Amend §2.5, `diplomacy/diplomacy`
Listed as "last push 2024-02". Master's last commit is 2020-06-01 and the last
real code change was April 2020. It is frozen, and it is AGPL-3.0, which matters
if anyone ever considers borrowing from it.

### New open question, Q-007: illegal and bluff orders
The tap grammar builds orders from `Options()` and therefore cannot express an
illegal order. Backstabbr allows illegal orders deliberately and says so in its
FAQ. WDC's rules mandate lenient interpretation of ambiguous paper orders. The
one substantive complaint about the hot-seat competitor was that you cannot
write a wrong order.

Decide from playtest, not from theory, exactly as Q-004 is framed. Options are
in §5.4 above.

### Q-004 gains external evidence
webDiplomacy's `per rulebook` press mode disables press entirely during retreat
and build phases, and its FAQ says face-to-face play works that way. Backstabbr
defaults to the same. WDC gives the whole season, including retreats, centre
counts and adjustments, 15 to 17 minutes. That is an argument for running
retreats and builds fast and in the open rather than making the table wait on a
full commit-reveal round.

### D-023 could gain a fourth press mode
`rulebook`: press during movement, none during retreat and build. It is the
mode that names the actual face-to-face convention, and webDiplomacy already
proved the name is legible to players. Cheap to add to the data model now, per
D-023's own reasoning about establishing the model early.

### D-013 could gain two things
A public, permanent per-phase URL for the spectator view (§5.1), and the referee
guide screen (§5.2). Both are secret-free by construction, so neither disturbs
the D-013 property.

### Add a timing acceptance criterion to the playtest
`DESIGN.md` §7 "Then" says playtest before adding anything. Give that playtest a
number. A face-to-face season at WDC is 15 to 17 minutes including negotiation.
**Seven seats should be able to enter and finalize a movement phase in under 3
minutes of wall time**, measured from the phase opening. If the tap grammar
cannot hit that, D-019 needs the free-form path from §5.4 whether or not anyone
wants to bluff.

### Licence notes for later reuse
- dipvis is GPL-3.0. Its `game_scoring/` is compatible with D-002 and is the
  right thing to fork if scoring is ever built.
- `diplomacy/diplomacy` is AGPL-3.0. webDiplomacy and vDiplomacy are AGPL-3.0.
  Copying from any of them pulls in AGPL obligations.
- **`johnpooch/diplicity-react` has no licence file at all.** Do not copy code
  from it. Its ideas are free; its source is not licensed.

### D-003 and D-017 get outside support
webDiplomacy has run two map systems side by side since June 2022: an
interactive React SVG board for Classic, and server-composited indexed PNGs for
every other variant. Four years later the SVG path still covers exactly one
variant. The lesson is the one D-003 already takes, and it is worth recording
because the alternative failed in public: **make the map a data-driven SVG for
every variant on day one.** Retrofitting it does not happen. Our placement-table
generator running across all 21 godip variants is the right shape.

### One thing this survey confirms rather than changes
**Nobody does commit-reveal.** Not webDiplomacy, not Backstabbr, not
PlayDiplomacy, not Diplicity. Every one of them stores plaintext orders that an
operator could read. Backstabbr's answer to a playing GM is to remove the GM's
powers instead. D-004 is the strongest genuinely novel technical claim in the
project, and §1.3 shows the alternative the incumbent chose. Keep it, and say so
publicly when the time comes.

---

## 7. Unverified, and worth re-checking

Recorded so nobody treats these as measured.

- **Community size for Backstabbr and PlayDiplomacy.** Neither publishes a
  number. "Low thousands of actives" for Backstabbr is a guess from 20 Patreon
  members and the tournament footprint.
- **The webDiplomacy footer counters contradict themselves.** 7,650 users
  "playing" against 414 active games cannot both mean what they look like on a
  seven-player site; "playing" almost certainly counts everyone in a
  non-finished game, including the 1,520 joinable. The defensible figures are
  414 active games and 85 concurrent users at one instant. "Registered" is 22
  years of cumulative signups.
- **The webDiplomacy owner/moderator split** in late 2020 rests on one
  secondhand source that doubts itself, plus commit-history inference. Do not
  repeat it as fact.
- **vDiplomacy's API.** Unconfirmed. Its version predates upstream's `api.php`.
- **vDiplomacy's `Map2/` and `interactiveMap/`** were not read.
- **Diplicity's live variant list** is inferred from App Store copy and repo
  docs, not read off the running site. Its OpenAPI schema may or may not be
  publicly reachable.
- **PlayDiplomacy's premium pricing** is inconsistent across its own pages.
- **"Nobody has tried per-player phone order entry at a tournament."** Probable,
  not proven. Reddit and Discord index poorly and I could not search them.
- **mylootcave's licence and internals.** The app is one minified HTML file. I
  read its strings and metadata, not its logic.

---

## Sources

Platform pages and documentation
- <https://webdiplomacy.net/faq.php>, <https://webdiplomacy.net/points.php>,
  <https://webdiplomacy.net/variants.php>, <https://webdiplomacy.net/datc.php>,
  <https://webdiplomacy.net/ghostRatings.php>,
  <https://webdiplomacy.net/tournamentInfo.php>,
  <https://webdiplomacy.net/rules.php>, <https://webdiplomacy.net/donations.php>,
  <https://webdiplomacy.net/doc/webDiplomacy%20API%20-%20Quick%20start.pdf>
- <https://vdiplomacy.com/>, <https://www.vdiplomacy.com/features.php>,
  <https://vdiplomacy.com/forum.php?viewthread=86868>
- <https://webdiplomacy.ru/>, <https://diplomania2.fr/>,
  <https://thediptionary.uk/w-x-y-z/>
- <https://www.backstabbr.com/faq>, <https://www.backstabbr.com/how-to-play>,
  <https://www.backstabbr.com/sandbox/EDC-2024-Top-Board/6314920668168192>
- <https://www.playdiplomacy.com/help.php?sub_page=Game_Options>,
  <https://www.playdiplomacy.com/premium.php>, <https://volo.com.mt/playdiplomacy/>
- <https://diplomacy.mylootcave.com/>,
  <https://boardgamegeek.com/thread/3737951/free-web-based-diplomacy-adjudicator-datc-complian>
- <https://sites.google.com/view/diplicity/home/documentation>,
  <https://apps.apple.com/us/app/diplicity/id6759169536>

Code
- <https://github.com/zond/godip>, <https://github.com/zond/diplicity>,
  <https://github.com/zond/dipact>, <https://github.com/johnpooch/diplicity-react>
- <https://github.com/kestasjk/webDiplomacy>
- <https://github.com/diplomacy/diplomacy>
- <https://github.com/avieth/diplomacy-server>
- <https://github.com/UEWBot/dipvis>, <https://diplomacytv.com/>
- <https://github.com/realnnpg/backstabbr-extras>, <https://backstabbr-extras.com/>
- <https://github.com/felixludos/digi-diplo>
- <https://gitlab.com/diplomacy-things/diplomacy-score-calculators>

Tournament rules and hobby infrastructure
- <https://athensdiplomacy.club/wdc2026/rules-and-code-of-conduct/>
- <https://manorcon.org.uk/diplomacy-tournament/>
- <https://carnagecon.com/diplomacy/>
- <https://www.thenadf.org/play/>
- <http://www.world-diplomacy-database.com/>,
  <https://www.world-diplomacy-reference.com/>
- <https://webdiplomacy.net/doc/DATC_v3_0.html>,
  <https://petermc.net/diplomacy/datc_v3_2.html>
- <https://diplom.org/dpjudge/>, <https://diplom.org/~njudge/docs/manual-all.htm>
- <https://jdip.gitlab.io/>, <https://sourceforge.net/projects/realpolitik/>

Official product and history
- <https://renegadegamestudios.com/diplomacy-1/>
- <https://renegadegamestudios.com/blog/renegade-game-studios-expands-licensing-partnership-with-hasbro-gaming-classics/>
- <https://ai.meta.com/blog/cicero-ai-negotiates-persuades-and-cooperates-with-people/>
- <https://news.ycombinator.com/item?id=8468378>
- <https://www.projecthorseshoe.com/2013/09/17/how-to-make-great-in-situ-digital-board-games/>

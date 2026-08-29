# M1 flow contract — GM setup, invites, seats, phases

Scope: the end-to-end flow of DESIGN.md D-020/D-021/D-022 on top of the M0
spike. In-memory for now (SQLite later within M1). Classical only. Orders
are stored plainly server-side (commit-reveal is M3); "finalize" here
means: mark the seat's orders locked-in, replaceable until the phase
resolves (D-011).

Terminology per CONTEXT.md: Power (UI word), Seat, Player, Finalize,
Adjudicate, Resolution, NMR, Spectator view.

## Tokens

All tokens are random, URL-safe, ≥16 bytes entropy. Three kinds:
`gmToken` (GM control), `inviteToken` (the one shared join link),
`seatToken` (one per seat, created at claim). Device secret: random value
set as a cookie at claim; a device presenting it gets its existing seat
back (D-020). Referee secret: a fourth random value, set as a cookie at
game creation; the browser holding it may open `/game/{id}/referee/`, and
it is how the GM reaches the controls without the GM link ever being
displayed or shared.

## Endpoints

Existing M0 endpoints stay untouched (legacy sandbox mode at /g/{id}/).
New game flow lives under /game/ (server) and new pages:

- `POST /games` body `{settings}` → `{gameId, inviteUrl}`. The response
  carries no GM secret; it sets the referee cookie (see Tokens).
  Settings: `{deadlineMinutes: int (0 = no deadline), gmPlays: bool}`.
- `GET /games` → every game on the server, newest first:
  `[{gameId, variant, started, phase, joinedCount, totalSeats, turns,
  deadlineAt, createdAt, referee}]`. Public facts only — a bare id opens
  the public pages, never a seat or the controls. `referee` is true only
  for the request's browser when its referee cookie matches that game.
- `GET /new` → game-creation page (frontend).
- `GET /game/{id}/referee/` → 302 to the GM view for the browser whose
  referee cookie matches; 404 for everyone else. The address itself
  carries no secret, so the main page may offer it per game.
- GM (all under /game/{id}/gm/{gmToken}):
  - `GET  .../state` → `{settings, settingsVersion, started, phase,
     seats: [{power, joined, finalized}], joinedCount, totalSeats,
     gmPower (null until started; then the leftover power when gmPlays),
     inviteUrl, deadlineAt (RFC3339 or null), canForce: bool}`
     Seats carry NO device or identity info.
  - `POST .../settings` `{settings}` → bumps settingsVersion (allowed
     before and after start; every change event-logged).
  - `POST .../start` → 409 unless all joiner seats claimed; assigns the
     leftover power to the GM seat when gmPlays; starts phase 1 and the
     deadline clock.
  - `POST .../adjudicate` → force adjudication; only when `canForce`
     (deadline passed, or all-but-one finalized — D-007). Unfinalized
     seats resolve as NMR (units hold), event-logged.
  - `POST .../extend` `{minutes}` → push deadlineAt; event-logged.
- Join:
  - `GET  /join/{id}/{inviteToken}` → join page (frontend).
  - `POST /game/{id}/join/{inviteToken}` → assigns a random unassigned
     power under the game lock; sets device cookie; → `{seatUrl}`.
     Same device again → same `{seatUrl}`. All powers taken → 409 with a
     friendly error. When gmPlays, one power is held back for the GM.
- Seat (all under /game/{id}/seat/{seatToken}):
  - `GET  .../` → the player board page (frontend).
   - `GET  .../state` → M0-shaped state BUT: `orders`/`orderParts` contain
      ONLY this seat's power's orders; adds `you: {power}`, `settings`,
      `settingsVersion`, `started`, `deadlineAt`,
      `finalized: {power: bool}` (public), `phaseResolutions` (public,
      previous phase, all powers — resolutions are public after
      adjudication). The GM's own power additionally gets
      `refereeUrl`, the GM view address: the switch from the board to
      the controls and back.
  - `GET  .../options?province=` → 403 unless the province's unit belongs
     to this seat's power. No nation query parameter accepted.
  - `POST .../order` → same body as M0; 403 for another power's unit.
  - `POST .../finalize` and `POST .../unfinalize` → toggle; auto-
     adjudicate the moment every power is finalized (D-008). After
     adjudication all seats' finalized flags reset.
- Public (no token): `GET /game/{id}/public` → `{phase, started,
   joinedCount, totalSeats, finalized: {power: bool}, settingsVersion,
   deadlineAt}` — the polling target for join/GM/seat pages and the
   later spectator view.

## No-leak discipline (hard requirement §1, §5)

There must exist NO endpoint that returns another power's current-phase
orders. Seat state filters to own power; GM state contains booleans only;
public state contains booleans only. Resolutions and past orders become
public only after adjudication.

## Frontend pages (static/, reuse the M0 board code)

- `/` : the main page — every game on the server, "in progress" and
  "setting up", each linking its spectator view, and the referee view only
  for the browser that created the game.
- `/new`: create-game form (deadline minutes, gmPlays checkbox) →
  POST /games → show the invite link and its QR (draw locally — tiny
  embedded QR lib or canvas implementation, no CDN), and an "open the game
  master view" entry that works through the referee cookie. No GM link is
  displayed anywhere.
- Join page: shows settings (the rules) before claiming; Claim button →
  redirect to seatUrl. Already-claimed device: straight to seat.
- GM page: settings editor, invite link + QR, seat grid (power names with
  joined/finalized badges), Start button (enabled when all joined),
  deadline countdown, Extend and Force-adjudicate (enabled per canForce),
  gmPower reveal at start ("You are Austria"), event feed later.
- Seat page: the existing board UI scoped to own power: only own units
  orderable, only own orders listed/drawn during the phase; after
  adjudication show all resolutions (public). Header: "You are Austria",
  phase, deadline countdown, Finalize toggle + "N of 7 finalized",
  "rules changed" banner on settingsVersion bump.
- Poll /public every ~3s for liveness (SSE comes later per D-006).

## Non-goals here

SQLite, SSE, commit-reveal hashes, spectator page, variant choice,
identity-mode setting, event-log UI. Keep the M0 sandbox working.


## Addendum: variant picker (r14)

- `GET /variants` → list of all godip variants with an `svg/` map, each:
  `{key, name, powers: [names], powerCount, soloSCCount, totalSCCount,
   startYear, description, rules, createdBy, supported: bool,
   mapUrl: "/variants/{key}/map.svg"}`. `supported` is true only for
  classical (D-014); the rest are experimental.
- `GET /variants/{key}/map.svg` → that variant's map.
- `POST /games` gains `settings.variant` (default `classical`); the whole
  flow (start position, parser, options, nations, long names) runs on the
  chosen variant. Experimental variants get an event-log line and a
  join-page badge.
- `GET /game/{id}/public` and seat/GM state gain `variant: {key, name,
   supported}` and `provinceNames: {abbr: long}` (from godip's
   ProvinceLongNames — replaces the frontend's hardcoded table, which is
   classical-only debt).
- Frontend /new: gallery of variant cards — name, power count with the
  power names, SC counts (solo target / total), description + notes,
  "Supported" vs "Experimental — placement not verified" badge, and a map
  preview. Previews must load lazily (the SVGs are 0.6–4.3 MB; never
  fetch all eagerly). Selecting a card sets the variant for creation.

## Addendum: deadline settings, watch URLs, press mode (r18)

### Settings (D-022, D-027)

`POST /games` and `POST /game/{id}/gm/{gmToken}/settings` accept, on top of
`deadlineMinutes`, `gmPlays` and `variant`:

- `retreatBuildPercent: int` (default 50). The share of the movement clock a
  retreat or build phase gets. Rounded up, never below one minute.
- `graceMinutes: int` (default 0). How long past the deadline orders are
  still taken. The deadline shown does not move. What moves is the moment
  `canForce` turns true.
- `firstTurnExtraMinutes: int` (default 0). Added to the first movement
  phase only.
- `pressMode: "ftf" | "gunboat" | "fullpress" | "rulebook"` (default `ftf`,
  D-023). Data only, with no behaviour attached. An unknown value is a 400.
  Immutable after start, like `gmPlays`.
- `illegalMoves: bool` (default **true**, D-029). With it on, an order that
  parses but fails engine validation is stored as the player wrote it and
  marked illegal. It never enters the engine, so the unit holds, and the
  review gives it the resolution `IllegalOrder`. With it off, such an order
  is a 400, which is the strict behaviour this server had.

A settings body is a patch: a field nobody sends keeps the value it had.
That is load-bearing for `illegalMoves`, whose default is true.

Order state gains `illegal: [province]` in seat state, filtered to the
seat's own power, and in the phase review and watch JSON, where it lists
every struck order. An order that does not parse is still a 400 in both
modes: godip's parser checks the order type and the number of parts, so a
failure there means there is no order to store.

Every change bumps `settingsVersion` and is event-logged. A change to the
clock resets the deadline of the phase now running.

The arithmetic, all three rules from research/platforms.md, steal 8: the
phase clock is `deadlineMinutes`, times `retreatBuildPercent` per cent for a
retreat or build phase, plus `firstTurnExtraMinutes` on the first movement
phase. Then the anti-rush rule, Backstabbr's, copied exactly. A phase that
resolves early with `R` still on the clock, into a next phase of period `T`,
gets `R + T` when `R < T` and `R` otherwise. Resolving early never shortens
the next phase for anybody. A phase the GM forces carries nothing.

GM, seat and public state gain `graceUntil` (RFC3339 or null) and
`phaseMinutes`, the clock this phase was given.

### Public per-phase watch URLs (D-013, D-028)

- `GET /watch/{gameId}/` and `GET /watch/{gameId}/{phaseIndex}` serve the SPA
  shell. A game that does not exist is a 404, not a shell.
- `GET /game/{id}/watch` is the phase now being played.
- `GET /game/{id}/watch/{phaseIndex}` is one phase of the past.

No token. The JSON is
`{gameId, phaseIndex, phaseCount, current, adjudicated, phase, units,
  dislodged, supplyCenters, variant, provinceNames, placements, now}`, plus:

- for an adjudicated phase, `orders`, `orderParts`, `powers`, `resolutions`
  and `nmr`. That is the position the phase was played from and everything
  that happened in it. All of it is public once the phase resolves.
- for the current phase, `started`, `finalized`, `deadlineAt` and
  `graceUntil`. Never a draft order, not even the caller's own. This
  endpoint has no token and cannot know who is asking.

A phase index that has not happened is a 404. The snapshots are built by the
same replay the restore path uses, so a historical URL is stable across a
restart and a hard kill.

### Map styles are composed at serve time (D-026)

- `GET /styles` returns `[{name, title, description}]`, the default first.
- `GET /variants/{key}/map.svg?style=<name>` and `/game/{id}/map.svg` behave
  as before: the default style when none is asked for, the unrestyled art at
  `?style=original`, a 404 for a style this map has none of.
- The styled art is no longer a file. The server composes it from the
  original map, the style plan in `styleplans/{key}.json` and the style
  tokens in `mapstyles/{name}.json`, and caches it in memory per map and
  style.

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
back (D-020).

## Endpoints

Existing M0 endpoints stay untouched (legacy sandbox mode at /g/{id}/).
New game flow lives under /game/ (server) and new pages:

- `POST /games` body `{settings}` → `{gameId, gmToken, inviteUrl}`.
  Settings: `{deadlineMinutes: int (0 = no deadline), gmPlays: bool}`.
- `GET /new` → game-creation page (frontend).
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
     adjudication).
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

- `/new`: create-game form (deadline minutes, gmPlays checkbox) →
  POST /games → show GM link (bookmark warning), invite link, and a QR
  (draw locally — tiny embedded QR lib or canvas implementation, no CDN).
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

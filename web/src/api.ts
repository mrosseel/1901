/*
The server, as the pages see it.

Every page is served under the URL that carries its own tokens, so no page is
ever told where its API lives: the addresses are built from location.pathname.
Nothing here holds a token in module state — the route object does.
*/

import type { BoardState, OptionTree, Placement, Unit } from "./board/types";
import { readVariants, type Variant } from "./variants";

// --- shapes ---------------------------------------------------------------

export interface Settings {
  deadlineMinutes: number;
  gmPlays: boolean;
  /** The godip variant key. Absent means the server's default, classical. */
  variant?: string;
  /*
  Whether a player may write an order the rules do not allow (D-029). The
  server keeps it, the adjudicator throws it out, and the unit holds — which
  is what paper does and what makes a bluff possible. Absent means yes: a
  server that predates the setting accepted whatever it was sent (illegal.ts).
  */
  illegalMoves?: boolean;
}

/** What a running game says about the variant it was created with. */
export interface VariantRef {
  key: string;
  name: string;
  supported: boolean;
}

/*
Every state answer carries the variant it belongs to and that variant's long
province names, because nothing else on the page knows them: the map is one
variant's map, and "bud" is Budapest in one variant and nothing at all in the
next.
*/
export interface VariantAware {
  variant?: VariantRef;
  provinceNames?: Record<string, string>;
  /*
  The variant's approved marker positions, from placements/<key>.json on the
  server. Null when that variant has no approved table and the board must fall
  back to the map's own anchors. It rides with the state rather than with the
  variant catalogue because the board is handed state and nothing else.
  */
  placements?: Record<string, Placement> | null;
  /*
  The server's own clock, RFC3339. Every countdown is measured against it,
  because a phone at the table can be minutes out (see clock.ts).
  */
  now?: string;
  previousPhase?: PreviousPhase | null;
}

/*
The phase that was just adjudicated, in full and for every power — public the
moment it resolved. It is what the review overlay draws, and it carries no
current-phase orders, so it leaks nothing (M1 contract §5).
*/
export interface PreviousPhase {
  phase?: BoardState["phase"];
  /** province → the prose sentence, one per ordered unit, all powers. */
  orders?: Record<string, string>;
  /** province → the raw parts, which is what the map draws from. */
  orderParts?: Record<string, string[]>;
  /** province → the power that ordered there. */
  powers?: Record<string, string>;
  /** province → "OK", or the reason it failed. */
  resolutions?: Record<string, string>;
  /** Units thrown out by this adjudication, by the province they left. */
  dislodged?: Record<string, Unit>;
  /** Powers that gave no orders at all: their units held. */
  nmr?: string[];
}

/*
The spectator feed, for the shared screen (D-013).

It is the public board and nothing else: units, centres, the phase, the clock
and — for a phase that has already resolved — that phase's orders and their
outcomes. There is no seat here, no token, and no endpoint that could carry an
order back, which is what makes the page read-only in the sense D-013 means:
nothing on this view can create or change an Order.

`phaseIndex` addresses one phase of the game's history; without it the feed
answers with the live one. `phaseCount` is how many resolved phases there are,
so the page can offer prev and next without guessing.
*/
export interface WatchState extends VariantAware {
  gameId: string;
  phase: BoardState["phase"];
  started: boolean;
  /** Which phase this answer is, counting resolved phases from zero. */
  phaseIndex?: number;
  /** How many phases the game has: the live one is the last. */
  phaseCount?: number;
  /** True when this is a resolved phase rather than the one being ordered. */
  historical?: boolean;
  units?: Record<string, Unit>;
  dislodged?: Record<string, Unit>;
  supplyCenters?: Record<string, string>;
  /** Only ever a resolved phase's orders — never the live one's. */
  orders?: Record<string, string>;
  orderParts?: Record<string, string[]>;
  /** province → the power that ordered there. */
  powers?: Record<string, string>;
  resolutions?: Record<string, string>;
  /** Powers that gave no orders in this phase. */
  nmr?: string[];
  finalized?: Record<string, boolean>;
  finalizedCount?: number;
  totalSeats?: number;
  deadlineAt: string | null;
}

export interface CreatedGame {
  gameId: string;
  inviteUrl: string;
}

export interface GmSeat {
  power: string;
  joined: boolean;
  finalized: boolean;
  isGm?: boolean;
}

export interface GmState extends VariantAware {
  gameId: string;
  settings: Settings;
  settingsVersion: number;
  started: boolean;
  phase: BoardState["phase"];
  seats: GmSeat[];
  joinedCount: number;
  /** Seats a joiner may claim: six when the GM plays, otherwise seven. */
  totalSeats: number;
  gmPower: string | null;
  inviteUrl: string;
  deadlineAt: string | null;
  canForce: boolean;
  gmSeatUrl?: string | null;
  events?: string[];
}

export interface PublicState extends VariantAware {
  gameId: string;
  phase: BoardState["phase"];
  started: boolean;
  joinedCount: number;
  totalSeats: number;
  finalized: Record<string, boolean>;
  settings: Settings;
  settingsVersion: number;
  deadlineAt: string | null;
}

export interface SeatState extends BoardState, VariantAware {
  you: { power: string };
  settings: Settings;
  settingsVersion: number;
  started: boolean;
  deadlineAt: string | null;
  finalized: Record<string, boolean>;
  youFinalized: boolean;
  finalizedCount: number;
  /** Powers that must finalize before the phase resolves. */
  totalSeats: number;
  phaseResolutions: Record<string, string>;
  canForce: boolean;
  /**
   * Set only on the game master's own seat: the address of the controls,
   * so the GM can switch between the board and the referee view.
   */
  refereeUrl?: string;
}

/**
 * One row of the main-page list. Everything here is what a bare game id may
 * already show on its public pages; no token of any kind rides with it.
 * `referee` is true only for the browser that created the game.
 */
export interface GameSummary {
  gameId: string;
  variant?: VariantRef;
  started: boolean;
  phase: BoardState["phase"];
  joinedCount: number;
  totalSeats: number;
  turns: number;
  deadlineAt: string | null;
  createdAt: string;
  referee: boolean;
}

// --- HTTP -----------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The server reports failures as {"error": "..."}, which is the sentence to
// show; anything else falls back to the status line.
async function readError(res: Response): Promise<ApiError> {
  const body = await res.text();
  let message = body.trim();
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === "string") message = parsed.error;
  } catch {
    // Not JSON: the raw text is the best there is.
  }
  if (!message) message = "request failed (" + res.status + ")";
  return new ApiError(message, res.status);
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  if (!res.ok) throw await readError(res);
  const text = await res.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

// --- routes ---------------------------------------------------------------

export type Route =
  | { kind: "index" }
  | { kind: "new" }
  | { kind: "join"; gameId: string; inviteToken: string }
  | { kind: "gm"; gameId: string; gmToken: string }
  | { kind: "seat"; gameId: string; seatToken: string }
  /* The spectator screen. phaseIndex null means the live phase; a number
     addresses one resolved phase of the history. */
  | { kind: "watch"; gameId: string; phaseIndex: number | null }
  | { kind: "unknown"; path: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "index" };
  if (parts.length === 1 && parts[0] === "new") return { kind: "new" };
  if (parts.length === 3 && parts[0] === "join") {
    return { kind: "join", gameId: parts[1], inviteToken: parts[2] };
  }
  if (parts[0] === "watch" && parts.length >= 2) {
    if (parts.length === 2) return { kind: "watch", gameId: parts[1], phaseIndex: null };
    if (parts.length === 3 && /^\d+$/.test(parts[2])) {
      return { kind: "watch", gameId: parts[1], phaseIndex: Number(parts[2]) };
    }
  }
  if (parts.length === 4 && parts[0] === "game") {
    if (parts[2] === "gm") return { kind: "gm", gameId: parts[1], gmToken: parts[3] };
    if (parts[2] === "seat") return { kind: "seat", gameId: parts[1], seatToken: parts[3] };
  }
  return { kind: "unknown", path: pathname };
}

function absolute(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/** The token-free endpoint every page may poll for liveness. */
export function publicUrl(gameId: string): string {
  return absolute("/game/" + encodeURIComponent(gameId) + "/public");
}

export function fetchPublic(gameId: string): Promise<PublicState> {
  return getJSON<PublicState>(publicUrl(gameId));
}

// --- spectator ------------------------------------------------------------

/*
Where the spectator page reads from. The page itself is served at /watch/{id}
and /watch/{id}/{phase}; its JSON lives under the game's API prefix:
/game/{id}/watch and /game/{id}/watch/{phase}.
*/
export function watchPath(gameId: string, phaseIndex: number | null): string {
  const base = "/watch/" + encodeURIComponent(gameId);
  return phaseIndex === null ? base : base + "/" + phaseIndex;
}

export function watchUrl(gameId: string, phaseIndex: number | null): string {
  const base = "/game/" + encodeURIComponent(gameId) + "/watch";
  return absolute(phaseIndex === null ? base : base + "/" + phaseIndex);
}

export function fetchWatch(gameId: string, phaseIndex: number | null): Promise<WatchState> {
  return getJSON<WatchState>(watchUrl(gameId, phaseIndex));
}

/** The map, which the spectator screen may ask for without any token. */
export function watchMapUrl(gameId: string): string {
  return absolute("/game/" + encodeURIComponent(gameId) + "/map.svg");
}

// --- variants -------------------------------------------------------------

/*
The catalogue behind the gallery on /new. It is metadata only: the maps
themselves are megabytes each and are asked for one at a time, by the card
that is showing one.
*/
export async function fetchVariants(): Promise<Variant[]> {
  return readVariants(await getJSON<unknown>(absolute("/variants")));
}

// --- creation -------------------------------------------------------------

export function createGame(settings: Settings): Promise<CreatedGame> {
  return postJSON<CreatedGame>(absolute("/games"), { settings: settings });
}

// --- the main-page list ---------------------------------------------------

/**
 * Every game the server holds, newest first. The answer carries no token of
 * any kind: an id opens the public pages only. The one exception is the
 * `referee` mark, which the server sets only for the browser that created
 * the game.
 */
export function fetchGames(): Promise<GameSummary[]> {
  return getJSON<GameSummary[]>(absolute("/games"));
}

// --- join -----------------------------------------------------------------

export function claimSeat(gameId: string, inviteToken: string): Promise<{ seatUrl: string }> {
  const url = absolute(
    "/game/" + encodeURIComponent(gameId) + "/join/" + encodeURIComponent(inviteToken),
  );
  return postJSON<{ seatUrl: string }>(url, {});
}

// --- GM -------------------------------------------------------------------

export class GmClient {
  private base: string;

  constructor(gameId: string, gmToken: string) {
    this.base = absolute(
      "/game/" + encodeURIComponent(gameId) + "/gm/" + encodeURIComponent(gmToken) + "/",
    );
  }

  state(): Promise<GmState> {
    return getJSON<GmState>(this.base + "state");
  }

  /** A partial patch is allowed; gmPlays is refused once the game started. */
  settings(patch: Partial<Settings>): Promise<unknown> {
    return postJSON(this.base + "settings", patch);
  }

  start(): Promise<unknown> {
    return postJSON(this.base + "start");
  }

  force(): Promise<unknown> {
    return postJSON(this.base + "adjudicate");
  }

  extend(minutes: number): Promise<unknown> {
    return postJSON(this.base + "extend", { minutes: minutes });
  }
}

// --- seat -----------------------------------------------------------------

export class SeatClient {
  readonly base: string;

  constructor(gameId: string, seatToken: string) {
    this.base = absolute(
      "/game/" + encodeURIComponent(gameId) + "/seat/" + encodeURIComponent(seatToken) + "/",
    );
  }

  get mapUrl(): string {
    return this.base + "map.svg";
  }

  state(): Promise<SeatState> {
    return getJSON<SeatState>(this.base + "state");
  }

  options(province: string): Promise<OptionTree> {
    return getJSON<OptionTree>(this.base + "options?province=" + encodeURIComponent(province));
  }

  order(province: string, parts: string[]): Promise<SeatState> {
    return postJSON<SeatState>(this.base + "order", { province: province, parts: parts });
  }

  finalize(on: boolean): Promise<SeatState> {
    return postJSON<SeatState>(this.base + (on ? "finalize" : "unfinalize"));
  }
}

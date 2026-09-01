/*
The server, as the pages see it.

Every page is served under the URL that carries its own tokens, so no page is
ever told where its API lives: the addresses are built from location.pathname.
Nothing here holds a token in module state — the route object does.
*/

import type { BoardState, LabelPlan, OptionTree, Placement, Unit } from "./board/types";
import { readSeatSeed, seatPublicKey, signAsSeat } from "./seatkey";
import { readVariants, type Variant } from "./variants";

// --- shapes ---------------------------------------------------------------

export interface Settings {
  deadlineMinutes: number;
  gmPlays: boolean;
	/** Percentage of the movement clock used for retreats and adjustments. */
	retreatBuildPercent?: number;
	/** Orders remain open this many minutes after the displayed deadline. */
	graceMinutes?: number;
	/** Extra minutes added only to Spring 1901 movement. */
	firstTurnExtraMinutes?: number;
  /*
  What the table calls this game. Optional, and empty is the ordinary case:
  an unnamed game is known by its id. It names the table, never a person, so
  nothing here is bound to a seat and ADR-020's anonymity is untouched.
  */
  name?: string;
  /** The godip variant key. Absent means the server's default, classical. */
  variant?: string;
  /*
  Whether a player may write an order the rules do not allow (ADR-029). The
  server keeps it, the adjudicator throws it out, and that phase's ordinary
  invalid-order consequence applies. Absent means yes: a
  server that predates the setting accepted whatever it was sent (illegal.ts).
  */
  illegalMoves?: boolean;
  /*
  How negotiation happens (ADR-023). The app carries no messages in any mode;
  the setting is a rule the table has declared, and the join and waiting
  screens say it. Absent means the server's default, ftf.
  */
  pressMode?: "ftf" | "gunboat" | "fullpress" | "rulebook";
  /*
  The year the game stops after, zero or absent meaning it plays on until a
  solo or a draw (ADR-044). A tournament round with a hard stop sets it.
  */
  endYear?: number;
}

/*
How a game ended (ADR-044), null while it runs.

`centres` names every power of the variant, zeros included, so an eliminated
one reads as eliminated rather than as missing. `powers` is who the ending
names: the winner of a solo, the powers that agreed a draw, everybody still
holding a centre at the end year.
*/
export interface GameResult {
  kind: "solo" | "draw" | "endYear";
  powers: string[];
  centres: Record<string, number>;
  year: number;
  /** How many phases had resolved: the last one a /watch link can show. */
  phaseIndex: number;
}

export interface DrawProposal {
  /** Powers included in the proposed result. */
  powers: string[];
  /** Surviving powers asked to consent to being excluded. */
  required: string[];
  confirmed: string[];
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
  /*
  Which client build the server is serving (ADR-050). A tab that sees it
  change is running JavaScript the server has moved on from; build.ts keeps
  the first one it saw and says so.
  */
  build?: string;
  variant?: VariantRef;
  provinceNames?: Record<string, string>;
  /*
  The variant's approved marker positions, from its placements.json on the
  server. Null when that variant has no approved table and the board must fall
  back to the map's own anchors. It rides with the state rather than with the
  variant catalogue because the board is handed state and nothing else.
  */
  placements?: Record<string, Placement> | null;
  /*
  How to draw the names and the supply centre glyphs of a map whose art no
  longer carries them (ADR-038). Absent on every map that draws its own, which
  is what a map does until its exporter stops.
  */
  labels?: LabelPlan | null;
  /*
  The server's own clock, RFC3339. Every countdown is measured against it,
  because a phone at the table can be minutes out (see clock.ts).
  */
  now?: string;
  previousPhase?: PreviousPhase | null;
  /*
  How the game ended (ADR-044). Null or absent while it runs, and on every
  answer once it has: the seat, the game master view, the public summary and
  every phase of the spectator feed, so a citation of Fall 1904 still says the
  game was won.
  */
  result?: GameResult | null;
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
The spectator feed, for the shared screen (ADR-013).

It is the public board and nothing else: units, centres, the phase, the clock
and — for a phase that has already resolved — that phase's orders and their
outcomes. There is no seat here, no token, and no endpoint that could carry an
order back, which is what makes the page read-only in the sense ADR-013 means:
nothing on this view can create or change an Order.

`phaseIndex` addresses one phase of the game's history; without it the feed
answers with the live one. `phaseCount` is how many resolved phases there are,
so the page can offer prev and next without guessing.
*/
export interface WatchState extends VariantAware {
  gameId: string;
  /** What the table calls this game (ADR-042). Absent when it has no name. */
  name?: string;
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
  locked?: Record<string, boolean>;
  lockedCount?: number;
  totalSeats?: number;
  /** Seats filled, and how many the invite still may hand out. Counts only. */
  joinedCount?: number;
  seatsToFill?: number;
  deadlineAt: string | null;
}

export interface CreatedGame {
  gameId: string;
  inviteUrl: string;
}

export interface GmSeat {
  power: string;
  joined: boolean;
  locked: boolean;
  isGm?: boolean;
	/** Supply centres currently held; zero means eliminated. */
	centres?: number;
  /** This seat has released the orders behind its lock (ADR-004). */
  revealed?: boolean;
}

export interface GmState extends VariantAware, SealedPhase {
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
  /**
   * Whether this game has a recovery key (ADR-048). Absent from a server that
   * predates keys, which is the same thing as not having one.
   */
  hasGmKey?: boolean;
	drawProposal?: DrawProposal | null;
}

export interface PublicState extends VariantAware, SealedPhase {
  gameId: string;
  phase: BoardState["phase"];
  started: boolean;
  joinedCount: number;
  totalSeats: number;
  locked: Record<string, boolean>;
  settings: Settings;
  settingsVersion: number;
  deadlineAt: string | null;
}

/*
How a game takes orders (ADR-004).

`sealed` is every game made from 2026-08-31 on: the draft lives on this phone,
locking sends it encrypted, and the key goes up only once every seat has
locked in. `revealOpen` is that moment. A game made before commit-reveal existed
keeps writing its drafts to the server and has all three of these false.
*/
export interface SealedPhase {
  sealed?: boolean;
  revealOpen?: boolean;
  /** Seats the board is still waiting on. It names seats, never orders. */
  awaitingReveal?: string[];
}

export interface SeatState extends BoardState, VariantAware, SealedPhase {
  you: { power: string };
  /** Which phase this is, counting resolved phases from zero. */
  phaseIndex?: number;
  /** This seat has released the orders behind its own lock. */
  youRevealed?: boolean;
  settings: Settings;
  settingsVersion: number;
  started: boolean;
  deadlineAt: string | null;
  locked: Record<string, boolean>;
  youLocked: boolean;
  /** True when this seat is the game master's own (ADR-021). */
  youAreGm?: boolean;
  /** How many phases have resolved, for the seat menu (ADR-041). */
  turns?: number;
  /** When the game was made, for the seat menu's elapsed line. */
  createdAt?: string;
  /**
   * This seat was locked by the server because its power has no legal
   * order this phase. The seat cannot be unlocked while it is set.
   */
  nothingToOrder?: boolean;
  lockedCount: number;
  /** Powers that must lock before the phase resolves. */
  totalSeats: number;
  /** Powers the invite has handed out so far. */
  joinedCount: number;
  /** Powers the invite may hand out: six when the game master plays. */
  seatsOnOffer: number;
  phaseResolutions: Record<string, string>;
  canForce: boolean;
  /**
   * Set only on the game master's own seat: the address of the controls,
   * so the GM can switch between the board and the referee view.
   */
  refereeUrl?: string;
	drawProposal?: DrawProposal | null;
}

/**
 * One row of the main-page list. Everything here is what a bare game id may
 * already show on its public pages; no token of any kind rides with it.
 * `referee` is true only for the browser that created the game.
 */
export interface GameSummary {
  gameId: string;
  /** What the table calls this game, empty when nobody named it. */
  name?: string;
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
  /* The landing page (ADR-043): the one address with nothing behind it. */
  | { kind: "index" }
  /* The page a handover QR code opens (ADR-041). Everything it needs to take
     the seat is in the address, and the signature is what authorises it. */
  | { kind: "handover"; gameId: string; power: string; epoch: string; signature: string }
  /* The same, for the game master role. It is a separate address because it
     is a separate act: the rights travel and a power does not. */
  | { kind: "handover-gm"; gameId: string; epoch: string; signature: string }
  /* Where a game master types their twelve words (ADR-048). The game id may be
     in the address or typed in, so it is optional. */
  | { kind: "recover"; gameId: string | null }
  /* The list of games this server holds, which used to stand at the root. */
  | { kind: "games" }
  /* The questions a first table asks. One page, no game behind it. */
  | { kind: "faq" }
  /* What this build scored against DATC (ADR-045). Generated, never typed. */
  | { kind: "datc" }
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
  if (parts.length === 1 && parts[0] === "games") return { kind: "games" };
  if (parts.length === 1 && parts[0] === "faq") return { kind: "faq" };
  if (parts.length === 1 && parts[0] === "datc") return { kind: "datc" };
  if (parts[0] === "recover" && parts.length <= 2) {
    return { kind: "recover", gameId: parts.length === 2 ? parts[1] : null };
  }
  if (parts.length === 4 && parts[0] === "handover-gm") {
    return { kind: "handover-gm", gameId: parts[1], epoch: parts[2], signature: parts[3] };
  }
  if (parts.length === 5 && parts[0] === "handover") {
    return {
      kind: "handover",
      gameId: parts[1],
      power: decodeURIComponent(parts[2]),
      epoch: parts[3],
      signature: parts[4],
    };
  }
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

/*
Where this app talks to itself (ADR-050).

Two surfaces, and only one of them is ours to change: /api/v1 is the
transport, and nothing outside the build that ships with it is promised
anything. The version is what makes that safe — a breaking change becomes
/api/v2 and a phone still on the old page keeps working until somebody
reloads it, rather than dying mid-phase.

The published reads — a game's public summary, the spectator feed, the
variant catalogue and the art — are built with `absolute` instead, because
they are addresses a person may paste and we mean to keep them working.
*/
const API = "/api/v1";

function api(path: string): string {
  return absolute(API + path);
}

/** The token-free endpoint every page may poll for liveness. */
export function publicUrl(gameId: string): string {
  return absolute("/game/" + encodeURIComponent(gameId) + "/public");
}

export function fetchPublic(gameId: string): Promise<PublicState> {
  return getJSON<PublicState>(publicUrl(gameId));
}

/*
The game master's own door, which carries no secret. The browser that created
the game holds a cookie for it; the server answers this address by redirecting
that browser to the GM view and answers everybody else with a 404. So it is
safe on the game list, and it is the address a create hands off to.
*/
export function refereePath(gameId: string): string {
  return "/game/" + encodeURIComponent(gameId) + "/referee/";
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

/*
The counts a tournament pipeline reads (ADR-046).

Public and token-free, like the board they are counted from. dipvis scrapes
Backstabbr's HTML for exactly this; a director who is handed one of these
addresses needs no scraper.
*/
export function resultsUrl(gameId: string, format: "json" | "csv"): string {
  return absolute("/game/" + encodeURIComponent(gameId) + "/results." + format);
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
  return postJSON<CreatedGame>(api("/games"), { settings: settings });
}

// --- the main-page list ---------------------------------------------------

/**
 * Every game the server holds, newest first. The list has its own address
 * because /games is a page now (ADR-043); a create is still a post to the
 * collection, which is what /games answers to POST.
 * The answer carries no token of
 * any kind: an id opens the public pages only. The one exception is the
 * `referee` mark, which the server sets only for the browser that created
 * the game.
 */
export function fetchGames(): Promise<GameSummary[]> {
  return getJSON<GameSummary[]>(api("/games"));
}

// --- join -----------------------------------------------------------------

/*
Claiming a power (ADR-012), with the key this device just made (ADR-049).

The public half goes with the claim, so the seat is bound to a key the server
never held. The answer says `keyed`, which is the page's cue to write the seed
into this device's storage before it opens the board.
*/
export function claimSeat(
  gameId: string,
  inviteToken: string,
  signPub: string,
): Promise<SeatClaim> {
  const url = api(
    "/game/" + encodeURIComponent(gameId) + "/join/" + encodeURIComponent(inviteToken),
  );
  return postJSON<SeatClaim>(url, { signPub: signPub });
}

export interface SeatClaim {
  seatUrl: string;
  /** True when the seat is held by a key rather than by a token. */
  keyed?: boolean;
  /** Set when a handover answered: the power that was taken. */
  power?: string;
  /** Current phase, so a handover can retain only its sealed-order key. */
  phaseIndex?: number;
}

/*
Signing in to a keyed seat (ADR-049).

Two steps and no token: the server hands out a sentence, this device signs it
with the seed it holds, and the server answers with an HttpOnly cookie. The
cookie reads the board and writes a draft. It is not the key: the key stays
here, and what it will sign one day is the sealed order itself.
*/
export async function openSeatSession(gameId: string): Promise<string> {
  const seed = readSeatSeed(gameId);
  if (!seed) throw new ApiError("This device does not hold a seat in this game.", 404);
  const base = api("/game/" + encodeURIComponent(gameId) + "/session");
  const challenge = await getJSON<{ nonce: string; message: string }>(base);
  const { power } = await postJSON<{ power: string }>(base, {
    signPub: seatPublicKey(seed),
    nonce: challenge.nonce,
    signature: signAsSeat(seed, challenge.message),
  });
  return power;
}

// --- GM -------------------------------------------------------------------

export class GmClient {
  private base: string;

  constructor(gameId: string, gmToken: string) {
    this.base = api(
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

  /*
  End the game in a draw the table agreed (ADR-044). The powers must each
  still hold a centre; one power is a concession and is allowed.
  */
  draw(powers: string[]): Promise<unknown> {
    return postJSON(this.base + "draw", { powers: powers });
  }

	drawWithdraw(): Promise<unknown> {
		return postJSON(this.base + "draw-withdraw");
	}

  /** The link that hands the game master role to another device (ADR-041). */
  roleHandover(): Promise<Handover> {
    return getJSON<Handover>(this.base + "handover-role");
  }

  /** The public half the server holds, empty when this game has no key. */
  key(): Promise<GmKey> {
    return getJSON<GmKey>(this.base + "key");
  }

  /** Register the public half, once (ADR-048). */
  setKey(publicKey: string): Promise<GmKey> {
    return postJSON<GmKey>(this.base + "key", { publicKey: publicKey });
  }
}

export interface GmKey {
  /** Base64url, 32 bytes. Empty means this game has no recovery key. */
  publicKey: string;
}

/*
Recovering the game master role with its twelve words (ADR-048).

Two steps, and neither carries a token: the person asking has lost every token
they had, which is the case this exists for. The server hands out a sentence to
sign, the browser signs it with the key the words rebuild, and a signature the
stored public half accepts is what buys a fresh game master address.
*/
export interface RecoverChallenge {
  gameId: string;
  nonce: string;
  /** Exactly what to sign. Never built on this side. */
  message: string;
}

export function recoverChallenge(gameId: string): Promise<RecoverChallenge> {
  return getJSON<RecoverChallenge>(api("/game/" + encodeURIComponent(gameId) + "/recover"));
}

export function recoverClaim(
  gameId: string,
  nonce: string,
  signature: string,
): Promise<{ gmUrl: string }> {
  return postJSON<{ gmUrl: string }>(
    api("/game/" + encodeURIComponent(gameId) + "/recover"),
    { nonce: nonce, signature: signature },
  );
}

// --- seat -----------------------------------------------------------------

export class SeatClient {
  readonly base: string;
  /*
  A keyed seat carries no token: `me` in the address, a session cookie for
  authority, and the seed on the device (ADR-049). Sessions live in the
  server's memory, so a restart ends them — and this device can open a new
  one on its own, which is what `keyed` turns on below.
  */
  private readonly gameId: string;
  readonly keyed: boolean;

  constructor(gameId: string, seatToken: string) {
    this.gameId = gameId;
    this.keyed = seatToken === "me";
    this.base = api(
      "/game/" + encodeURIComponent(gameId) + "/seat/" + encodeURIComponent(seatToken) + "/",
    );
  }

  get mapUrl(): string {
    return this.base + "map.svg";
  }

  /*
  Every call goes through here. A keyed seat whose session has gone answers
  404, exactly as a wrong address does, so the first one is met by signing in
  again and trying once more. Twice would be a loop: if the second attempt
  fails the seat really is gone.
  */
  private async withSession<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!this.keyed || !(err instanceof ApiError) || err.status !== 404) throw err;
      /*
      A restart drops every session at once (ADR-049), so every phone at
      every table finds out in the same second and signs back in together.
      A short random wait spreads that over the poll interval instead of
      landing it on a server that is still warming up.
      */
      await new Promise((wake) => setTimeout(wake, Math.random() * 1500));
      await openSeatSession(this.gameId);
      return run();
    }
  }

  state(): Promise<SeatState> {
    return this.withSession(() => getJSON<SeatState>(this.base + "state"));
  }

  options(province: string): Promise<OptionTree> {
    return this.withSession(() =>
      getJSON<OptionTree>(this.base + "options?province=" + encodeURIComponent(province)),
    );
  }

  order(province: string, parts: string[]): Promise<SeatState> {
    return this.withSession(() =>
      postJSON<SeatState>(this.base + "order", { province: province, parts: parts }),
    );
  }

  /*
  Locking. In a sealed game the body is the sealed orders and nothing else,
  which is what makes the lock a commitment (ADR-011): one act, one word in
  front of the player, an envelope behind it.
  */
  lock(on: boolean, sealed?: string): Promise<SeatState> {
    return this.withSession(() =>
      postJSON<SeatState>(this.base + (on ? "lock" : "unlock"), on ? { sealed: sealed } : {}),
    );
  }

	/** Accept or reject being excluded from the pending draw proposal. */
	drawResponse(accept: boolean): Promise<SeatState> {
		return this.withSession(() =>
			postJSON<SeatState>(this.base + "draw-response", { accept: accept }),
		);
	}

  /*
  Releasing what this phone locked in (ADR-004): the key, and only the key.
  The orders are already on the server, inside the envelope it opens. No
  player presses anything — the page sends this by itself the moment it sees
  the window open (ADR-009).
  */
  reveal(key: string): Promise<SeatState> {
    return this.withSession(() => postJSON<SeatState>(this.base + "reveal", { key: key }));
  }

  /** The link that hands this power to another phone (ADR-041). */
  handover(): Promise<Handover> {
    return getJSON<Handover>(this.base + "handover");
  }

  /** The role's link, for the seat that is the game master's own. */
  roleHandover(): Promise<Handover> {
    return getJSON<Handover>(this.base + "handover-role");
  }
}

/** A minted handover link, and the power it hands over. */
export interface Handover {
  power: string;
  url: string;
}

/*
Taking a power from a handover link (ADR-041).

The signature in the address is the whole credential, which is why this is a
post and never a page load: a link preview or a scanner that fetches before it
shows would otherwise burn the seat and strand the phone that still holds it.
*/
export function claimHandover(
  gameId: string,
  power: string,
  epoch: string,
  signature: string,
  signPub: string,
): Promise<SeatClaim> {
  return postJSON<SeatClaim>(
    api(
      "/game/" +
        encodeURIComponent(gameId) +
        "/handover/" +
        encodeURIComponent(power) +
        "/" +
        encodeURIComponent(epoch) +
        "/" +
        encodeURIComponent(signature),
    ),
    { signPub: signPub },
  );
}

/*
Taking the game master role (ADR-041).

The rights travel and a power does not: whoever opens this runs the game, and
the power the last game master played stays where it is.
*/
export function claimGmHandover(
  gameId: string,
  epoch: string,
  signature: string,
): Promise<{ gmUrl: string }> {
  return postJSON<{ gmUrl: string }>(
    api(
      "/game/" +
        encodeURIComponent(gameId) +
        "/handover-gm/" +
        encodeURIComponent(epoch) +
        "/" +
        encodeURIComponent(signature),
    ),
  );
}

/** The game master mints a link for any power, dead phone or not (r44). */
export function mintHandover(gameId: string, gmToken: string, power: string): Promise<Handover> {
  return getJSON<Handover>(
    api(
      "/game/" +
        encodeURIComponent(gameId) +
        "/gm/" +
        encodeURIComponent(gmToken) +
        "/handover?power=" +
        encodeURIComponent(power),
    ),
  );
}

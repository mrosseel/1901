/*
The server, as the pages see it.

Every page is served under the URL that carries its own tokens, so no page is
ever told where its API lives: the addresses are built from location.pathname.
Nothing here holds a token in module state — the route object does.
*/

import type { BoardState, OptionTree } from "./board/types";

// --- shapes ---------------------------------------------------------------

export interface Settings {
  deadlineMinutes: number;
  gmPlays: boolean;
}

export interface CreatedGame {
  gameId: string;
  gmToken: string;
  inviteUrl: string;
  gmUrl?: string;
}

export interface GmSeat {
  power: string;
  joined: boolean;
  finalized: boolean;
  isGm?: boolean;
}

export interface GmState {
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

export interface PublicState {
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

export interface SeatState extends BoardState {
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
  | { kind: "new" }
  | { kind: "join"; gameId: string; inviteToken: string }
  | { kind: "gm"; gameId: string; gmToken: string }
  | { kind: "seat"; gameId: string; seatToken: string }
  | { kind: "unknown"; path: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "new") return { kind: "new" };
  if (parts.length === 3 && parts[0] === "join") {
    return { kind: "join", gameId: parts[1], inviteToken: parts[2] };
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

// --- creation -------------------------------------------------------------

export function createGame(settings: Settings): Promise<CreatedGame> {
  return postJSON<CreatedGame>(absolute("/games"), { settings: settings });
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

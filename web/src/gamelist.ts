/*
The rows the game list draws, worked out before anything is drawn.

Two sources feed the list and neither one is complete. The server says which
games exist and how far each has got; this device's storage says which of them
it can open (held.ts, ADR-048 and ADR-049). The two are joined here so the page
itself only has to draw what it is handed.

A game the server no longer lists but this device still holds a key for keeps
its row. The key is the way back in, and a browser that quietly dropped the row
would leave the person holding it with nothing to click.
*/

import type { GameSummary } from "./api";
import type { HeldGame } from "./held";
import type { BoardState } from "./board/types";

/** One game on the list, with what this device can do about it. */
export interface GameRow {
  gameId: string;
  /** What the table calls the game. Empty when nobody named it. */
  name: string;
  variantName: string;
  /** The review note for the map, or "" (ADR-061). */
  variantNote: string;
  started: boolean;
  /** A board with no players (ADR-047). Its seat count means nothing. */
  sandbox: boolean;
  phase: BoardState["phase"];
  joinedCount: number;
  totalSeats: number;
  turns: number;
  deadlineAt: string | null;
  /** A seat seed for this game is on this device, so /seat/me can sign in. */
  seat: boolean;
  /** A game-master key is on this device, so the twelve words are not needed. */
  gmKey: boolean;
  /** The server says this browser's cookie is the referee. */
  referee: boolean;
  /** The server listed this game. A held game it has forgotten is false. */
  onServer: boolean;
}

/** The three blocks the page prints, in the order it prints them. */
export interface GameGroups {
  playing: GameRow[];
  waiting: GameRow[];
  /** Held here, unknown to the server. */
  gone: GameRow[];
}

/*
The server's list first, in the order it came in, then whatever this device
holds that was not in it. The server sorts newest first, and that order is the
one a person scanning the page expects, so it is kept.
*/
export function buildRows(games: GameSummary[] | null, held: HeldGame[]): GameRow[] {
  const byId = new Map(held.map((one) => [one.gameId, one]));
  const rows: GameRow[] = [];

  for (const game of games || []) {
    const mine = byId.get(game.gameId);
    rows.push({
      gameId: game.gameId,
      name: game.name || "",
      variantName: game.variant ? game.variant.name : "",
      variantNote: game.variant?.note || "",
      started: game.started,
      sandbox: Boolean(game.sandbox),
      phase: game.phase,
      joinedCount: game.joinedCount,
      totalSeats: game.totalSeats,
      turns: game.turns,
      deadlineAt: game.deadlineAt,
      seat: Boolean(mine?.seat),
      gmKey: Boolean(mine?.gameMaster),
      referee: game.referee,
      onServer: true,
    });
  }

  const listed = new Set(rows.map((row) => row.gameId));
  for (const one of held) {
    if (listed.has(one.gameId)) continue;
    rows.push({
      gameId: one.gameId,
      name: "",
      variantName: "",
      variantNote: "",
      started: false,
      sandbox: false,
      phase: undefined,
      joinedCount: 0,
      totalSeats: 0,
      turns: 0,
      deadlineAt: null,
      seat: one.seat,
      gmKey: one.gameMaster,
      referee: false,
      onServer: false,
    });
  }

  return rows;
}

/** Whether this browser can open the game as more than a spectator. */
export function isYours(row: GameRow): boolean {
  return row.seat || row.gmKey || row.referee;
}

/*
Which of the two it is. "Yours" on its own is a badge nobody can act on: a
person with a seat and a person with the game-master role want different
buttons, so the badge says which one is on offer.

A sandbox says nothing here. It is one person's board already (ADR-047), so
the creator's browser holding the referee cookie is not news; the Sandbox tag
beside it is the whole story.
*/
export function yoursLabel(row: GameRow): string {
  if (row.sandbox) return "";
  const parts: string[] = [];
  if (row.seat) parts.push("your seat");
  if (row.gmKey || row.referee) parts.push("GM");
  return parts.join(" and ");
}

/** The seat count as the row prints it. A sandbox has no seats to count. */
export function seatText(row: GameRow): string {
  if (row.sandbox) return "";
  return row.joinedCount + " / " + row.totalSeats;
}

/*
The colour the seat count is printed in.

Somebody scanning the list wants the tables they can still join, so a full
table is read out of the way and a table with room is worth a look. Warm for a
table more than half taken, plain for one still wide open.
*/
export function seatTone(joined: number, total: number): "good" | "warn" | "muted" {
  if (total <= 0) return "muted";
  if (joined >= total) return "good";
  if (joined * 2 > total) return "warn";
  return "muted";
}

/*
The blocks, with the filter applied. Filtering before grouping is what makes
an empty page say "this device holds no game" instead of showing three empty
headings.
*/
export function groupRows(rows: GameRow[], onlyMine: boolean): GameGroups {
  const kept = onlyMine ? rows.filter(isYours) : rows;
  return {
    playing: kept.filter((row) => row.onServer && row.started),
    waiting: kept.filter((row) => row.onServer && !row.started),
    gone: kept.filter((row) => !row.onServer),
  };
}

/** Whether any block has a row, so the page knows to print the empty line. */
export function anyRows(groups: GameGroups): boolean {
  return groups.playing.length + groups.waiting.length + groups.gone.length > 0;
}

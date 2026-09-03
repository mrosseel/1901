/*
What this browser can still get into.

A person who lands on "Return to a game" is asked for a game id or twelve
words, and most of the time the browser already knows the answer. A seat is a
seed in this device's storage (ADR-049) and the game master's key is an entropy
beside it (ADR-048), both one entry per game. Reading them back is a matter of
walking the two prefixes.

Nothing here talks to the server. The list says what this device holds, not
what the games are; a name and a phase come from /games, and a game the server
has forgotten still appears, because the key is here whatever the server says.
*/

import { STORE_PREFIX as GM_PREFIX, readStoredKey } from "./gmkey";
import { STORE_PREFIX as SEAT_PREFIX, readSeatSeed } from "./seatkey";

/** One game this device has a credential for. */
export interface HeldGame {
  gameId: string;
  /** A seat seed is stored, so /seat/me can sign itself in. */
  seat: boolean;
  /** The game master's entropy is stored, so the words are not needed. */
  gameMaster: boolean;
}

/*
Every game with a seat seed or a game master key here, by id.

A stored entry counts only when it reads back as a key of the right length:
storage is shared with anything else on the origin, and a row offering to open
a seat that cannot sign is worse than no row.
*/
export function heldGames(): HeldGame[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(SEAT_PREFIX)) ids.push(key.slice(SEAT_PREFIX.length));
      else if (key.startsWith(GM_PREFIX)) ids.push(key.slice(GM_PREFIX.length));
    }
  } catch {
    // A private window refuses storage outright. Then this device holds
    // nothing, and the manual cards below the list are the way in.
    return [];
  }

  const held: HeldGame[] = [];
  for (const gameId of [...new Set(ids)].sort()) {
    const seat = Boolean(readSeatSeed(gameId));
    const gameMaster = Boolean(readStoredKey(gameId));
    if (seat || gameMaster) held.push({ gameId: gameId, seat: seat, gameMaster: gameMaster });
  }
  return held;
}

/*
The game an address belongs to, or null when it is not a game address.

The recent-game note keeps a URL and no id (it was written for a link, not for
a list), so the id has to come back out of it to tell a duplicate row from a
new one.
*/
export function gameIdInUrl(url: string): string | null {
  const match = /\/game\/([^/?#]+)/.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return match[1];
  }
}

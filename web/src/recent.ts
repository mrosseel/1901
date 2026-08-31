/*
The way back to the game you are in.

Every screen here is reached by a link somebody handed you, and there is no
account behind any of them (ADR-020). So leaving your seat to look at the game
list or read the rules used to be a one-way trip: the address bar was the only
copy of your token, and a tab closed on it took the seat with it.

This is the device's own note of where it was. It holds one game — the last
seat or game master page this browser opened — and nothing else, because a
phone at a table is at one board. It never goes to the server: it is the same
kind of fact as the map style, about this device and nobody else.

Storing a token in localStorage is storing a credential, and that is a real
choice. It is the same credential the address bar already holds and the same
one the browser's own history keeps; what it buys is that "back to my game"
survives a tab being closed, which at a table is the difference between
carrying on and asking the game master for a new link.
*/

const KEY = "1901.recentGame";

/** The game this device was last in, and how to reach it. */
export interface RecentGame {
  /** The seat or game master address, in full. */
  url: string;
  /** What the game is called, or its id when it has no name. */
  label: string;
  /** The power this device holds, when the game has started and dealt one. */
  power?: string;
}

export function readRecentGame(): RecentGame | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return null;
    const one = parsed as Partial<RecentGame>;
    if (typeof one.url !== "string" || typeof one.label !== "string") return null;
    return { url: one.url, label: one.label, power: one.power };
  } catch {
    return null;
  }
}

export function writeRecentGame(game: RecentGame): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(game));
  } catch {
    // The way back is a convenience. A browser that refuses to remember it
    // still has the address bar, which is where the token came from.
  }
}

export function forgetRecentGame(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: it was never written.
  }
}

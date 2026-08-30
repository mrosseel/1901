/*
Who is winning, from the board everyone can already see.

Supply centre ownership and unit positions are public — the map draws both, and
the spectator feed publishes them (D-013) — so this is arithmetic on what the
screen already holds and asks the server for nothing.

It is the one number a player checks constantly and the app never showed: how
many centres do I have, and how many does the player across the table have.
Counting them off the map is what people do instead, and it is slow and wrong
about a centre that changed hands in the phase just gone.
*/

import type { BoardState } from "./board/types";

/** One power's standing: what it owns and what it has on the board. */
export interface Standing {
  power: string;
  /** Supply centres owned. Ownership changes only after a Fall adjustment. */
  centres: number;
  /** Units on the board. Fewer than centres means builds are owed. */
  units: number;
}

/*
Every power in the game, sorted by centres and then by name.

Powers with nothing are still listed: a player is entitled to see that a power
is out, and a table reading "Austria 0" is the story of the game so far. The
list of powers comes from the locked map rather than from the units, because a
power can hold centres with no units standing and the reverse.
*/
export function standings(state: BoardState | null | undefined, powers?: string[]): Standing[] {
  const centres = state?.supplyCenters || {};
  const units = state?.units || {};

  const named = new Set<string>(powers || []);
  Object.values(centres).forEach((power) => named.add(power));
  Object.values(units).forEach((unit) => named.add(unit.nation));
  named.delete("");

  const rows = Array.from(named).map((power) => ({
    power: power,
    centres: Object.values(centres).filter((owner) => owner === power).length,
    units: Object.values(units).filter((unit) => unit.nation === power).length,
  }));

  return rows.sort((a, b) => {
    if (a.centres !== b.centres) return b.centres - a.centres;
    return a.power < b.power ? -1 : a.power > b.power ? 1 : 0;
  });
}

/*
What a power owes or is owed at the next build.

Positive means builds, negative means disbands, and it is only ever true after
a Fall adjustment has moved the ownership — which is exactly when the number
matters. Anything else is a guess about a board still being played.
*/
export function buildBalance(row: Standing): number {
  return row.centres - row.units;
}

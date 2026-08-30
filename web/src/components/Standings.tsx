import type { BoardState } from "../board/types";
import { standings, buildBalance } from "../standings";
import { PowerChip } from "./PowerChip";

/*
The centre count, for every power, on the screen a player is already looking
at.

It is the number the whole game is about and the app never showed it. Players
counted centres off the map instead, which is slow and goes wrong about a
centre that changed hands in the phase just gone.

Nothing here is private. Ownership and unit positions are on the map for
everyone, and the spectator screen publishes both (D-013), so listing them
tells no one anything they could not count themselves.

The build column is the honest part: it is right after a Fall adjustment moves
the ownership and meaningless before it, so it says so rather than printing a
number that will change.
*/
export function Standings({
  state,
  you,
  powers,
}: {
  state: BoardState | null | undefined;
  /** This device's own power, so its row can be marked. Absent for a watcher. */
  you?: string;
  /** Every power in the variant, so one that has lost everything is still listed. */
  powers?: string[];
}) {
  const rows = standings(state, powers);
  if (!rows.length) return null;

  // Ownership only moves at a Fall adjustment, so the difference between
  // centres and units is a build owed then and a half-played turn otherwise.
  const settled = state?.phase?.type === "Adjustment";

  return (
    <section className="card standings">
      <h2>Centres</h2>
      <ul>
        {rows.map((row) => {
          const balance = buildBalance(row);
          return (
            <li key={row.power} className={row.power === you ? "you" : undefined}>
              <PowerChip power={row.power} small />
              <span className="standings-centres">{row.centres}</span>
              <span className="standings-units">
                {row.units} {row.units === 1 ? "unit" : "units"}
              </span>
              {settled && balance !== 0 ? (
                <span className={balance > 0 ? "standings-build" : "standings-build off"}>
                  {balance > 0 ? "+" + balance : String(balance)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="note">
        {settled
          ? "Centres own the builds: + is owed, − comes off."
          : "Ownership changes after the Fall retreats, not before."}
      </p>
    </section>
  );
}

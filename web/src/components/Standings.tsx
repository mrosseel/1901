import type { BoardState } from "../board/types";
import { standings, buildBalance } from "../standings";
import { PowerChip } from "./PowerChip";

/*
The supply centre count, for every power, on the screen a player is already
looking at.

It is the number the whole game is about and the app never showed it. Players
counted them off the map instead, which is slow and goes wrong about a centre
that changed hands in the phase just gone.

Nothing here is private. Ownership and unit positions are on the map for
everyone, and the spectator screen publishes both (ADR-013), so listing them
tells no one anything they could not count themselves.

The build column is the honest part: it is right after a Fall adjustment moves
the ownership and meaningless before it, so it says so rather than printing a
number that will change.

"SC" heads its column because the column is two characters wide. Every word a
person reads in a sentence is "supply centre" in full (CONTEXT.md).
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
  // supply centres and units is a build owed then, and a half-played turn
  // otherwise.
  const settled = state?.phase?.type === "Adjustment";

  return (
    <section className="card standings">
      <h2>Supply centres</h2>
      <ul className="standings-rows">
        <li className="standings-legend" aria-hidden="true">
          <span className="standings-centres">SC</span>
          <span className="standings-units">units</span>
        </li>
        {rows.map((row) => {
          const balance = buildBalance(row);
          return (
            <li key={row.power} className={row.power === you ? "you" : undefined}>
              <PowerChip power={row.power} small />
              <span className="standings-centres">{row.supplyCentres}</span>
              {/*
              A dash where the two agree, which is most rows most of the
              time. Printing the same number twice makes the reader compare
              them; a dash says "nothing to see" at a glance, and leaves the
              eye free for the rows where they differ.

              The word "units" is in the header and not in every cell, for
              the reason "SC" is not repeated either.
              */}
              <span className="standings-units">
                {row.units === row.supplyCentres ? "—" : row.units}
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
          ? "Supply centres pay for units: + is a build owed, − comes off."
          : "Supply centre ownership changes after the Fall retreats, not before."}
      </p>
    </section>
  );
}

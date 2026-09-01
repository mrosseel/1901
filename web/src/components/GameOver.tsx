import type { GameResult } from "../api";
import { PowerChip } from "./PowerChip";

/*
The last screen (ADR-044).

Until this, a game had no end: the board adjudicated on for as long as anybody
kept pressing, and a table that had just watched somebody take their
eighteenth centre had to agree out loud that it was over and then close the
tab. The result is the thing the room came for, so it is drawn once, large, at
the top of every screen that shows the game.

Three endings and three sentences, because they are not the same event and a
table reads the difference:

  solo      one power took the variant's number. Nobody agreed to this.
  draw      the table agreed. One power named is a concession.
  endYear   the clock ran out on the round, and the survivors are listed.

The centre counts come with it. They are what a tournament director writes
down, what ADR-046 publishes, and the one thing everybody looks for the moment
a game stops.
*/
export function GameOver({ result }: { result: GameResult | null | undefined }) {
  if (!result) return null;

  const ranked = Object.entries(result.centres)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return (
    <section className="card game-over">
      <h2>{headline(result)}</h2>
      <p className="game-over-powers">
        {result.powers.map((power) => (
          <PowerChip key={power} power={power} />
        ))}
      </p>
      <p className="note">{sentence(result)}</p>
      <ul className="game-over-centres">
        {ranked.map(([power, count]) => (
          <li key={power}>
            <PowerChip power={power} small />
            <span className="game-over-count">{count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function headline(result: GameResult): string {
  if (result.kind === "solo") return "Solo in " + result.year;
  if (result.kind === "draw") {
    return result.powers.length === 1 ? "Conceded in " + result.year : "Draw in " + result.year;
  }
  return "The game ended in " + result.year;
}

/*
What the ending was, in one line. It says who decided, because that is the
part a player asks about: an engine declared the solo, the table agreed the
draw, and the end year was a rule set before anybody sat down.
*/
function sentence(result: GameResult): string {
  if (result.kind === "solo") {
    return "Enough supply centres to win outright. The game stopped here.";
  }
  if (result.kind === "draw") {
    return result.powers.length === 1
      ? "The other surviving powers confirmed a concession to this power."
      : "The table agreed a draw. The game master recorded it.";
  }
  return "The game was set to stop after this year. Everybody still holding a supply centre is listed.";
}

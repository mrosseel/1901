import type { GameResult } from "../api";
import type { BoardState } from "../board/types";
import { useFixEnabled } from "@mrosseel/page-comments/fixes";
import { PowerChip } from "./PowerChip";
import { Standings } from "./Standings";

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
export function GameOver({
  result,
  board,
  powers,
  you,
}: {
  result: GameResult | null | undefined;
  /*
  Fix c024: the board this result came off, so the card can carry the same
  supply-centre table the sidebar shows everywhere else instead of an ad-hoc
  count of its own. Omit it on a screen with no board to read one from — the
  game master's own view has no board state, so it keeps the ad-hoc list.
  */
  board?: BoardState | null;
  /** Every power in the variant, so one eliminated before the end still gets a row. */
  powers?: string[];
  you?: string;
}) {
  // c024: reuse the shared supply-centre table instead of drawing centre
  // counts a second, different way, and keep it inside this card.
  const sharedTable = useFixEnabled("c024") && Boolean(board);
  // c023: the ending is the headline and the powers named under it. Who
  // agreed to it, and in which year, is already in those two lines, so the
  // sentence that restated them is gone. OFF puts it back.
  const headlineSaysItAll = useFixEnabled("c023");
  if (!result) return null;

  const ranked = Object.entries(result.centres)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return (
    <section className="card game-over">
      <h2>{resultHeadline(result)}</h2>
      <p className="game-over-powers">
        {result.powers.map((power) => (
          <PowerChip key={power} power={power} />
        ))}
      </p>
      {headlineSaysItAll ? null : <p className="note">{sentence(result)}</p>}
      {sharedTable ? (
        /* Inside the card, bare: the result and the centres that made it are
           one thing to read, and a bordered table within a bordered card is
           two boxes saying so. The card's own heading names the ending, and
           the table's legend names its columns, so the table drops its
           heading here. */
        <Standings state={board} you={you} powers={powers} bare />
      ) : (
        <ul className="game-over-centres">
          {ranked.map(([power, count]) => (
            <li key={power}>
              <PowerChip power={power} small />
              <span className="game-over-count">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* The ending in three or four words, which is the whole heading of the card. */
function resultHeadline(result: GameResult): string {
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

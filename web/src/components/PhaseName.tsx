import {
  phaseWords,
  seasonKey,
  splitPhaseLabel,
  phaseTypeKey,
  type PhaseWords,
} from "../board/provinces";
import type { BoardState } from "../board/types";

/*
The phase, with each of its three words saying what it is.

"Spring 1901 Movement" is the largest line on every screen that shows a board,
because it is the one thing the whole table has to agree on. Printed in one ink
it is still one string to read; a player checking whether the retreat phase has
started reads all of it to find out.

So the two words that decide what a player must do carry a colour and the one
that never does stays in the neutral ink:

  season   Spring / Fall — which half of the year, so which adjudication is
           coming: an autumn movement takes supply centres and a spring one
           cannot. Warm for spring, amber for fall.
  year     neutral. It counts, and it asks nothing.
  type     Movement / Retreat / Adjustment — what this screen is for right now.

The colours are picked away from the outcome red and green the board and the
review already spend: on a screen where red means "this order failed", a red
phase word would be a second thing red means.
*/
export function PhaseName({
  phase,
  label,
}: {
  /** The phase itself, where the caller still has it. */
  phase?: BoardState["phase"];
  /** A label already built, for a caller that has only the string. */
  label?: string;
}) {
  const words: PhaseWords = label === undefined ? phaseWords(phase) : splitPhaseLabel(label);
  const season = seasonKey(words.season);
  const type = phaseTypeKey(words.type);

  /*
  Two fixed lines, so walking a game's history never reflows the header:
  the year on top, then "Spring Movement" — always the same shape whatever
  the words are. Movement wears the season's own colour (the season is the
  story in a movement phase); a retreat is the same warning colour in
  spring and fall alike, and an adjustment likewise its own.
  */
  const typeClass = ["phase-type"];
  if (type) typeClass.push("is-" + type);
  if (type === "movement") typeClass.push(season ? "sn-" + season : "sn-other");

  return (
    <span className="phase-lines">
      <span className="phase-year">{words.year || "\u00a0"}</span>
      <span className="phase-words">
        {words.season ? (
          <span className={season ? "phase-season is-" + season : "phase-season"}>
            {words.season}
          </span>
        ) : null}
        {words.type ? <span className={typeClass.join(" ")}>{words.type}</span> : null}
      </span>
    </span>
  );
}

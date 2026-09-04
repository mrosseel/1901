/*
The rules of a game, one fact per line.

Two screens say them: the panel a player waits on, and the block over the map
beside it. They must never disagree, so the words live here and nowhere else,
and this file touches no element and no storage — it is arithmetic over the
settings the server sent, and it is tested as such.

The lines are ordered the way a player asks for them: what board is this, may
I talk, how long have I got, and then the rules that only some tables change.
*/

import { illegalAllowed } from "./illegal";

/*
How each press mode reads to a player (ADR-023, ADR-053).

The first two say what the people at the table do, because the app carries
nothing in them. The last two say what the app itself does, because a player
joining a game that carries messages needs to know which phases they may write
in before anybody has written one.
*/
export const PRESS_LINES: Record<string, string> = {
  ftf: "Negotiate out loud, at the table.",
  gunboat: "Gunboat: no negotiation at all.",
  rulebook: "Messages in the app, in movement phases only.",
  fullpress: "Messages in the app, in every phase.",
};

/** Whether this mode makes the app carry messages at all (ADR-023). */
export function carriesPress(mode: string | undefined): boolean {
  return mode === "fullpress" || mode === "rulebook";
}

export interface RuleSettings {
  deadlineMinutes: number;
  gmPlays: boolean;
  illegalMoves?: boolean;
  pressMode?: string;
  pressSilenceSeconds?: number;
  gmReadsPress?: boolean;
  endYear?: number;
  retreatBuildPercent?: number;
  graceMinutes?: number;
  firstTurnExtraMinutes?: number;
}

/** The minutes a retreat or adjustment phase runs for. */
export function retreatMinutes(settings: RuleSettings): number {
  const share = settings.retreatBuildPercent ?? 50;
  return Math.round(((settings.deadlineMinutes * share) / 100) * 10) / 10;
}

/**
 * The rules of this game as bullets, one fact each. The variant name is
 * passed in because it is the game's board, not one of its settings.
 */
export function ruleLines(
  settings: RuleSettings | undefined,
  variantName?: string,
): string[] {
  const rules = settings || { deadlineMinutes: 0, gmPlays: false };
  const share = rules.retreatBuildPercent ?? 50;
  return [
    variantName ? variantName + " map." : "",
    PRESS_LINES[rules.pressMode || "ftf"] || "",
    rules.deadlineMinutes > 0
      ? "Movement orders: " + rules.deadlineMinutes + " minutes."
      : "No deadline.",
    rules.deadlineMinutes > 0
      ? "Retreats and adjustments: " + retreatMinutes(rules) +
        " minutes (" + share + "% of the movement clock)."
      : "",
    rules.deadlineMinutes > 0 && (rules.graceMinutes ?? 0) > 0
      ? "Orders stay open for " + rules.graceMinutes + " grace minutes after the deadline."
      : "",
    rules.deadlineMinutes > 0 && (rules.firstTurnExtraMinutes ?? 0) > 0
      ? "Spring 1901 gets " + rules.firstTurnExtraMinutes + " extra minutes."
      : "",
    carriesPress(rules.pressMode) && (rules.pressSilenceSeconds ?? 0) > 0
      ? "Messages close " + (rules.pressSilenceSeconds ?? 0) +
        " seconds before the deadline, for writing orders."
      : "",
    carriesPress(rules.pressMode) && rules.gmReadsPress
      ? "The game master reads every message."
      : "",
    /* Only a game that has one gets a line. No end year is the ordinary case
       and it is what a game plays under until somebody wins (ADR-044). */
    rules.endYear && rules.endYear > 0 ? "The game stops after " + rules.endYear + "." : "",
    /* Only the change is worth a line. Allowing illegal orders is what paper
       does, so it is the quiet case; refusing them is the rule a table has
       chosen and the one a player needs told (ADR-029). */
    illegalAllowed(rules)
      ? "Orders are accepted as entered; invalid orders fail under the rules for that phase."
      : "Only legal orders are accepted.",
    rules.gmPlays
      ? "The game master plays a power as well."
      : "The game master does not play a power.",
  ].filter((line) => line !== "");
}

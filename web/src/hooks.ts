import { useEffect, useRef, useState } from "react";

import { illegalAllowed } from "./illegal";

/*
Runs a job now and every `ms` after that, and stops while the tab is hidden so
a phone in a pocket does not keep asking. The job is read from a ref, so a
fresh closure every render does not restart the timer.
*/
export function usePoll(ms: number, job: () => void | Promise<void>, enabled = true): void {
  const latest = useRef(job);
  latest.current = job;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer = 0;

    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try {
          await latest.current();
        } catch {
          // One failed poll is not worth a message; the next one retries.
        }
      }
      if (!stopped) timer = window.setTimeout(tick, ms);
    };

    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [ms, enabled]);
}

/** Re-renders once a second, so a countdown line stays true. */
export function useTicker(enabled = true): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
}

export { countdown } from "./clock";

/*
How each press mode reads to a player (ADR-023). The app carries no messages in
any of them, so every line says what the people at the table do, never what
the screen offers.
*/
const PRESS_LINES: Record<string, string> = {
  ftf: "Negotiate out loud, at the table.",
  gunboat: "Gunboat: no negotiation at all.",
  rulebook: "Negotiate in movement phases only.",
  fullpress: "Full press: negotiate however the table agrees.",
};

/** The rules, one plain sentence each. */
export function settingsLines(
  settings:
    | {
        deadlineMinutes: number;
        gmPlays: boolean;
        illegalMoves?: boolean;
        pressMode?: string;
        endYear?: number;
      }
    | undefined,
): string[] {
  const rules = settings || { deadlineMinutes: 0, gmPlays: false };
  return [
    rules.deadlineMinutes > 0
      ? "Deadline: " + rules.deadlineMinutes + " minutes for each phase."
      : "No deadline.",
    rules.gmPlays
      ? "The game master plays a power as well."
      : "The game master does not play a power.",
    /* Only the change is worth a line. Allowing illegal orders is what paper
       does, so it is the quiet case; refusing them is the rule a table has
       chosen and the one a player needs told (ADR-029). */
    illegalAllowed(rules)
      ? "Illegal orders may be written; they resolve as holds."
      : "Only legal orders are accepted.",
    // A mode the server does not know is a mode this build cannot describe,
    // so it says nothing rather than guessing (filtered below).
    PRESS_LINES[rules.pressMode || "ftf"] || "",
    /* Only a game that has one gets a line. No end year is the ordinary case
       and it is what a game plays under until somebody wins (ADR-044). */
    rules.endYear && rules.endYear > 0
      ? "The game stops after " + rules.endYear + "."
      : "",
  ].filter((line) => line !== "");
}

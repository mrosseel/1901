import { useEffect, useRef, useState } from "react";

import { illegalAllowed } from "./illegal";
import { msLeft } from "./clock";
import { PRESS_LINES, carriesPress, type RuleSettings } from "./rules";

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

/*
Keeps one live invalidation channel open and reconnects it after a sleeping
phone, network change, or server restart. Frames carry no state: they only say
that the caller should re-read its own authorized view. While one read is in
flight, further frames collapse into one final read of the newest state.
*/
export function useGameEvents(
  url: string,
  job: () => void | Promise<unknown>,
  enabled = true,
): boolean {
  const latest = useRef(job);
  latest.current = job;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || !url || typeof WebSocket === "undefined") {
      setConnected(false);
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer = 0;
    let stableTimer = 0;
    let retry = 0;
    let reading = false;
    let readAgain = false;
    let readFailures = 0;
    let stateReadsFailed = false;

    const closeAfterFailedReads = () => {
      stateReadsFailed = true;
      setConnected(false);
      socket?.close(1011, "state refresh failed");
    };

    const read = async () => {
      readAgain = true;
      if (reading) return;
      reading = true;
      while (readAgain && !stopped) {
        readAgain = false;
        try {
          await latest.current();
          readFailures = 0;
        } catch {
          readFailures++;
          if (readFailures >= 5) {
            closeAfterFailedReads();
            break;
          }
          // A live socket and a failed state read is still a stale screen. A
          // few bounded retries cover transient failures; after that the
          // socket yields to the page's slower polling fallback.
          readAgain = true;
          const delay = Math.min(1000 * 2 ** (readFailures - 1), 15000);
          await new Promise((wake) => window.setTimeout(wake, delay));
        }
      }
      reading = false;
    };

    const connect = () => {
      if (stopped || stateReadsFailed) return;
      const target = new URL(url, window.location.href);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const openedSocket = new WebSocket(target);
      socket = openedSocket;
      openedSocket.onopen = () => {
        setConnected(true);
        // An upgrade that a proxy immediately drops is not a successful
        // reconnect. Reset the backoff only after a genuinely stable socket.
        stableTimer = window.setTimeout(() => { retry = 0; }, 5000);
      };
      openedSocket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as { type?: string; version?: number };
          if (event.type === "state" && typeof event.version === "number") void read();
        } catch {
          // Unknown frames belong to a newer protocol. This build ignores
          // them instead of refreshing on untrusted or malformed input.
        }
      };
      openedSocket.onerror = () => openedSocket.close();
      openedSocket.onclose = () => {
        if (socket === openedSocket) socket = null;
        window.clearTimeout(stableTimer);
        setConnected(false);
        if (stopped || stateReadsFailed) return;
        const delay = Math.min(1000 * 2 ** retry, 15000);
        retry++;
        retryTimer = window.setTimeout(connect, delay + Math.random() * 250);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(stableTimer);
      socket?.close(1000, "page closed");
    };
  }, [url, enabled]);

  return connected;
}

/*
Some state changes because server time crosses a boundary, not because a
request was made: reveal opens and force adjudication becomes available when
grace ends. A socket has no mutation to announce then, so refresh once at that
known server timestamp. A sleeping tab runs the overdue timer when it wakes.
*/
export function useRefreshAt(
  at: string | null | undefined,
  job: () => void | Promise<unknown>,
  enabled = true,
): void {
  const latest = useRef(job);
  latest.current = job;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      const left = msLeft(at);
      if (left === null || stopped) return;
      // Browsers cannot represent a timeout past roughly 24 days. Wake and
      // recalculate instead of overflowing a long tournament deadline.
      if (left > 2_000_000_000) {
        timer = window.setTimeout(schedule, 2_000_000_000);
        return;
      }
      timer = window.setTimeout(() => void latest.current(), Math.max(0, left) + 100);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [at, enabled]);
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

/** The rules, one plain sentence each. The words come from rules.ts, so this
    paragraph form and the bullet form can never drift apart. */
export function settingsLines(settings: RuleSettings | undefined): string[] {
  const rules = settings || { deadlineMinutes: 0, gmPlays: false };
  return [
    rules.deadlineMinutes > 0
      ? "Movement clock: " + rules.deadlineMinutes + " minutes. Retreats and adjustments: " +
        (rules.retreatBuildPercent ?? 50) + "% (" +
        Math.round(rules.deadlineMinutes * (rules.retreatBuildPercent ?? 50) / 100 * 10) / 10 +
        " minutes)."
      : "No deadline.",
    rules.deadlineMinutes > 0 && (rules.firstTurnExtraMinutes ?? 0) > 0
      ? "Spring 1901 gets " + rules.firstTurnExtraMinutes + " extra minutes."
      : "",
    rules.deadlineMinutes > 0 && (rules.graceMinutes ?? 0) > 0
      ? "Orders stay open for " + rules.graceMinutes + " grace minutes after the deadline."
      : "",
    rules.gmPlays
      ? "The game master plays a power as well."
      : "The game master does not play a power.",
    /* Only the change is worth a line. Allowing illegal orders is what paper
       does, so it is the quiet case; refusing them is the rule a table has
       chosen and the one a player needs told (ADR-029). */
    illegalAllowed(rules)
      ? "Orders are accepted as entered; invalid orders fail under the rules for that phase."
      : "Only legal orders are accepted.",
    // A mode the server does not know is a mode this build cannot describe,
    // so it says nothing rather than guessing (filtered below).
    PRESS_LINES[rules.pressMode || "ftf"] || "",
    /*
    The two things a player must be told before joining a game that carries
    messages: when the app stops taking them, and whether the referee is in
    every conversation (ADR-054, ADR-055). Both are silent in a game with no
    messages in it, where neither means anything.
    */
    carriesPress(rules.pressMode) && (rules.pressSilenceSeconds ?? 0) > 0
      ? "Messages close " + (rules.pressSilenceSeconds ?? 0) +
        " seconds before the deadline, for writing orders."
      : "",
    carriesPress(rules.pressMode) && rules.gmReadsPress
      ? "The game master reads every message."
      : "",
    /* Only a game that has one gets a line. No end year is the ordinary case
       and it is what a game plays under until somebody wins (ADR-044). */
    rules.endYear && rules.endYear > 0
      ? "The game stops after " + rules.endYear + "."
      : "",
  ].filter((line) => line !== "");
}

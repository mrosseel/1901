/*
Every fixture still matches the type the gallery reads it as.

The files are JSON, so `as SeatState` proves nothing. These tests are what
makes the cast true: each file is walked through the structural guard for its
kind, and a capture taken against a server whose shapes have moved fails here
rather than rendering a page full of blanks.

The naming rule is the test's only convention: a file called seat-* holds a
SeatState, gm-* a GmState, watch-* a WatchState, options-* a book of option
trees, datc-* the published compliance report. Anything else is a fixture
nobody claims, which is also a failure.
*/

import { describe, expect, it } from "vitest";
import { names, raw } from "./fixtures";
import {
  isDatcReport,
  isGmState,
  isOptionBook,
  isOptionTree,
  isPublicState,
  isSeatState,
  isWatchState,
} from "./guards";

const guards: Array<[string, (value: unknown) => boolean]> = [
  ["seat-", isSeatState],
  ["gm-", isGmState],
  ["watch-", isWatchState],
  ["options-", isOptionBook],
  ["datc-", isDatcReport],
];

describe("fixtures", () => {
  it("has some", () => {
    expect(names.length).toBeGreaterThan(10);
  });

  it.each(names)("%s matches the type its name claims", (name) => {
    const guard = guards.find(([prefix]) => name.startsWith(prefix));
    expect(guard, "no type is claimed by the name " + name).toBeTruthy();
    expect(guard![1](raw(name))).toBe(true);
  });

  /*
  The moments the gallery was built for. A fixture that still parses but no
  longer holds its interesting fact is a fixture that has quietly stopped
  earning its place.
  */
  it("keeps the review that carries a bounce, a dislodge and an NMR", () => {
    const state = raw("seat-retreat") as Record<string, never>;
    const previous = state.previousPhase as unknown as {
      resolutions: Record<string, string>;
      dislodged: Record<string, unknown>;
      nmr: string[];
    };
    const failed = Object.values(previous.resolutions).filter((one) => one !== "OK");
    expect(failed.some((one) => one.startsWith("ErrBounce"))).toBe(true);
    expect(Object.keys(previous.dislodged).length).toBeGreaterThan(0);
    expect(previous.nmr.length).toBeGreaterThan(0);
  });

  it("keeps a seat that owes builds and one that owes a disband", () => {
    const builds = raw("options-build");
    const disbands = raw("options-disband");
    expect(JSON.stringify(builds)).toContain("MAX:Build:");
    expect(JSON.stringify(disbands)).toContain("MAX:Disband:");
  });

  it("keeps a dislodged unit on the seat that must retreat", () => {
    const state = raw("seat-retreat") as { dislodged?: Record<string, unknown> };
    expect(Object.keys(state.dislodged || {})).toHaveLength(1);
    expect(Object.keys(raw("options-retreat") as object)).toHaveLength(1);
  });

  it("keeps a lobby with three of six seats filled", () => {
    const gm = raw("gm-prestart") as { joinedCount: number; totalSeats: number; started: boolean };
    expect(gm.started).toBe(false);
    expect(gm.joinedCount).toBe(3);
    expect(gm.totalSeats).toBe(6);
  });

  it("keeps a game master whose deadline has passed with force armed", () => {
    const gm = raw("gm-deadline-passed") as { canForce: boolean; deadlineAt: string; now: string };
    expect(gm.canForce).toBe(true);
    expect(Date.parse(gm.deadlineAt)).toBeLessThan(Date.parse(gm.now));
  });

  /* The endings (ADR-044). Three fixtures, two kinds: a draw the table agreed
     and a round that stopped at its end year. A capture whose result went
     missing draws the running game, which is the one thing these screens are
     not for. */
  it("keeps a game the table drew and one that hit its end year", () => {
    const drawn = raw("seat-ended-draw") as { result?: { kind: string; powers: string[] } };
    expect(drawn.result?.kind).toBe("draw");
    expect(drawn.result?.powers.length).toBeGreaterThan(1);

    const gm = raw("gm-ended-draw") as { result?: { kind: string }; canForce: boolean };
    expect(gm.result?.kind).toBe("draw");
    expect(gm.canForce).toBe(false);

    const ended = raw("watch-ended") as { result?: { kind: string; year: number } };
    expect(ended.result?.kind).toBe("endYear");
    expect(ended.result?.year).toBe(1901);
  });

  /* The DATC report is the page (ADR-045): a copy with no cases in it would
     render a screen that says nothing. */
  it("keeps a DATC report with cases in it", () => {
    const report = raw("datc-report") as { cases: number; files: unknown[]; limits: string[] };
    expect(report.cases).toBeGreaterThan(100);
    expect(report.files.length).toBeGreaterThan(1);
    expect(report.limits.length).toBeGreaterThan(0);
  });

  it("keeps every resolved phase of the spectator feed", () => {
    for (let i = 0; i < 5; i++) {
      const phase = raw("watch-phase-" + i) as { phaseIndex: number; phaseCount: number };
      expect(phase.phaseIndex).toBe(i);
      expect(phase.phaseCount).toBe(5);
    }
  });
});

/*
The guards must be able to say no. A structural check that accepts anything
would pass every test above while proving nothing.
*/
describe("guards", () => {
  it("refuse the wrong kind of state", () => {
    expect(isSeatState(raw("gm-midphase"))).toBe(false);
    expect(isGmState(raw("seat-movement"))).toBe(false);
    expect(isOptionBook(raw("seat-movement"))).toBe(false);
  });

  it("refuse rubbish", () => {
    for (const guard of [isSeatState, isGmState, isWatchState, isPublicState, isOptionTree]) {
      expect(guard(null)).toBe(false);
      expect(guard(42)).toBe(false);
      expect(guard([])).toBe(false);
    }
  });

  it("refuse a state whose units have lost their shape", () => {
    const broken = JSON.parse(JSON.stringify(raw("seat-movement")));
    broken.units.par = { type: "Army" };
    expect(isSeatState(broken)).toBe(false);
  });
});

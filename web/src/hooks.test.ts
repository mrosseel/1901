import { afterEach, describe, expect, it, vi } from "vitest";
import { countdown, settingsLines } from "./hooks";

afterEach(() => vi.useRealTimers());

describe("countdown", () => {
  it("says so when a game runs without one", () => {
    expect(countdown(null)).toBe("No deadline");
    expect(countdown(undefined)).toBe("No deadline");
  });

  it("counts minutes and seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    expect(countdown("2026-01-01T12:02:05Z")).toBe("2:05 left");
    expect(countdown("2026-01-01T13:20:00Z")).toBe("1:20:00 left");
  });

  it("stops at zero rather than counting up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    expect(countdown("2026-01-01T11:59:00Z")).toBe("Deadline passed");
  });
});

describe("the rules, in words", () => {
  it("names the deadline and who plays", () => {
    expect(settingsLines({ deadlineMinutes: 15, gmPlays: true })).toEqual([
      "Movement clock: 15 minutes. Retreats and adjustments: 50% (7.5 minutes).",
      "The game master plays a power as well.",
      "Orders are accepted as entered; invalid orders fail under the rules for that phase.",
      "Negotiate out loud, at the table.",
    ]);
    expect(settingsLines({ deadlineMinutes: 0, gmPlays: false })).toEqual([
      "No deadline.",
      "The game master does not play a power.",
      "Orders are accepted as entered; invalid orders fail under the rules for that phase.",
      "Negotiate out loud, at the table.",
    ]);
  });

  /* A mode the app carries nothing in says what the people do; a mode it
     carries messages in says what the app does (ADR-023, ADR-053). */
  it("says how the table negotiates", () => {
    const press = (mode: string) =>
      settingsLines({ deadlineMinutes: 0, gmPlays: false, pressMode: mode })[3];
    expect(press("gunboat")).toBe("Gunboat: no negotiation at all.");
    expect(press("rulebook")).toBe("Messages in the app, in movement phases only.");
    expect(press("fullpress")).toBe("Messages in the app, in every phase.");
  });

  /* Two rules a player must be told before joining a game that carries
     messages: when the app stops taking them (WDC 4b2), and whether the
     referee is in every conversation (ADR-054). */
  it("says when messages close and who else is reading them", () => {
    const lines = settingsLines({
      deadlineMinutes: 15,
      gmPlays: false,
      pressMode: "fullpress",
      pressSilenceSeconds: 60,
      gmReadsPress: true,
    });
    expect(lines).toContain("Messages close 60 seconds before the deadline, for writing orders.");
    expect(lines).toContain("The game master reads every message.");
  });

  it("says neither in a game that carries no messages", () => {
    const lines = settingsLines({
      deadlineMinutes: 15,
      gmPlays: false,
      pressMode: "ftf",
      pressSilenceSeconds: 60,
      gmReadsPress: true,
    });
    expect(lines.join(" ")).not.toContain("Messages close");
    expect(lines.join(" ")).not.toContain("reads every message");
  });

  it("says nothing about a mode this build does not know", () => {
    expect(
      settingsLines({ deadlineMinutes: 0, gmPlays: false, pressMode: "telepathy" }),
    ).toHaveLength(3);
  });

  /* A server that predates the setting accepted whatever it was sent, so an
     absent setting reads as the permissive one (ADR-029). */
  it("says illegal orders are allowed when nothing says otherwise", () => {
    expect(settingsLines({ deadlineMinutes: 0, gmPlays: false })[2]).toBe(
      "Orders are accepted as entered; invalid orders fail under the rules for that phase.",
    );
    expect(settingsLines(undefined)[2]).toBe(
      "Orders are accepted as entered; invalid orders fail under the rules for that phase.",
    );
  });

  it("names the table that turned them off", () => {
    expect(
      settingsLines({ deadlineMinutes: 0, gmPlays: false, illegalMoves: false })[2],
    ).toBe("Only legal orders are accepted.");
  });
});

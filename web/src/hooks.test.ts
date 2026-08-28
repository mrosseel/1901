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
    expect(countdown("2026-01-01T13:20:00Z")).toBe("1h 20m left");
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
      "Deadline: 15 minutes for each phase.",
      "The game master plays a power as well.",
    ]);
    expect(settingsLines({ deadlineMinutes: 0, gmPlays: false })).toEqual([
      "No deadline.",
      "The game master does not play a power.",
    ]);
  });
});

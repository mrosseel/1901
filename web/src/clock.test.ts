import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clockFace,
  clockTone,
  countdown,
  msLeft,
  noteServerTime,
  resetServerTime,
  serverNow,
  serverOffsetMs,
  serverTimeKnown,
} from "./clock";

beforeEach(() => {
  resetServerTime();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetServerTime();
});

describe("the server's clock", () => {
  it("uses the device's own until a server time arrives", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    expect(serverTimeKnown()).toBe(false);
    expect(serverNow()).toBe(Date.now());
    expect(countdown("2026-01-01T12:02:05Z")).toBe("2:05 left");
  });

  it("counts against the server when the device's clock is fast", () => {
    // The phone believes it is 12:05; the server says 12:00. A deadline at
    // 12:02 has not passed, whatever the phone thinks.
    vi.setSystemTime(new Date("2026-01-01T12:05:00Z"));
    noteServerTime("2026-01-01T12:00:00Z");
    expect(serverOffsetMs()).toBe(-5 * 60_000);
    expect(msLeft("2026-01-01T12:02:00Z")).toBe(2 * 60_000);
    expect(countdown("2026-01-01T12:02:00Z")).toBe("2:00 left");
  });

  it("counts against the server when the device's clock is slow", () => {
    vi.setSystemTime(new Date("2026-01-01T11:57:00Z"));
    noteServerTime("2026-01-01T12:00:00Z");
    expect(serverOffsetMs()).toBe(3 * 60_000);
    expect(countdown("2026-01-01T12:04:00Z")).toBe("4:00 left");
  });

  it("keeps ticking against the offset as the device's clock runs", () => {
    vi.setSystemTime(new Date("2026-01-01T12:05:00Z"));
    noteServerTime("2026-01-01T12:00:00Z");
    vi.advanceTimersByTime(30_000);
    expect(countdown("2026-01-01T12:02:00Z")).toBe("1:30 left");
  });

  /*
  A refresh loses the offset and takes a new one from the next poll, which is
  the whole reason nothing is written down: the answer is the same either way.
  */
  it("comes back to the same answer after a refresh", () => {
    vi.setSystemTime(new Date("2026-01-01T12:05:30Z"));
    noteServerTime("2026-01-01T12:00:30Z");
    const before = countdown("2026-01-01T12:02:00Z");
    resetServerTime();
    noteServerTime("2026-01-01T12:00:30Z");
    expect(countdown("2026-01-01T12:02:00Z")).toBe(before);
  });

  it("ignores a server time it cannot read", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    noteServerTime("not a time");
    noteServerTime(null);
    noteServerTime(undefined);
    expect(serverTimeKnown()).toBe(false);
    expect(serverOffsetMs()).toBe(0);
  });
});

describe("the face and its colour", () => {
  it("shows minutes and seconds, and hours when there are any", () => {
    expect(clockFace(2 * 60_000 + 5_000)).toBe("2:05");
    expect(clockFace(9_000)).toBe("0:09");
    expect(clockFace(3600_000 + 4 * 60_000 + 2_000)).toBe("1:04:02");
    expect(clockFace(0)).toBe("0:00");
    expect(clockFace(null)).toBe("");
  });

  it("turns amber under five minutes and red under one", () => {
    expect(clockTone(20 * 60_000)).toBe("calm");
    expect(clockTone(5 * 60_000)).toBe("calm");
    expect(clockTone(4 * 60_000 + 59_000)).toBe("low");
    expect(clockTone(60_000)).toBe("low");
    expect(clockTone(59_000)).toBe("urgent");
    expect(clockTone(0)).toBe("over");
    expect(clockTone(-1)).toBe("over");
    expect(clockTone(null)).toBe("calm");
  });

  it("says there is no clock at all when the game has no deadline", () => {
    expect(msLeft(null)).toBeNull();
    expect(msLeft("nonsense")).toBeNull();
    expect(countdown(null)).toBe("No deadline");
  });
});

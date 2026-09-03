import { beforeEach, describe, expect, it } from "vitest";

import { gameIdInUrl, heldGames } from "./held";
import { makeEntropy, writeStoredKey } from "./gmkey";
import { makeSeatSeed, writeSeatSeed } from "./seatkey";

describe("the games this device holds", () => {
  beforeEach(() => window.localStorage.clear());

  it("finds nothing in fresh storage", () => {
    expect(heldGames()).toEqual([]);
  });

  it("reports a seat, a game master key, and both at once", () => {
    writeSeatSeed("aaa", makeSeatSeed());
    writeStoredKey("bbb", makeEntropy());
    writeSeatSeed("ccc", makeSeatSeed());
    writeStoredKey("ccc", makeEntropy());

    expect(heldGames()).toEqual([
      { gameId: "aaa", seat: true, gameMaster: false },
      { gameId: "bbb", seat: false, gameMaster: true },
      { gameId: "ccc", seat: true, gameMaster: true },
    ]);
  });

  it("ignores keys of other kinds and entries of the wrong length", () => {
    window.localStorage.setItem("1901.recentGame", '{"url":"/game/aaa/seat/me","label":"x"}');
    window.localStorage.setItem("1901.draft.aaa.3", "{}");
    window.localStorage.setItem("1901.seat.short", "AAAA");

    expect(heldGames()).toEqual([]);
  });

  it("carries on when the browser refuses to remember anything", () => {
    const store = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("site data is blocked");
      },
    });
    expect(heldGames()).toEqual([]);
    Object.defineProperty(window, "localStorage", { configurable: true, value: store });
  });
});

describe("the game an address belongs to", () => {
  it("reads the id out of a seat, a referee and a watch address", () => {
    expect(gameIdInUrl("/game/aaa/seat/me")).toBe("aaa");
    expect(gameIdInUrl("https://host/game/bbb/referee/")).toBe("bbb");
    expect(gameIdInUrl("/game/c%20c/watch?x=1")).toBe("c c");
  });

  it("says nothing for an address that names no game", () => {
    expect(gameIdInUrl("/games")).toBeNull();
    expect(gameIdInUrl("")).toBeNull();
  });
});

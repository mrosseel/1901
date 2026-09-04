import { describe, expect, it } from "vitest";

import type { GameSummary } from "./api";
import type { HeldGame } from "./held";
import {
  anyRows,
  buildRows,
  groupRows,
  isYours,
  seatText,
  seatTone,
  yoursLabel,
  type GameRow,
} from "./gamelist";

function summary(over: Partial<GameSummary> & { gameId: string }): GameSummary {
  return {
    name: "",
    variant: { key: "classical", name: "Classical", supported: true },
    started: false,
    phase: { season: "Spring", year: 1901, type: "Movement" },
    joinedCount: 0,
    totalSeats: 7,
    turns: 0,
    deadlineAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    referee: false,
    ...over,
  };
}

function held(gameId: string, seat: boolean, gameMaster: boolean): HeldGame {
  return { gameId: gameId, seat: seat, gameMaster: gameMaster };
}

describe("the rows the game list draws", () => {
  it("keeps the server's order and marks what this device holds", () => {
    const rows = buildRows(
      [summary({ gameId: "aaa", name: "Table one" }), summary({ gameId: "bbb" })],
      [held("bbb", true, false)],
    );

    expect(rows.map((row) => row.gameId)).toEqual(["aaa", "bbb"]);
    expect(rows[0].name).toBe("Table one");
    expect(rows[0].seat).toBe(false);
    expect(rows[1].seat).toBe(true);
    expect(rows.every((row) => row.onServer)).toBe(true);
  });

  it("keeps a held game the server no longer lists", () => {
    const rows = buildRows([summary({ gameId: "aaa" })], [held("zzz", false, true)]);

    expect(rows.map((row) => row.gameId)).toEqual(["aaa", "zzz"]);
    expect(rows[1].onServer).toBe(false);
    expect(rows[1].gmKey).toBe(true);
  });

  it("holds the keys before the server has answered", () => {
    const rows = buildRows(null, [held("zzz", true, false)]);

    expect(rows).toHaveLength(1);
    expect(rows[0].onServer).toBe(false);
  });
});

describe("whose game a row is", () => {
  const bare = buildRows([summary({ gameId: "aaa" })], [])[0];

  it("is nobody's without a key and without the referee mark", () => {
    expect(isYours(bare)).toBe(false);
    expect(yoursLabel(bare)).toBe("");
  });

  it("names the seat, the role, and both", () => {
    expect(yoursLabel({ ...bare, seat: true })).toBe("your seat");
    expect(yoursLabel({ ...bare, gmKey: true })).toBe("GM");
    expect(yoursLabel({ ...bare, referee: true })).toBe("GM");
    expect(yoursLabel({ ...bare, seat: true, referee: true })).toBe("your seat and GM");
  });

  it("says nothing on a sandbox, whose creator holds the cookie anyway", () => {
    expect(yoursLabel({ ...bare, sandbox: true, referee: true })).toBe("");
  });

  it("counts the referee mark as yours, key or no key", () => {
    expect(isYours({ ...bare, referee: true })).toBe(true);
  });
});

describe("the seat count on a row", () => {
  const rows = buildRows(
    [
      summary({ gameId: "aaa", joinedCount: 3, totalSeats: 7 }),
      summary({ gameId: "bbb", sandbox: true, joinedCount: 0, totalSeats: 7 }),
    ],
    [],
  );

  it("reads as a fraction of the table", () => {
    expect(seatText(rows[0])).toBe("3 / 7");
  });

  it("says nothing on a sandbox, which has no seats to fill", () => {
    expect(seatText(rows[1])).toBe("");
  });
});

describe("the colour of the seat count", () => {
  it("marks a full table, one filling up, and one still open", () => {
    expect(seatTone(7, 7)).toBe("good");
    expect(seatTone(4, 7)).toBe("warn");
    expect(seatTone(3, 7)).toBe("muted");
    expect(seatTone(1, 2)).toBe("muted");
    expect(seatTone(0, 7)).toBe("muted");
  });

  it("has nothing to say about a table with no seats", () => {
    expect(seatTone(0, 0)).toBe("muted");
  });
});

describe("the blocks the page prints", () => {
  const rows = buildRows(
    [
      summary({ gameId: "playing", started: true }),
      summary({ gameId: "waiting" }),
      summary({ gameId: "mine", started: true }),
    ],
    [held("mine", true, false), held("gone", false, true)],
  );

  it("splits the server's games by whether they have started", () => {
    const groups = groupRows(rows, false);
    expect(groups.playing.map((row) => row.gameId)).toEqual(["playing", "mine"]);
    expect(groups.waiting.map((row) => row.gameId)).toEqual(["waiting"]);
    expect(groups.gone.map((row) => row.gameId)).toEqual(["gone"]);
  });

  it("keeps only the rows this device can open when asked", () => {
    const groups = groupRows(rows, true);
    expect(groups.playing.map((row) => row.gameId)).toEqual(["mine"]);
    expect(groups.waiting).toEqual([]);
    expect(groups.gone.map((row) => row.gameId)).toEqual(["gone"]);
    expect(anyRows(groups)).toBe(true);
  });

  it("says a filter matched nothing", () => {
    const strangers: GameRow[] = buildRows([summary({ gameId: "aaa" })], []);
    expect(anyRows(groupRows(strangers, true))).toBe(false);
    expect(anyRows(groupRows(strangers, false))).toBe(true);
  });
});

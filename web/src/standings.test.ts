import { describe, expect, it } from "vitest";
import { buildBalance, standings } from "./standings";
import type { BoardState } from "./board/types";

/*
The supply centre count is the number the game is about, and it is arithmetic
on a board every screen already draws. Nothing here asks the server for
anything.
*/
const STATE: BoardState = {
  phase: { season: "Fall", year: 1902, type: "Adjustment" },
  units: {
    vie: { type: "Army", nation: "Austria" },
    bud: { type: "Army", nation: "Austria" },
    par: { type: "Army", nation: "France" },
    mos: { type: "Army", nation: "Russia" },
  },
  supplyCenters: {
    vie: "Austria",
    bud: "Austria",
    tri: "Austria",
    par: "France",
    mar: "France",
    mos: "Russia",
  },
  orders: {},
  orderParts: {},
};

describe("the supply centre count", () => {
  it("counts what each power owns and what it has standing", () => {
    expect(standings(STATE)).toEqual([
      { power: "Austria", supplyCentres: 3, units: 2 },
      { power: "France", supplyCentres: 2, units: 1 },
      { power: "Russia", supplyCentres: 1, units: 1 },
    ]);
  });

  it("puts the leader first and settles a tie by name", () => {
    const rows = standings({
      ...STATE,
      supplyCenters: { par: "France", mos: "Russia" },
      units: {},
    });
    expect(rows.map((row) => row.power)).toEqual(["France", "Russia"]);
  });

  /* A power with nothing left is the story of the game so far, and a table
     is entitled to read it. */
  it("still lists a power that has lost everything", () => {
    const rows = standings(STATE, ["Austria", "France", "Russia", "Turkey"]);
    expect(rows.at(-1)).toEqual({ power: "Turkey", supplyCentres: 0, units: 0 });
  });

  it("says nothing at all about a board it has not been given", () => {
    expect(standings(null)).toEqual([]);
    expect(standings(undefined)).toEqual([]);
  });

  it("reads builds owed and units to come off from the same two numbers", () => {
    expect(buildBalance({ power: "Austria", supplyCentres: 3, units: 2 })).toBe(1);
    expect(buildBalance({ power: "France", supplyCentres: 1, units: 4 })).toBe(-3);
  });
});


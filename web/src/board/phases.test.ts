import { describe, expect, it } from "vitest";
import {
  candidates,
  describeInPhase,
  dutyLine,
  dutyOf,
  dutyProgress,
  emptyPlan,
  ownDislodged,
  phaseKind,
} from "./phases";
import type { BoardState, OptionTree } from "./types";

describe("phase kinds", () => {
  it("reads the phase type godip sends", () => {
    expect(phaseKind({ season: "Spring", year: 1901, type: "Movement" })).toBe("movement");
    expect(phaseKind({ season: "Fall", year: 1901, type: "Retreat" })).toBe("retreat");
    expect(phaseKind({ season: "Fall", year: 1901, type: "Adjustment" })).toBe("adjustment");
    expect(phaseKind(undefined)).toBe("movement");
  });
});

describe("the build and disband count", () => {
  it("is one more than the number in the filter", () => {
    expect(dutyOf({ Build: { Filter: "MAX:Build:0" } } as OptionTree)).toEqual({
      type: "Build",
      count: 1,
    });
    expect(dutyOf({ Build: { Filter: "MAX:Build:2" } } as OptionTree)).toEqual({
      type: "Build",
      count: 3,
    });
    expect(dutyOf({ Disband: { Filter: "MAX:Disband:1" } } as OptionTree)).toEqual({
      type: "Disband",
      count: 2,
    });
  });

  it("is absent where the tree carries no filter", () => {
    expect(dutyOf({ Move: { Type: "OrderType" } } as OptionTree)).toBeNull();
  });

  it("counts the orders already in", () => {
    const state: BoardState = {
      orderParts: { rom: ["Build", "Army"], nap: ["Build", "Fleet"], bud: ["Disband"] },
    };
    expect(dutyProgress(state, { type: "Build", count: 3 })).toBe(2);
    expect(dutyProgress(state, { type: "Disband", count: 1 })).toBe(1);
  });
});

describe("what to ask the server about", () => {
  const retreatState: BoardState = {
    units: { tri: { type: "Army", nation: "Italy" } },
    dislodged: {
      tri: { type: "Fleet", nation: "Austria" },
      gal: { type: "Army", nation: "Russia" },
    },
  };

  it("asks about your own dislodged units in a retreat", () => {
    expect(candidates(retreatState, "Austria", "retreat")).toEqual(["tri"]);
    expect(ownDislodged(retreatState, "Russia")).toEqual(["gal"]);
  });

  it("asks about your units and your empty supply centres in an adjustment", () => {
    const state: BoardState = {
      units: { bud: { type: "Army", nation: "Austria" }, ven: { type: "Army", nation: "Italy" } },
      supplyCenters: { bud: "Austria", vie: "Austria", tri: "Italy", ven: "Italy" },
    };
    // vie is Austria's and nothing stands there, so a build may be offered;
    // tri is Italy's now; bud carries a unit, so a disband may be offered
    // there.
    expect(candidates(state, "Austria", "adjustment")).toEqual(["bud", "vie"]);
  });

  it("knows no home centres of its own: every empty centre it holds is asked about", () => {
    // ser is not a classical home centre. The server answers with an empty
    // tree for it, and the page has no table that could have ruled it out —
    // which is what lets a variant with other home centres work at all.
    const state: BoardState = {
      units: {},
      supplyCenters: { ser: "Austria", vie: "Austria", par: "France" },
    };
    expect(candidates(state, "Austria", "adjustment")).toEqual(["ser", "vie"]);
  });

  it("asks about nothing at all in a movement phase", () => {
    expect(candidates(retreatState, "Austria", "movement")).toEqual([]);
  });
});

describe("the line that says what this phase wants", () => {
  const state: BoardState = {
    units: { tri: { type: "Army", nation: "Italy" } },
    dislodged: { tri: { type: "Fleet", nation: "Austria" } },
  };

  it("names the unit that must retreat", () => {
    const plan = {
      kind: "retreat" as const,
      power: "Austria",
      actionable: { tri: {} },
      duty: null,
    };
    expect(dutyLine(plan, state)).toBe("Fleet Trieste must retreat or disband.");
  });

  it("says when there is nothing to do", () => {
    expect(dutyLine(emptyPlan("Austria", "retreat"), state)).toBe(
      "Nothing to order this phase — waiting for others.",
    );
    expect(dutyLine(emptyPlan("Austria", "adjustment"), state)).toBe(
      "Nothing to order this phase — waiting for others.",
    );
  });

  it("says how many builds or disbands are owed", () => {
    expect(
      dutyLine(
        {
          kind: "adjustment",
          power: "Italy",
          actionable: { rom: {} },
          duty: { type: "Build", count: 2 },
        },
        state,
      ),
    ).toBe("Build 2: tap a highlighted supply centre.");
    expect(
      dutyLine(
        {
          kind: "adjustment",
          power: "Austria",
          actionable: { bud: {} },
          duty: { type: "Disband", count: 1 },
        },
        state,
      ),
    ).toBe("Disband 1: tap a unit to remove.");
  });

  it("stays quiet in a movement phase", () => {
    expect(dutyLine(emptyPlan("Austria"), state)).toBe("");
  });
});

describe("order sentences", () => {
  it("reads the same parts differently in each phase", () => {
    expect(describeInPhase("tri", ["Move", "alb"], "retreat")).toBe("Trieste retreats to Albania.");
    expect(describeInPhase("tri", ["Disband"], "retreat")).toBe("Trieste disbands.");
    expect(describeInPhase("rom", ["Build", "Army"], "adjustment")).toBe("Rome builds an army.");
    expect(describeInPhase("rom", ["Build", "Fleet"], "adjustment")).toBe("Rome builds a fleet.");
    expect(describeInPhase("bud", ["Disband"], "adjustment")).toBe("Budapest disbands.");
    // A movement phase keeps the wording the board already had.
    expect(describeInPhase("vie", ["Move", "gal"], "movement")).toBe("");
  });
});

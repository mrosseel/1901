import { describe, expect, it } from "vitest";

import {
  abbreviateOrder,
  abbreviateOrders,
  mapCode,
  provinceCode,
  unitInitial,
  unitsOf,
} from "./notation";
import type { Unit } from "./board/types";

const board: Record<string, Unit> = {
  par: { type: "Army", nation: "France" },
  tri: { type: "Fleet", nation: "Austria" },
  ven: { type: "Army", nation: "Italy" },
  gal: { type: "Army", nation: "Russia" },
  nth: { type: "Fleet", nation: "England" },
  lon: { type: "Army", nation: "England" },
  "spa/sc": { type: "Fleet", nation: "France" },
};

const at = unitsOf(board);

describe("provinceCode", () => {
  it("capitalizes the variant's own key", () => {
    expect(provinceCode("bur")).toBe("Bur");
    expect(provinceCode("par")).toBe("Par");
  });

  it("keeps a coast on the end, in its own case", () => {
    expect(provinceCode("spa/sc")).toBe("Spa/sc");
  });

  it("answers nothing for nothing", () => {
    expect(provinceCode("")).toBe("");
  });
});

describe("mapCode", () => {
  it("is the same key in the case a map label wants", () => {
    expect(mapCode("bur")).toBe("BUR");
    expect(mapCode("spa/sc")).toBe("SPA/SC");
  });
});

describe("unitInitial", () => {
  it("is the first letter of the type", () => {
    expect(unitInitial({ type: "Army", nation: "France" })).toBe("A");
    expect(unitInitial({ type: "Fleet", nation: "France" })).toBe("F");
  });

  it("is empty where nothing is standing", () => {
    expect(unitInitial(undefined)).toBe("");
  });
});

describe("abbreviateOrder in a movement phase", () => {
  it("writes a move", () => {
    expect(abbreviateOrder("par", ["Move", "bur"], "movement", at)).toBe("A Par → Bur");
  });

  it("writes a hold", () => {
    expect(abbreviateOrder("gal", ["Hold"], "movement", at)).toBe("A Gal H");
  });

  it("writes a support to move", () => {
    expect(abbreviateOrder("tri", ["Support", "ven", "tri"], "movement", at)).toBe(
      "F Tri S A Ven → Tri",
    );
  });

  /* A support that names its own source is a support to hold, and so is one
     with no third part at all. Both must read the same. */
  it("writes a support to hold, however the parts spell it", () => {
    expect(abbreviateOrder("tri", ["Support", "ven", "ven"], "movement", at)).toBe(
      "F Tri S A Ven",
    );
    expect(abbreviateOrder("tri", ["Support", "ven"], "movement", at)).toBe("F Tri S A Ven");
  });

  it("writes a convoy", () => {
    expect(abbreviateOrder("nth", ["Convoy", "lon", "bel"], "movement", at)).toBe(
      "F Nth C A Lon → Bel",
    );
  });

  it("names a province with no unit on it without a letter", () => {
    expect(abbreviateOrder("bur", ["Hold"], "movement", at)).toBe("Bur H");
  });
});

describe("abbreviateOrder in a retreat phase", () => {
  const dislodged: Record<string, Unit> = { tri: { type: "Fleet", nation: "Austria" } };
  const retreating = unitsOf(board, dislodged);

  it("marks a retreat apart from an ordinary move", () => {
    expect(abbreviateOrder("tri", ["Move", "alb"], "retreat", retreating)).toBe("F Tri ⇢ Alb");
  });

  it("writes a disband", () => {
    expect(abbreviateOrder("tri", ["Disband"], "retreat", retreating)).toBe("F Tri ✕");
  });
});

describe("abbreviateOrder in an adjustment phase", () => {
  it("writes a build with the unit it will put there", () => {
    expect(abbreviateOrder("rom", ["Build", "Army"], "adjustment", at)).toBe("Build A Rom");
    expect(abbreviateOrder("nap", ["Build", "Fleet"], "adjustment", at)).toBe("Build F Nap");
  });

  it("writes a disband", () => {
    expect(abbreviateOrder("gal", ["Disband"], "adjustment", at)).toBe("A Gal ✕");
  });
});

describe("abbreviateOrder on anything it does not know", () => {
  it("falls back to the province alone when there are no parts", () => {
    expect(abbreviateOrder("par", [], "movement", at)).toBe("Par");
  });

  it("strings an unknown order type's parts together rather than dropping it", () => {
    expect(abbreviateOrder("par", ["Sabotage", "bur"], "movement", at)).toBe("A Par Bur");
  });
});

describe("abbreviateOrders", () => {
  it("keeps the province keys and writes every value", () => {
    const out = abbreviateOrders(
      { par: ["Move", "bur"], gal: ["Hold"] },
      "movement",
      at,
    );
    expect(out).toEqual({ par: "A Par → Bur", gal: "A Gal H" });
  });

  it("answers an empty table with an empty one", () => {
    expect(abbreviateOrders({}, "movement", at)).toEqual({});
  });
});

describe("unitsOf", () => {
  it("finds a coast's unit by its own key", () => {
    expect(unitsOf(board)("spa/sc")?.type).toBe("Fleet");
  });

  it("falls back from a coast to the base province", () => {
    expect(unitsOf(board)("par/nc")?.type).toBe("Army");
  });

  /* In a retreat the unit that gives the order is the one that was thrown
     out, not the one that took the province from it. */
  it("prefers a dislodged unit to the one now standing there", () => {
    const lookup = unitsOf(
      { tri: { type: "Army", nation: "Italy" } },
      { tri: { type: "Fleet", nation: "Austria" } },
    );
    expect(lookup("tri")?.nation).toBe("Austria");
  });
});

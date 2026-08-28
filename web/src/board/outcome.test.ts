import { describe, expect, it } from "vitest";
import {
  SUPPORT_BOW,
  bowStep,
  inkForStyle,
  outcomeOf,
  outcomePaint,
  supportBow,
  supportRanks,
  supportTarget,
} from "./outcome";

describe("the ink a map wants", () => {
  it("puts light ink on the one dark style", () => {
    expect(inkForStyle("midnight")).toBe("light");
  });

  it("puts dark ink on every light style, and on no style at all", () => {
    expect(inkForStyle("parchment")).toBe("dark");
    expect(inkForStyle("print")).toBe("dark");
    expect(inkForStyle("flat")).toBe("dark");
    expect(inkForStyle("")).toBe("dark");
    expect(inkForStyle(undefined)).toBe("dark");
  });
});

describe("what an order graphic means", () => {
  it("calls a move that came off a success", () => {
    expect(outcomeOf("movement", ["Move", "tri"], false)).toBe("success");
  });

  it("calls anything that did not come off a failure", () => {
    expect(outcomeOf("movement", ["Move", "tri"], true)).toBe("failed");
    expect(outcomeOf("adjustment", ["Build", "Army"], true)).toBe("failed");
  });

  it("calls a retreat phase's own orders retreats", () => {
    expect(outcomeOf("retreat", ["Move", "alb"], false)).toBe("retreat");
    expect(outcomeOf("retreat", ["Disband"], false)).toBe("retreat");
  });

  it("lets a failure beat a retreat, because that unit comes off the board", () => {
    expect(outcomeOf("retreat", ["Move", "alb"], true)).toBe("failed");
  });
});

describe("the outcome palette", () => {
  it("draws a success in ink and a failure in red, whichever way the map goes", () => {
    const onLight = outcomePaint("success", "dark");
    const onDark = outcomePaint("success", "light");
    expect(onLight.line).not.toBe(onDark.line);
    expect(outcomePaint("failed", "dark").line).toBe(outcomePaint("failed", "light").line);
    expect(outcomePaint("retreat", "dark").line).toBe(outcomePaint("retreat", "light").line);
  });

  it("always contrasts the halo against the ink", () => {
    expect(outcomePaint("success", "dark").halo).toBe(outcomePaint("failed", "dark").halo);
    expect(outcomePaint("success", "dark").halo).not.toBe(outcomePaint("success", "light").halo);
  });
});

describe("the bow that keeps parallel supports apart", () => {
  it("fans out symmetrically around the straight line", () => {
    expect([0, 1, 2, 3, 4, 5].map(bowStep)).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it("never answers zero, so no support is ever drawn straight", () => {
    for (let i = 0; i < 12; i += 1) expect(bowStep(i)).not.toBe(0);
  });

  it("survives a rank it was never given", () => {
    expect(bowStep(-1)).toBe(1);
    expect(bowStep(Number.NaN)).toBe(1);
  });

  it("scales each step by the published fraction of the span", () => {
    expect(supportBow(0)).toBeCloseTo(SUPPORT_BOW);
    expect(supportBow(1)).toBeCloseTo(-SUPPORT_BOW);
    expect(supportBow(2)).toBeCloseTo(2 * SUPPORT_BOW);
    // Two supports of one move end up 0.10 of the span apart.
    expect(supportBow(0) - supportBow(1)).toBeCloseTo(2 * SUPPORT_BOW);
  });
});

describe("which supports would draw on top of each other", () => {
  it("reads the move a support is aimed at", () => {
    expect(supportTarget(["Support", "bud", "gal"])).toBe("bud>gal");
    expect(supportTarget(["Convoy", "bud", "gal"])).toBe("bud>gal");
  });

  it("writes a support-hold the same way whichever form it arrived in", () => {
    expect(supportTarget(["Support", "bud"])).toBe("bud>bud");
    expect(supportTarget(["Support", "bud", "bud"])).toBe("bud>bud");
  });

  it("has nothing to say about a move or a hold", () => {
    expect(supportTarget(["Move", "tri"])).toBeNull();
    expect(supportTarget(["Hold"])).toBeNull();
    expect(supportTarget([])).toBeNull();
  });

  it("ranks the supports of one move, in province order", () => {
    const ranks = supportRanks({
      vie: ["Support", "bud", "gal"],
      tri: ["Support", "bud", "gal"],
      rom: ["Move", "ven"],
      ven: ["Support", "rom", "rom"],
    });
    // tri sorts before vie, and rom's move is not a support at all.
    expect(ranks).toEqual({ tri: 0, vie: 1, ven: 0 });
  });

  it("counts a convoy and a support of the same move as one fan", () => {
    const ranks = supportRanks({
      eng: ["Convoy", "lon", "bre"],
      wal: ["Support", "lon", "bre"],
    });
    expect(new Set([ranks.eng, ranks.wal])).toEqual(new Set([0, 1]));
  });
});

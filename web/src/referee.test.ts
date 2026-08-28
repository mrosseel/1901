import { describe, expect, it } from "vitest";
import type { PreviousPhase } from "./api";
import { pieceLabel, refereeGuide, refereeReason, unitTypeOf } from "./referee";

/*
The classical names are the fallback the province table ships with, so these
read as a real table would hear them without any server in the picture.
*/

function guideOf(previous: PreviousPhase) {
  const guide = refereeGuide(previous);
  if (!guide) throw new Error("expected a guide");
  return guide;
}

function textsIn(previous: PreviousPhase, id: string): string[] {
  const section = guideOf(previous).sections.find((one) => one.id === id);
  return (section?.actions || []).map((action) =>
    action.note ? action.text + " [" + action.note + "]" : action.text,
  );
}

describe("reading the unit type back out of the server's prose", () => {
  it("takes the words before the province's long name", () => {
    expect(unitTypeOf("vie", "Army Vienna Move Trieste")).toBe("Army");
    expect(unitTypeOf("adr", "Fleet Adriatic Sea Move Venice")).toBe("Fleet");
  });

  it("answers nothing when the prose names no unit", () => {
    expect(unitTypeOf("vie", "Vienna Hold")).toBe("");
    expect(unitTypeOf("vie", undefined)).toBe("");
    expect(unitTypeOf("vie", "some other sentence")).toBe("");
  });

  it("still names the piece when the unit type is missing", () => {
    expect(pieceLabel("vie", "Army Vienna Move Trieste")).toBe("Army Vienna");
    expect(pieceLabel("vie", "Vienna Hold")).toBe("Vienna");
  });
});

describe("the reason, as it is said aloud", () => {
  it("says bounced in, not bounce", () => {
    expect(refereeReason("ErrBounce:bur")).toBe("bounced in Burgundy");
  });

  it("unpacks godip's camel case into words", () => {
    expect(refereeReason("ErrSupportBroken:vie")).toBe("support broken in Vienna");
    expect(refereeReason("ErrIllegalMove")).toBe("illegal move");
  });

  it("has nothing to say about an order that came off", () => {
    expect(refereeReason("OK")).toBe("");
    expect(refereeReason(undefined)).toBe("");
  });
});

describe("a movement phase", () => {
  const phase: PreviousPhase = {
    phase: { season: "Spring", year: 1901, type: "Movement" },
    orders: {
      vie: "Army Vienna Move Trieste",
      par: "Army Paris Move Burgundy",
      mun: "Army Munich Move Burgundy",
      bud: "Army Budapest Support Vienna Trieste",
      gal: "Army Galicia Hold",
    },
    orderParts: {
      vie: ["Move", "tri"],
      par: ["Move", "bur"],
      mun: ["Move", "bur"],
      bud: ["Support", "vie", "tri"],
      gal: ["Hold"],
    },
    powers: {
      vie: "Austria",
      par: "France",
      mun: "Germany",
      bud: "Austria",
      gal: "Russia",
    },
    resolutions: {
      vie: "OK",
      par: "ErrBounce:bur",
      mun: "ErrBounce:bur",
      bud: "OK",
      gal: "OK",
    },
    dislodged: { tri: { type: "Army", nation: "Italy" } },
    nmr: ["Turkey"],
  };

  it("tells the piece pusher what to move", () => {
    expect(textsIn(phase, "moves")).toEqual(["Move Army Vienna to Trieste."]);
  });

  it("tells them what stays, and why", () => {
    expect(textsIn(phase, "stays")).toEqual([
      "Army Munich stays [bounced in Burgundy.]",
      "Army Paris stays [bounced in Burgundy.]",
      "Turkey sent no orders [all of Turkey's units hold.]",
    ]);
  });

  it("names the dislodged unit as a piece to lift off its province", () => {
    expect(textsIn(phase, "removals")).toEqual([
      "Army Trieste is dislodged [stand it aside until the retreat phase.]",
    ]);
  });

  it("says nothing about a support or a hold that came off: no hand touches them", () => {
    const said = guideOf(phase)
      .sections.flatMap((section) => section.actions.map((action) => action.text))
      .join(" ");
    expect(said).not.toContain("Budapest");
    expect(said).not.toContain("Galicia");
  });

  it("keeps the power on every line, for the dot", () => {
    const moves = guideOf(phase).sections.find((one) => one.id === "moves");
    expect(moves?.actions[0].power).toBe("Austria");
  });

  it("puts the sections in the order a pair of hands works", () => {
    expect(guideOf(phase).sections.map((one) => one.id)).toEqual([
      "moves",
      "removals",
      "stays",
    ]);
  });

  it("counts only the pieces a hand has to touch", () => {
    // One move and one dislodgement; the two bounces and the NMR are not work.
    expect(guideOf(phase).total).toBe(2);
  });
});

describe("a retreat phase", () => {
  const phase: PreviousPhase = {
    phase: { season: "Spring", year: 1901, type: "Retreat" },
    orders: {
      gal: "Army Galicia Move Ukraine",
      tri: "Fleet Trieste Disband",
      ven: "Army Venice Move Tuscany",
    },
    orderParts: {
      gal: ["Move", "ukr"],
      tri: ["Disband"],
      ven: ["Move", "tus"],
    },
    powers: { gal: "Russia", tri: "Italy", ven: "Italy" },
    resolutions: { gal: "OK", tri: "OK", ven: "ErrBounce:tus" },
    dislodged: {},
    nmr: [],
  };

  it("says retreat, not move", () => {
    expect(textsIn(phase, "moves")).toEqual(["Retreat Army Galicia to Ukraine."]);
  });

  it("takes off both the disbanded unit and the one whose retreat failed", () => {
    expect(textsIn(phase, "removals")).toEqual([
      "Remove Fleet Trieste from the board.",
      "Remove Army Venice from the board [its retreat bounced in Tuscany.]",
    ]);
  });
});

describe("an adjustment phase", () => {
  const phase: PreviousPhase = {
    phase: { season: "Fall", year: 1901, type: "Adjustment" },
    orders: { rom: "Rome Build Army", gal: "Army Galicia Disband" },
    orderParts: { rom: ["Build", "Army"], gal: ["Disband"] },
    powers: { rom: "Italy", gal: "Russia" },
    resolutions: { rom: "OK", gal: "OK" },
    dislodged: {},
    nmr: [],
  };

  it("names the piece to put on the board and where", () => {
    expect(textsIn(phase, "placements")).toEqual(["Place a new Army in Rome."]);
  });

  it("names the piece to take off", () => {
    expect(textsIn(phase, "removals")).toEqual(["Remove Army Galicia from the board."]);
  });

  it("puts removals before placements: hands clear the board first", () => {
    expect(guideOf(phase).sections.map((one) => one.id)).toEqual(["removals", "placements"]);
  });
});

describe("nothing to do", () => {
  it("answers nothing at all when there is no phase to report", () => {
    expect(refereeGuide(null)).toBeNull();
    expect(refereeGuide(undefined)).toBeNull();
    expect(refereeGuide({ orders: {}, orderParts: {}, nmr: [] })).toBeNull();
  });

  it("counts the acts, so a header can say how many", () => {
    const guide = guideOf({
      phase: { season: "Spring", year: 1901, type: "Movement" },
      orders: { vie: "Army Vienna Move Trieste" },
      orderParts: { vie: ["Move", "tri"] },
      powers: { vie: "Austria" },
      resolutions: { vie: "OK" },
      nmr: [],
    });
    expect(guide.total).toBe(1);
    expect(guide.title).toBe("Spring 1901 Movement");
  });
});

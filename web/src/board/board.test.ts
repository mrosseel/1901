// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./board";
import { emptyPlan, planDuty } from "./phases";
import { powerColor } from "./provinces";
import type { PhasePlan } from "./phases";
import type { BoardApi, BoardState, BuilderView, OptionTree, Placement } from "./types";

/*
The island under a stub map and a stub server. jsdom has no layout, so the
drawing itself cannot be judged here — what is checked is the grammar: whose
units may be ordered, what a tap means in each phase type, and what is posted.

The option trees are the ones a live classical game answers with; they were
copied from a game driven to each phase.
*/

// jsdom ships no CSS object; the board escapes province ids with it.
if (!(globalThis as { CSS?: unknown }).CSS) {
  (globalThis as { CSS?: unknown }).CSS = {
    escape: (value: string) => value.replace(/([^\w-])/g, "\\$1"),
  };
}

const MAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1524 1357">
  <g id="provinces" style="display:none">
    <path id="vie" d="M 700,800 h 60 v 60 h -60 z"/>
    <path id="tri" d="M 700,900 h 60 v 60 h -60 z"/>
    <path id="bud" d="M 800,800 h 60 v 60 h -60 z"/>
    <path id="gal" d="M 900,800 h 60 v 60 h -60 z"/>
    <!-- Galicia's coasts are drawn after it and cover it, the way the cold
         war map draws west Canada. A tap lands on one of these, never on the
         shape whose id the options tree names. -->
    <path id="gal/nc" d="M 900,800 h 60 v 30 h -60 z"/>
    <path id="gal/sc" d="M 900,830 h 60 v 30 h -60 z"/>
    <path id="alb" d="M 900,900 h 60 v 60 h -60 z"/>
    <path id="adr" d="M 1000,900 h 60 v 60 h -60 z"/>
    <path id="ven" d="M 1000,800 h 60 v 60 h -60 z"/>
    <path id="rom" d="M 1100,800 h 60 v 60 h -60 z"/>
  </g>
  <g id="supply-centers" style="display:none">
    <path id="vieCenter" d="m 730,830 h 10 v 10 h -10 z"/>
    <path id="budCenter" d="m 830,830 h 10 v 10 h -10 z"/>
    <path id="triCenter" d="m 730,930 h 10 v 10 h -10 z"/>
    <path id="romCenter" d="m 1130,830 h 10 v 10 h -10 z"/>
  </g>
  <g id="province-centers" style="display:none">
    <path id="galCenter" d="m 930,830 h 10 v 10 h -10 z"/>
    <path id="albCenter" d="m 930,930 h 10 v 10 h -10 z"/>
    <path id="adrCenter" d="m 1030,930 h 10 v 10 h -10 z"/>
    <path id="venCenter" d="m 1030,830 h 10 v 10 h -10 z"/>
  </g>
</svg>`;

const MOVEMENT_TREE: OptionTree = {
  vie: {
    Type: "Province",
    Next: {
      Hold: { Type: "OrderType", Next: { vie: { Type: "SrcProvince", Next: {} } } },
      Move: {
        Type: "OrderType",
        Next: {
          vie: {
            Type: "SrcProvince",
            Next: { tri: { Type: "Province", Next: {} }, gal: { Type: "Province", Next: {} } },
          },
        },
      },
      Support: {
        Type: "OrderType",
        Next: {
          vie: {
            Type: "SrcProvince",
            Next: { bud: { Type: "Province", Next: { bud: { Type: "Province", Next: {} } } } },
          },
        },
      },
    },
  },
};

// A dislodged fleet in Trieste: three ways out, or disband.
const RETREAT_TREE: OptionTree = {
  Move: {
    Type: "OrderType",
    Next: {
      tri: {
        Type: "SrcProvince",
        Next: { adr: { Next: {} }, alb: { Next: {} }, ven: { Next: {} } },
      },
    },
  },
  Disband: { Type: "OrderType", Next: { tri: { Type: "SrcProvince", Next: {} } } },
};

const BUILD_TREE: OptionTree = {
  Build: {
    Type: "OrderType",
    Filter: "MAX:Build:0",
    Next: {
      Army: { Type: "UnitType", Next: { rom: { Type: "SrcProvince", Next: {} } } },
      Fleet: { Type: "UnitType", Next: { rom: { Type: "SrcProvince", Next: {} } } },
    },
  },
};

const DISBAND_TREE: OptionTree = {
  Disband: {
    Type: "OrderType",
    Filter: "MAX:Disband:0",
    Next: { bud: { Type: "SrcProvince", Next: {} } },
  },
};

const MOVEMENT_STATE: BoardState = {
  phase: { season: "Spring", year: 1901, type: "Movement" },
  units: {
    vie: { type: "Army", nation: "Austria" },
    bud: { type: "Army", nation: "Turkey" },
  },
  orders: {},
  orderParts: {},
};

// Trieste has fallen: Italy stands there, the Austrian fleet is dislodged.
const RETREAT_STATE: BoardState = {
  phase: { season: "Fall", year: 1901, type: "Retreat" },
  units: {
    tri: { type: "Army", nation: "Italy" },
    bud: { type: "Army", nation: "Austria" },
  },
  dislodged: { tri: { type: "Fleet", nation: "Austria" } },
  orders: {},
  orderParts: {},
};

const ADJUSTMENT_STATE: BoardState = {
  phase: { season: "Fall", year: 1901, type: "Adjustment" },
  units: { bud: { type: "Army", nation: "Austria" }, vie: { type: "Army", nation: "Austria" } },
  supplyCenters: { bud: "Austria", vie: "Austria", rom: "Austria" },
  orders: {},
  orderParts: {},
};

function shapeOf(id: string): Element | null {
  return document.querySelector('#provinces [id="' + id + '"]');
}

function tap(id: string) {
  shapeOf(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function classesOf(id: string): string[] {
  return Array.from(shapeOf(id)?.classList || []);
}

function setup(
  power: string,
  trees: Record<string, OptionTree>,
  onIllegal?: (provinces: string[]) => void,
) {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, text: async () => MAP }) as unknown as Response,
  );

  const posted: Array<{ province: string; parts: string[] }> = [];
  const status: string[] = [];
  let builder: BuilderView | null = null;

  const api: BoardApi = {
    mapUrl: "/map.svg",
    options: async (province) => trees[province] || {},
    order: async (province, parts) => {
      posted.push({ province: province, parts: parts });
      return { orders: { [province]: parts.join(" ") }, orderParts: { [province]: parts } };
    },
  };

  const host = document.createElement("div");
  document.body.appendChild(host);
  const board = mount(host, api, {
    status: (text) => status.push(text),
    builder: (view) => { builder = view; },
    state: () => {},
    select: () => {},
    illegal: (provinces) => onIllegal?.(provinces),
    canOrder: (_province, unit) => Boolean(unit && unit.nation === power),
    refusal: (province, unit) =>
      unit ? province + " is " + unit.nation + "'s." : "no unit in " + province,
  });

  return { board, posted, status, view: () => builder as BuilderView | null };
}

function planFor(kind: PhasePlan["kind"], power: string, actionable: Record<string, OptionTree>): PhasePlan {
  return { kind: kind, power: power, actionable: actionable, duty: planDuty(actionable) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/*
The approved placement table, as the server hands it over. These are the real
classical figures: Belgium sits where the owner put it by hand, Gascony takes
a 0.95x marker and Denmark a 0.8x one because neither province is wide enough
for a full-size piece.
*/
const PLACEMENTS: Record<string, Placement> = {
  vie: { unit: [712, 812], scale: 1, dislodged: [750, 780] },
  bud: { unit: [812, 812], scale: 0.8, dislodged: [850, 780] },
  tri: { unit: [712, 912], scale: 0.95, dislodged: [755, 955] },
};

function unitAt(index: number): SVGCircleElement | null {
  return document.querySelectorAll<SVGCircleElement>("#unit-overlay circle.unit")[index] || null;
}

describe("the server's placement table", () => {
  it("puts a marker where the table says, not where the anchor is", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    // The map's own anchor for vie is 730,830; the table overrules it.
    expect(seat.board.debug.centers.get("vie")).toEqual({ x: 730, y: 830 });
    seat.board.update({ ...MOVEMENT_STATE, placements: PLACEMENTS }, emptyPlan("Austria"));

    const vie = unitAt(0)!;
    expect(vie.getAttribute("cx")).toBe("712");
    expect(vie.getAttribute("cy")).toBe("812");
    seat.board.destroy();
  });

  it("draws a shrunken province's marker at its own scale", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update({ ...MOVEMENT_STATE, placements: PLACEMENTS }, emptyPlan("Austria"));

    // Both markers are drawn from the same board radius; only the table's
    // scale separates them, and Budapest's is 0.8 of Vienna's.
    const full = Number(unitAt(0)!.getAttribute("r"));
    const shrunk = Number(unitAt(1)!.getAttribute("r"));
    expect(full).toBeGreaterThan(0);
    expect(shrunk / full).toBeCloseTo(0.8, 5);
    seat.board.destroy();
  });

  it("falls back to the anchor one province at a time", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    // A table that knows Vienna and not Budapest must leave Budapest on its
    // own anchor rather than borrowing Vienna's position.
    seat.board.update(
      { ...MOVEMENT_STATE, placements: { vie: PLACEMENTS.vie } },
      emptyPlan("Austria"),
    );

    expect(unitAt(0)!.getAttribute("cx")).toBe("712");
    expect(unitAt(1)!.getAttribute("cx")).toBe("830");
    seat.board.destroy();
  });

  it("puts the dislodged marker where the table says", async () => {
    const seat = setup("Austria", { tri: {} });
    await seat.board.ready;
    seat.board.update({ ...RETREAT_STATE, placements: PLACEMENTS }, emptyPlan("Austria"));

    const ring = document.querySelector<SVGCircleElement>("#unit-overlay circle.dislodged-ring")!;
    expect(ring.getAttribute("cx")).toBe("755");
    expect(ring.getAttribute("cy")).toBe("955");
    seat.board.destroy();
  });

  it("keeps the map's anchors when the server sends no table", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update({ ...MOVEMENT_STATE, placements: null }, emptyPlan("Austria"));

    expect(unitAt(0)!.getAttribute("cx")).toBe("730");
    seat.board.destroy();
  });
});

describe("a movement phase", () => {
  it("injects the map and reads the province anchors", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    expect(seat.board.debug.centers.get("vie")).toEqual({ x: 730, y: 830 });
    seat.board.destroy();
  });

  it("refuses another power's unit before any request is made", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("bud");
    await settle();

    expect(seat.view()).toBeNull();
    expect(seat.status.at(-1)).toBe("bud is Turkey's.");
    expect(seat.posted).toEqual([]);
    seat.board.destroy();
  });

  it("opens the order builder on your own unit", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();

    expect(seat.view()?.options.map((option) => option.id)).toEqual(["Hold", "Move", "Support"]);
    expect(classesOf("gal")).toContain("legal");
    seat.board.destroy();
  });

  it("posts a move from two taps", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("gal");
    await settle();

    expect(seat.posted).toEqual([{ province: "vie", parts: ["Move", "gal"] }]);
    expect(seat.status.at(-1)).toBe("Vienna moves to Galicia.");
    seat.board.destroy();
  });

  /*
  The cold war bug: the coast shapes are painted over the province they belong
  to, so the finger lands on "gal/nc" while the options tree offers "gal". The
  tap used to match nothing and nothing happened.
  */
  it("takes a tap on a coast for the province the tree offers", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("gal/nc");
    await settle();

    expect(seat.posted).toEqual([{ province: "vie", parts: ["Move", "gal"] }]);
    seat.board.destroy();
  });

  /*
  A province the map cannot draw used to fail in silence: no highlight, no
  tap, no complaint. In development it says so now — that is how the cold war
  map's missing province would have been caught.
  */
  it("says in development when a map has no shape for a province", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tree: OptionTree = {
      vie: {
        Type: "Province",
        Next: {
          Move: {
            Type: "OrderType",
            Next: {
              vie: { Type: "SrcProvince", Next: { boh: { Type: "Province", Next: {} } } },
            },
          },
        },
      },
    };
    const seat = setup("Austria", { vie: tree });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();

    expect(warn.mock.calls.some((call) => String(call[0]).includes('"boh"'))).toBe(true);
    warn.mockRestore();
    seat.board.destroy();
  });

  /*
  A fleet's move into a province with two coasts. The tap cannot say which, so
  the chip asks, in the names a player reads rather than in option codes.
  */
  it("asks which coast, by name, when a province offers two", async () => {
    const tree: OptionTree = {
      vie: {
        Type: "Province",
        Next: {
          Move: {
            Type: "OrderType",
            Next: {
              vie: {
                Type: "SrcProvince",
                Next: {
                  "gal/nc": { Type: "Province", Next: {} },
                  "gal/sc": { Type: "Province", Next: {} },
                },
              },
            },
          },
        },
      },
    };
    const seat = setup("Austria", { vie: tree });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();
    /* The tap lands on a coast strip, which is where a tap on such a province
       always lands: the strips cover the province they belong to. The strip
       under the finger must not decide which coast the order names. */
    tap("gal/nc");
    await settle();

    const chip = document.getElementById("chip")!;
    expect(chip.querySelector(".chip-title")?.textContent).toBe("Galicia");
    const rows = Array.from(chip.querySelectorAll("button:not(.chip-close)"));
    expect(rows.map((row) => row.textContent)).toEqual(["North coast", "South coast"]);

    (rows[1] as HTMLButtonElement).click();
    await settle();

    expect(seat.posted).toEqual([{ province: "vie", parts: ["Move", "gal/sc"] }]);
    expect(document.getElementById("chip")).toBeNull();
    seat.board.destroy();
  });

  /*
  The hold support, and the line that offers it.

  A support of a hold asks the supporting unit to reach the province the
  supported unit stands in, so the tree offers it only where that province is
  among the destinations. The line has to follow the tree: it named a province
  the map had not lit, and a tap on it wrote a bluff nobody asked for.
  */
  it("offers the hold when the tree carries the supported unit's own province", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("bud");
    await settle();

    expect(seat.view()?.hint).toBe(
      "Supporting Army Budapest — tap where you are helping it go, " +
        "or tap Budapest again to back its hold.",
    );
    expect(classesOf("bud")).toContain("support-src");
    seat.board.destroy();
  });

  it("says nothing about the hold when the tree does not carry it", async () => {
    const moveOnly: OptionTree = {
      vie: {
        Type: "Province",
        Next: {
          Support: {
            Type: "OrderType",
            Next: {
              vie: {
                Type: "SrcProvince",
                Next: { bud: { Type: "Province", Next: { gal: { Type: "Province", Next: {} } } } },
              },
            },
          },
        },
      },
    };
    const seat = setup("Austria", { vie: moveOnly });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("bud");
    await settle();

    expect(seat.view()?.hint).toBe(
      "Supporting Army Budapest — tap where you are helping it go.",
    );
    expect(classesOf("bud")).not.toContain("support-src");
    seat.board.destroy();
  });

  it("lights up every shape a province is drawn with, coasts included", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();

    // Without this the coast shape on top stays unpainted and the province
    // looks unavailable however legal it is.
    expect(classesOf("gal")).toContain("legal");
    expect(classesOf("gal/nc")).toContain("legal");
    expect(classesOf("gal/sc")).toContain("legal");
    seat.board.destroy();
  });

  it("drops an order with an empty parts list", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    await seat.board.cancelOrder("vie");

    expect(seat.posted).toEqual([{ province: "vie", parts: [] }]);
    seat.board.destroy();
  });

  it("takes the map with it when it goes", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    expect(document.querySelector("#provinces")).not.toBeNull();

    seat.board.destroy();

    expect(document.querySelector("svg")).toBeNull();
    tap("vie");
    await settle();
    expect(seat.posted).toEqual([]);
  });
});

describe("a retreat phase", () => {
  const plan = () => planFor("retreat", "Austria", { tri: RETREAT_TREE });

  it("draws the dislodged unit beside the one that threw it out", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(RETREAT_STATE, plan());

    expect(document.querySelectorAll("#unit-overlay .dislodged").length).toBe(1);
    expect(document.querySelectorAll("#unit-overlay .dislodged-ring").length).toBe(1);
    // The dislodged marker is offset, so the two units do not overlap.
    const anchor = seat.board.debug.centers.get("tri")!;
    const ring = document.querySelector("#unit-overlay .dislodged-ring")!;
    expect(Number(ring.getAttribute("cx"))).toBeGreaterThan(anchor.x);
    expect(Number(ring.getAttribute("cy"))).toBeLessThan(anchor.y);
    seat.board.destroy();
  });

  it("marks the province that must be ordered before anything is tapped", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(RETREAT_STATE, plan());

    expect(classesOf("tri")).toContain("todo");
    expect(classesOf("bud")).not.toContain("todo");
    seat.board.destroy();
  });

  it("turns away a unit that has nothing to do this phase", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(RETREAT_STATE, plan());

    tap("bud");
    await settle();

    expect(seat.status.at(-1)).toBe("Only a dislodged unit can be ordered in a retreat phase.");
    expect(seat.view()).toBeNull();
    seat.board.destroy();
  });

  it("offers every destination and Disband on one bar", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(RETREAT_STATE, plan());

    tap("tri");
    await settle();

    const view = seat.view();
    expect(view?.title).toBe("Fleet Trieste (Austria, dislodged)");
    expect(view?.options.map((option) => option.id)).toEqual([
      "Disband",
      "Move:adr",
      "Move:alb",
      "Move:ven",
    ]);
    expect(view?.options.map((option) => option.label)).toEqual([
      "Disband",
      "Adriatic Sea",
      "Albania",
      "Venice",
    ]);
    expect(view?.options.find((option) => option.id === "Disband")?.danger).toBe(true);
    // The hint enumerates the bar rather than naming the state, and only the
    // order type carries a letter: the destinations are provinces.
    expect(view?.hint).toBe(
      "Fleet Trieste is dislodged: disband (d), Adriatic Sea, Albania, Venice" +
        " — or tap a highlighted province",
    );
    expect(view?.options.map((option) => option.key)).toEqual([
      "d",
      undefined,
      undefined,
      undefined,
    ]);
    // The destinations are lit, so the retreat is one more tap.
    expect(classesOf("alb")).toContain("legal");
    seat.board.destroy();
  });

  it("retreats to a province tapped on the map", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(RETREAT_STATE, plan());

    tap("tri");
    await settle();
    tap("alb");
    await settle();

    expect(seat.posted).toEqual([{ province: "tri", parts: ["Move", "alb"] }]);
    expect(seat.status.at(-1)).toBe("Trieste retreats to Albania.");
    seat.board.destroy();
  });

  it("disbands only from the button", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(RETREAT_STATE, plan());

    tap("tri");
    await settle();
    seat.board.choose("Disband");
    await settle();

    expect(seat.posted).toEqual([{ province: "tri", parts: ["Disband"] }]);
    expect(seat.status.at(-1)).toBe("Trieste disbands.");
    seat.board.destroy();
  });

  it("says so when a dislodged unit has nowhere to go", async () => {
    const cornered: OptionTree = {
      Disband: { Type: "OrderType", Next: { tri: { Type: "SrcProvince", Next: {} } } },
    };
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(RETREAT_STATE, planFor("retreat", "Austria", { tri: cornered }));

    tap("tri");
    await settle();

    expect(seat.view()?.options.map((option) => option.id)).toEqual(["Disband"]);
    expect(seat.view()?.hint).toBe(
      "Fleet Trieste is dislodged and has nowhere to go: it must disband.",
    );
    seat.board.destroy();
  });

  it("draws the retreat as a dashed run with a solid head", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(
      { ...RETREAT_STATE, orders: { tri: "retreat" }, orderParts: { tri: ["Move", "alb"] } },
      plan(),
    );

    const order = document.querySelector("#order-overlay .order")!;
    expect(order.querySelector("line[stroke-dasharray]")).not.toBeNull();
    expect(order.querySelector("polygon")).not.toBeNull();
    seat.board.destroy();
  });

  it("draws a disband as a cross", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(
      { ...RETREAT_STATE, orders: { tri: "disband" }, orderParts: { tri: ["Disband"] } },
      plan(),
    );

    const path = document.querySelector("#order-overlay .order path")!;
    expect(path.getAttribute("d")).toMatch(/^M .* L .* M .* L /);
    seat.board.destroy();
  });
});

/*
The review of a phase that has already resolved. It is the only time the board
draws orders that are not this seat's, and the only time it draws orders that
did not happen.
*/
describe("the review of the last phase", () => {
  const REVIEW = {
    kind: "movement" as const,
    orderParts: { vie: ["Move", "gal"], bud: ["Move", "gal"] },
    powers: { vie: "Austria", bud: "Turkey" },
    failed: ["bud"],
    dislodged: { gal: { type: "Army", nation: "Russia" } },
  };

  it("draws every power's orders, not only this seat's", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.showReview(REVIEW);

    const drawn = Array.from(document.querySelectorAll("#order-overlay .order")).map((node) =>
      node.getAttribute("data-province"),
    );
    expect(drawn.sort()).toEqual(["bud", "vie"]);
    seat.board.destroy();
  });

  it("marks the order that failed and leaves the one that worked alone", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.showReview(REVIEW);

    const bounced = document.querySelector('#order-overlay .order[data-province="bud"]')!;
    const worked = document.querySelector('#order-overlay .order[data-province="vie"]')!;
    expect(bounced.classList.contains("failed")).toBe(true);
    expect(bounced.querySelector(".order-miss")).not.toBeNull();
    expect(worked.classList.contains("failed")).toBe(false);
    expect(worked.querySelector(".order-miss")).toBeNull();
    seat.board.destroy();
  });

  it("rings the unit the phase threw out", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.showReview(REVIEW);

    expect(document.querySelectorAll("#unit-overlay .dislodged-ring")).toHaveLength(1);
    seat.board.destroy();
  });

  it("takes no orders while it is up, and takes them again after", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.showReview(REVIEW);

    tap("vie");
    await settle();
    expect(seat.view()).toBeNull();
    expect(seat.posted).toEqual([]);
    // Nothing on the map invites a tap either.
    expect(classesOf("gal")).not.toContain("legal");

    seat.board.showReview(null);
    tap("vie");
    await settle();
    expect(seat.view()).not.toBeNull();
    seat.board.destroy();
  });

  /*
  The colour language: the outcome is the loud channel, so a resolved phase
  reads without a legend. What is asserted here is the CONTRAST, not the exact
  hexadecimal: a success and a failure must not be drawn the same, and neither
  may be drawn in a power's colour, because that is the whole point.
  */
  it("draws the outcome, not the power, as the loud colour", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.showReview(REVIEW);

    const lineOf = (province: string) =>
      document
        .querySelector('#order-overlay .order[data-province="' + province + '"] .order-line')!
        .getAttribute("fill") ||
      document
        .querySelector('#order-overlay .order[data-province="' + province + '"] .order-line')!
        .getAttribute("stroke");

    expect(lineOf("vie")).not.toBe(lineOf("bud"));
    expect(lineOf("vie")).not.toBe(powerColor("Austria"));
    expect(lineOf("bud")).not.toBe(powerColor("Turkey"));
    // The power is still there, one layer in.
    const nation = document.querySelector(
      '#order-overlay .order[data-province="vie"] .order-nation',
    );
    expect(nation?.getAttribute("stroke")).toBe(powerColor("Austria"));
    seat.board.destroy();
  });

  it("turns the ink over for a dark map", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    seat.board.showReview({ ...REVIEW, style: "parchment" });
    const onPaper = document
      .querySelector('#order-overlay .order[data-province="vie"] .order-line')!
      .getAttribute("fill");
    seat.board.showReview({ ...REVIEW, style: "midnight" });
    const onMidnight = document
      .querySelector('#order-overlay .order[data-province="vie"] .order-line')!
      .getAttribute("fill");

    expect(onPaper).not.toBe(onMidnight);
    seat.board.destroy();
  });

  it("bows two supports of the same move apart", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.showReview({
      kind: "movement",
      orderParts: {
        vie: ["Move", "gal"],
        bud: ["Support", "vie", "gal"],
        tri: ["Support", "vie", "gal"],
      },
      powers: { vie: "Austria", bud: "Austria", tri: "Austria" },
      failed: [],
      dislodged: {},
    });

    const curveOf = (province: string) =>
      document
        .querySelector('#order-overlay .order[data-province="' + province + '"] .order-line')!
        .getAttribute("d")!;
    // Same span, so a shared control point would mean one curve hiding under
    // the other. The two ranks are signed apart.
    expect(curveOf("bud")).not.toBe(curveOf("tri"));
    seat.board.destroy();
  });

  it("keeps drawing the review while this device's own arrows are hidden", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(
      { ...MOVEMENT_STATE, orders: { vie: "hold" }, orderParts: { vie: ["Hold"] } },
      emptyPlan("Austria"),
    );

    seat.board.setHideOrders(true);
    expect(document.querySelectorAll("#order-overlay .order")).toHaveLength(0);
    // The unit is still marked as spoken for.
    expect(document.querySelectorAll("#unit-overlay .unit.ordered").length).toBeGreaterThan(0);

    seat.board.showReview(REVIEW);
    expect(document.querySelectorAll("#order-overlay .order")).toHaveLength(2);

    seat.board.showReview(null);
    expect(document.querySelectorAll("#order-overlay .order")).toHaveLength(0);
    seat.board.setHideOrders(false);
    expect(document.querySelectorAll("#order-overlay .order")).toHaveLength(1);
    seat.board.destroy();
  });

  it("goes back to this seat's own orders when it closes", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(
      { ...MOVEMENT_STATE, orders: { vie: "hold" }, orderParts: { vie: ["Hold"] } },
      emptyPlan("Austria"),
    );
    seat.board.showReview(REVIEW);
    expect(document.querySelectorAll("#order-overlay .order")).toHaveLength(2);

    seat.board.showReview(null);
    const drawn = Array.from(document.querySelectorAll("#order-overlay .order")).map((node) =>
      node.getAttribute("data-province"),
    );
    expect(drawn).toEqual(["vie"]);
    seat.board.destroy();
  });
});

describe("an adjustment phase", () => {
  const plan = () => planFor("adjustment", "Austria", { rom: BUILD_TREE, bud: DISBAND_TREE });

  it("colours every owned supply centre even when no unit occupies it", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(ADJUSTMENT_STATE, emptyPlan("Austria", "adjustment"));

    const owned = document.querySelector<SVGElement>('#owned-lands [data-province="rom"]');
    expect(owned?.getAttribute("fill")).toBe(powerColor("Austria"));
    expect(document.querySelector('#unit-overlay [data-province="rom"]')).toBeNull();
    seat.board.destroy();
  });

  /* The tint is the whole province, not a dot on its glyph: the question it
     answers is "whose count goes down if I take this", which is asked about a
     territory. It goes under the hit shapes so a reachability highlight paints
     over it rather than replacing it. */
  it("tints the whole province and leaves the highlights on top", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(ADJUSTMENT_STATE, emptyPlan("Austria", "adjustment"));

    const layer = document.querySelector("#owned-lands")!;
    const tint = layer.querySelector<SVGElement>('[data-province="rom"]')!;
    // A copy of the province's own hit shape, so it covers the same ground.
    expect(tint.tagName).toBe(document.querySelector("#provinces #rom")!.tagName);
    expect(tint.getAttribute("id")).toBeNull();
    expect(tint.getAttribute("style")).toContain("fill-opacity:0.22");
    /* The wash alone cannot carry a pale power against a warm ground, so the
       province is outlined in the same colour at full strength. */
    expect(tint.getAttribute("style")).toContain("stroke:" + powerColor("Austria"));
    expect(tint.getAttribute("style")).toContain("stroke-opacity:1");
    expect(layer.nextElementSibling?.id).toBe("provinces");
    seat.board.destroy();
  });

  /*
  The outline is measured in screen pixels, and it has to stay that way.

  It was a fraction of the map's width to begin with, and that is wrong twice
  over: this layer is built in renderAll() and a zoom only calls
  renderOverlays(), so the line kept its size in map units while the map grew
  under it. A border a hair wide at fit-all became a band at four times in,
  and the seam between two provinces of one power, which carries the line from
  both sides, became a coloured river through the middle of that power.

  Two things keep the fix working, and both are asserted here. The width is
  its own attribute rather than part of the style, because the style is
  written once and the width is re-measured on every zoom. And it is the
  pixel figure, not a share of the 1524 units this map is wide.
  */
  it("measures the ownership outline in screen pixels, outside the style", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(ADJUSTMENT_STATE, emptyPlan("Austria", "adjustment"));

    const tint = document.querySelector<SVGElement>('#owned-lands [data-province="rom"]')!;
    expect(tint.getAttribute("style")).not.toContain("stroke-width");
    const edge = Number(tint.getAttribute("stroke-width"));
    // 1.4 screen pixels. A share of the map's width would be 1524/500 here.
    expect(edge).toBeCloseTo(1.4, 6);
    seat.board.destroy();
  });

  it("reads the build count from the options filter", () => {
    expect(planFor("adjustment", "Austria", { rom: BUILD_TREE }).duty).toEqual({
      type: "Build",
      count: 1,
    });
    expect(planFor("adjustment", "Austria", { bud: DISBAND_TREE }).duty).toEqual({
      type: "Disband",
      count: 1,
    });
  });

  it("offers the unit type straight away", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(ADJUSTMENT_STATE, plan());

    tap("rom");
    await settle();

    expect(seat.view()?.options.map((option) => option.label)).toEqual([
      "Build Army",
      "Build Fleet",
    ]);
    expect(seat.view()?.hint).toBe("Rome: build army, build fleet");

    seat.board.choose("Build:Fleet");
    await settle();
    expect(seat.posted).toEqual([{ province: "rom", parts: ["Build", "Fleet"] }]);
    expect(seat.status.at(-1)).toBe("Rome builds a fleet.");
    seat.board.destroy();
  });

  it("asks for the Disband button rather than a stray tap", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(ADJUSTMENT_STATE, plan());

    tap("bud");
    await settle();

    expect(seat.view()?.options.map((option) => option.id)).toEqual(["Disband"]);
    expect(seat.view()?.hint).toBe("Army Budapest: disband (d)");
    expect(seat.posted).toEqual([]);

    seat.board.choose("Disband");
    await settle();
    expect(seat.posted).toEqual([{ province: "bud", parts: ["Disband"] }]);
    seat.board.destroy();
  });

  it("refuses a province the phase does not offer", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(ADJUSTMENT_STATE, plan());

    tap("vie");
    await settle();

    expect(seat.status.at(-1)).toBe(
      "You can only build in an empty supply centre this variant allows.",
    );
    expect(seat.view()).toBeNull();
    seat.board.destroy();
  });

  it("draws a build as the outline of the unit to come", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(
      { ...ADJUSTMENT_STATE, orders: { rom: "build" }, orderParts: { rom: ["Build", "Army"] } },
      plan(),
    );

    const order = document.querySelector("#order-overlay .order")!;
    const circle = order.querySelector("circle")!;
    expect(circle.getAttribute("fill")).toBe("none");
    seat.board.destroy();
  });

  it("keeps a half-built order from surviving a phase change", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(ADJUSTMENT_STATE, plan());
    tap("rom");
    await settle();
    expect(seat.view()).not.toBeNull();

    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    expect(seat.view()).toBeNull();
    seat.board.destroy();
  });
});

/*
Illegal orders (ADR-029). The highlights still say what is legal; they have
stopped being a fence. Every case below taps a province the option tree never
offered and checks what is posted.
*/
describe("an order the rules refuse", () => {
  const ALLOWED: BoardState = { ...MOVEMENT_STATE, settings: { illegalMoves: true } };
  const REFUSED: BoardState = { ...MOVEMENT_STATE, settings: { illegalMoves: false } };

  it("posts a move to an empty province the tree never offered", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(ALLOWED, emptyPlan("Austria"));

    tap("vie");
    await settle();
    // Rome is not in Vienna's tree, and there is no unit on it.
    tap("rom");
    await settle();

    expect(seat.posted).toEqual([{ province: "vie", parts: ["Move", "rom"] }]);
    expect(seat.status.some((line) => /not legal/.test(line))).toBe(true);
    seat.board.destroy();
  });

  it("tells the panel which drafts it knows are illegal", async () => {
    const marked: string[][] = [];
    const seat = setup("Austria", { vie: MOVEMENT_TREE }, (provinces) => marked.push(provinces));
    await seat.board.ready;
    seat.board.update(ALLOWED, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("rom");
    await settle();

    expect(marked[marked.length - 1]).toEqual(["vie"]);
    seat.board.destroy();
  });

  /* The gesture the whole map is built around: tapping another of your own
     units switches to ordering it. Losing that would cost more than the
     bluff is worth, so an own unit is never taken as an illegal target. */
  it("still switches units when your own unit is tapped", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE, rom: MOVEMENT_TREE });
    await seat.board.ready;
    // Rome is outside Vienna's tree AND holds a unit of this seat's own.
    seat.board.update(
      {
        ...ALLOWED,
        units: {
          vie: { type: "Army", nation: "Austria" },
          rom: { type: "Army", nation: "Austria" },
        },
      },
      emptyPlan("Austria"),
    );

    tap("vie");
    await settle();
    tap("rom");
    await settle();

    expect(seat.posted).toEqual([]);
    seat.board.destroy();
  });

  it("keeps refusing the same tap when the table turned the rule off", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(REFUSED, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("rom");
    await settle();

    expect(seat.posted).toEqual([]);
    seat.board.destroy();
  });

  /* A server that predates the setting accepted whatever it was sent, so an
     absent setting has to behave as the permissive one. */
  it("allows it where the state says nothing about the rule", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("rom");
    await settle();

    expect(seat.posted).toEqual([{ province: "vie", parts: ["Move", "rom"] }]);
    seat.board.destroy();
  });

  it("draws the draft it knows is illegal apart from the rest", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(ALLOWED, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("rom");
    await settle();
    seat.board.update(
      { ...ALLOWED, orderParts: { vie: ["Move", "rom"] }, orders: { vie: "x" } },
      emptyPlan("Austria"),
    );

    const group = document.querySelector('#order-overlay .order[data-province="vie"]')!;
    expect(Array.from(group.classList)).toContain("illegal");
    expect(group.querySelector(".order-halo")!.getAttribute("stroke-dasharray")).toBeTruthy();
    seat.board.destroy();
  });

  /* The mark is knowledge about a draft. An order the server no longer holds
     is not a draft, so the mark goes with it. */
  it("forgets the mark once the order is gone", async () => {
    const marked: string[][] = [];
    const seat = setup("Austria", { vie: MOVEMENT_TREE }, (provinces) => marked.push(provinces));
    await seat.board.ready;
    seat.board.update(ALLOWED, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("rom");
    await settle();
    seat.board.update({ ...ALLOWED, orderParts: {} }, emptyPlan("Austria"));

    expect(marked[marked.length - 1]).toEqual([]);
    seat.board.destroy();
  });

  /* The province keeps an order, so nothing is removed: the illegal draft is
     overwritten by a legal one. The mark belongs to the draft, not to the
     province, so it goes when the draft does. */
  it("forgets the mark once a legal order replaces it", async () => {
    const marked: string[][] = [];
    const seat = setup("Austria", { vie: MOVEMENT_TREE }, (provinces) => marked.push(provinces));
    await seat.board.ready;
    seat.board.update(ALLOWED, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("rom");
    await settle();
    expect(marked[marked.length - 1]).toEqual(["vie"]);
    seat.board.update(
      { ...ALLOWED, orderParts: { vie: ["Move", "rom"] }, orders: { vie: "x" } },
      emptyPlan("Austria"),
    );

    // Vienna is ordered again, this time to a province its tree offers.
    tap("vie");
    await settle();
    tap("tri");
    await settle();

    expect(seat.posted[seat.posted.length - 1]).toEqual({
      province: "vie",
      parts: ["Move", "tri"],
    });
    expect(marked[marked.length - 1]).toEqual([]);
    seat.board.destroy();
  });
});

describe("province codes on the map", () => {
  it("draws nothing until it is asked to", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));

    expect(document.querySelectorAll("#brief-labels text")).toHaveLength(0);
    seat.board.destroy();
  });

  /* This map has one names layer and no brief one, which is what every godip
     map is. The codes are drawn at the anchors instead. */
  it("hides the names layer and draws codes at the anchors", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.setBriefLabels(true);

    const codes = Array.from(document.querySelectorAll("#brief-labels text")).map(
      (node) => node.textContent,
    );
    expect(codes).toContain("VIE");
    expect(codes).toContain("ROM");
    seat.board.destroy();
  });

  it("takes them off again", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.setBriefLabels(true);
    seat.board.setBriefLabels(false);

    expect(document.querySelectorAll("#brief-labels text")).toHaveLength(0);
    seat.board.destroy();
  });

  it("leaves a coast to its base province rather than labelling it twice", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(MOVEMENT_STATE, emptyPlan("Austria"));
    seat.board.setBriefLabels(true);

    const codes = Array.from(document.querySelectorAll("#brief-labels text")).map(
      (node) => node.textContent,
    );
    expect(codes.filter((code) => code === "GAL")).toHaveLength(1);
    expect(codes).not.toContain("GAL/NC");
    seat.board.destroy();
  });

  it("puts a code where the table says, not at the offset it would guess", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update(
      { ...MOVEMENT_STATE, placements: { ...PLACEMENTS, vie: { ...PLACEMENTS.vie, brief: [640, 770] } } },
      emptyPlan("Austria"),
    );
    seat.board.setBriefLabels(true);

    const vie = Array.from(document.querySelectorAll("#brief-labels text")).find(
      (node) => node.textContent === "VIE",
    )!;
    expect(vie.getAttribute("x")).toBe("640");
    expect(vie.getAttribute("y")).toBe("770");
    seat.board.destroy();
  });

  /* Two things the offset heuristic cannot do, and the table can: keep a code
     still while a unit moves in and out, and answer for a province the table
     places but says nothing about the code for. */
  it("keeps a measured code still whether or not a unit stands there", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    const table = { ...PLACEMENTS, rom: { unit: [900, 900] as [number, number], scale: 1, dislodged: [930, 870] as [number, number], brief: [900, 940] as [number, number] } };
    seat.board.update({ ...MOVEMENT_STATE, placements: table }, emptyPlan("Austria"));
    seat.board.setBriefLabels(true);

    const codeY = () =>
      Array.from(document.querySelectorAll("#brief-labels text"))
        .find((node) => node.textContent === "ROM")!
        .getAttribute("y");
    const empty = codeY();
    seat.board.update(
      { ...MOVEMENT_STATE, units: { ...MOVEMENT_STATE.units, rom: { type: "Army", nation: "Italy" } }, placements: table },
      emptyPlan("Austria"),
    );
    expect(codeY()).toBe(empty);
    expect(empty).toBe("940");
    seat.board.destroy();
  });

  it("falls back to the offset heuristic where the table has no code", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    // Vienna is placed but carries no brief position, so the board draws the
    // code at the marker itself — an occupied province gets the offset.
    seat.board.update({ ...MOVEMENT_STATE, placements: PLACEMENTS }, emptyPlan("Austria"));
    seat.board.setBriefLabels(true);

    const vie = Array.from(document.querySelectorAll("#brief-labels text")).find(
      (node) => node.textContent === "VIE",
    )!;
    expect(vie.getAttribute("x")).toBe("712");
    expect(Number(vie.getAttribute("y"))).toBeGreaterThan(812);
    seat.board.destroy();
  });

  /* A switch flipped before the map has arrived must not throw: a device with
     a saved preference sets it on the very first render. */
  it("survives being set before the map has loaded", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    expect(() => seat.board.setBriefLabels(true)).not.toThrow();
    expect(() => seat.board.setHideOrders(true)).not.toThrow();
    await seat.board.ready;
    seat.board.destroy();
  });
});

/*
Everything the board draws on top of the map is scenery, and scenery must not
take a tap.

The click is resolved by asking what is under the finger and walking up to a
child of #provinces. Anything drawn above it answers with itself, and the tap
is lost. The arrow of an order covers the unit that gave it, so without this a
unit with orders is the one unit on the board that cannot be told to do
something else.
*/
describe("what the board draws on top of the map", () => {
  it("lets a tap through to the province underneath", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update({ ...MOVEMENT_STATE, placements: PLACEMENTS }, emptyPlan("Austria"));

    const drawn = Array.from(document.querySelectorAll("svg > g[id]")).filter(
      (layer) => layer.id !== "provinces",
    );
    expect(drawn.length).toBeGreaterThan(0);
    for (const layer of drawn) {
      expect([layer.id, layer.getAttribute("pointer-events")]).toEqual([layer.id, "none"]);
    }
    seat.board.destroy();
  });

  it("orders a unit that already has orders somewhere else", async () => {
    const seat = setup("Austria", { vie: MOVEMENT_TREE });
    await seat.board.ready;
    seat.board.update({ ...MOVEMENT_STATE, placements: PLACEMENTS }, emptyPlan("Austria"));

    tap("vie");
    await settle();
    tap("gal");
    await settle();
    expect(seat.posted).toEqual([{ province: "vie", parts: ["Move", "gal"] }]);

    // The same unit, now with an arrow across it, sent somewhere else. The
    // second order replaces the first: one province, one order (ADR-011).
    seat.board.update(
      {
        ...MOVEMENT_STATE,
        placements: PLACEMENTS,
        orders: { vie: "Vienna moves to Galicia" },
        orderParts: { vie: ["Move", "gal"] },
      },
      emptyPlan("Austria"),
    );
    tap("vie");
    await settle();
    tap("tri");
    await settle();
    expect(seat.posted[1]).toEqual({ province: "vie", parts: ["Move", "tri"] });
    seat.board.destroy();
  });
});

/*
A convoy is a chain, and each fleet carries one leg of it.

It used to be drawn exactly like a support of the same move: a dashed curve to
the middle of the crossing with a bar across the end. Two fleets carrying one
army then aimed at the same patch of open water, and the picture said
"support" — which is a different order with different rules.
*/
describe("a convoy", () => {
  const CONVOY_STATE: BoardState = {
    phase: { season: "Spring", year: 1901, type: "Movement" },
    units: {
      vie: { type: "Army", nation: "Austria" },
      adr: { type: "Fleet", nation: "Austria" },
      alb: { type: "Fleet", nation: "Austria" },
    },
    // vie 730,830 → rom 1130,830 is a straight run east; the two fleets sit
    // south of it, at 1030,930 and 930,930.
    orders: { vie: "", adr: "", alb: "" },
    orderParts: {
      vie: ["Move", "rom"],
      adr: ["Convoy", "vie", "rom"],
      alb: ["Convoy", "vie", "rom"],
    },
  };

  function ticksOf(province: string): Array<{ x: number; y: number }> {
    return Array.from(
      document.querySelectorAll(
        '#order-overlay .order[data-province="' + province + '"] line.order-line',
      ),
    )
      // The stub from the fleet to the crossing is dashed; the ticks are not.
      .filter((node) => !node.getAttribute("stroke-dasharray"))
      .map((node) => ({
        x: (Number(node.getAttribute("x1")) + Number(node.getAttribute("x2"))) / 2,
        y: (Number(node.getAttribute("y1")) + Number(node.getAttribute("y2"))) / 2,
      }));
  }

  it("marks the crossing where each fleet is, not the middle of the move", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(CONVOY_STATE, emptyPlan("Austria"));

    // Two ticks per fleet, and each pair straddles the point on the move line
    // nearest that fleet: 1030,830 for the Adriatic, 930,830 for Albania.
    const adr = ticksOf("adr");
    const alb = ticksOf("alb");
    expect(adr).toHaveLength(2);
    expect(alb).toHaveLength(2);
    const centre = (marks: Array<{ x: number; y: number }>) => ({
      x: (marks[0].x + marks[1].x) / 2,
      y: (marks[0].y + marks[1].y) / 2,
    });
    expect(centre(adr).x).toBeCloseTo(1030, 0);
    expect(centre(alb).x).toBeCloseTo(930, 0);
    // Not the same place: the old drawing put both at the middle of the move.
    expect(Math.abs(centre(adr).x - centre(alb).x)).toBeGreaterThan(50);
    seat.board.destroy();
  });

  it("reaches the crossing with a dashed stub, and draws no support curve", async () => {
    const seat = setup("Austria", {});
    await seat.board.ready;
    seat.board.update(CONVOY_STATE, emptyPlan("Austria"));

    const order = document.querySelector('#order-overlay .order[data-province="adr"]')!;
    expect(order.querySelector("line[stroke-dasharray]")).not.toBeNull();
    // A support is the only thing that draws a curve, and this is not one.
    expect(order.querySelector("path")).toBeNull();
    seat.board.destroy();
  });
});

/*
The opening view is decided by the space the board has, not by the window.

jsdom lays nothing out, so the host's box is stubbed here. That is also why
the board falls back to the window when the box has no size at all.
*/
describe("how much room the board thinks it has", () => {
  async function openedWidth(width: number, height: number): Promise<number> {
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: true, status: 200, text: async () => MAP }) as unknown as Response,
    );
    const host = document.createElement("div");
    host.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
         width: width, height: height }) as DOMRect;
    document.body.appendChild(host);
    const board = mount(host, { mapUrl: "/map.svg", options: async () => ({}), order: async () => ({}) }, {
      status: () => {}, builder: () => {}, state: () => {}, select: () => {},
    });
    await board.ready;
    const view = (document.querySelector("svg")?.getAttribute("viewBox") || "").split(" ");
    board.destroy();
    return Number(view[2]);
  }

  it("opens a wide pane on the whole map", async () => {
    // fit-width for a 1524x1357 map in a 1200x800 pane.
    expect(await openedWidth(1200, 800)).toBeCloseTo(1357 * (1200 / 800), 1);
  });

  it("steps a narrow pane in so a province is big enough to tap", async () => {
    // The window is 1024 wide here, so the old reading called this pane wide.
    expect(await openedWidth(600, 800)).toBeCloseTo(1524 / 1.6, 1);
  });
});

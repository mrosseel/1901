// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./board";
import type { BoardApi, BoardState, BuilderView, OptionTree } from "./types";

/*
The island under a stub map and a stub server. jsdom has no layout, so the
drawing itself cannot be judged here — what is checked is the grammar: whose
units may be ordered, what a tap means, and what is posted.
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
  </g>
  <g id="supply-centers" style="display:none">
    <path id="vieCenter" d="m 730,830 h 10 v 10 h -10 z"/>
    <path id="budCenter" d="m 830,830 h 10 v 10 h -10 z"/>
    <path id="triCenter" d="m 730,930 h 10 v 10 h -10 z"/>
    <path id="galCenter" d="m 930,830 h 10 v 10 h -10 z"/>
  </g>
</svg>`;

const OPTIONS: OptionTree = {
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

const START: BoardState = {
  phase: { season: "Spring", year: 1901, type: "Movement" },
  units: {
    vie: { type: "Army", nation: "Austria" },
    bud: { type: "Army", nation: "Turkey" },
  },
  orders: {},
  orderParts: {},
};

function tap(id: string) {
  const shape = document.querySelector("#provinces #" + id);
  shape?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(power: string) {
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, text: async () => MAP }) as unknown as Response);

  const posted: Array<{ province: string; parts: string[] }> = [];
  const status: string[] = [];
  let builder: BuilderView | null = null;

  const api: BoardApi = {
    mapUrl: "/map.svg",
    options: async () => OPTIONS,
    order: async (province, parts) => {
      posted.push({ province: province, parts: parts });
      return {
        ...START,
        orders: { [province]: parts.join(" ") },
        orderParts: { [province]: parts },
      };
    },
  };

  const host = document.createElement("div");
  document.body.appendChild(host);
  const board = mount(host, api, {
    status: (text) => status.push(text),
    builder: (view) => { builder = view; },
    state: () => {},
    select: () => {},
    canOrder: (_province, unit) => Boolean(unit && unit.nation === power),
    refusal: (province, unit) =>
      unit ? province + " is " + unit.nation + "'s." : "no unit in " + province,
  });

  return {
    board,
    posted,
    status,
    builderView: () => builder as BuilderView | null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the board island in seat mode", () => {
  it("injects the map and reads the province anchors", async () => {
    const seat = setup("Austria");
    await seat.board.ready;
    expect(document.querySelector("#provinces #vie")).not.toBeNull();
    expect(seat.board.debug.centers.get("vie")).toEqual({ x: 730, y: 830 });
    seat.board.destroy();
  });

  it("refuses another power's unit before any request is made", async () => {
    const seat = setup("Austria");
    await seat.board.ready;
    seat.board.update(START);

    tap("bud");
    await settle();

    expect(seat.builderView()).toBeNull();
    expect(seat.status.at(-1)).toBe("bud is Turkey's.");
    expect(seat.posted).toEqual([]);
    seat.board.destroy();
  });

  it("opens the order builder on your own unit", async () => {
    const seat = setup("Austria");
    await seat.board.ready;
    seat.board.update(START);

    tap("vie");
    await settle();

    const view = seat.builderView();
    expect(view?.province).toBe("vie");
    expect(view?.options.map((option) => option.key)).toEqual(["Hold", "Move", "Support"]);
    expect(view?.hint).toContain("Army Vienna");
    // The move targets are lit at once, so a second tap is the whole order.
    expect(document.querySelector("#provinces #gal")?.classList.contains("legal")).toBe(true);
    expect(document.querySelector("#provinces #bud")?.classList.contains("occupied")).toBe(true);
    seat.board.destroy();
  });

  it("posts a move from two taps", async () => {
    const seat = setup("Austria");
    await seat.board.ready;
    seat.board.update(START);

    tap("vie");
    await settle();
    tap("gal");
    await settle();

    expect(seat.posted).toEqual([{ province: "vie", parts: ["Move", "gal"] }]);
    expect(seat.status.at(-1)).toBe("Vienna moves to Galicia.");
    expect(seat.builderView()).toBeNull();
    seat.board.destroy();
  });

  it("drops an order with an empty parts list", async () => {
    const seat = setup("Austria");
    await seat.board.ready;
    seat.board.update(START);

    await seat.board.cancelOrder("vie");

    expect(seat.posted).toEqual([{ province: "vie", parts: [] }]);
    expect(seat.status.at(-1)).toBe("Order for Vienna removed.");
    seat.board.destroy();
  });

  it("takes the map with it when it goes", async () => {
    const seat = setup("Austria");
    await seat.board.ready;
    seat.board.update(START);
    expect(document.querySelector("#provinces")).not.toBeNull();

    seat.board.destroy();

    expect(document.querySelector("svg")).toBeNull();
    // A tap after the island is gone must reach nothing at all.
    tap("vie");
    await settle();
    expect(seat.posted).toEqual([]);
  });
});

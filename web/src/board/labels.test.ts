// @vitest-environment jsdom
/*
The reader against the writer, on one map.

Nothing here can run on a map as it is served today: every map draws its own
names and centres in its art, and where the art draws the layer the art wins
(D-038). So this takes the fixture the exporter actually wrote, strips the two
layers out of the art to force the mode the exporter has not switched on yet,
and checks the board redraws what it removed.

The comparison is the whole point. The art's <text> elements and the label
records come out of one placement search in one coordinate space, so a name
the board draws from a record must land where the art drew it — same x, same
reserved width, same baseline. The art writes one decimal and a record two, so
the two never agree exactly: the tolerance below is that rounding and no more.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./board";
import { emptyPlan } from "./phases";
import { resetProvinceNames, setProvinceNames } from "./provinces";
import type { BoardApi, BoardState, LabelPlan, Placement } from "./types";
import ART from "../../../testdata/generated/demo7/map.svg?raw";
import placementsFile from "../../../testdata/generated/demo7/placements.json?raw";
import descriptorFile from "../../../testdata/generated/demo7/variant.json?raw";

if (!(globalThis as { CSS?: unknown }).CSS) {
  (globalThis as { CSS?: unknown }).CSS = {
    escape: (value: string) => value.replace(/([^\w-])/g, "\\$1"),
  };
}

const PLACEMENTS: Record<string, Placement> = JSON.parse(placementsFile);
const DESCRIPTOR: { provinces: Array<[string, string, string | null]> } =
  JSON.parse(descriptorFile);

const LONG_NAMES: Record<string, string> = {};
DESCRIPTOR.provinces.forEach(([key, long]) => { LONG_NAMES[key] = long; });

/*
The art writes one decimal, a record writes two.

Half the art's rounding step is 0.05, and a baseline is a sum of two rounded
records, so it can be 0.0075 further out again. An exact comparison calls 72
of these 73 names broken; this one calls none of them broken and would still
catch a name drawn half a cap height high, which is 7 units.
*/
const TOLERANCE = 0.06;

interface ArtLabel {
  x: number;
  y: number;
  size: number;
  length: number;
  text: string;
}

/* What the art itself drew, read straight out of the fixture. */
function artLabels(): Record<string, ArtLabel> {
  const doc = new DOMParser().parseFromString(ART, "image/svg+xml");
  const out: Record<string, ArtLabel> = {};
  doc.querySelectorAll("#names text").forEach((node) => {
    const key = node.id.replace(/Name$/, "");
    out[key] = {
      x: Number(node.getAttribute("x")),
      y: Number(node.getAttribute("y")),
      size: Number(node.getAttribute("font-size")),
      length: Number(node.getAttribute("textLength")),
      text: node.textContent || "",
    };
  });
  return out;
}

/* The rings the art drew, and only the rings: an owned centre also carries a
   small filled dot inside its ring, which is not the glyph under discussion. */
function artRings(): Array<{ x: number; y: number; r: number }> {
  const doc = new DOMParser().parseFromString(ART, "image/svg+xml");
  return Array.from(doc.querySelectorAll("#supply-centers circle"))
    .map((node) => ({
      x: Number(node.getAttribute("cx")),
      y: Number(node.getAttribute("cy")),
      r: Number(node.getAttribute("r")),
      fill: node.getAttribute("fill") || "",
    }))
    .filter((ring) => ring.fill !== "#4c4433");
}

/*
The art with the two layers taken out, which is what the exporter will ship
once it stops drawing them. The anchors layer goes with them (D-038): the
placement table already carries a unit position for every province, and an
anchor and a centre glyph share the id the board matches for anchors.
*/
function dataModeArt(): string {
  return ["names", "supply-centers", "province-centers"].reduce(
    (svg, id) => svg.replace(new RegExp('<g id="' + id + '"[^>]*>[\\s\\S]*?</g>'), ""),
    ART,
  );
}

const PLAN: LabelPlan = {
  mode: "records",
  sea: ["adr", "bos"],
  defaultStyle: "parchment",
  typography: {
    flat: {
      land: {
        family: "Georgia, serif",
        weight: "bold",
        style: "normal",
        letterSpacing: -0.2,
        fill: "#1f2a33",
        halo: { color: "#f6f1e6", width: 0.59 },
      },
      sea: {
        family: "Georgia, serif",
        weight: "normal",
        style: "italic",
        letterSpacing: 0,
        fill: "#0f3f5c",
        halo: { color: "#e4f1fa", width: 0.59 },
      },
    },
  },
};

function boardFor(svg: string, state: BoardState, style = "flat") {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, text: async () => svg }) as unknown as Response,
  );
  setProvinceNames(LONG_NAMES);
  const api: BoardApi = {
    mapUrl: "/map.svg?style=" + style,
    options: async () => ({}),
    order: async () => ({}),
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const board = mount(host, api, {
    status: () => {},
    builder: () => {},
    state: () => {},
    select: () => {},
  });
  return board.ready.then(() => {
    board.update(state, emptyPlan(""));
    return board;
  });
}

const DATA_STATE: BoardState = { placements: PLACEMENTS, labels: PLAN };

afterEach(() => {
  vi.unstubAllGlobals();
  resetProvinceNames();
  document.body.replaceChildren();
});

function drawnNames(): Record<string, SVGTextElement> {
  const out: Record<string, SVGTextElement> = {};
  document.querySelectorAll<SVGTextElement>("#data-labels text").forEach((node) => {
    out[node.textContent || ""] = node;
  });
  return out;
}

describe("names drawn from records", () => {
  it("lands every name where the art drew it", async () => {
    const board = await boardFor(dataModeArt(), DATA_STATE);
    const art = artLabels();
    const drawn = drawnNames();
    const keys = Object.keys(art);
    expect(keys.length).toBe(73);

    let worst = 0;
    keys.forEach((key) => {
      const want = art[key];
      const node = drawn[want.text];
      expect(node, key + " was not drawn").toBeTruthy();
      const got = {
        x: Number(node.getAttribute("x")),
        y: Number(node.getAttribute("y")),
        size: Number(node.getAttribute("font-size")),
        length: Number(node.getAttribute("textLength")),
      };
      // The baseline is the one the reader has to compute: `at` is the centre
      // of the ink box, and a reader that took it for the baseline would draw
      // every name half a cap height high.
      (["x", "y", "size", "length"] as const).forEach((field) => {
        const off = Math.abs(got[field] - want[field]);
        worst = Math.max(worst, off);
        expect(off, key + " " + field + ": " + got[field] + " against " + want[field])
          .toBeLessThanOrEqual(TOLERANCE);
      });
      expect(node.getAttribute("lengthAdjust")).toBe("spacing");
      expect(node.getAttribute("text-anchor")).toBe("middle");
    });
    // Every one of the 73 names was matched by its own string, and the
    // worst any of them was out by is the rounding: 0.055 of a map unit.
    expect(Object.keys(drawn).length).toBe(73);
    expect(worst).toBeGreaterThan(0.05);
    board.destroy();
  });

  it("draws the supply centre glyphs the art was carrying", async () => {
    const board = await boardFor(dataModeArt(), DATA_STATE);
    const rings = Array.from(document.querySelectorAll<SVGCircleElement>("#data-centres circle"));
    const want = artRings();
    expect(rings.length).toBe(want.length);

    const drawn = rings.map((node) => ({
      x: Number(node.getAttribute("cx")),
      y: Number(node.getAttribute("cy")),
      r: Number(node.getAttribute("r")),
    }));
    want.forEach((ring) => {
      const found = drawn.find(
        (one) =>
          Math.abs(one.x - ring.x) <= TOLERANCE &&
          Math.abs(one.y - ring.y) <= TOLERANCE &&
          Math.abs(one.r - ring.r) <= TOLERANCE,
      );
      expect(found, "no ring drawn at " + ring.x + "," + ring.y).toBeTruthy();
    });

    // godip's glyph: a stroked circle, no fill, black at 0.47 opacity.
    expect(rings[0].getAttribute("fill")).toBe("none");
    expect(rings[0].getAttribute("stroke")).toBe("#000000");
    expect(Number(rings[0].getAttribute("stroke-opacity"))).toBeCloseTo(0.47, 2);
    // Never "<key>Center": that selector is how the board finds unit anchors.
    rings.forEach((ring) => {
      expect(ring.id.startsWith("sc-")).toBe(true);
      expect(ring.id.endsWith("Center")).toBe(false);
    });
    expect(document.querySelectorAll('[id$="Center"]').length).toBe(0);
    board.destroy();
  });

  it("takes the face, the inks and the halo from the server", async () => {
    const board = await boardFor(dataModeArt(), DATA_STATE);
    const drawn = drawnNames();
    const land = drawn[LONG_NAMES.att];
    const sea = drawn[LONG_NAMES.adr];
    expect(land.getAttribute("fill")).toBe("#1f2a33");
    expect(land.getAttribute("font-style")).toBe("normal");
    expect(sea.getAttribute("fill")).toBe("#0f3f5c");
    expect(sea.getAttribute("font-style")).toBe("italic");
    expect(land.getAttribute("stroke")).toBe("#f6f1e6");
    expect(land.getAttribute("stroke-width")).toBe("0.59");
    expect(land.getAttribute("class")).toBe("province-name");
    board.destroy();
  });

  it("falls back to the default style for a map asked for in none", async () => {
    const board = await boardFor(dataModeArt(), DATA_STATE, "");
    const plan: LabelPlan = {
      ...PLAN,
      typography: { parchment: PLAN.typography!.flat },
    };
    board.update({ ...DATA_STATE, labels: plan }, emptyPlan(""));
    expect(drawnNames()[LONG_NAMES.att].getAttribute("fill")).toBe("#1f2a33");
    board.destroy();
  });

  it("turns a rotated name about its own box", async () => {
    const turned: Record<string, Placement> = {
      ...PLACEMENTS,
      att: { ...PLACEMENTS.att, label: { ...PLACEMENTS.att.label!, rot: -62 } },
    };
    const board = await boardFor(dataModeArt(), { ...DATA_STATE, placements: turned });
    const at = PLACEMENTS.att.label!.at;
    const group = drawnNames()[LONG_NAMES.att].parentElement as unknown as SVGGElement;
    expect(group.getAttribute("transform")).toBe("rotate(-62 " + at[0] + " " + at[1] + ")");
    board.destroy();
  });

  it("draws the author's lines when a name was broken across them", async () => {
    const runs: Record<string, Placement> = {
      ...PLACEMENTS,
      att: {
        ...PLACEMENTS.att,
        labelRuns: [
          { at: [100, 50], size: 12, width: 80, height: 9, text: "Village of" },
          { at: [100, 62], size: 12, width: 46, height: 9, text: "Aeolus" },
        ],
      },
    };
    const board = await boardFor(dataModeArt(), { ...DATA_STATE, placements: runs });
    const drawn = drawnNames();
    expect(drawn[LONG_NAMES.att]).toBeUndefined();
    expect(drawn["Village of"].getAttribute("y")).toBe("54.5");
    expect(drawn["Aeolus"].getAttribute("textLength")).toBe("46");
    board.destroy();
  });
});

describe("the art wins where it draws the layer", () => {
  it("draws nothing on a map that still draws its own names and centres", async () => {
    const board = await boardFor(ART, DATA_STATE);
    expect(document.querySelectorAll("#data-labels text").length).toBe(0);
    expect(document.querySelectorAll("#data-centres circle").length).toBe(0);
    // The art's own names are untouched, and there are still 73 of them.
    expect(document.querySelectorAll("#names text").length).toBe(73);
    board.destroy();
  });

  it("draws nothing at all without the server's flag", async () => {
    const board = await boardFor(dataModeArt(), { placements: PLACEMENTS });
    expect(document.querySelector("#data-labels")).toBeNull();
    expect(document.querySelector("#data-centres")).toBeNull();
    board.destroy();
  });

  it("shows the codes instead of the names in brief mode", async () => {
    const board = await boardFor(dataModeArt(), DATA_STATE);
    expect(Object.keys(drawnNames()).length).toBe(73);
    board.setBriefLabels(true);
    expect(document.querySelectorAll("#data-labels text").length).toBe(0);
    expect(document.querySelectorAll("#brief-labels text").length).toBeGreaterThan(0);
    board.setBriefLabels(false);
    expect(Object.keys(drawnNames()).length).toBe(73);
    board.destroy();
  });
});

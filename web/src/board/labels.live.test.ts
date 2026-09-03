// @vitest-environment jsdom
/*
The live fixture, mounted exactly as the exporter wrote it.

labels.test.ts runs against internal/variant/testdata/frozen/demo7-drawn, which is art that
draws its own names, centres and anchors. It has to cut those three layers out
with a helper before the board will draw anything, because at the time it was
written the exporter had not stopped drawing them. That fixture is frozen and
will never be produced again, so nothing mounts the live one.

This does. It says the one thing the frozen test cannot: that no stripping is
needed. There is no helper in this file. The bytes that go into the board are
the bytes on disk, and if the board still has to have layers removed to draw a
name, the exporter has not made the change this is waiting for.

The fixture landed in data mode on 2026-08-30 and this became an ordinary
test. It was written before that, marked `it.fails`, so it would turn red on
the day the fixture arrived rather than sit green and prove nothing.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./board";
import { emptyPlan } from "./phases";
import { resetProvinceNames, setProvinceNames } from "./provinces";
import type { BoardApi, BoardState, LabelPlan, Placement } from "./types";
import ART from "../../../internal/variant/testdata/generated/demo7/map.svg?raw";
import placementsFile from "../../../internal/variant/testdata/generated/demo7/placements.json?raw";
import descriptorFile from "../../../internal/variant/testdata/generated/demo7/variant.json?raw";

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

const PLAN: LabelPlan = {
  mode: "records",
  sea: ["adr", "aeg", "bal", "bar", "bla", "bot", "eas", "eng", "gol", "gre",
    "hel", "ion", "iri", "mid", "nao", "nrg", "nth", "ska", "tyn", "wes"],
  defaultStyle: "parchment",
  typography: {
    parchment: {
      land: {
        family: "Georgia, serif", weight: "bold", style: "normal",
        letterSpacing: -0.2, fill: "#1f2a33",
        halo: { color: "#f6f1e6", width: 0.59 },
      },
      sea: {
        family: "Georgia, serif", weight: "normal", style: "italic",
        letterSpacing: 0, fill: "#0f3f5c", halo: null,
      },
    },
  },
};

function boardFor(svg: string, state: BoardState) {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, text: async () => svg }) as unknown as Response,
  );
  setProvinceNames(LONG_NAMES);
  const api: BoardApi = {
    mapUrl: "/map.svg?style=parchment",
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

afterEach(() => {
  vi.unstubAllGlobals();
  resetProvinceNames();
  document.body.replaceChildren();
});

/* The rings the art drew, and only the rings: an owned centre also carries a
   small filled dot inside its ring, which is not the glyph under discussion. */
function centreRecords(): number {
  return Object.keys(PLACEMENTS).filter((province) => {
    const spot = PLACEMENTS[province];
    return Array.isArray(spot.centre) && (spot.centreRadius || 0) > 0;
  }).length;
}

describe("the exporter's own map, in data mode", () => {
  it("shows a province's code where the exporter drew no name", async () => {
    /* The exporter drops a name whose fitted size falls under its floor and
       leaves the code to say the same thing (ADR-038). Reading a missing
       record as "no label" left 121 of Imperial's 346 provinces blank. */
    const thinned: Record<string, Placement> = {};
    Object.keys(PLACEMENTS).forEach((province) => {
      thinned[province] = { ...PLACEMENTS[province] };
    });
    const dropped = Object.keys(thinned).filter((p) => thinned[p].label).slice(0, 3);
    dropped.forEach((province) => { delete thinned[province].label; });

    const board = await boardFor(ART, { placements: thinned, labels: PLAN });
    const layer = document.querySelector("#data-labels");
    expect(layer?.querySelectorAll("text.province-name").length).toBe(73 - dropped.length);
    const codes = Array.from(layer?.querySelectorAll("text.brief-label") || [])
      .map((node) => node.textContent);
    expect(codes.sort()).toEqual(dropped.map((p) => p.toUpperCase()).sort());
    board.destroy();
  });

  it("draws every name and glyph from the records with nothing stripped", async () => {
    const doc = new DOMParser().parseFromString(ART, "image/svg+xml");
    // What the art must no longer carry. A name, a supply-centre glyph and a
    // unit anchor are records now (ADR-038), and the anchors go with the other
    // two because an anchor and a glyph share the id the board matches.
    expect(doc.querySelectorAll("text").length).toBe(0);
    expect(doc.querySelector("#names")).toBeNull();
    expect(doc.querySelector("#supply-centers")).toBeNull();
    expect(doc.querySelector("#province-centers")).toBeNull();
    expect(doc.querySelectorAll('[id$="Center"]').length).toBe(0);

    // And what the board puts back, out of the records alone. The art going in
    // is the file on disk: no layer was cut to get this picture.
    const board = await boardFor(ART, { placements: PLACEMENTS, labels: PLAN });
    expect(document.querySelectorAll("#data-labels text").length).toBe(73);
    expect(centreRecords()).toBe(31);
    expect(document.querySelectorAll("#data-centres circle").length).toBe(31);
    board.destroy();
  });
});

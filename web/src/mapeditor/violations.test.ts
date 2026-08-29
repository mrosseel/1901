/*
The scoring port, checked against maps small enough to reason about by hand.

The point of these is not that the numbers are right — geometry.ts's own tests
cover the numbers, and this file imports the same geometry.ts. It is that the
RULES are wired to them: that a marker outside its province is reported as
containment and not as something else, that the lexicographic order holds, and
that moving a marker changes the count, which is the one behaviour the whole
editor rests on.
*/

import { describe, expect, test } from "vitest";
import type { MapGeometry, PlacementTable } from "../../../tools/placement/rules.ts";
import { RULE_ORDER, countByProvince, scorePlacements, type Geometry } from "./violations";

/*
A map of two square provinces side by side, 100 units each, with one province
name drawn in the middle of the left one and a supply centre glyph in the
right. The containment test is a rectangle test, which is what makes the
expectations below readable.
*/
const BOXES: Record<string, { x: number; y: number; w: number; h: number }> = {
  aaa: { x: 0, y: 0, w: 100, h: 100 },
  bbb: { x: 100, y: 0, w: 100, h: 100 },
};

const map: MapGeometry = {
  viewBox: { x: 0, y: 0, w: 200, h: 100 },
  provinces: [
    { key: "aaa", box: BOXES.aaa, anchor: { x: 50, y: 50 }, shapes: 1 },
    { key: "bbb", box: BOXES.bbb, anchor: { x: 150, y: 50 }, shapes: 1 },
  ],
  labels: [{ x: 40, y: 45, w: 20, h: 10 }],
  supplyCentres: [{ x: 145, y: 45, w: 10, h: 10 }],
  drawsBriefLabels: false,
  anchorsWithoutShape: [],
  shapesWithoutAnchor: [],
  notes: [],
};

const geom: Geometry = {
  insideDisc(key, centre, radius) {
    const box = BOXES[key];
    if (!box) return false;
    return (
      centre.x - radius >= box.x &&
      centre.x + radius <= box.x + box.w &&
      centre.y - radius >= box.y &&
      centre.y + radius <= box.y + box.h
    );
  },
  insideBox(key, centre, halfW, halfH) {
    const box = BOXES[key];
    if (!box) return false;
    return (
      centre.x - halfW >= box.x &&
      centre.x + halfW <= box.x + box.w &&
      centre.y - halfH >= box.y &&
      centre.y + halfH <= box.y + box.h
    );
  },
  briefSize: () => ({ w: 12, h: 6 }),
};

const R = 5;

function tableWith(rows: PlacementTable): PlacementTable {
  return rows;
}

function rules(table: PlacementTable): string[] {
  return scorePlacements(map, table, R, geom).map((one) => one.key + ":" + one.field + ":" + one.rule);
}

describe("scorePlacements", () => {
  test("a marker in the clear is not a violation", () => {
    const table = tableWith({
      aaa: { unit: [20, 80], scale: 1, dislodged: [30, 70] },
    });
    expect(rules(table)).toEqual([]);
  });

  test("a marker off its own province is a containment fault", () => {
    const table = tableWith({
      aaa: { unit: [150, 50], scale: 1, dislodged: [30, 70] },
    });
    expect(rules(table)).toContain("aaa:unit:containment");
  });

  test("a marker straddling its border is caught by the border margin", () => {
    // Dead on the edge at radius 5: inside by the bare radius, outside once
    // BORDER_MARGIN is added, which is the whole point of the margin.
    const table = tableWith({
      aaa: { unit: [5, 50], scale: 1, dislodged: [30, 70] },
    });
    expect(rules(table)).toContain("aaa:unit:containment");
  });

  test("a marker on a name and on a glyph names both rules", () => {
    const table = tableWith({
      bbb: { unit: [150, 50], scale: 1, dislodged: [180, 20] },
    });
    expect(rules(table)).toContain("bbb:unit:supplyCentre");
  });

  test("a marker allowed out over its border is reported as overhang, not containment", () => {
    const table = tableWith({
      aaa: {
        unit: [150, 50],
        scale: 1,
        dislodged: [30, 70],
        overhang: { land: 1, sea: 0, open: 0 },
      },
    });
    const found = rules(table);
    expect(found).toContain("aaa:unit:overhang");
    expect(found).not.toContain("aaa:unit:containment");
  });

  test("two provinces' markers on top of each other collide", () => {
    const table = tableWith({
      aaa: { unit: [96, 50], scale: 1, dislodged: [30, 70] },
      bbb: { unit: [104, 50], scale: 1, dislodged: [180, 20] },
    });
    const found = rules(table);
    expect(found).toContain("aaa:unit:neighbour");
    expect(found).toContain("bbb:unit:neighbour");
  });

  test("a province's own dislodged marker is not a collision with its unit", () => {
    const table = tableWith({
      aaa: { unit: [50, 50], scale: 1, dislodged: [52, 50] },
    });
    expect(rules(table)).not.toContain("aaa:dislodged:neighbour");
  });

  test("a brief code outside its province is a containment fault", () => {
    const table = tableWith({
      aaa: { unit: [20, 80], scale: 1, dislodged: [30, 70], brief: [150, 50] },
    });
    expect(rules(table)).toContain("aaa:brief:containment");
  });

  test("a code centred in its province but over the line is overhang, not containment", () => {
    // The box is 12 by 6, so a code two units from the border leans over it
    // while its own anchor is plainly inside.
    const table = tableWith({
      aaa: { unit: [20, 80], scale: 1, dislodged: [30, 70], brief: [2, 50] },
    });
    const found = rules(table);
    expect(found).toContain("aaa:brief:overhang");
    expect(found).not.toContain("aaa:brief:containment");
  });

  test("a map that draws its own codes is not scored on brief positions", () => {
    const drawn: MapGeometry = { ...map, drawsBriefLabels: true };
    const table = tableWith({
      aaa: { unit: [20, 80], scale: 1, dislodged: [30, 70], brief: [150, 50] },
    });
    expect(scorePlacements(drawn, table, R, geom).some((one) => one.field === "brief")).toBe(false);
  });

  test("a province the map cannot draw is not accused of anything", () => {
    const ghosted: MapGeometry = {
      ...map,
      provinces: [{ key: "aaa", box: BOXES.aaa, anchor: null, shapes: 0 }],
    };
    const table = tableWith({ aaa: { unit: [900, 900], scale: 1, dislodged: [900, 900] } });
    expect(scorePlacements(ghosted, table, R, geom)).toEqual([]);
  });

  test("the list is sorted worst rule first", () => {
    const table = tableWith({
      aaa: { unit: [150, 50], scale: 1, dislodged: [30, 70] },
      bbb: { unit: [150, 50], scale: 1, dislodged: [180, 20] },
    });
    const found = scorePlacements(map, table, R, geom);
    const ranks = found.map((one) => RULE_ORDER.indexOf(one.rule));
    expect(ranks).toEqual(ranks.slice().sort((a, b) => a - b));
  });

  test("dragging a marker back inside drops the count", () => {
    const bad = tableWith({ aaa: { unit: [150, 50], scale: 1, dislodged: [30, 70] } });
    const good = tableWith({ aaa: { unit: [20, 80], scale: 1, dislodged: [30, 70] } });
    expect(scorePlacements(map, bad, R, geom).length).toBeGreaterThan(
      scorePlacements(map, good, R, geom).length,
    );
  });

  test("countByProvince adds every field's faults to one province", () => {
    const table = tableWith({
      aaa: { unit: [150, 50], scale: 1, dislodged: [150, 50] },
    });
    const counts = countByProvince(scorePlacements(map, table, R, geom));
    expect(counts.get("aaa")).toBeGreaterThanOrEqual(2);
  });
});

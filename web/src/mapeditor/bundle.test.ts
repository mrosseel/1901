/*
The export, checked for the one property that matters: a session that changed
nothing writes the file that was already there.

The amended table lands in variants/generated/<key>/placements.json and is
reviewed as a diff. A
diff is only readable if everything that did not move is byte-identical, so
key order, field order, rounding and whitespace are all part of the contract —
and the real checked-in table is the fixture, because a table this file made
up could agree with the writer and still disagree with the repository.
*/

import { describe, expect, test } from "vitest";
import classicalFile from "../../../variants/generated/classical/placements.json?raw";
import twentytwentyFile from "../../../variants/generated/twentytwenty/placements.json?raw";
import type { PlacementTable } from "../../../tools/placement/rules.ts";
import {
  canonicalTable,
  changedNames,
  dragsFile,
  namesFile,
  placementFile,
  type DragRecord,
} from "./bundle";

describe("placementFile", () => {
  test("rewrites a checked-in table byte for byte", () => {
    for (const original of [classicalFile, twentytwentyFile]) {
      const table = JSON.parse(original) as PlacementTable;
      expect(placementFile(table)).toBe(original);
    }
  });

  test("sorts keys however the table was built", () => {
    const table: PlacementTable = {
      zzz: { unit: [1, 2], scale: 1, dislodged: [3, 4] },
      aaa: { unit: [5, 6], scale: 1, dislodged: [7, 8] },
    };
    expect(Object.keys(canonicalTable(table))).toEqual(["aaa", "zzz"]);
  });

  test("writes the fields in the file's own order", () => {
    const table: PlacementTable = {
      aaa: {
        brief: [9, 9],
        dislodged: [3, 4],
        scale: 0.8,
        unit: [1, 2],
        overhang: { land: 1, sea: 0, open: 0 },
      },
    };
    expect(Object.keys(canonicalTable(table).aaa)).toEqual([
      "unit",
      "scale",
      "dislodged",
      "overhang",
      "brief",
    ]);
  });

  test("rounds a dragged position to the file's two decimals", () => {
    const table: PlacementTable = {
      aaa: { unit: [1.234567, 2.987654], scale: 1, dislodged: [3, 4] },
    };
    expect(canonicalTable(table).aaa.unit).toEqual([1.23, 2.99]);
  });

  test("a missing scale is written as a whole marker, not an invisible one", () => {
    const table = { aaa: { unit: [1, 2], scale: 0, dislodged: [3, 4] } } as unknown as PlacementTable;
    expect(canonicalTable(table).aaa.scale).toBe(1);
  });
});

describe("namesFile", () => {
  test("keeps only the names that were actually retyped", () => {
    const served = { par: "Paris", bur: "Burgundy" };
    const edited = { par: "Paris", bur: "Bourgogne" };
    expect(changedNames(served, edited)).toEqual({ bur: "Bourgogne" });
  });

  test("a name edited back to itself is not an override", () => {
    expect(changedNames({ par: "Paris" }, { par: "  Paris  " })).toEqual({});
  });

  test("writes sorted keys and a trailing newline", () => {
    expect(namesFile({ zzz: "Zed", aaa: "Ay" })).toBe('{\n  "aaa": "Ay",\n  "zzz": "Zed"\n}\n');
  });

  test("a blank name is dropped rather than written", () => {
    expect(namesFile({ par: "   " })).toBe("{}\n");
  });
});

describe("dragsFile", () => {
  test("keeps the drags in the order they happened", () => {
    const drags: DragRecord[] = [
      { province: "bur", field: "unit", from: [1, 1], to: [2, 2], violationsBefore: 4, violationsAfter: 3 },
      { province: "par", field: "brief", from: [3, 3], to: [4, 4], violationsBefore: 3, violationsAfter: 3 },
    ];
    const written = JSON.parse(dragsFile(drags)) as DragRecord[];
    expect(written.map((one) => one.province)).toEqual(["bur", "par"]);
    // The drag that changed nothing is the interesting one: it is a fault the
    // rules cannot see yet (D-030).
    expect(written[1].violationsBefore).toBe(written[1].violationsAfter);
  });
});

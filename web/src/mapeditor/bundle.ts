/*
What the editor hands back, and why it is written this way.

Two things come out of a session. One is the amended placement table, which
has to land in placements/<key>.json as a DIFF: a table written a different
way every time is a table nobody can review, and reviewing it is the whole
point of the file existing. So it is written exactly as tools/placement writes
it — keys sorted, fields in one order, two decimals, two-space indent, one
trailing newline — and a session that moved nothing produces a file identical
to the one on disk, byte for byte.

The other is the drag log, and it is the more interesting half (D-030). Every
hand drag is a scoring bug: the optimizer put a marker somewhere and a person
moved it, so there is a rule the optimizer does not know. The log records the
move with the violation count either side of it, which is what separates the
two kinds of drag — one that dropped the count found a fault the rules already
name and the optimizer's search missed, one that did not found a fault the
rules cannot see yet and is where the next rule comes from.
*/

import { roundUnit, type Placement, type PlacementTable } from "../../../tools/placement/rules.ts";
import type { Field } from "./violations.ts";

export interface DragRecord {
  province: string;
  field: Field;
  from: [number, number];
  to: [number, number];
  /** The whole table's violation count before this drag, and after it. */
  violationsBefore: number;
  violationsAfter: number;
}

export interface ExportBundle {
  variant: string;
  /** The amended table, in the file's own shape. */
  placements: PlacementTable;
  /** Display names that differ from the ones the server served. */
  names: Record<string, string>;
  drags: DragRecord[];
}

function pair(value: [number, number]): [number, number] {
  return [roundUnit(value[0]), roundUnit(value[1])];
}

/*
One province's row, with its fields in the order the checked-in files carry
them: unit, scale, dislodged, then overhang and brief where they exist.

JSON.stringify writes an object's keys in insertion order, so this function IS
the file's field order. Building the row any other way reorders every line of
every province and turns a one-marker correction into a whole-file diff.
*/
export function canonicalPlacement(placed: Placement): Placement {
  const row: Placement = {
    unit: pair(placed.unit),
    scale: placed.scale > 0 ? placed.scale : 1,
    dislodged: pair(placed.dislodged),
  };
  if (placed.overhang) {
    row.overhang = {
      land: placed.overhang.land,
      sea: placed.overhang.sea,
      open: placed.overhang.open,
    };
  }
  if (Array.isArray(placed.brief)) row.brief = pair(placed.brief);
  return row;
}

/** The whole table, keys sorted, every row canonical. */
export function canonicalTable(table: PlacementTable): PlacementTable {
  const out: PlacementTable = {};
  for (const key of Object.keys(table).sort()) {
    const placed = table[key];
    if (!placed || !Array.isArray(placed.unit)) continue;
    out[key] = canonicalPlacement(placed);
  }
  return out;
}

/** The bytes that go in placements/<key>.json, as tools/placement writes them. */
export function placementFile(table: PlacementTable): string {
  return JSON.stringify(canonicalTable(table), null, 2) + "\n";
}

/** The bytes that go in names/<key>.json: only the names that were changed. */
export function namesFile(overrides: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const key of Object.keys(overrides).sort()) {
    const name = overrides[key].trim();
    if (name) out[key] = name;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

/** The bytes that go in mapeditor/<key>.drags.json, in the order they happened. */
export function dragsFile(drags: DragRecord[]): string {
  return JSON.stringify(drags, null, 2) + "\n";
}

/*
Only the names a person actually retyped.

The editor is handed the whole name table and edits it in place, so telling an
override from an untouched name is a comparison, not a flag. A name edited
back to what it was is not an override.
*/
export function changedNames(
  served: Record<string, string>,
  edited: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(edited)) {
    const name = edited[key].trim();
    if (name && name !== served[key]) out[key] = name;
  }
  return out;
}

/** Everything a session produced, as the one object the save endpoint takes. */
export function buildBundle(
  variant: string,
  table: PlacementTable,
  names: Record<string, string>,
  drags: DragRecord[],
): ExportBundle {
  return {
    variant: variant,
    placements: canonicalTable(table),
    names: names,
    drags: drags,
  };
}

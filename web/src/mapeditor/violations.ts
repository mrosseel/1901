/*
What is wrong with a placement table, asked live while somebody drags it.

tools/placement asks the same questions offline, in Node, through playwright:
audit.ts walks a table and reports what it found. The map editor (D-030) needs
the answer between two frames of a drag, so it cannot go through Node and it
cannot go through playwright — but it must not disagree with them either, or
the editor would bless a table the audit rejects.

So the thresholds and the arithmetic are IMPORTED, not copied:
tools/placement/geometry.ts is the pure half of the tool and every number
below comes out of it, and tools/placement/rules.ts carries the vocabulary
both halves share. What is not imported is the browser half — the containment
test needs isPointInFill on real shapes, and audit.ts reaches it through
page.evaluate, which cannot see an imported module. Here it arrives as the
`Geometry` interface, which measure.ts answers against the live map and a test
answers with whatever shape it wants to describe.

Reporting differs from the audit on purpose. The audit answers one row per
province, because it writes a report; the editor answers one row per FAULT,
named by the field it is a fault of, because a person drags one marker at a
time and has to see which one and why. The rules are the audit's, in the
audit's own order.
*/

import {
  BRIEF_FONT_FRACTION,
  DISLODGED_BODY,
  DISLODGED_RING,
  MIN_CLEARANCE_RADII,
  baseKey,
  coveredFraction,
  covers,
  discGap,
  distance,
  edgeClearance,
  rectAround,
  rectGap,
  type Point,
  type Rect,
} from "../../../tools/placement/geometry.ts";
import {
  BORDER_MARGIN,
  isCoast,
  type MapGeometry,
  type Placement,
  type PlacementTable,
} from "../../../tools/placement/rules.ts";

/** The three things a province's row in the table says, one draggable each. */
export type Field = "unit" | "dislodged" | "brief";

/*
The rules, in the order a fault is settled in.

It is the optimizer's own lexicographic order (geometry.ts, compareQuality):
a marker outside its province is a worse fault than one covering a name, and
no amount of clearance buys back containment. The editor sorts its list by the
same order, so the fault at the top of the list is the one worth dragging.
*/
export type Rule =
  | "containment"
  | "overhang"
  | "clearance"
  | "neighbour"
  | "supplyCentre"
  | "name";

export const RULE_ORDER: Rule[] = [
  "containment",
  "overhang",
  "clearance",
  "neighbour",
  "supplyCentre",
  "name",
];

export interface Violation {
  /** The province whose row is at fault. */
  key: string;
  field: Field;
  rule: Rule;
  /** One line naming what is wrong, for the list beside the map. */
  detail: string;
}

/*
The questions only the drawn map can answer.

Everything above is arithmetic on boxes and points. These three are geometry
on arbitrary paths, and the only honest answer to them comes from an SVG
engine — measure.ts hands over a live one, a test hands over a description.
*/
export interface Geometry {
  /** Whether a disc of this radius around this point is wholly inside `key`. */
  insideDisc(key: string, centre: Point, radius: number): boolean;
  /** The same question for an axis-aligned box, which is what a code is. */
  insideBox(key: string, centre: Point, halfWidth: number, halfHeight: number): boolean;
  /** How wide and tall this province's three-letter code is drawn, in map units. */
  briefSize(key: string, fontSize: number): { w: number; h: number };
}

/** One marker on the board, as everything below has to see it. */
interface Disc {
  key: string;
  field: Field;
  centre: Point;
  radius: number;
}

function point(pair: [number, number]): Point {
  return { x: pair[0], y: pair[1] };
}

function scaleOf(placed: Placement): number {
  return placed.scale > 0 ? placed.scale : 1;
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/*
Everything drawn on the board, as discs, so a collision is one distance test.

A unit marker is its own radius; a dislodged marker is drawn smaller (the
board scales it by DISLODGED_BODY) but carries a ring around it that is what a
reader actually sees, so it is measured at DISLODGED_RING — the same pair of
constants the board draws with and the audit measures with.
*/
function discsOf(table: PlacementTable): Disc[] {
  const out: Disc[] = [];
  for (const key of Object.keys(table)) {
    const placed = table[key];
    if (!placed || !Array.isArray(placed.unit)) continue;
    const r = scaleOf(placed);
    out.push({ key: key, field: "unit", centre: point(placed.unit), radius: r });
    if (Array.isArray(placed.dislodged)) {
      out.push({
        key: key,
        field: "dislodged",
        centre: point(placed.dislodged),
        radius: r * DISLODGED_RING,
      });
    }
  }
  return out;
}

/*
The nearest marker that is not this one's own.

A province's unit and its own dislodged marker stand side by side on purpose —
that is what a dislodged marker IS — so they are not a collision with each
other. Every other pair is: two discs that overlap are two pieces a reader
cannot tell apart, whoever they belong to.
*/
function nearestClash(
  discs: Disc[],
  self: Disc,
  radiusInUnits: (radius: number) => number,
): Disc | null {
  let worst: Disc | null = null;
  let deepest = 0;
  for (const other of discs) {
    if (other === self || other.key === self.key) continue;
    const gap =
      distance(self.centre, other.centre) -
      radiusInUnits(self.radius) -
      radiusInUnits(other.radius);
    if (gap < 0 && gap < deepest) {
      deepest = gap;
      worst = other;
    }
  }
  return worst;
}

/*
Scores one whole table.

`r` is the board's marker radius in map units at the view placement is judged
on — geometry.ts's standardRadius(), the laptop pane at fit-all zoom. Every
radius below is that number times the province's own scale, which is exactly
what board.ts draws.
*/
export function scorePlacements(
  map: MapGeometry,
  table: PlacementTable,
  r: number,
  geom: Geometry,
): Violation[] {
  const found: Violation[] = [];
  const drawable = new Map<string, boolean>();
  for (const province of map.provinces) drawable.set(province.key, province.shapes > 0);

  const discs = discsOf(table);
  const inUnits = (radius: number) => radius * r;

  for (const key of Object.keys(table)) {
    const placed = table[key];
    if (!placed || !Array.isArray(placed.unit)) continue;
    // A province the map cannot draw cannot be judged, only reported — and
    // the editor reports it by leaving its row unmarked rather than by
    // accusing a marker of leaving a border that was never drawn.
    if (drawable.get(key) === false) continue;
    const rp = r * scaleOf(placed);
    const unit = point(placed.unit);
    const away = point(placed.dislodged);

    // --- containment, and the overhang that was allowed instead ------------
    /*
    The border margin does not apply to a coast, and audit.ts says why: the
    margin an ordinary province keeps from its border makes no sense on a
    shoreline the marker is meant to sit ACROSS. Padding a coast marker here
    would report every correctly placed fleet as misplaced.
    */
    const padded = isCoast(key) ? rp : rp * (1 + BORDER_MARGIN);
    const unitFits = geom.insideDisc(key, unit, padded);
    if (!unitFits && !placed.overhang) {
      found.push({
        key: key,
        field: "unit",
        rule: "containment",
        detail: isCoast(key)
          ? "the marker has left its own coast strip"
          : "the marker is not wholly inside its province",
      });
    } else if (placed.overhang) {
      const over = placed.overhang;
      found.push({
        key: key,
        field: "unit",
        rule: "overhang",
        detail:
          "allowed out over its border — " +
          round(over.land) +
          " land, " +
          round(over.sea) +
          " sea, " +
          round(over.open) +
          " open",
      });
    }

    const awayFits = geom.insideDisc(
      key,
      away,
      isCoast(key) ? rp * DISLODGED_BODY : rp * DISLODGED_BODY * (1 + BORDER_MARGIN),
    );
    if (!awayFits && !placed.overhang) {
      found.push({
        key: key,
        field: "dislodged",
        rule: "containment",
        detail: "the dislodged marker is not wholly inside its province",
      });
    }

    // --- clearance ---------------------------------------------------------
    /*
    The finer of the two collision questions, and the one the optimizer is
    actually steered by: how far the marker's EDGE is from the nearest name or
    supply centre box. MIN_CLEARANCE_RADII is negative, so a marker is allowed
    to graze one; below that it is sitting on it.
    */
    const obstacles = map.labels.concat(map.supplyCentres);
    const clearance = edgeClearance(unit, rp, obstacles);
    if (clearance < MIN_CLEARANCE_RADII * rp) {
      found.push({
        key: key,
        field: "unit",
        rule: "clearance",
        detail: "only " + round(clearance / rp) + " radii from the nearest label",
      });
    }

    // --- neighbouring markers ----------------------------------------------
    for (const field of ["unit", "dislodged"] as Field[]) {
      const self = discs.find((one) => one.key === key && one.field === field);
      if (!self) continue;
      const clash = nearestClash(discs, self, inUnits);
      if (clash) {
        found.push({
          key: key,
          field: field,
          rule: "neighbour",
          detail: "overlaps " + clash.key + "'s " + clash.field + " marker",
        });
      }
    }

    // --- the supply centre glyph and the province name ---------------------
    if (covers(coveredFraction(unit, rp, map.supplyCentres))) {
      found.push({
        key: key,
        field: "unit",
        rule: "supplyCentre",
        detail: "the marker covers the supply centre glyph",
      });
    }
    if (covers(coveredFraction(unit, rp, map.labels))) {
      found.push({
        key: key,
        field: "unit",
        rule: "name",
        detail: "the marker covers a province name",
      });
    }
    if (covers(coveredFraction(away, rp * DISLODGED_RING, map.labels))) {
      found.push({
        key: key,
        field: "dislodged",
        rule: "name",
        detail: "the dislodged marker covers a province name",
      });
    }
  }

  found.push(...scoreBrief(map, table, r, geom, discs, inUnits));
  return sortViolations(found);
}

/*
The three-letter codes, which are only scored on a map that does not ship its
own.

A jDip-converted map carries its author's own BriefLabelLayer and the board
shows that layer rather than drawing anything, so a brief position on such a
map is a number nothing reads — and a fault reported against it would be a
fault nobody can fix. Coast keys are skipped for the same kind of reason: the
board writes one code per base province.
*/
function scoreBrief(
  map: MapGeometry,
  table: PlacementTable,
  r: number,
  geom: Geometry,
  discs: Disc[],
  inUnits: (radius: number) => number,
): Violation[] {
  if (map.drawsBriefLabels) return [];
  const found: Violation[] = [];
  const boxes = new Map<string, Rect>();

  for (const key of Object.keys(table)) {
    const placed = table[key];
    if (!placed || !Array.isArray(placed.brief)) continue;
    if (key !== baseKey(key)) continue;
    const size = geom.briefSize(key, r * BRIEF_FONT_FRACTION);
    boxes.set(key, rectAround(point(placed.brief), size.w, size.h));
  }

  for (const [key, box] of boxes) {
    const at = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    /*
    A code is judged in two steps, and they are not the same fault.

    Stray — the code's own anchor is not in the province at all — is the worst
    thing that can happen to a label, because the label now names somewhere
    else. Leaning over the border is not: geometry.ts ranks it below every
    legibility fault on purpose, since a province narrower than the code that
    names it still has to be named, and a code centred in its province plainly
    belongs to it. So the first is containment and the second is overhang.
    */
    if (!geom.insideDisc(key, at, 0)) {
      found.push({
        key: key,
        field: "brief",
        rule: "containment",
        detail: "the code is not in the province it names",
      });
    } else if (!geom.insideBox(key, at, box.w / 2, box.h / 2)) {
      found.push({
        key: key,
        field: "brief",
        rule: "overhang",
        detail: "the code leans over its own border",
      });
    }
    for (const disc of discs) {
      if (discGap(box, disc.centre, inUnits(disc.radius)) < 0) {
        found.push({
          key: key,
          field: "brief",
          rule: "neighbour",
          detail: "the code sits under " + disc.key + "'s " + disc.field + " marker",
        });
        break;
      }
    }
    if (map.supplyCentres.some((glyph) => rectGap(box, glyph) < 0)) {
      found.push({
        key: key,
        field: "brief",
        rule: "supplyCentre",
        detail: "the code sits on the supply centre glyph",
      });
    }
    for (const [otherKey, other] of boxes) {
      if (otherKey === key || rectGap(box, other) >= 0) continue;
      found.push({
        key: key,
        field: "brief",
        rule: "name",
        detail: "the code overlaps " + otherKey + "'s code",
      });
      break;
    }
  }
  return found;
}

/** Worst rule first, then by province, so the list reads the same every time. */
export function sortViolations(violations: Violation[]): Violation[] {
  const rank = (rule: Rule) => RULE_ORDER.indexOf(rule);
  return violations.slice().sort((a, b) => {
    if (a.rule !== b.rule) return rank(a.rule) - rank(b.rule);
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
  });
}

/** How many faults each province carries, for the highlights on the map. */
export function countByProvince(violations: Violation[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const one of violations) out.set(one.key, (out.get(one.key) || 0) + 1);
  return out;
}

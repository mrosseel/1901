/*
What "placement verified" means, in numbers.

Three things can be wrong with where a unit marker sits:

  outside   the marker is not wholly inside its own province, so which power
            holds what stops being readable at a glance
  name      the marker covers a province name
  supply    the marker covers a supply centre glyph

Only the first two are faults on every map. The third is reported because it
was asked for, but see the note in cli.ts: on a hand-placed map the anchor IS
the supply centre glyph, by tradition, so a high supply count is the normal
state of a good map rather than a defect.
*/

import {
  DISLODGED_BODY,
  DISLODGED_RING,
  candidatePoints,
  covers,
  coveredFraction,
  defaultDislodgedPoint,
  dislodgedCandidates,
  distance,
  scorePoint,
  type Point,
  type Weights,
} from "./geometry.ts";
import { computePoles, testInside, type MapGeometry } from "./browser.ts";
import type { Page } from "playwright-core";

export interface Violation {
  key: string;
  /** Whether the marker leaves its own province. */
  outside: boolean;
  /** No hit shape at all: the map cannot draw this province. */
  missingShape: boolean;
  /** No <key>Center path: the map ships no anchor for it. */
  missingAnchor: boolean;
  nameFraction: number;
  scFraction: number;
  coversName: boolean;
  coversSupplyCentre: boolean;
  /** The same three questions asked of the dislodged marker. */
  dislodgedOutside: boolean;
  dislodgedCoversName: boolean;
}

export interface AuditSummary {
  provinces: number;
  placed: number;
  outside: number;
  coversName: number;
  coversSupplyCentre: number;
  dislodgedOutside: number;
  dislodgedCoversName: number;
  missingShape: number;
  missingAnchor: number;
  clean: number;
}

export interface Audit {
  summary: AuditSummary;
  violations: Violation[];
}

export interface Placement {
  unit: [number, number];
  dislodged: [number, number];
}

export type PlacementTable = Record<string, Placement>;

/** The anchors a map ships, as a placement table. */
export function shippedPlacement(map: MapGeometry, r: number): PlacementTable {
  const table: PlacementTable = {};
  for (const province of map.provinces) {
    if (!province.anchor) continue;
    const away = defaultDislodgedPoint(province.anchor, r);
    table[province.key] = {
      unit: [province.anchor.x, province.anchor.y],
      dislodged: [away.x, away.y],
    };
  }
  return table;
}

/*
The margin a marker keeps from its own border. A marker whose edge touches the
line is already ambiguous, so it is asked to keep a fraction of itself clear.
*/
export const BORDER_MARGIN = 0.12;

const EDGE_SAMPLES = 24;

/*
Runs the three tests over a whole placement table. The inside test is the one
that needs the browser, so every province's questions are asked at once.
*/
export async function audit(
  page: Page,
  map: MapGeometry,
  table: PlacementTable,
  r: number,
  margin = BORDER_MARGIN,
): Promise<Audit> {
  const unitRequests = [];
  const dislodgedRequests = [];
  for (const province of map.provinces) {
    const placed = table[province.key];
    if (!placed) continue;
    unitRequests.push({
      key: province.key,
      centres: [placed.unit] as Array<[number, number]>,
      radius: r * (1 + margin),
      samples: EDGE_SAMPLES,
    });
    dislodgedRequests.push({
      key: province.key,
      centres: [placed.dislodged] as Array<[number, number]>,
      radius: r * DISLODGED_BODY * (1 + margin),
      samples: EDGE_SAMPLES,
    });
  }
  const unitInside = await testInside(page, unitRequests);
  const dislodgedInside = await testInside(page, dislodgedRequests);

  const violations: Violation[] = map.provinces.map((province) => {
    const placed = table[province.key];
    const missingShape = province.shapes === 0;
    const missingAnchor = !province.anchor;
    if (!placed) {
      return {
        key: province.key,
        outside: false,
        missingShape: missingShape,
        missingAnchor: missingAnchor,
        nameFraction: 0,
        scFraction: 0,
        coversName: false,
        coversSupplyCentre: false,
        dislodgedOutside: false,
        dislodgedCoversName: false,
      };
    }
    const unit: Point = { x: placed.unit[0], y: placed.unit[1] };
    const away: Point = { x: placed.dislodged[0], y: placed.dislodged[1] };
    const nameFraction = coveredFraction(unit, r, map.labels);
    const scFraction = coveredFraction(unit, r, map.supplyCentres);
    const awayName = coveredFraction(away, r * DISLODGED_RING, map.labels);
    return {
      key: province.key,
      // A province the map cannot draw cannot be judged, only reported.
      outside: !missingShape && !(unitInside[province.key] || [])[0],
      missingShape: missingShape,
      missingAnchor: missingAnchor,
      nameFraction: nameFraction,
      scFraction: scFraction,
      coversName: covers(nameFraction),
      coversSupplyCentre: covers(scFraction),
      dislodgedOutside: !missingShape && !(dislodgedInside[province.key] || [])[0],
      dislodgedCoversName: covers(awayName),
    };
  });

  return { summary: summarise(violations), violations: violations };
}

export function summarise(violations: Violation[]): AuditSummary {
  const count = (test: (v: Violation) => boolean) => violations.filter(test).length;
  return {
    provinces: violations.length,
    placed: count((v) => !v.missingAnchor),
    outside: count((v) => v.outside),
    coversName: count((v) => v.coversName),
    coversSupplyCentre: count((v) => v.coversSupplyCentre),
    dislodgedOutside: count((v) => v.dislodgedOutside),
    dislodgedCoversName: count((v) => v.dislodgedCoversName),
    missingShape: count((v) => v.missingShape),
    missingAnchor: count((v) => v.missingAnchor),
    clean: count((v) => !v.outside && !v.coversName && !v.missingShape && !v.dislodgedOutside && !v.dislodgedCoversName),
  };
}

// --- optimizing -----------------------------------------------------------

export interface Fixed {
  key: string;
  moved: number;
  /** Nothing inside the province clears the marker: hand correction needed. */
  impossible: boolean;
  reason: string;
}

export interface OptimizeResult {
  table: PlacementTable;
  fixed: Fixed[];
  flagged: Fixed[];
  poles: Map<string, Point>;
}

/*
Places every province's marker afresh.

Each province is solved on its own, because everything a marker can collide
with — the outline, the name, the supply centre glyph — stands still. Inside
one province the search is: reject any point that does not hold the whole
marker with a margin, then take the lowest score, where score is
name-overlap first, supply-centre overlap a distant second, and distance from
the province's pole of inaccessibility third.

The anchor the map ships is thrown into the candidate pool and judged on the
same terms as any other point. It gets no head start: a table where every
marker sits at the deepest point of its own province is the thing being
aimed at, and a hand-placed anchor either already is that or is not.
*/
export async function optimize(
  page: Page,
  map: MapGeometry,
  current: PlacementTable,
  r: number,
  weights: Weights,
  margin = BORDER_MARGIN,
): Promise<OptimizeResult> {
  const table: PlacementTable = {};
  const fixed: Fixed[] = [];
  const flagged: Fixed[] = [];

  const drawable = map.provinces.filter((province) => province.shapes > 0);
  const poleList = await computePoles(page, drawable.map((province) => province.key));
  const poles = new Map<string, Point>(poleList.map((pole) => [pole.key, pole.point]));
  const clearances = new Map<string, number>(poleList.map((pole) => [pole.key, pole.clearance]));

  /*
  Candidates: a lattice over the province, its pole, and the anchor the map
  ships. The pole is included explicitly because a lattice can step over the
  one point that matters.
  */
  const candidatesByKey = new Map<string, Point[]>();
  const requests = drawable.map((province) => {
    const pole = poles.get(province.key);
    const shipped = current[province.key];
    const points = candidatePoints(province.box, pole || { x: province.box.x, y: province.box.y }, r);
    if (pole) points.unshift(pole);
    if (shipped) points.push({ x: shipped.unit[0], y: shipped.unit[1] });
    candidatesByKey.set(province.key, points);
    return {
      key: province.key,
      centres: points.map((p) => [p.x, p.y]) as Array<[number, number]>,
      radius: r * (1 + margin),
      samples: EDGE_SAMPLES,
    };
  });
  const fits = requests.length ? await testInside(page, requests) : {};

  // A province too tight for a marker plus its margin gets a second pass with
  // the margin dropped, which is the difference between "snug" and "will not
  // go in at all".
  const relaxed = drawable.filter((province) => !(fits[province.key] || []).some(Boolean));
  const relaxedFits = relaxed.length
    ? await testInside(
        page,
        relaxed.map((province) => ({
          key: province.key,
          centres: (candidatesByKey.get(province.key) || []).map((p) => [p.x, p.y]) as Array<[number, number]>,
          radius: r,
          samples: EDGE_SAMPLES,
        })),
      )
    : {};

  for (const province of map.provinces) {
    const shipped = current[province.key];
    const pole = poles.get(province.key);
    if (province.shapes === 0) {
      if (shipped) {
        // No outline to place anything inside: the anchor stands as it is.
        table[province.key] = { unit: shipped.unit, dislodged: [0, 0] };
        flagged.push({
          key: province.key,
          moved: 0,
          impossible: true,
          reason: "the map draws no shape for this province — the shipped anchor is kept untested",
        });
      }
      continue;
    }

    const from: Point = shipped
      ? { x: shipped.unit[0], y: shipped.unit[1] }
      : pole || { x: province.box.x + province.box.w / 2, y: province.box.y + province.box.h / 2 };
    const target = pole || from;
    const points = candidatesByKey.get(province.key) || [];
    const snug = (fits[province.key] || []).some(Boolean);
    const mask = snug ? fits[province.key] : relaxedFits[province.key] || [];
    const allowed = points.filter((_point, i) => mask[i]);

    if (allowed.length === 0) {
      // Nothing holds the marker. The pole is still the best guess there is,
      // and the province needs a human or a smaller marker.
      const fallback = target;
      table[province.key] = { unit: [round(fallback.x), round(fallback.y)], dislodged: [0, 0] };
      flagged.push({
        key: province.key,
        moved: distance(fallback, from),
        impossible: true,
        reason:
          "too small for the marker at any position (widest clearance " +
          (clearances.get(province.key) || 0).toFixed(1) +
          " map units, marker needs " +
          r.toFixed(1) +
          ")",
      });
      continue;
    }

    let best = allowed[0];
    let bestScore = Infinity;
    for (const point of allowed) {
      const score = scorePoint(point, target, r, map.labels, map.supplyCentres, weights);
      if (score.total < bestScore) {
        bestScore = score.total;
        best = point;
      }
    }
    if (!snug) {
      flagged.push({
        key: province.key,
        moved: distance(best, from),
        impossible: false,
        reason: "the marker only fits without its border margin — tight province",
      });
    }
    const moved = distance(best, from);
    if (moved > 0.01) {
      fixed.push({ key: province.key, moved: moved, impossible: false, reason: "recentred on the province" });
    }

    table[province.key] = { unit: [round(best.x), round(best.y)], dislodged: [0, 0] };
  }

  // The dislodged marker is placed against the unit anchor that was just
  // settled, so it is a second pass rather than part of the first.
  const dislodgedCandidatesByKey = new Map<string, Point[]>();
  const dislodgedRequests = map.provinces
    .filter((province) => table[province.key])
    .map((province) => {
      const unit = { x: table[province.key].unit[0], y: table[province.key].unit[1] };
      const points = dislodgedCandidates(unit, r);
      dislodgedCandidatesByKey.set(province.key, points);
      return {
        key: province.key,
        centres: points.map((p) => [p.x, p.y]) as Array<[number, number]>,
        radius: r * DISLODGED_BODY * (1 + margin),
        samples: EDGE_SAMPLES,
      };
    });
  const dislodgedFits = dislodgedRequests.length ? await testInside(page, dislodgedRequests) : {};

  for (const province of map.provinces) {
    const row = table[province.key];
    if (!row) continue;
    const unit = { x: row.unit[0], y: row.unit[1] };
    const home = defaultDislodgedPoint(unit, r);
    const points = dislodgedCandidatesByKey.get(province.key) || [home];
    const mask = dislodgedFits[province.key] || [];

    const homeOk = mask[0] && !covers(coveredFraction(home, r * DISLODGED_RING, map.labels));
    if (homeOk) {
      row.dislodged = [round(home.x), round(home.y)];
      continue;
    }
    const allowed = points.filter((_point, i) => mask[i]);
    if (allowed.length === 0) {
      // Best effort: the drawn offset, flagged. A dislodged unit is on the
      // board for one phase, so a poor spot is better than none.
      row.dislodged = [round(home.x), round(home.y)];
      flagged.push({
        key: province.key,
        moved: 0,
        impossible: true,
        reason: "no dislodged position inside this province fits — keeping the drawn offset",
      });
      continue;
    }
    let best = allowed[0];
    let bestScore = Infinity;
    for (const point of allowed) {
      const nameFraction = coveredFraction(point, r * DISLODGED_RING, map.labels);
      const scFraction = coveredFraction(point, r * DISLODGED_RING, map.supplyCentres);
      // Distance here is measured from the place the board would have drawn
      // it, so the two markers stay where a player expects to find them.
      const total =
        weights.name * nameFraction +
        weights.supplyCentre * scFraction +
        weights.centre * (distance(point, home) / r);
      if (total < bestScore) {
        bestScore = total;
        best = point;
      }
    }
    row.dislodged = [round(best.x), round(best.y)];
  }

  return { table: table, fixed: fixed, flagged: flagged, poles: poles };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

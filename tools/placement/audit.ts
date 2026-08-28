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
  MIN_SCALE,
  OVERHANG_CLEARANCE,
  SCALES,
  candidatePoints,
  compareQuality,
  covers,
  coveredFraction,
  defaultDislodgedPoint,
  dislodgedCandidates,
  distance,
  isPlaced,
  neighbours,
  proofGrid,
  qualityAt,
  refinementSteps,
  type Point,
  type Quality,
} from "./geometry.ts";
import {
  classifyTerrain,
  computePoles,
  probeOverhang,
  testInside,
  type MapGeometry,
  type Terrain,
} from "./browser.ts";
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
  /* Set when this marker is allowed out over its border because nothing
     fits inside; the report says where the overhang falls. */
  overhang?: OverhangNote;
  /*
  How big this province's marker is, as a fraction of the board's normal
  radius. A province too narrow for a full marker gets a smaller one rather
  than a misplaced one; the board reads this and draws accordingly.
  */
  scale: number;
  dislodged: [number, number];
}

export interface OverhangNote {
  /** Share of the marker's edge over a neighbouring land province. */
  land: number;
  /** Share over sea. */
  sea: number;
  /** Share over nothing at all — off the map or an impassable gap. */
  open: number;
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
      scale: 1,
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
    const scale = placed.scale || 1;
    unitRequests.push({
      key: province.key,
      centres: [placed.unit] as Array<[number, number]>,
      radius: r * scale * (1 + margin),
      samples: EDGE_SAMPLES,
    });
    dislodgedRequests.push({
      key: province.key,
      centres: [placed.dislodged] as Array<[number, number]>,
      radius: r * scale * DISLODGED_BODY * (1 + margin),
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
    const scale = placed.scale || 1;
    const unit: Point = { x: placed.unit[0], y: placed.unit[1] };
    const away: Point = { x: placed.dislodged[0], y: placed.dislodged[1] };
    const nameFraction = coveredFraction(unit, r * scale, map.labels);
    const scFraction = coveredFraction(unit, r * scale, map.supplyCentres);
    const awayName = coveredFraction(away, r * scale * DISLODGED_RING, map.labels);
    return {
      key: province.key,
      /* A province the map cannot draw cannot be judged, only reported. A
         marker deliberately allowed to overhang is not a fault either: the
         placement recorded that decision, and the report names it. */
      outside: !missingShape && !placed.overhang && !(unitInside[province.key] || [])[0],
      missingShape: missingShape,
      missingAnchor: missingAnchor,
      nameFraction: nameFraction,
      scFraction: scFraction,
      coversName: covers(nameFraction),
      coversSupplyCentre: covers(scFraction),
      dislodgedOutside: !missingShape && !placed.overhang && !(dislodgedInside[province.key] || [])[0],
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

// --- placing ---------------------------------------------------------------

export interface Decision {
  key: string;
  /** The marker size used, as a fraction of the board's normal radius. */
  scale: number;
  /** How far the marker ended from the anchor the map ships. */
  moved: number;
  quality: Quality;
  /** Set when the marker had to be let out over its border. */
  overhang?: OverhangNote;
  /*
  Set when the marker still covers something and an exhaustive sweep of the
  province found nowhere better. This is the proof, not an excuse.
  */
  unavoidable?: string;
  /** Set when the province cannot be judged at all. */
  undrawable?: boolean;
}

export interface PlaceResult {
  table: PlacementTable;
  decisions: Decision[];
  poles: Map<string, Point>;
  terrain: Terrain;
}

/*
Places every province's marker.

Each province is solved on its own, because everything a marker can collide
with — the outline, the name, the supply centre glyph — stands still. Within
one province the search runs in three movements:

  sweep     a lattice over the province, plus its pole and the shipped anchor,
            tried at each marker size from full down to three quarters
  refine    a pattern search from the best of those, stepping down to half a
            map unit, which is what turns a near miss into a clean placement
  prove     for anything still covering something, an exhaustive sweep at one
            map unit, which either finds the clean spot the other two missed
            or establishes that there is none

The size is chosen for cleanliness, not only for fit: the LARGEST size that
yields a fully clean placement wins, so a province shrinks its marker only as
far as it must and only when shrinking actually buys something. A province
that will not take a marker at three quarters is allowed to overhang instead,
centred well inside its own border and leaning into sea or empty space rather
than into a neighbour that could be mistaken for its owner.
*/
export async function place(
  page: Page,
  map: MapGeometry,
  shipped: PlacementTable,
  r: number,
  margin = BORDER_MARGIN,
): Promise<PlaceResult> {
  const drawable = map.provinces.filter((province) => province.shapes > 0);
  const poleList = await computePoles(page, drawable.map((province) => province.key));
  const poles = new Map<string, Point>(poleList.map((pole) => [pole.key, pole.point]));
  const terrain = await classifyTerrain(page, poleList);

  const table: PlacementTable = {};
  const decisions: Decision[] = [];

  // --- movement one: the lattice, at every size ---------------------------

  const candidates = new Map<string, Point[]>();
  for (const province of drawable) {
    const pole = poles.get(province.key) || {
      x: province.box.x + province.box.w / 2,
      y: province.box.y + province.box.h / 2,
    };
    const points = candidatePoints(province.box, pole, r);
    points.unshift(pole);
    const anchor = shipped[province.key];
    if (anchor) points.push({ x: anchor.unit[0], y: anchor.unit[1] });
    candidates.set(province.key, points);
  }

  const fitsAtScale = new Map<number, Record<string, boolean[]>>();
  for (const scale of SCALES) {
    fitsAtScale.set(
      scale,
      await testInside(
        page,
        drawable.map((province) => ({
          key: province.key,
          centres: (candidates.get(province.key) || []).map((p) => [p.x, p.y]) as Array<[number, number]>,
          radius: r * scale * (1 + margin),
          samples: EDGE_SAMPLES,
        })),
      ),
    );
  }

  interface Best {
    point: Point;
    scale: number;
    quality: Quality;
    overhang?: OverhangNote;
  }
  const best = new Map<string, Best>();

  for (const province of drawable) {
    const pole = poles.get(province.key) || { x: province.box.x, y: province.box.y };
    const points = candidates.get(province.key) || [];
    let chosen: Best | null = null;

    /*
    Size is chosen for two reasons and no others: because a full marker will
    not go in, or because a smaller one can stand somewhere clean that a
    bigger one cannot. It is NOT shrunk to shave a few percent off an overlap
    that no size avoids — markers that are all slightly different sizes for
    no visible gain read worse than markers that are all the same.
    */
    let widest: Best | null = null;
    for (const scale of SCALES) {
      const mask = (fitsAtScale.get(scale) || {})[province.key] || [];
      let bestHere: Best | null = null;
      for (let i = 0; i < points.length; i++) {
        if (!mask[i]) continue;
        const quality = qualityAt(points[i], pole, r * scale, map.labels, map.supplyCentres, 0);
        if (!bestHere || compareQuality(quality, bestHere.quality) < 0) {
          bestHere = { point: points[i], scale: scale, quality: quality };
        }
      }
      if (!bestHere) continue;
      // The first size that fits at all is the largest that fits.
      if (!widest) widest = bestHere;
      if (isPlaced(bestHere.quality)) {
        chosen = bestHere;
        break;
      }
    }
    if (!chosen) chosen = widest;
    if (chosen) best.set(province.key, chosen);
  }

  // --- the provinces that fit at no size: let them overhang ---------------

  const cramped = drawable.filter((province) => !best.has(province.key));
  if (cramped.length) {
    const probes = await probeOverhang(
      page,
      cramped.map((province) => ({
        key: province.key,
        centres: (candidates.get(province.key) || []).map((p) => [p.x, p.y]) as Array<[number, number]>,
        radius: r * MIN_SCALE,
        samples: EDGE_SAMPLES,
      })),
      terrain.kind,
    );
    for (const province of cramped) {
      const pole = poles.get(province.key) || { x: province.box.x, y: province.box.y };
      const points = candidates.get(province.key) || [];
      const results = probes[province.key] || [];
      let chosen: Best | null = null;
      for (let i = 0; i < points.length; i++) {
        const probe = results[i];
        if (!probe || !probe.inside) continue;
        if (probe.clearance < r * MIN_SCALE * OVERHANG_CLEARANCE) continue;
        const ambiguity = probe.land / EDGE_SAMPLES;
        const quality = qualityAt(points[i], pole, r * MIN_SCALE, map.labels, map.supplyCentres, 1, ambiguity);
        if (!chosen || compareQuality(quality, chosen.quality) < 0) {
          chosen = {
            point: points[i],
            scale: MIN_SCALE,
            quality: quality,
            overhang: {
              land: probe.land / EDGE_SAMPLES,
              sea: probe.sea / EDGE_SAMPLES,
              open: probe.open / EDGE_SAMPLES,
            },
          };
        }
      }
      /*
      Last resort for a province narrower than half a marker: stand on the
      pole. It is the deepest point there is, so no other position is less
      ambiguous, and every province must end with a placement.
      */
      if (!chosen) {
        chosen = {
          point: pole,
          scale: MIN_SCALE,
          quality: qualityAt(pole, pole, r * MIN_SCALE, map.labels, map.supplyCentres, 1, 1),
          overhang: { land: 1, sea: 0, open: 0 },
        };
      }
      best.set(province.key, chosen);
    }
  }

  // --- movement two: pattern search ---------------------------------------

  for (const step of refinementSteps(r)) {
    for (let pass = 0; pass < 3; pass++) {
      const moving = drawable.filter((province) => best.has(province.key));
      if (!moving.length) break;
      const trials = new Map<string, Point[]>();
      for (const province of moving) {
        trials.set(province.key, neighbours(best.get(province.key)!.point, step));
      }
      const masks = await testInside(
        page,
        moving.map((province) => ({
          key: province.key,
          centres: trials.get(province.key)!.map((p) => [p.x, p.y]) as Array<[number, number]>,
          radius: r * best.get(province.key)!.scale * (1 + margin),
          samples: EDGE_SAMPLES,
        })),
      );
      let improved = false;
      for (const province of moving) {
        const held = best.get(province.key)!;
        // A marker already out over its border is not refined by this test,
        // which only knows how to say "wholly inside".
        if (held.overhang) continue;
        const pole = poles.get(province.key) || held.point;
        const mask = masks[province.key] || [];
        const points = trials.get(province.key)!;
        for (let i = 0; i < points.length; i++) {
          if (!mask[i]) continue;
          const quality = qualityAt(points[i], pole, r * held.scale, map.labels, map.supplyCentres, 0);
          if (compareQuality(quality, held.quality) < 0) {
            best.set(province.key, { point: points[i], scale: held.scale, quality: quality });
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  }

  // --- movement three: prove the rest ------------------------------------

  /*
  Anything still covering something gets swept exhaustively — every position
  in the province at one map unit, at every marker size. Either the sweep
  finds the clean spot the lattice and the pattern search both stepped over,
  or there is no clean spot, and the report can say so as a fact rather than
  as a shrug. This is what makes "unavoidable" mean something.
  */
  const offenders = drawable.filter((province) => {
    const held = best.get(province.key);
    return held && !held.overhang && !isPlaced(held.quality);
  });
  if (offenders.length) {
    const sweeps = new Map<string, Point[]>();
    for (const province of offenders) sweeps.set(province.key, proofGrid(province.box));

    for (const scale of SCALES) {
      const masks = await testInside(
        page,
        offenders.map((province) => ({
          key: province.key,
          centres: sweeps.get(province.key)!.map((p) => [p.x, p.y]) as Array<[number, number]>,
          radius: r * scale * (1 + margin),
          samples: EDGE_SAMPLES,
        })),
      );
      for (const province of offenders) {
        const held = best.get(province.key)!;
        // Once a size is proved clean, nothing smaller is an improvement.
        if (isPlaced(held.quality)) continue;
        const pole = poles.get(province.key) || held.point;
        const points = sweeps.get(province.key)!;
        const mask = masks[province.key] || [];
        for (let i = 0; i < points.length; i++) {
          if (!mask[i]) continue;
          const quality = qualityAt(points[i], pole, r * scale, map.labels, map.supplyCentres, 0);
          /*
          At the size already chosen, take any improvement. At a smaller one,
          take it only if it is actually clean — same rule as the sweep above,
          so the proof cannot quietly shrink a marker for a 2% gain.
          */
          const better = compareQuality(quality, held.quality) < 0;
          if (!better) continue;
          if (scale < held.scale && !isPlaced(quality)) continue;
          best.set(province.key, { point: points[i], scale: scale, quality: quality });
        }
      }
    }
  }

  // --- the dislodged marker, under exactly the same rules -----------------

  for (const province of map.provinces) {
    const held = best.get(province.key);
    const anchor = shipped[province.key];
    if (!held) {
      if (anchor) {
        table[province.key] = { unit: anchor.unit, scale: 1, dislodged: anchor.dislodged };
        decisions.push({
          key: province.key,
          scale: 1,
          moved: 0,
          quality: qualityAt({ x: anchor.unit[0], y: anchor.unit[1] }, { x: anchor.unit[0], y: anchor.unit[1] }, r, map.labels, map.supplyCentres, 0),
          undrawable: true,
        });
      }
      continue;
    }
    table[province.key] = {
      unit: [round(held.point.x), round(held.point.y)],
      scale: held.scale,
      dislodged: [0, 0],
      overhang: held.overhang,
    };
  }

  const withMarker = map.provinces.filter((province) => table[province.key] && best.has(province.key));
  const awayCandidates = new Map<string, Point[]>();
  for (const province of withMarker) {
    const held = best.get(province.key)!;
    awayCandidates.set(province.key, dislodgedCandidates(held.point, r * held.scale));
  }
  const awayFits = await testInside(
    page,
    withMarker.map((province) => {
      const held = best.get(province.key)!;
      return {
        key: province.key,
        centres: awayCandidates.get(province.key)!.map((p) => [p.x, p.y]) as Array<[number, number]>,
        radius: r * held.scale * DISLODGED_BODY * (1 + margin),
        samples: EDGE_SAMPLES,
      };
    }),
  );

  /*
  The fallback lattice, tested once for every province that might need it, so
  the rescue below costs one round trip rather than one per province.
  */
  const lateFits = await testInside(
    page,
    withMarker.map((province) => {
      const held = best.get(province.key)!;
      return {
        key: province.key,
        centres: (candidates.get(province.key) || []).map((p) => [p.x, p.y]) as Array<[number, number]>,
        radius: r * held.scale * DISLODGED_BODY * (1 + margin),
        samples: EDGE_SAMPLES,
      };
    }),
  );

  for (const province of withMarker) {
    const held = best.get(province.key)!;
    const radius = r * held.scale;
    const home = defaultDislodgedPoint(held.point, radius);
    const points = awayCandidates.get(province.key)!;
    const mask = awayFits[province.key] || [];
    const pole = poles.get(province.key) || held.point;

    let chosen: Point | null = null;
    let chosenQuality: Quality | null = null;
    for (let i = 0; i < points.length; i++) {
      if (!mask[i]) continue;
      const quality = qualityAt(points[i], pole, radius * DISLODGED_RING, map.labels, map.supplyCentres, 0);
      // Nearness to the place the board would have drawn it stands in for
      // prettiness here: a player looks up and to the right first.
      quality.offCentre = distance(points[i], home) / radius;
      if (!chosenQuality || compareQuality(quality, chosenQuality) < 0) {
        chosen = points[i];
        chosenQuality = quality;
      }
    }
    /*
    Nothing on the ring fits, which happens in a province barely wide enough
    for the unit itself. Rather than drop the marker outside, the province's
    own lattice is searched — anywhere inside it will do — preferring the spot
    nearest where the board would have drawn it. The same ladder the unit
    marker climbs, one rung down.
    */
    if (!chosen) {
      const fallbackMask = lateFits[province.key] || [];
      const lattice = candidates.get(province.key) || [];
      for (let i = 0; i < lattice.length; i++) {
        if (!fallbackMask[i]) continue;
        const quality = qualityAt(lattice[i], pole, radius * DISLODGED_RING, map.labels, map.supplyCentres, 0);
        quality.offCentre = distance(lattice[i], home) / radius;
        if (!chosenQuality || compareQuality(quality, chosenQuality) < 0) {
          chosen = lattice[i];
          chosenQuality = quality;
        }
      }
    }

    /* Still nowhere: the drawn offset stands. A dislodged unit is on the
       board for one phase and is ringed in red, so a poor spot beats none. */
    const away = chosen || home;
    table[province.key].dislodged = [round(away.x), round(away.y)];

    const anchor = shipped[province.key];
    const from = anchor ? { x: anchor.unit[0], y: anchor.unit[1] } : held.point;
    decisions.push({
      key: province.key,
      scale: held.scale,
      moved: distance(held.point, from),
      quality: held.quality,
      overhang: held.overhang,
      unavoidable: isPlaced(held.quality)
        ? undefined
        : "an exhaustive sweep of this province at one map unit found no position that avoids it",
    });
  }

  return { table: table, decisions: decisions, poles: poles, terrain: terrain };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

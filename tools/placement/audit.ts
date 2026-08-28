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
  MIN_CLEARANCE_RADII,
  MIN_SCALE,
  OVERHANG_CLEARANCE,
  SCALES,
  baseKey,
  candidatePoints,
  clearlyBetter,
  compareCoastFirst,
  compareQuality,
  covers,
  coveredFraction,
  defaultDislodgedPoint,
  dislodgedCandidates,
  distance,
  edgeClearance,
  isPlaced,
  meetsSeparation,
  neighbours,
  proofGrid,
  qualityAt,
  refinementSteps,
  separationShortfall,
  coastPenalty,
  type Point,
  type Quality,
} from "./geometry.ts";
import {
  classifyTerrain,
  computePoles,
  probeCoasts,
  probeOverhang,
  testInside,
  type InsideRequest,
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
How far a coast marker's centre may sit from its own strip and still count as
standing on that coast, in marker radii.

One radius means the marker is at worst touching the strip with its edge —
straddling the shoreline, which is the whole point of the rule. Beyond that it
has walked inland and is no longer describing a coast.
*/
export const COAST_REACH = 1;

/** A key naming one coast of a province, rather than the province. */
export function isCoast(key: string): boolean {
  return key.includes("/");
}

/*
Runs the containment test appropriate to each key.

An ordinary province asks "does the whole marker fit inside my border". A
named coast asks the coast question instead — see probeCoasts() — because a
coast strip is usually narrower than a marker and a fleet is supposed to sit
on the shoreline. Both answer in the same shape, a boolean per candidate, so
every caller below is unchanged by which one ran.
*/
async function testPlaceable(
  page: Page,
  requests: InsideRequest[],
  terrain: Record<string, "sea" | "land" | "unknown">,
  radiusOf: (key: string) => number,
): Promise<Record<string, boolean[]>> {
  const plain = requests.filter((request) => !isCoast(request.key));
  const coasts = requests.filter((request) => isCoast(request.key));
  const answer = plain.length ? await testInside(page, plain) : {};
  if (coasts.length) {
    const probes = await probeCoasts(
      page,
      coasts.map((request) => ({
        key: request.key,
        base: baseKey(request.key),
        centres: request.centres,
        // The margin an ordinary province keeps from its border makes no
        // sense on a shoreline the marker is meant to sit across.
        radius: radiusOf(request.key),
        samples: request.samples,
        reach: COAST_REACH * radiusOf(request.key),
      })),
      terrain,
    );
    for (const request of coasts) {
      answer[request.key] = (probes[request.key] || []).map((one) => one.ok);
    }
  }
  return answer;
}

/*
Runs the three tests over a whole placement table. The inside test is the one
that needs the browser, so every province's questions are asked at once.
*/
export async function audit(
  page: Page,
  map: MapGeometry,
  table: PlacementTable,
  r: number,
  terrain: Record<string, "sea" | "land" | "unknown"> = {},
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
  /* The same test the placer used, coast rule included, or a marker the
     placer called clean would be reported here as a violation. */
  const radiusOf = (key: string) => r * ((table[key] && table[key].scale) || 1);
  const unitInside = await testPlaceable(page, unitRequests, terrain, radiusOf);
  const dislodgedInside = await testPlaceable(
    page, dislodgedRequests, terrain, (key) => radiusOf(key) * DISLODGED_BODY);

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

// --- measuring the margin a person actually keeps --------------------------

/*
RULE B starts by asking the placement, not the tool, what a good margin is.

Every marker in a table is measured from its own edge to the nearest name or
supply centre box. Run over the owner's hand-corrected table, the middle of
that distribution is the margin they were content with — not the widest gap
they achieved, and not zero. That median becomes the threshold every marker is
asked to clear, and clearing it is worth nothing further, so the optimizer
stops shoving markers into corners to buy clearance it was never asked for.

Reported in radii as well as map units, because the number has to carry to a
map drawn at a different scale.
*/
export interface ClearanceSample {
  key: string;
  /** Map units from the marker's edge to the nearest obstacle; may be negative. */
  clearance: number;
  /** The same, in this marker's own radii. */
  radii: number;
  /** The marker's radius in map units, which the figures above are per. */
  radius: number;
  /** Measured against names alone, and against supply centres alone. */
  nameClearance: number;
  scClearance: number;
}

export interface ClearanceStudy {
  samples: ClearanceSample[];
  /** The median over every marker, which is what the threshold is taken from. */
  medianRadii: number;
  medianUnits: number;
  medianNameRadii: number;
  medianScRadii: number;
  /** Deciles of the combined figure, in radii, for the report. */
  deciles: number[];
  overlapping: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finite(values: number[]): number[] {
  return values.filter((value) => isFinite(value));
}

export function measureClearance(map: MapGeometry, table: PlacementTable, r: number): ClearanceStudy {
  const samples: ClearanceSample[] = [];
  for (const province of map.provinces) {
    const placed = table[province.key];
    if (!placed) continue;
    const radius = r * (placed.scale || 1);
    const at: Point = { x: placed.unit[0], y: placed.unit[1] };
    const name = edgeClearance(at, radius, map.labels);
    const sc = edgeClearance(at, radius, map.supplyCentres);
    const both = Math.min(name, sc);
    if (!isFinite(both)) continue;
    samples.push({
      key: province.key,
      clearance: both,
      radius: radius,
      radii: both / radius,
      nameClearance: name,
      scClearance: sc,
    });
  }
  const radii = finite(samples.map((s) => s.radii)).sort((a, b) => a - b);
  const deciles: number[] = [];
  for (let i = 0; i <= 10; i++) {
    if (radii.length === 0) break;
    deciles.push(radii[Math.min(radii.length - 1, Math.floor((radii.length - 1) * (i / 10)))]);
  }
  return {
    samples: samples,
    medianRadii: median(radii),
    medianUnits: median(finite(samples.map((s) => s.clearance))),
    medianNameRadii: median(finite(samples.map((s) => s.nameClearance / s.radius))),
    medianScRadii: median(finite(samples.map((s) => s.scClearance / s.radius))),
    deciles: deciles,
    overlapping: samples.filter((s) => s.clearance < 0).length,
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
  /** The marker was left exactly where the seed table put it. */
  keptSeed?: boolean;
  /** The marker left its seeded position, and this is why. */
  deviation?: Deviation;
  /*
  RULE A could not be met anywhere in this province: no position clears the
  wanted separation from the rest of its coast family. The marker is placed as
  well as the province allows and the report says so.
  */
  coastIllegible?: boolean;
}

/*
Every departure from a seeded — that is, hand-placed — position, with the
reason spelled out. The owner has to be able to see what the tool overruled
and disagree with it; a silent improvement is indistinguishable from a bug.
*/
export interface Deviation {
  key: string;
  /** How far the marker moved from the hand-placed one, in map units. */
  moved: number;
  from: [number, number];
  to: [number, number];
  fromScale: number;
  toScale: number;
  /** Which term of the quality tuple the new position won on. */
  reason: string;
  seedQuality: Quality;
  chosenQuality: Quality;
  /** True when only the dislodged marker moved. */
  dislodgedOnly?: boolean;
}

export interface PlaceOptions {
  /*
  A privileged table — the hand-corrected one. Its positions go into the
  search as candidates AND are kept unless something beats them on a term a
  reader could name; see clearlyBetter() in geometry.ts.
  */
  seed?: PlacementTable;
  /** The RULE B threshold, in marker radii. */
  minClearanceRadii?: number;
  margin?: number;
}

export interface PlaceResult {
  table: PlacementTable;
  decisions: Decision[];
  poles: Map<string, Point>;
  terrain: Terrain;
  /** Every position that left its seed, for the report. */
  deviations: Deviation[];
  /** How many seeded positions were kept untouched. */
  keptSeeds: number;
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
  options: PlaceOptions = {},
): Promise<PlaceResult> {
  const margin = options.margin === undefined ? BORDER_MARGIN : options.margin;
  const seed = options.seed;
  const minRadii = options.minClearanceRadii === undefined ? MIN_CLEARANCE_RADII : options.minClearanceRadii;
  const drawable = map.provinces.filter((province) => province.shapes > 0);
  const poleList = await computePoles(page, drawable.map((province) => province.key));
  const poles = new Map<string, Point>(poleList.map((pole) => [pole.key, pole.point]));
  const terrain = await classifyTerrain(page, poleList);

  const table: PlacementTable = {};
  const decisions: Decision[] = [];
  const deviations: Deviation[] = [];
  /* What each seeded position scored when it was weighed, kept so the report
     can say what the tool traded away when it overruled a hand. */
  const seedScores = new Map<string, Quality>();
  const seedQualityOf = (key: string): Quality =>
    seedScores.get(key) || {
      name: 0, coast: 0, supplyCentre: 0, containment: 0, ambiguity: 0, clearance: 0, offCentre: 0,
    };

  /*
  The coast families (RULE A): every key that shares a base province with
  another. "stp", "stp/nc" and "stp/sc" are one family and have to end up far
  enough apart to be told apart; a province with no coasts is in no family and
  the rule costs it nothing.
  */
  const byBase = new Map<string, string[]>();
  for (const province of map.provinces) {
    const b = baseKey(province.key);
    const list = byBase.get(b) || [];
    list.push(province.key);
    byBase.set(b, list);
  }
  const family = new Map<string, string[]>();
  for (const [, members] of byBase) {
    if (members.length < 2) continue;
    for (const key of members) family.set(key, members.filter((other) => other !== key));
  }

  /*
  Where the tool currently believes each family member stands. The separation
  test needs an answer before anything has been placed, so it starts from the
  seed if there is one and the shipped anchor otherwise, and is updated as
  positions are chosen.
  */
  const standing = new Map<string, Point>();
  for (const province of map.provinces) {
    const from = (seed && seed[province.key]) || shipped[province.key];
    if (from) standing.set(province.key, { x: from.unit[0], y: from.unit[1] });
  }

  const siblingPoints = (key: string): Point[] => {
    const members = family.get(key);
    if (!members) return [];
    const out: Point[] = [];
    for (const other of members) {
      const point = standing.get(other);
      if (point) out.push(point);
    }
    return out;
  };

  /** The quality inputs every candidate for this key shares. */
  const inputsFor = (key: string, point: Point, radius: number, containment: number, ambiguity = 0) => ({
    containment: containment,
    ambiguity: ambiguity,
    coast: coastPenalty(separationShortfall(point, siblingPoints(key), radius), false),
    wantedClearance: minRadii * radius,
  });

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
    // The hand-placed position goes in first: it is the one the search is
    // meant to keep unless it finds something demonstrably better.
    const held = seed && seed[province.key];
    if (held) points.unshift({ x: held.unit[0], y: held.unit[1] });
    candidates.set(province.key, points);
  }

  const fitsAtScale = new Map<number, Record<string, boolean[]>>();
  for (const scale of SCALES) {
    fitsAtScale.set(
      scale,
      await testPlaceable(
        page,
        drawable.map((province) => ({
          key: province.key,
          centres: (candidates.get(province.key) || []).map((p) => [p.x, p.y]) as Array<[number, number]>,
          radius: r * scale * (1 + margin),
          samples: EDGE_SAMPLES,
        })),
        terrain.kind,
        () => r * scale,
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
        const quality = qualityAt(
          points[i], pole, r * scale, map.labels, map.supplyCentres,
          inputsFor(province.key, points[i], r * scale, 0),
        );
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
        const quality = qualityAt(
          points[i], pole, r * MIN_SCALE, map.labels, map.supplyCentres,
          inputsFor(province.key, points[i], r * MIN_SCALE, 1, ambiguity),
        );
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
          quality: qualityAt(
            pole, pole, r * MIN_SCALE, map.labels, map.supplyCentres,
            inputsFor(province.key, pole, r * MIN_SCALE, 1, 1),
          ),
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
      const masks = await testPlaceable(
        page,
        moving.map((province) => ({
          key: province.key,
          centres: trials.get(province.key)!.map((p) => [p.x, p.y]) as Array<[number, number]>,
          radius: r * best.get(province.key)!.scale * (1 + margin),
          samples: EDGE_SAMPLES,
        })),
        terrain.kind,
        (key) => r * (best.get(key)?.scale || 1),
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
          const quality = qualityAt(
            points[i], pole, r * held.scale, map.labels, map.supplyCentres,
            inputsFor(province.key, points[i], r * held.scale, 0),
          );
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
      const masks = await testPlaceable(
        page,
        offenders.map((province) => ({
          key: province.key,
          centres: sweeps.get(province.key)!.map((p) => [p.x, p.y]) as Array<[number, number]>,
          radius: r * scale * (1 + margin),
          samples: EDGE_SAMPLES,
        })),
        terrain.kind,
        () => r * scale,
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
          const quality = qualityAt(
            points[i], pole, r * scale, map.labels, map.supplyCentres,
            inputsFor(province.key, points[i], r * scale, 0),
          );
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

  for (const province of drawable) {
    const held = best.get(province.key);
    if (held) standing.set(province.key, held.point);
  }

  // --- movement four: give the hand-placed positions their privilege ------

  /*
  A seeded table is a person's answer, not a starting guess. Every seeded
  position that survives the hard constraints is put back, and the search's
  own answer is kept only where it beats the hand on a term a reader could
  name — a covered name, an illegible coast, a marker off its province, a
  margin below the measured threshold. Prettiness never overrules a hand.
  */
  const keptSeed = new Set<string>();
  /* Seeds that could not be kept at all, and why. A hard constraint is not a
     judgement call and the report must not describe it as one. */
  const seedRejected = new Map<string, string>();
  if (seed) {
    const seeded = drawable.filter((province) => seed[province.key]);
    const seedPoint = (key: string): Point => ({ x: seed[key].unit[0], y: seed[key].unit[1] });
    const seedFits = await testPlaceable(
      page,
      seeded.map((province) => ({
        key: province.key,
        centres: [[seedPoint(province.key).x, seedPoint(province.key).y]] as Array<[number, number]>,
        radius: r * (seed[province.key].scale || 1) * (1 + margin),
        samples: EDGE_SAMPLES,
      })),
      terrain.kind,
      (key) => r * (seed[key].scale || 1),
    );
    const onCoast = await standsOnOwnCoast(
      page,
      family,
      new Map(seeded.map((province) => [province.key, [seedPoint(province.key)]])),
    );

    for (const province of seeded) {
      const held = best.get(province.key);
      if (!held) continue;
      const spot = seed[province.key];
      const scale = spot.scale || 1;
      const point = seedPoint(province.key);
      const radius = r * scale;
      const fitted = (seedFits[province.key] || [])[0];
      const pole = poles.get(province.key) || point;
      const quality = qualityAt(point, pole, radius, map.labels, map.supplyCentres, {
        // A hand position that does not fit and was never marked as a
        // deliberate overhang is scored as what it is: outside.
        containment: fitted ? 0 : 1,
        ambiguity: spot.overhang ? spot.overhang.land : 0,
        coast: coastPenalty(
          separationShortfall(point, siblingPoints(province.key), radius),
          Boolean((onCoast.get(province.key) || [])[0]),
        ),
        wantedClearance: minRadii * radius,
      });
      seedScores.set(province.key, quality);
      if (!fitted && !spot.overhang) {
        seedRejected.set(province.key, "the hand position does not fit inside its province at " + scale.toFixed(2) + "x");
        continue;
      }
      if (clearlyBetter(held.quality, quality)) continue;
      best.set(province.key, { point: point, scale: scale, quality: quality, overhang: spot.overhang });
      standing.set(province.key, point);
      keptSeed.add(province.key);
    }
  }

  // --- movement five: the coast rule ---------------------------------------

  /*
  RULE A is the one rule that couples two provinces, so it cannot be settled
  one province at a time like everything above. A family — "stp", "stp/nc",
  "stp/sc" — is walked round a few times, each member re-placed against where
  the others currently stand, until nobody wants to move. Three members and a
  handful of rounds is not a search problem; it converges or it stops.

  The candidates are the province's own lattice plus a two-unit sweep of it,
  which is fine enough that a coast strip a marker can stand on is found.
  */
  /* Family members that could not make the separation anywhere in their own
     province. This is a fact about the map, not a placement to argue with. */
  const illegible = new Set<string>();
  const coastKeys = drawable.filter((province) => family.has(province.key)).map((p) => p.key);
  if (coastKeys.length) {
    const boxOf = new Map(drawable.map((province) => [province.key, province.box]));
    const pool = new Map<string, Point[]>();
    for (const key of coastKeys) {
      const points = (candidates.get(key) || []).slice();
      const box = boxOf.get(key);
      if (box) points.push(...proofGrid(box, 2));
      const held = best.get(key);
      if (held) points.unshift(held.point);
      pool.set(key, points);
    }

    const fitsAt = new Map<number, Record<string, boolean[]>>();
    for (const scale of SCALES) {
      fitsAt.set(
        scale,
        await testPlaceable(
          page,
          coastKeys.map((key) => ({
            key: key,
            centres: pool.get(key)!.map((p) => [p.x, p.y]) as Array<[number, number]>,
            radius: r * scale * (1 + margin),
            samples: EDGE_SAMPLES,
          })),
          terrain.kind,
          () => r * scale,
        ),
      );
    }
    const onCoast = await standsOnOwnCoast(page, family, pool);

    for (let round = 0; round < 4; round++) {
      let moved = false;
      for (const key of coastKeys) {
        const held = best.get(key);
        if (!held) continue;
        const pole = poles.get(key) || held.point;
        const points = pool.get(key)!;
        const flags = onCoast.get(key) || [];

        const qualityOf = (point: Point, scale: number, onSibling: boolean): Quality => {
          const radius = r * scale;
          return qualityAt(point, pole, radius, map.labels, map.supplyCentres, {
            containment: 0,
            coast: coastPenalty(separationShortfall(point, siblingPoints(key), radius), onSibling),
            wantedClearance: minRadii * radius,
          });
        };

        // Where the marker stands now, judged against where the family
        // stands now — the coast term is stale after anyone else moves.
        const current = held.overhang
          ? held.quality
          : qualityOf(held.point, held.scale, false);

        /*
        The separation is a filter before it is a preference: only positions
        that clear it are searched, so nothing can outvote legibility. A
        province that offers none is searched wholly and named in the report.
        */
        const search = (legibleOnly: boolean) => {
          let widest: { point: Point; scale: number; quality: Quality } | null = null;
          for (const scale of SCALES) {
            const mask = (fitsAt.get(scale) || {})[key] || [];
            let here: { point: Point; scale: number; quality: Quality } | null = null;
            for (let i = 0; i < points.length; i++) {
              if (!mask[i]) continue;
              if (legibleOnly) {
                if (flags[i]) continue;
                if (!meetsSeparation(points[i], siblingPoints(key), r * scale)) continue;
              }
              const quality = qualityOf(points[i], scale, Boolean(flags[i]));
              /*
              Once the filter has failed, legibility becomes the first
              question rather than a late one. Otherwise the fallback is free
              to pick a position that is clean of names and sits on top of its
              own base province, which is the fault the rule exists for
              arrived at by another road.
              */
              const rank = legibleOnly ? compareQuality : compareCoastFirst;
              if (!here || rank(quality, here.quality) < 0) {
                here = { point: points[i], scale: scale, quality: quality };
              }
            }
            if (!here) continue;
            // The same size ladder as movement one: the largest marker that
            // is clean wins, and nothing shrinks for a few percent.
            if (!widest) widest = here;
            if (isPlaced(here.quality)) return here;
          }
          return widest;
        };

        const chosen = search(true) || search(false);
        if (!chosen) continue;
        if (chosen.quality.coast > 0) illegible.add(key);
        else illegible.delete(key);

        /*
        Accepted on the same ranking it was chosen by. A position picked for
        legibility and then judged name-first would be refused every time,
        and the family would sit where it started for ever.

        A hand-placed marker is held to the stricter test here too: the coast
        rule may overrule it, a nicer centre may not.
        */
        const stuck = chosen.quality.coast > 0 || current.coast > 0;
        const wins = keptSeed.has(key)
          ? clearlyBetter(chosen.quality, current)
          : (stuck ? compareCoastFirst : compareQuality)(chosen.quality, current) < 0;
        if (!wins) {
          best.set(key, { ...held, quality: current });
          continue;
        }
        best.set(key, chosen);
        standing.set(key, chosen.point);
        keptSeed.delete(key);
        moved = true;
      }
      if (!moved) break;
    }

    /*
    Who is actually illegible is a question about where the family ENDED, not
    about which round a search came up empty in: a member can fail the filter
    early and be rescued when a sibling moves away later.
    */
    illegible.clear();
    for (const key of coastKeys) {
      const held = best.get(key);
      if (!held) continue;
      if (!meetsSeparation(held.point, siblingPoints(key), r * held.scale)) illegible.add(key);
    }
  }

  // --- the dislodged marker, under exactly the same rules -----------------

  for (const province of map.provinces) {
    const held = best.get(province.key);
    const anchor = shipped[province.key];
    if (!held) {
      if (anchor) {
        table[province.key] = { unit: anchor.unit, scale: 1, dislodged: anchor.dislodged };
        const at = { x: anchor.unit[0], y: anchor.unit[1] };
        decisions.push({
          key: province.key,
          scale: 1,
          moved: 0,
          quality: qualityAt(at, at, r, map.labels, map.supplyCentres, { containment: 0 }),
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
    const points = dislodgedCandidates(held.point, r * held.scale);
    /* A hand-placed dislodged marker is a candidate too, but only where its
       own unit stayed put: an offset from a marker that has moved is just a
       point in the wrong place. */
    const spot = seed && seed[province.key];
    if (spot && keptSeed.has(province.key)) {
      points.unshift({ x: spot.dislodged[0], y: spot.dislodged[1] });
    }
    awayCandidates.set(province.key, points);
  }
  const awayFits = await testPlaceable(
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
    terrain.kind,
    (key) => r * (best.get(key)?.scale || 1) * DISLODGED_BODY,
  );

  /*
  The fallback lattice, tested once for every province that might need it, so
  the rescue below costs one round trip rather than one per province.
  */
  const lateFits = await testPlaceable(
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
    terrain.kind,
    (key) => r * (best.get(key)?.scale || 1) * DISLODGED_BODY,
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
      const quality = qualityAt(points[i], pole, radius * DISLODGED_RING, map.labels, map.supplyCentres, {
        containment: 0,
        wantedClearance: minRadii * radius * DISLODGED_RING,
      });
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
        const quality = qualityAt(lattice[i], pole, radius * DISLODGED_RING, map.labels, map.supplyCentres, {
          containment: 0,
          wantedClearance: minRadii * radius * DISLODGED_RING,
        });
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

    /* Everything the owner has to be able to check: did this marker stay
       where they put it, and if not, on what grounds. */
    let keptThisSeed = keptSeed.has(province.key);
    let deviation: Deviation | undefined;
    const spot = seed && seed[province.key];
    if (spot) {
      const at: Point = { x: spot.unit[0], y: spot.unit[1] };
      const shift = distance(held.point, at);
      const scaleChanged = (spot.scale || 1) !== held.scale;
      const dislodgedShift = distance(
        { x: table[province.key].dislodged[0], y: table[province.key].dislodged[1] },
        { x: spot.dislodged[0], y: spot.dislodged[1] },
      );
      if (shift > 0.01 || scaleChanged) {
        keptThisSeed = false;
        deviation = {
          key: province.key,
          moved: shift,
          from: [spot.unit[0], spot.unit[1]],
          to: table[province.key].unit,
          fromScale: spot.scale || 1,
          toScale: held.scale,
          reason: seedRejected.get(province.key) || whyBetter(held.quality, seedQualityOf(province.key)),
          seedQuality: seedQualityOf(province.key),
          chosenQuality: held.quality,
        };
      } else if (dislodgedShift > 0.05) {
        deviation = {
          key: province.key,
          moved: dislodgedShift,
          from: [spot.dislodged[0], spot.dislodged[1]],
          to: table[province.key].dislodged,
          fromScale: spot.scale || 1,
          toScale: held.scale,
          reason: "the dislodged marker moved; the unit marker did not",
          seedQuality: held.quality,
          chosenQuality: held.quality,
          dislodgedOnly: true,
        };
      }
    }
    if (deviation) deviations.push(deviation);

    decisions.push({
      key: province.key,
      scale: held.scale,
      moved: distance(held.point, from),
      quality: held.quality,
      overhang: held.overhang,
      keptSeed: keptThisSeed,
      deviation: deviation,
      coastIllegible: illegible.has(province.key) || undefined,
      unavoidable: isPlaced(held.quality)
        ? undefined
        : "an exhaustive sweep of this province at one map unit found no position that avoids it",
    });
  }

  return {
    table: table,
    decisions: decisions,
    poles: poles,
    terrain: terrain,
    deviations: deviations,
    keptSeeds: decisions.filter((d) => d.keptSeed).length,
  };
}

/*
Which term of the tuple the new position won on, in the words the report
uses. The first term that differs is the reason; nothing below it mattered.
*/
function whyBetter(chosen: Quality, seeded: Quality): string {
  const say = (term: string, a: number, b: number) =>
    term + " " + Math.round(b * 100) / 100 + " -> " + Math.round(a * 100) / 100;
  if (chosen.name !== seeded.name) return say("covers a name", chosen.name, seeded.name);
  if (chosen.coast !== seeded.coast) return say("coast legibility", chosen.coast, seeded.coast);
  if (chosen.supplyCentre !== seeded.supplyCentre) {
    return say("covers a supply centre", chosen.supplyCentre, seeded.supplyCentre);
  }
  if (chosen.containment !== seeded.containment) {
    return chosen.containment < seeded.containment ? "now fits inside its province" : "let out over its border";
  }
  if (chosen.ambiguity !== seeded.ambiguity) return say("overhang onto land", chosen.ambiguity, seeded.ambiguity);
  if (chosen.clearance !== seeded.clearance) return say("margin shortfall", chosen.clearance, seeded.clearance);
  return "the hand position broke a hard constraint and could not be kept";
}

/*
Whether each candidate point stands inside one of its own province's coast
strips.

This is the fault RULE A exists for. "stp" owns its outline and every coast
drawn on top of it, so a marker placed anywhere on the north coast strip is
still, as far as containment goes, inside St Petersburg — and v2 duly put the
stp marker three map units from the stp/nc marker, where neither could be
read. Containment cannot see it; only asking the coast shape itself can.

Only a base province can commit it. A coast key standing inside its own strip
is exactly where it belongs.
*/
async function standsOnOwnCoast(
  page: Page,
  family: Map<string, string[]>,
  points: Map<string, Point[]>,
): Promise<Map<string, boolean[]>> {
  const out = new Map<string, boolean[]>();
  const requests: InsideRequest[] = [];
  // One request per (base province, its coast) pair, all in one round trip.
  const pairs: Array<{ owner: string; coast: string }> = [];
  for (const [key, members] of family) {
    const list = points.get(key);
    if (!list || key !== baseKey(key)) continue;
    out.set(key, new Array(list.length).fill(false));
    for (const coast of members) {
      if (coast === baseKey(coast)) continue;
      pairs.push({ owner: key, coast: coast });
      requests.push({
        key: coast,
        centres: list.map((p) => [p.x, p.y]) as Array<[number, number]>,
        radius: 0,
        samples: 0,
      });
    }
  }
  if (requests.length === 0) return out;

  /*
  testInside keys its answer by province, and one province can be asked about
  from several owners, so the batch is run one pair at a time in groups that
  share no key. In practice a family has two or three coasts and this is two
  or three round trips for the whole map.
  */
  const seen = new Set<string>();
  let batch: InsideRequest[] = [];
  let batchPairs: typeof pairs = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const answer = await testInside(page, batch);
    batchPairs.forEach((pair) => {
      const mask = answer[pair.coast] || [];
      const flags = out.get(pair.owner)!;
      for (let i = 0; i < flags.length; i++) if (mask[i]) flags[i] = true;
    });
    batch = [];
    batchPairs = [];
    seen.clear();
  };
  for (let i = 0; i < requests.length; i++) {
    if (seen.has(requests[i].key)) await flush();
    seen.add(requests[i].key);
    batch.push(requests[i]);
    batchPairs.push(pairs[i]);
  }
  await flush();
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

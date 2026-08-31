/*
The placement vocabulary, with no browser in it.

audit.ts owns the measuring, and measuring needs a page: whether a marker is
inside its province is a question only an SVG engine can answer. The SHAPES
that question is asked and answered in — what a placement is, what a map's
geometry looks like, what counts as a violation and how violations are
summarised — need nothing of the sort, and the in-app editor (DESIGN.md ADR-030)
needs exactly those and none of the playwright half.

So they live here, and audit.ts and browser.ts re-export them: the tool's
callers are unchanged, and web/src/mapeditor imports this file directly rather
than keeping a second copy of the vocabulary that would drift from this one.
*/

import type { Point, Rect } from "./geometry.ts";
import { defaultDislodgedPoint } from "./geometry.ts";

export interface ProvinceGeometry {
  key: string;
  /** The union bounding box of every shape the key is drawn with. */
  box: Rect;
  /** The anchor the map ships, or null when it has no <key>Center path. */
  anchor: Point | null;
  /** How many hit shapes the key has; zero means the map cannot draw it. */
  shapes: number;
}

export interface MapGeometry {
  viewBox: Rect;
  provinces: ProvinceGeometry[];
  /** Name labels, one box per word-sized group. */
  labels: Rect[];
  /** Supply centre glyphs, likewise. */
  supplyCentres: Rect[];
  /*
  Whether the map ships its own brief labels. A jDip-converted map carries
  BriefLabelLayer and FullLabelLayer, and the board shows one and hides the
  other rather than drawing anything — so a brief position computed for such a
  map would be a number nothing reads. Their codes are the map author's own
  work and are left where they were put.
  */
  drawsBriefLabels: boolean;
  /** Anchors with no hit shape, and shapes with no anchor. */
  anchorsWithoutShape: string[];
  shapesWithoutAnchor: string[];
  notes: string[];
}

/** What the terrain heuristic, or the server's province list, answers with. */
export type TerrainKind = Record<string, "sea" | "land" | "unknown">;

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
  /*
  Where the three-letter code goes when brief labels are on. Absent on a coast
  key, because the board draws one code per base province; absent on a map the
  tool could not measure a box for. See placeBrief().
  */
  brief?: [number, number];
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

/** How many points of a marker's edge are walked for the inside test. */
export const EDGE_SAMPLES = 24;

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

/*
The one number rounding in a placement file: two decimals.

A placement is written to disk and diffed against what was there before, so it
has to be written the same way every time. Two decimals is finer than any map
in the set can draw and coarse enough that a re-run of the optimizer does not
rewrite every line with float noise.
*/
export function roundUnit(value: number): number {
  return Math.round(value * 100) / 100;
}

/*
The geometry the placement tool reasons with, kept pure so it can be tested
without a browser.

Everything here is in map units — the SVG's own user coordinates — because
that is the space the anchor table is written in and the space the board draws
in. Nothing here knows what a pixel is; markerRadius() is the one bridge, and
it takes the viewport as an argument rather than looking one up.
*/

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  name: string;
  /** The map pane's size in CSS pixels, not the whole window. */
  width: number;
  height: number;
  /** Narrow panes open stepped in; see resetView() in board.ts. */
  narrow: boolean;
}

/*
The two panes the board actually opens in, from app.css: a laptop gives the
map everything left of the 340px side panel, less 8px of padding on each side;
a phone gives it the full width and 58vh of an 844-tall screen.

The laptop pane is the one placement is judged on. It is the view that shows
the whole map at fit zoom — the view a table gathers round — and it is where a
marker is smallest against the map, so an anchor that works there is the
baseline every anchor should meet.

The phone pane is kept as a stress case, not a standard. board.ts opens a
narrow pane stepped in by 1.6, and because a marker is a constant size in
pixels it then covers far MORE map units, not fewer: 29 against the laptop's
18 on the classical map. At that size a marker is wider than Belgium, which is
a fact about phones rather than about anchors, and no table can fix it.
*/
export const LAPTOP_PANE: Viewport = { name: "laptop 1440x900", width: 1440 - 340 - 16, height: 900 - 16, narrow: false };
export const PHONE_PANE: Viewport = { name: "phone 390x844", width: 390, height: Math.round(844 * 0.58), narrow: true };

export const REFERENCE_VIEWPORTS: Viewport[] = [LAPTOP_PANE, PHONE_PANE];

const MAX_ZOOM = 8;

/*
The marker's radius in map units, worked out exactly as board.ts does it:

  fitAllWidth = max(baseW, baseH * paneAspect)      the widest view allowed
  resetView   = that width, stepped in by 1.6 on a narrow pane
  unitsPerPixel = view.w / paneWidth
  r = clamp(12 * unitsPerPixel, 8, 60)

A marker is a constant size on screen, so it covers FEWER map units the
further you zoom in. The view that matters for placement is therefore the one
the board opens at, and the largest radius across the panes it opens in is the
one every anchor has to survive.
*/
export function markerRadius(box: Rect, pane: Viewport): number {
  const fitAll = Math.max(box.w, box.h * (pane.width / pane.height));
  const wanted = pane.narrow ? Math.min(fitAll, box.w) / 1.6 : fitAll;
  const aspect = pane.height / pane.width;
  const widest = fitAll;
  const viewW = Math.min(widest, Math.max(widest / MAX_ZOOM, wanted));
  void aspect;
  return clamp(12 * (viewW / pane.width), 8, 60);
}

/** The radius placement is judged on: the whole map on a laptop. */
export function standardRadius(box: Rect): number {
  return markerRadius(box, LAPTOP_PANE);
}

/** The radius the same table has to survive on a phone. */
export function stressRadius(box: Rect): number {
  return markerRadius(box, PHONE_PANE);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Where the dislodged marker goes by default — board.ts's dislodgedPoint(). */
export function defaultDislodgedPoint(anchor: Point, r: number): Point {
  return { x: anchor.x + r * 1.15, y: anchor.y - r * 1.15 };
}

/*
The dislodged marker is drawn smaller than the unit that threw it out, inside
a ring that is wider than either. The body is what must stay in the province;
the ring is what covers a label.
*/
export const DISLODGED_BODY = 0.82;
export const DISLODGED_RING = 1.45;

// --- overlap --------------------------------------------------------------

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/*
How much of a marker a set of rectangles covers, as a fraction of the marker's
area.

The marker is a disc and the labels are boxes, so the exact area is fiddly and
not worth it: the disc is sampled on a square lattice and the points that land
in a box are counted. At the default step that is a few hundred samples per
marker, which is finer than the decision being made.
*/
export function coveredFraction(centre: Point, radius: number, boxes: Rect[], steps = 15): number {
  if (radius <= 0 || boxes.length === 0) return 0;
  // Only the boxes that could possibly reach the marker are worth testing.
  const near = boxes.filter((box) =>
    rectsOverlap(box, { x: centre.x - radius, y: centre.y - radius, w: radius * 2, h: radius * 2 }),
  );
  if (near.length === 0) return 0;

  let inside = 0;
  let hit = 0;
  const step = (radius * 2) / steps;
  const start = -radius + step / 2;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const dx = start + i * step;
      const dy = start + j * step;
      if (dx * dx + dy * dy > radius * radius) continue;
      inside++;
      const px = centre.x + dx;
      const py = centre.y + dy;
      if (near.some((box) => px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h)) {
        hit++;
      }
    }
  }
  return inside === 0 ? 0 : hit / inside;
}

// --- candidates -----------------------------------------------------------

/*
Where a marker might go instead. Collisions here are only ever with things
that do not move — the province outline, the name, the supply centre glyph —
so each province is solved on its own and there is no global arrangement to
search. A lattice over the province's own bounding box is enough, and the
current anchor goes in first so that "leave it alone" is always on the table.
*/
export function candidatePoints(box: Rect, anchor: Point, r: number, budget = 600): Point[] {
  const points: Point[] = [{ x: anchor.x, y: anchor.y }];
  // Start at half a marker and coarsen until the lattice fits the budget.
  let step = Math.max(r / 2, 1);
  for (;;) {
    const cols = Math.max(1, Math.floor(box.w / step));
    const rows = Math.max(1, Math.floor(box.h / step));
    if (cols * rows <= budget) break;
    step *= 1.35;
  }
  for (let x = box.x + step / 2; x <= box.x + box.w; x += step) {
    for (let y = box.y + step / 2; y <= box.y + box.h; y += step) {
      points.push({ x: x, y: y });
    }
  }
  return points;
}

/*
Where a dislodged marker might go: around its own unit, starting from the
place board.ts already puts it. The first ring is the drawn distance, the
wider ones are for a province where that spot is taken by a name.
*/
export function dislodgedCandidates(anchor: Point, r: number): Point[] {
  const home = defaultDislodgedPoint(anchor, r);
  const points: Point[] = [home];
  const baseAngle = Math.atan2(home.y - anchor.y, home.x - anchor.x);
  const reach = distance(anchor, home);
  for (const scale of [1, 1.25, 1.55]) {
    for (let step = 1; step <= 12; step++) {
      // Out from the default heading in both directions, nearest first.
      for (const side of [1, -1]) {
        const angle = baseAngle + side * step * (Math.PI / 12);
        points.push({
          x: anchor.x + Math.cos(angle) * reach * scale,
          y: anchor.y + Math.sin(angle) * reach * scale,
        });
      }
    }
    points.push({ x: anchor.x + Math.cos(baseAngle) * reach * scale, y: anchor.y + Math.sin(baseAngle) * reach * scale });
  }
  return points;
}

/** The ring of points a marker's edge is tested on. */
export function perimeter(centre: Point, radius: number, samples = 24): Point[] {
  const points: Point[] = [{ x: centre.x, y: centre.y }];
  for (let i = 0; i < samples; i++) {
    const angle = (2 * Math.PI * i) / samples;
    points.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
  }
  return points;
}

// --- scoring --------------------------------------------------------------

export interface Weights {
  /* A marker over a province name is the failure this whole exercise is
     about, so it outweighs everything. */
  name: number;
  /* A marker over a supply centre glyph is usually not a fault at all — see
     the note in cli.ts — so it only breaks ties. */
  supplyCentre: number;
  /** Per marker-radius of distance from the deepest point of the province. */
  centre: number;
}

export const DEFAULT_WEIGHTS: Weights = { name: 1000, supplyCentre: 25, centre: 10 };

export interface Score {
  nameFraction: number;
  scFraction: number;
  /** Distance from the pole, in marker radii. */
  offCentre: number;
  total: number;
}

/*
What one candidate position is worth.

The pull is toward the pole of inaccessibility — the deepest interior point of
the province — not toward the anchor the map happens to ship. Markers that all
sit at the heart of their province read as one system; markers that each sit
wherever they were first put do not. The anchor the map ships is only ever one
more candidate, with no privilege of its own.
*/
export function scorePoint(
  point: Point,
  pole: Point,
  r: number,
  labels: Rect[],
  supplyCentres: Rect[],
  weights: Weights = DEFAULT_WEIGHTS,
): Score {
  const nameFraction = coveredFraction(point, r, labels);
  const scFraction = coveredFraction(point, r, supplyCentres);
  const offCentre = distance(point, pole) / (r || 1);
  return {
    nameFraction: nameFraction,
    scFraction: scFraction,
    offCentre: offCentre,
    total: weights.name * nameFraction + weights.supplyCentre * scFraction + weights.centre * offCentre,
  };
}

/*
A marker only counts as covering something when it covers enough of it to see.
A label whose corner grazes one percent of a marker is not the complaint.
*/
export const COVER_TOLERANCE = 0.01;

export function covers(fraction: number): boolean {
  return fraction > COVER_TOLERANCE;
}

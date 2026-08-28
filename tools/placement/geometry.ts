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

/*
A marker only counts as covering something when it covers enough of it to see.
A label whose corner grazes one percent of a marker is not the complaint, and
treating it as one would send markers scurrying away from nothing.
*/
export const COVER_TOLERANCE = 0.01;

export function covers(fraction: number): boolean {
  return fraction > COVER_TOLERANCE;
}

/*
How good a position is, as a tuple compared in order rather than a single
blended number.

A weighted sum was the first attempt and it was wrong: a small supply centre
overlap weighed 25, drifting a marker's width from the pole weighed 10, so the
optimizer would sit on an overlap a human could clear with one short drag
because moving cost more than the overlap did. Blending lets a preference
outvote a defect. Comparing in order does not: any position that covers less
of a name beats every position that covers more, whatever it costs in
prettiness, and only positions that are equally clean are judged on how near
the middle of their province they sit.

The overlap terms are quantised to one percent before comparison, so two
positions that are equally clean in any way a person could see are treated as
equal and the tidier one wins. Without that, a hundredth of a percent of
difference would decide, and the markers would scatter.
*/
export interface Quality {
  /** Quantised share of the marker covering a province name. */
  name: number;
  /** Quantised share covering a supply centre glyph. */
  supplyCentre: number;
  /** 0 fits with its border margin, 1 overhangs. Lower is better. */
  containment: number;
  /** Share of the overhang falling on a neighbouring LAND province. */
  ambiguity: number;
  /** Distance from the province's pole, in marker radii. Prettiness only. */
  offCentre: number;
}

/* One percent buckets: finer than that is not a thing anyone can see. */
export function level(fraction: number): number {
  return fraction <= COVER_TOLERANCE ? 0 : Math.round(fraction * 100) / 100;
}

export function compareQuality(a: Quality, b: Quality): number {
  return (
    a.name - b.name ||
    a.supplyCentre - b.supplyCentre ||
    a.containment - b.containment ||
    a.ambiguity - b.ambiguity ||
    a.offCentre - b.offCentre
  );
}

/** Nothing a reader would call wrong. */
export function isClean(quality: Quality): boolean {
  return quality.name === 0 && quality.supplyCentre === 0 && quality.containment === 0;
}

/** Clean of the two faults every map agrees on, whatever the SC glyph does. */
export function isPlaced(quality: Quality): boolean {
  return quality.name === 0 && quality.containment === 0;
}

export function qualityAt(
  point: Point,
  pole: Point,
  radius: number,
  labels: Rect[],
  supplyCentres: Rect[],
  containment: number,
  ambiguity = 0,
): Quality {
  return {
    name: level(coveredFraction(point, radius, labels)),
    supplyCentre: level(coveredFraction(point, radius, supplyCentres)),
    containment: containment,
    ambiguity: Math.round(ambiguity * 100) / 100,
    offCentre: distance(point, pole) / (radius || 1),
  };
}

/*
How far a marker may be shrunk to fit a province that will not take a full
one. Below three quarters it stops reading as the same piece as its
neighbours, so that is the floor; a province that still will not take it is
allowed to overhang instead.
*/
export const SCALES = [1, 0.95, 0.9, 0.85, 0.8, 0.75];
export const MIN_SCALE = 0.75;

/*
The overhang rule, used only when no scale fits. The marker's centre must be
inside its own province and at least half a radius from the border, so the
piece still plainly belongs to the province it stands in.
*/
export const OVERHANG_CLEARANCE = 0.5;

/*
The eight neighbours of a point at a given step: the moves a pattern search
tries before it shortens its stride.

This is the part that behaves like a hand. The lattice gets a marker roughly
right; a near miss — a marker whose edge clips a name by a few percent — is
then walked off the name a map unit at a time, which is exactly the small drag
a person makes when they see an amber marker and nudge it clear.
*/
export function neighbours(point: Point, step: number): Point[] {
  const out: Point[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      out.push({ x: point.x + dx * step, y: point.y + dy * step });
    }
  }
  return out;
}

/*
The strides a refinement pass walks, coarse to fine. It ends at half a map
unit, which is finer than any anchor needs to be and finer than a person could
place one by hand.
*/
export function refinementSteps(radius: number): number[] {
  const steps: number[] = [];
  for (let step = Math.max(radius / 4, 2); step >= 0.5; step /= 2) steps.push(step);
  steps.push(0.5);
  return steps;
}

/*
An exhaustive sweep of a province, used to PROVE that a marker left with a
violation had nowhere clean to go. One map unit is finer than the marker is by
a factor of tens, so a clean position that this misses is not a clean position
anyone would find by dragging either.
*/
export function proofGrid(box: Rect, step = 1, budget = 24000): Point[] {
  let use = step;
  while ((box.w / use) * (box.h / use) > budget) use *= 1.5;
  const points: Point[] = [];
  for (let x = box.x + use / 2; x <= box.x + box.w; x += use) {
    for (let y = box.y + use / 2; y <= box.y + box.h; y += use) {
      points.push({ x: x, y: y });
    }
  }
  return points;
}

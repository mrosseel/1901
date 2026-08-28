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

// --- clearance -------------------------------------------------------------

/*
How far a marker's edge is from the nearest thing it must not touch.

Negative means it already overlaps; the depth is reported rather than clamped,
because a marker buried in a name and a marker grazing one are not the same
complaint and the distribution has to show the difference.
*/
export function distanceToRect(point: Point, box: Rect): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.w));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

/** Edge-to-box distance to the nearest of a set. Infinity when the set is empty. */
export function edgeClearance(centre: Point, radius: number, boxes: Rect[]): number {
  let nearest = Infinity;
  for (const box of boxes) {
    const d = distanceToRect(centre, box);
    if (d < nearest) nearest = d;
  }
  return nearest === Infinity ? Infinity : nearest - radius;
}

/*
The threshold rule (RULE B).

The owner's hand-placed markers were measured, and the median margin they keep
from the nearest name or supply centre is the margin every marker is asked
for. Clearing it earns full credit and nothing more: a marker two radii clear
of everything is not better placed than one that clears the threshold, it is
just further from the middle of its province, which is worse. Below the
threshold the penalty rises smoothly, so a marker that cannot make the margin
still prefers the largest margin it can get.

Expressed in radii rather than map units so one measurement carries to a map
drawn at a different scale.
*/
/*
The margin, in marker radii, measured off the owner's hand-corrected classical
table: the median distance from a hand-placed marker's edge to the nearest
name or supply centre box. See the CLEARANCE section of any report, which
re-measures it every run and prints the distribution it came from.

It is a fraction of a radius rather than a count of map units so the same
judgement carries to a map drawn at another scale — sailho's map units are
four times smaller than classical's.

Measured off the owner's classical table it came out slightly NEGATIVE: half
their markers touch the box of a nearby name, which on a map where a unit
stands beside its own province name is not a defect but the normal state. A
negative threshold is therefore meaningful and is kept as measured — it says
how much overlap the owner was content with — rather than being clamped to
zero, which would quietly turn the rule off.
*/
export const MIN_CLEARANCE_RADII = -0.06;

/*
The graded part, in map units.

The scale runs from the wanted margin down to a marker sunk a full radius into
whatever it hits, which is the worst case there is: the centre buried in the
box. Anything at or above the margin scores zero, so a marker with room to
spare gains nothing by finding more.
*/
export function clearancePenalty(clearance: number, wanted: number, radius: number): number {
  if (!isFinite(clearance)) return 0;
  if (clearance >= wanted) return 0;
  const span = Math.max(wanted + radius, radius * 0.25);
  return clamp((wanted - clearance) / span, 0, 2);
}

// --- coasts ----------------------------------------------------------------

/*
The coast rule (RULE A).

"stp/nc" has to read as the north coast of St Petersburg, which means a reader
must be able to tell it apart from "stp" itself and from "stp/sc" at a glance.
v2 put stp/nc three map units from stp — one marker on top of another, and no
way to tell which was which. Two markers of the same family therefore have to
stand at least this far apart, measured in marker radii.

Two and a half radii is a marker's width of clear space between the two edges,
which is the least that reads as two pieces rather than one smudge.
*/
export const COAST_SEPARATION = 2.5;

/*
And the reason it is a constraint and not only a preference.

RULE A ranks coast legibility below name overlap, which on its own would let a
coast marker climb on top of its own base province to get off a label — the
exact fault the rule was written to kill, arrived at by a different route.
"Must be readable as their coast" cannot be enforced by a term that anything
else can outvote, so the separation is applied first as a filter: positions
that make the margin are searched, and the tuple decides among them. Only when
a province offers no such position at all does the search fall back to the
whole set, and the report names it.
*/
export function meetsSeparation(point: Point, family: Point[], radius: number): boolean {
  // Judged on the same quantised figure the score uses, or a marker a third
  // of a map unit short would be treated as a different kind of thing from
  // one that made it, which is a distinction no reader can draw.
  return coastPenalty(separationShortfall(point, family, radius), false) === 0;
}

/*
Legibility first, then everything else.

Used only once the separation filter has come up empty. Ranking by the normal
tuple there lets a position that is clean of names and sitting on top of its
own base province beat one that is readable and grazes a label — which is how
the rule gets defeated by the back door.
*/
export function compareCoastFirst(a: Quality, b: Quality): number {
  return a.coast - b.coast || compareQuality(a, b);
}

/*
How badly a position breaks the coast rule, in [0, 2].

The lower point is the separation shortfall: nothing when the family is far
enough apart, rising towards one when two markers coincide. The whole point is
reserved for a base province's marker standing inside one of its OWN coast
strips — the exact fault stp had, where the province marker sits on the coast
it is meant to be distinguished from. That one is worse than any shortfall,
because moving cannot fix it: the two are in the same place by construction,
so the marker has to leave the strip entirely. The shortfall is therefore
capped just below the point it would otherwise reach, and the two never tie.
*/
export function coastPenalty(separationShortfall: number, onSiblingCoast: boolean): number {
  const shortfall = Math.min(Math.round(clamp(separationShortfall, 0, 1) * 100) / 100, 0.99);
  return shortfall + (onSiblingCoast ? 1 : 0);
}

/** The shortfall of the nearest family member against the wanted separation. */
export function separationShortfall(point: Point, family: Point[], radius: number): number {
  if (family.length === 0) return 0;
  const wanted = COAST_SEPARATION * radius;
  let nearest = Infinity;
  for (const other of family) {
    const d = distance(point, other);
    if (d < nearest) nearest = d;
  }
  if (nearest >= wanted) return 0;
  return (wanted - nearest) / wanted;
}

/** The base province a key belongs to: "stp/nc" → "stp". */
export function baseKey(key: string): string {
  return key.includes("/") ? key.slice(0, key.indexOf("/")) : key;
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
  /** How badly the coast rule is broken, 0 to 2. See coastPenalty(). */
  coast: number;
  /** Quantised share covering a supply centre glyph. */
  supplyCentre: number;
  /** 0 fits with its border margin, 1 overhangs. Lower is better. */
  containment: number;
  /** Share of the overhang falling on a neighbouring LAND province. */
  ambiguity: number;
  /** How far short of the wanted margin this position falls, 0 to 2. */
  clearance: number;
  /** Distance from the province's pole, in marker radii. Prettiness only. */
  offCentre: number;
}

/* One percent buckets: finer than that is not a thing anyone can see. */
export function level(fraction: number): number {
  return fraction <= COVER_TOLERANCE ? 0 : Math.round(fraction * 100) / 100;
}

/*
The order the terms are compared in, and why it is this order.

  name          a covered province name is the one fault every reader hits
  coast         a coast that cannot be told from its own base province stops
                saying which coast it is — worse than sitting on an SC glyph,
                better than hiding a name (owner's ruling, RULE A)
  supplyCentre  normal on a hand-drawn map; see the note in cli.ts
  containment   leaving your own province
  ambiguity     which way an unavoidable overhang leans
  clearance     the measured margin from RULE B: below the threshold this
                grades, at or above it every position scores the same 0
  offCentre     prettiness, and it only ever breaks ties

RULE A's own wording puts coast legibility "above SC-overlap, below
name-overlap", which is what is implemented here. The task's summary line
listed it after containment instead; the two disagree and the rule's own
severity statement was taken as the more specific one.
*/
export function compareQuality(a: Quality, b: Quality): number {
  return (
    a.name - b.name ||
    a.coast - b.coast ||
    a.supplyCentre - b.supplyCentre ||
    a.containment - b.containment ||
    a.ambiguity - b.ambiguity ||
    a.clearance - b.clearance ||
    a.offCentre - b.offCentre
  );
}

/*
Whether one position beats another on something a reader could name.

Every term here is quantised, and prettiness is left out. A hand-placed marker
is only overruled when the new position fixes a fault or makes a measured
margin — never because it sits a few map units nearer the middle of its
province, which is an opinion the tool does not get to have about a placement
a person chose.
*/
export function clearlyBetter(candidate: Quality, held: Quality): boolean {
  /*
  Two terms are read coarsely here and nowhere else.

  The margin is a THRESHOLD, so what counts is whether a position reaches it,
  not how much of the shortfall it shaves: taking 0.70 down to 0.60 is a
  number changing, not a placement improving, and it is no reason to move a
  marker someone put where they wanted it. Supply centre overlap is read in
  tenths for the same reason — three percent of a glyph is not a thing anyone
  can see, and on this map a unit is supposed to stand on its supply centre.
  */
  const meets = (q: Quality) => (q.clearance > 0 ? 1 : 0);
  const glyph = (q: Quality) => Math.round(q.supplyCentre * 10);
  return (
    candidate.name - held.name ||
    candidate.coast - held.coast ||
    glyph(candidate) - glyph(held) ||
    candidate.containment - held.containment ||
    candidate.ambiguity - held.ambiguity ||
    meets(candidate) - meets(held)
  ) < 0;
}

/** Nothing a reader would call wrong. */
export function isClean(quality: Quality): boolean {
  return quality.name === 0 && quality.supplyCentre === 0 && quality.containment === 0;
}

/** Clean of the two faults every map agrees on, whatever the SC glyph does. */
export function isPlaced(quality: Quality): boolean {
  return quality.name === 0 && quality.containment === 0;
}

/*
Everything a position is judged on, in one call.

`wantedClearance` is in map units, already scaled for this marker; `coast` is
worked out by the caller, because it depends on where the rest of the family
ended up and this function knows about one marker only.
*/
export interface QualityInput {
  containment: number;
  ambiguity?: number;
  coast?: number;
  wantedClearance?: number;
}

export function qualityAt(
  point: Point,
  pole: Point,
  radius: number,
  labels: Rect[],
  supplyCentres: Rect[],
  input: QualityInput,
): Quality {
  const wanted = input.wantedClearance === undefined ? 0 : input.wantedClearance;
  const clearance = Math.min(
    edgeClearance(point, radius, labels),
    edgeClearance(point, radius, supplyCentres),
  );
  return {
    name: level(coveredFraction(point, radius, labels)),
    coast: input.coast || 0,
    supplyCentre: level(coveredFraction(point, radius, supplyCentres)),
    containment: input.containment,
    ambiguity: Math.round((input.ambiguity || 0) * 100) / 100,
    clearance: Math.round(clearancePenalty(clearance, wanted, radius) * 50) / 50,
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

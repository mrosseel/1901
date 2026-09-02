/*
The shapes a unit marker is drawn in.

A marker style is presentation, like the map style in style.ts: it changes how
the pieces look and nothing about the game, so it belongs to the person looking
rather than to the table. One player can read shields on a phone while the
projector shows cannons, in the same game, in the same phase.

Every style draws inside the same circle of radius r. That is not a stylistic
choice, it is the contract with the placement table: dipmap fitted the province
names and the supply centre glyphs around a marker of exactly that size, so a
style whose piece spilled past r would land on a name nobody measured against.

Every style is also one filled outline plus an optional dark mark over it. The
board strokes the body in the power's colour to draw a unit and strokes it
empty to preview a build, so a body that needed two elements would break the
build preview.
*/

const SVG_NS = "http://www.w3.org/2000/svg";

export type MarkerStyle = "strategic" | "pretty" | "heraldic" | "ancient";

export const DEFAULT_MARKER_STYLE: MarkerStyle = "strategic";

export interface MarkerStyleInfo {
  name: MarkerStyle;
  title: string;
  description: string;
}

/*
The four, in the order the picker offers them.

Strategic is the default because it is the one a first-time player can read
without being told: a letter says which kind of unit this is, and the two
shapes differ at any size. It is also what Backstabbr draws, so a player
arriving from there is already fluent.

Pretty is the flavour. Players on the vDiplomacy icon thread liked cannons and
ships best for exactly that reason, with one warning worth heeding: a
silhouette gets lost inside a territory of the same colour. So the cannon and
the ship are filled in the power's colour and outlined dark, like every other
piece here.

Heraldic follows webDiplomacy's current client, which draws one shield body for
both kinds and changes the mark inside it. Shields were the best-reviewed army
mark in that thread, and one body with two marks holds its shape down to the
twelve pixels a marker gets at fit-all zoom.

Ancient is the same idea taken to the classical world: a hoplite aspis and a
trireme. It is the one style that belongs to a variant rather than to a taste,
and ancientmediterranean is already among the maps that ship.

Nothing here is anybody else's art. Every drawing below was written for this
file, out of a description of what the other sites draw rather than off their
files, and shares no coordinate with any of them.
*/
export const MARKER_STYLES: MarkerStyleInfo[] = [
  {
    name: "strategic",
    title: "Strategic",
    description: "A circle for an army, a triangle for a fleet, each lettered.",
  },
  {
    name: "pretty",
    title: "Pieces",
    description: "A cannon for an army, a sailing ship for a fleet.",
  },
  {
    name: "heraldic",
    title: "Heraldic",
    description: "A shield for both, starred for an army and anchored for a fleet.",
  },
  {
    name: "ancient",
    title: "Ancient",
    description: "A hoplite shield and spears for an army, a trireme for a fleet.",
  },
];

export function isMarkerStyle(name: string): name is MarkerStyle {
  return MARKER_STYLES.some((one) => one.name === name);
}

export interface Point {
  x: number;
  y: number;
}

/*
The drawings, normalised to a marker of radius 1 centred on the origin, so a
path is scaled and moved rather than rewritten. Nothing here reaches past 1 in
either direction.

There are no arcs. Every number in a path is scaled by the marker radius, and
an arc's two flags are not lengths, so an arc would come out of that pass
meaning something else. The round shapes are quadrant cubics instead, at the
usual 0.5523 handle.

A body is stroked, so every subpath boundary is drawn. Where the parts are
meant to read as separate, they stack rather than cross: the ship's hull, mast
and sails do not touch. Where the seam IS the drawing, they overlap on purpose,
which is how the cannon's barrel sits on its wheel. Everything is wound the
same way, clockwise on screen, so the nonzero fill stays solid across an
overlap instead of punching a hole in it.
*/
const SHIELD =
  "M -0.80 -0.62 Q -0.80 -0.95 -0.47 -0.95 H 0.47 Q 0.80 -0.95 0.80 -0.62 " +
  "V 0.15 Q 0.80 0.62 0.42 0.83 L 0 1.00 L -0.42 0.83 Q -0.80 0.62 -0.80 0.15 Z";

const SHIP =
  // The hull, a shallow trapezoid sitting on the waterline.
  "M -0.97 0.26 L 0.97 0.26 L 0.58 0.90 L -0.58 0.90 Z " +
  // The mast, stopping at the waterline so it never crosses the hull.
  "M -0.07 -0.98 L 0.07 -0.98 L 0.07 0.24 L -0.07 0.24 Z " +
  // Two sails, clear of the mast on either side.
  "M 0.14 -0.78 L 0.84 0.16 L 0.14 0.16 Z " +
  "M -0.14 -0.78 L -0.84 0.16 L -0.14 0.16 Z";

const CANNON =
  // The barrel, breech at the lower left and muzzle raised to the right. It is
  // thick for its length: a gun drawn to scale reads as a stick at twelve
  // pixels, and none of the other pieces here are that thin either.
  "M -0.69 0.02 L 0.71 -0.64 L 0.89 -0.24 L -0.51 0.42 Z " +
  // The wheel, a disc rather than a ring so it survives the shrink. The barrel
  // crosses it, which is what makes the two read as one gun.
  "M 0.16 -0.02 C 0.39 -0.02 0.58 0.17 0.58 0.40 C 0.58 0.63 0.39 0.82 0.16 0.82 " +
  "C -0.07 0.82 -0.26 0.63 -0.26 0.40 C -0.26 0.17 -0.07 -0.02 0.16 -0.02 Z " +
  // The trail, running back from the breech to the ground.
  "M -0.50 0.26 L -0.24 0.40 L -0.52 0.84 L -0.80 0.84 Z";

/*
The phalanx, as the aspis and the spears behind it.

A Corinthian helmet is the obvious drawing and it does not survive. The board
outlines a piece at a sixth of its radius, so the eye slot, the nose guard and
the crest are all thinner than the line drawn round them, and the helmet
closes up into a blob somewhere above the size it is actually read at.

Crossed spears are the next thing to try and they are worse than wrong: an X
over a disc is what the board already draws over a unit being disbanded, so
half the army markers on an adjustment board would read as ordered away.

One spear held behind the shield has neither problem. Nothing in it is thinner
than the outline, and the head above the rim and the butt below it break the
circle so it is never the strategic army. It is set left of centre, because a
spear through the middle of a disc reads as a sign rather than a soldier.
*/
const PHALANX =
  // The spear, listed before the shield so the shield's outline closes over
  // it and the two read as one behind the other.
  "M -0.46 -0.98 L -0.20 -0.52 L -0.72 -0.52 Z " +
  "M -0.59 -0.54 L -0.33 -0.54 L -0.33 0.92 L -0.59 0.92 Z " +
  // The aspis, set right of the anchor by as much as the spear stands left of
  // it, so the piece as a whole still balances on the point the table measured.
  "M 0.10 -0.60 C 0.43 -0.60 0.70 -0.33 0.70 0 C 0.70 0.33 0.43 0.60 0.10 0.60 " +
  "C -0.23 0.60 -0.50 0.33 -0.50 0 C -0.50 -0.33 -0.23 -0.60 0.10 -0.60 Z";

/*
The trireme, told by the three things nothing else has: the ram at the
waterline, the stern post curling back over the deck, and the oars.
*/
const TRIREME =
  // The hull, ram forward and at the waterline.
  "M -0.98 0.12 L -0.42 -0.12 L 0.56 -0.12 L 0.44 0.42 L -0.52 0.42 Z " +
  // The stern post, curling back over the deck. It runs into the hull rather
  // than sitting beside it, which is what makes the two read as one ship.
  "M 0.44 -0.16 C 0.66 -0.24 0.74 -0.44 0.72 -0.74 L 0.96 -0.70 " +
  "C 0.98 -0.32 0.86 -0.06 0.60 0.02 Z " +
  // Two oars, well apart and as wide as the outline that will be drawn round
  // them. Three thinner ones ran together into one dark wedge.
  "M -0.44 0.46 L -0.18 0.46 L -0.44 0.88 L -0.70 0.88 Z " +
  "M 0.06 0.46 L 0.32 0.46 L 0.06 0.88 L -0.20 0.88 Z";

const STAR =
  "M 0 -0.62 L 0.15 -0.19 L 0.59 -0.19 L 0.24 0.08 L 0.37 0.51 " +
  "L 0 0.24 L -0.37 0.51 L -0.24 0.08 L -0.59 -0.19 L -0.15 -0.19 Z";

const ANCHOR =
  // The ring at the head.
  "M 0 -0.84 C 0.09 -0.84 0.16 -0.77 0.16 -0.68 C 0.16 -0.59 0.09 -0.52 0 -0.52 " +
  "C -0.09 -0.52 -0.16 -0.59 -0.16 -0.68 C -0.16 -0.77 -0.09 -0.84 0 -0.84 Z " +
  // The stock, across the shank.
  "M -0.46 -0.44 L 0.46 -0.44 L 0.46 -0.30 L -0.46 -0.30 Z " +
  // The shank, from the head down into the crown.
  "M -0.08 -0.60 L 0.08 -0.60 L 0.08 0.58 L -0.08 0.58 Z " +
  // The flukes, a crescent under the crown.
  "M 0.62 0.06 Q 0.62 0.60 0 0.66 Q -0.62 0.60 -0.62 0.06 " +
  "L -0.44 0.14 Q -0.40 0.46 0 0.50 Q 0.40 0.46 0.44 0.14 Z";

/*
One drawing, moved to a province and sized to its marker.

Two decimals is what the map art is stored at (ADR-037), and a path written to
more would be longer than the art it sits on for nothing anybody can see.
*/
function placed(drawing: string, at: Point, r: number): SVGPathElement {
  const node = document.createElementNS(SVG_NS, "path");
  node.setAttribute(
    "d",
    drawing.replace(/-?\d*\.?\d+/g, (number) => trim(parseFloat(number) * r)),
  );
  node.setAttribute("transform", "translate(" + trim(at.x) + " " + trim(at.y) + ")");
  return node;
}

function trim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/*
The strategic fleet, balanced on its anchor.

The old triangle ran from 1.1r above the anchor to 0.75r below it, which put
its centre of area a seventh of a radius low and its bounding box a fifth of a
radius high: it sat on neither. An apex twice as far out as the base puts the
centroid exactly on the anchor, which is the point the placement table
measured, and it is also where the letter then belongs with no nudge.
*/
const FLEET_APEX = 1.34;
const FLEET_BASE = 0.67;

function triangle(at: Point, r: number): SVGPolygonElement {
  const node = document.createElementNS(SVG_NS, "polygon");
  node.setAttribute(
    "points",
    [
      trim(at.x) + "," + trim(at.y - r * FLEET_APEX),
      trim(at.x + r) + "," + trim(at.y + r * FLEET_BASE),
      trim(at.x - r) + "," + trim(at.y + r * FLEET_BASE),
    ].join(" "),
  );
  return node;
}

/*
The piece itself: one element the board fills with the power's colour and
outlines dark, or outlines alone to show a build that has not happened yet.
*/
export function markerBody(
  style: MarkerStyle,
  at: Point,
  r: number,
  isFleet: boolean,
): SVGElement {
  if (style === "pretty") return placed(isFleet ? SHIP : CANNON, at, r);
  if (style === "ancient") return placed(isFleet ? TRIREME : PHALANX, at, r);
  if (style === "heraldic") return placed(SHIELD, at, r);
  if (isFleet) return triangle(at, r);
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", trim(at.x));
  circle.setAttribute("cy", trim(at.y));
  circle.setAttribute("r", trim(r));
  return circle;
}

/* How much of the shield a mark inside it may take, and how far up it sits.
   A shield carries its weight at the top, so a mark centred on the marker's
   own anchor reads low inside one. */
const MARK_SCALE = 0.66;
const MARK_RISE = 0.08;

/*
What is drawn dark over the piece to say which kind of unit it is, or null
where the piece already says so. The cannon, the ship, the aspis and the
trireme are the statement; putting a letter on them would be saying it twice.
*/
export function markerMark(
  style: MarkerStyle,
  at: Point,
  r: number,
  isFleet: boolean,
): SVGElement | null {
  if (style === "pretty" || style === "ancient") return null;
  if (style === "heraldic") {
    const mark = placed(
      isFleet ? ANCHOR : STAR,
      { x: at.x, y: at.y - r * MARK_RISE },
      r * MARK_SCALE,
    );
    mark.setAttribute("class", "unit-mark");
    return mark;
  }
  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("x", trim(at.x));
  label.setAttribute("y", trim(at.y));
  // A letter in a triangle has the width of the triangle at its own height to
  // live in, which is narrower than a circle's.
  label.setAttribute("font-size", trim(r * (isFleet ? 0.95 : 1.1)));
  label.setAttribute("class", "unit-label");
  label.textContent = isFleet ? "F" : "A";
  return label;
}

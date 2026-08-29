/*
How big an order graphic is drawn, and how it fits the span it has.

The unit markers already hold one size on screen however far the map is
zoomed: markerRadius() turns a fixed number of screen pixels into map units
every frame. Every order graphic is measured off that same radius, so its
strokes, heads and rings hold their size on screen too.

What does NOT hold its size is the one measurement an arrow cannot choose: the
distance between two provinces. That is fixed in map units, so on screen it
shrinks as the map is zoomed out while the radius does not. A move between two
provinces that touch — Paris to Burgundy — then spends its whole span on the
clearance around the two markers and has nothing left to draw an arrow with.
Zoomed in it is an arrow; zoomed out it is a sliver, and the stroke width was
never the reason.

fitEnds is the fix: the clearances are a wish, not a promise. A span too short
to grant them keeps a fixed share of itself for the body, and the two ends give
up the rest in proportion. fitHead then stops the arrowhead outgrowing the body
it caps — a head longer than its own arrow turns the polygon inside out, which
is what the sliver actually was.

The two clamps below are the other half. markerRadius() has a floor in map
units and a ceiling as a fraction of the map, and where either binds the radius
stops tracking the zoom. Orders drawn straight off it would then stop tracking
too — invisible on one map, clownish at full zoom on another — so the order
graphics take the radius back into screen pixels and hold it between a floor
and a ceiling of their own.
*/

/** The share of a span that stays as drawn arrow, however short the span. */
export const MIN_BODY = 0.5;

/** The most of its own body an arrowhead may take. */
export const HEAD_BODY = 0.72;

/** How narrow a shortened head may get, as a share of its full width. */
export const HEAD_MIN_WIDTH = 0.5;

/* The radius the order graphics are drawn at, in screen pixels. The markers
   aim for 12; orders may run a little either side of that but no further. */
export const ORDER_RADIUS_MIN_PX = 9;
export const ORDER_RADIUS_MAX_PX = 20;

/* An order's stroke, in screen pixels. Below the floor a line stops reading as
   a line; above the ceiling it stops reading as anything but a blob. */
export const ORDER_STROKE_MIN_PX = 2.2;
export const ORDER_STROKE_MAX_PX = 7;

/** The stroke an order is drawn with, as a share of the radius. */
export const STROKE_OF_RADIUS = 0.3;

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

/** What is left of a span once both ends have taken their clearance. */
export interface Ends {
  /** How far in from the start the drawing begins. */
  start: number;
  /** How far back from the end it stops. */
  end: number;
  /** The length actually drawn. Never less than minBody of the span. */
  body: number;
}

/*
Both clearances, trimmed until the body is worth drawing.

They are trimmed in proportion, so the drawing stays centred the way the full
clearances would have put it: an arrow that gave up a third of its head room
gave up a third of its tail room too. The tail then starts inside its own unit
marker, which is drawn over the orders and hides it — the right end to lose,
since the marker already says where the order begins.
*/
export function fitEnds(
  distance: number,
  startClear: number,
  endClear: number,
  minBody = MIN_BODY,
): Ends {
  const span = Math.max(0, distance);
  const start = Math.max(0, startClear);
  const end = Math.max(0, endClear);
  const wanted = start + end;
  if (wanted === 0) return { start: 0, end: 0, body: span };
  const room = span * (1 - clamp(minBody, 0, 0.95));
  const keep = Math.min(1, room / wanted);
  return { start: start * keep, end: end * keep, body: span - wanted * keep };
}

/** An arrowhead and its half-width, kept inside the body it caps. */
export interface Head {
  length: number;
  half: number;
}

/*
The head, never longer than HEAD_BODY of the arrow it ends.

The length is capped outright, because a head longer than its arrow inverts the
outline. The width follows it down so the head keeps its shape rather than
fanning out, but only so far: past HEAD_MIN_WIDTH a head is thinner than the
shaft it sits on and the arrow stops pointing anywhere.
*/
export function fitHead(body: number, length: number, half: number): Head {
  const room = Math.max(0, body) * HEAD_BODY;
  if (length <= 0) return { length: 0, half: 0 };
  if (length <= room) return { length: length, half: half };
  const shrunk = room / length;
  return { length: room, half: half * Math.max(shrunk, HEAD_MIN_WIDTH) };
}

/*
The radius order graphics are drawn at.

It is the marker radius held between a floor and a ceiling in screen pixels, so
an order keeps its size even where markerRadius() has hit one of its own limits
and stopped following the zoom.
*/
export function orderRadius(markerRadius: number, unitsPerPixel: number): number {
  if (!(unitsPerPixel > 0)) return markerRadius;
  return clamp(
    markerRadius,
    ORDER_RADIUS_MIN_PX * unitsPerPixel,
    ORDER_RADIUS_MAX_PX * unitsPerPixel,
  );
}

/** The stroke one order is drawn with, in map units. */
export function orderStroke(radius: number, unitsPerPixel: number): number {
  const wanted = radius * STROKE_OF_RADIUS;
  if (!(unitsPerPixel > 0)) return wanted;
  return clamp(wanted, ORDER_STROKE_MIN_PX * unitsPerPixel, ORDER_STROKE_MAX_PX * unitsPerPixel);
}

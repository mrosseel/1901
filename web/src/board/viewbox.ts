/*
The pan-and-zoom arithmetic, on its own.

Both things that show a map need it: the board, which also takes orders, and
the gallery lightbox, which does nothing but let you look. The rules are the
same in both — move the SVG's viewBox and transform nothing, so hit testing,
getBBox and every anchor stay in map coordinates — and the rules are fiddly
enough (clamp the width to the zoom range, keep the box over the map, hold the
point under the cursor still while zooming) that two copies would drift.

Everything here is a pure function of a base box, the container's rectangle
and the current view. No element is touched and no state is kept, so each
caller keeps its own view and its own gestures: the board's are entangled with
ordering, the lightbox's are three lines.
*/

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How much closer than "fit all" a view may go. */
export const MAX_ZOOM = 8;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The width of the view that just fits the whole map into the container. */
export function fitAllWidth(base: Box, rect: DOMRect): number {
  if (!rect.width || !rect.height) return base.w;
  return Math.max(base.w, base.h * (rect.width / rect.height));
}

/*
A view's size from the width it wants.

The height always follows the container's shape, so the map is never
stretched, and the width is held between "fit all" and MAX_ZOOM times closer.
*/
export function clampedSize(
  base: Box,
  rect: DOMRect,
  wantedWidth: number,
  maxZoom = MAX_ZOOM,
): { w: number; h: number } {
  const aspect = rect.width && rect.height ? rect.height / rect.width : base.h / base.w;
  const widest = fitAllWidth(base, rect);
  const w = Math.min(widest, Math.max(widest / maxZoom, wantedWidth));
  return { w: w, h: w * aspect };
}

/*
A box of that size, put at (x, y) but kept over the map.

On an axis where the view is larger than the map there is nothing to pan
along, so it is centred instead; that is what stops a map from drifting off
into the corner of a wide window.
*/
export function placeView(base: Box, size: { w: number; h: number }, x: number, y: number): Box {
  return {
    w: size.w,
    h: size.h,
    x: size.w >= base.w ? base.x + (base.w - size.w) / 2 : clamp(x, base.x, base.x + base.w - size.w),
    y: size.h >= base.h ? base.y + (base.h - size.h) / 2 : clamp(y, base.y, base.y + base.h - size.h),
  };
}

/** The view of the given width, centred on the map. */
export function centredView(base: Box, rect: DOMRect, wantedWidth: number, maxZoom = MAX_ZOOM): Box {
  const size = clampedSize(base, rect, wantedWidth, maxZoom);
  return placeView(
    base,
    size,
    base.x + base.w / 2 - size.w / 2,
    base.y + base.h / 2 - size.h / 2,
  );
}

/** Client coordinates to map coordinates. */
export function toMapPoint(view: Box, rect: DOMRect, clientX: number, clientY: number): Point {
  return {
    x: view.x + ((clientX - rect.left) / rect.width) * view.w,
    y: view.y + ((clientY - rect.top) / rect.height) * view.h,
  };
}

/*
Zoomed by `factor`, with the map point under (clientX, clientY) left where it
is. That is what makes a wheel or a pinch feel like the map is being pulled
rather than replaced.
*/
export function zoomedView(
  base: Box,
  rect: DOMRect,
  view: Box,
  clientX: number,
  clientY: number,
  factor: number,
  maxZoom = MAX_ZOOM,
): Box {
  const anchor = toMapPoint(view, rect, clientX, clientY);
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  const size = clampedSize(base, rect, view.w / factor, maxZoom);
  return placeView(base, size, anchor.x - fx * size.w, anchor.y - fy * size.h);
}

/** Panned by a screen-pixel delta, at the current zoom. */
export function pannedView(base: Box, rect: DOMRect, view: Box, dxPixels: number, dyPixels: number): Box {
  const dx = (dxPixels / rect.width) * view.w;
  const dy = (dyPixels / rect.height) * view.h;
  return placeView(base, { w: view.w, h: view.h }, view.x - dx, view.y - dy);
}

/** How far in the view is, as a multiple of "fit all". */
export function zoomLevel(base: Box, rect: DOMRect, view: Box): number {
  return fitAllWidth(base, rect) / view.w;
}

/** The map's own box, read off its viewBox attribute. */
export function baseBoxOf(svg: SVGSVGElement, fallback: Box): Box {
  const parts = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((one) => !Number.isFinite(one)) || !parts[2] || !parts[3]) {
    return fallback;
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

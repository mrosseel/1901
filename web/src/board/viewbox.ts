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

The one exception is at the bottom: the wheel accumulator, the inertia tracker
and the ramp runner keep the little bit of state a gesture needs over time.
They still touch no element — they hand a caller numbers and let it decide what
to move — and they take their clock and their scheduler as arguments, so the
tests drive them without a browser.
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

/** A view part-way between two others, for an eased transition. */
export function interpolateView(from: Box, to: Box, progress: number): Box {
  const t = clamp(progress, 0, 1);
  const mix = (a: number, b: number) => a + (b - a) * t;
  return { x: mix(from.x, to.x), y: mix(from.y, to.y), w: mix(from.w, to.w), h: mix(from.h, to.h) };
}

// --- Wheels -----------------------------------------------------------------

/*
A wheel notch, in CSS pixels.

deltaY is only in pixels when deltaMode is 0. Firefox reports lines (mode 1) at
about 3 per notch, and a page-mode wheel (mode 2) means a screenful. Reading
deltaY raw therefore zooms about 1.0045x per notch in Firefox, which is why
wheel zoom looked dead there. There is no way to ask the browser how tall a
line is, so 20 px is the figure every map library settled on.
*/
export const WHEEL_LINE_PX = 20;
/** How fast the wheel zooms, per normalised pixel. */
export const WHEEL_ZOOM_RATE = 0.0015;
/** How long deltas are gathered before one zoom step is applied. */
export const WHEEL_WINDOW_MS = 40;

export function wheelPixels(deltaY: number, deltaMode: number, viewportHeight: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * (viewportHeight || WHEEL_LINE_PX);
  return deltaY;
}

/** The zoom factor a run of normalised wheel pixels asks for. */
export function wheelZoomFactor(deltaPixels: number): number {
  return Math.exp(-deltaPixels * WHEEL_ZOOM_RATE);
}

export interface WheelStep {
  factor: number;
  clientX: number;
  clientY: number;
}

export interface WheelLike {
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
}

export interface WheelAccumulator {
  push(event: WheelLike, viewportHeight: number): void;
  cancel(): void;
}

/** Cancels a scheduled run. */
export type Cancel = () => void;
export type Scheduler = (run: () => void) => Cancel;

const timerScheduler: Scheduler = (run) => {
  const id = setTimeout(run, WHEEL_WINDOW_MS);
  return () => clearTimeout(id);
};

/*
One zoom step per window of wheel events.

A trackpad emits dozens of wheel events for one flick, and each one used to run
a viewBox write and a full overlay render. Summing the deltas and applying
their product once per window costs one render instead, and because the factors
are exponential the sum is exactly the zoom the separate events would have
reached. The anchor is the last pointer position in the window, which is where
the pointer actually is when the step lands.
*/
export function createWheelAccumulator(
  apply: (step: WheelStep) => void,
  schedule: Scheduler = timerScheduler,
): WheelAccumulator {
  let pixels = 0;
  let at: Point = { x: 0, y: 0 };
  let pending: Cancel | null = null;

  const flush = () => {
    pending = null;
    const total = pixels;
    pixels = 0;
    if (total === 0) return;
    apply({ factor: wheelZoomFactor(total), clientX: at.x, clientY: at.y });
  };

  return {
    push(event, viewportHeight) {
      pixels += wheelPixels(event.deltaY, event.deltaMode, viewportHeight);
      at = { x: event.clientX, y: event.clientY };
      if (!pending) pending = schedule(flush);
    },
    cancel() {
      if (pending) pending();
      pending = null;
      pixels = 0;
    },
  };
}

// --- Inertia ----------------------------------------------------------------

/** How many pointermove samples a velocity is read from. */
export const INERTIA_SAMPLES = 3;
/** A release older than this was a stop, not a throw. */
export const INERTIA_MAX_AGE_MS = 50;
/** Below this speed, in pixels per millisecond, a release does not coast. */
export const INERTIA_MIN_SPEED = 0.08;
/** How long a coast takes to come to rest. */
export const INERTIA_DECAY_MS = 250;

export interface Sample extends Point {
  t: number;
}

/** The sample list with a new one on the end, oldest dropped. */
export function trackSample(samples: Sample[], sample: Sample): Sample[] {
  return [...samples, sample].slice(-INERTIA_SAMPLES);
}

/*
The velocity a release should coast at, or null if it should not coast.

Two guards keep a tap from throwing the map: the newest sample must be recent —
a finger that came to rest before lifting has a stale one — and the speed must
clear a floor, because the pixel or two of jitter inside the tap slop would
otherwise register as a very slow throw.
*/
export function inertiaVelocity(samples: Sample[], now: number): Point | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  if (now - last.t > INERTIA_MAX_AGE_MS) return null;
  const first = samples[0];
  const span = last.t - first.t;
  if (span <= 0) return null;
  const velocity = { x: (last.x - first.x) / span, y: (last.y - first.y) / span };
  if (Math.hypot(velocity.x, velocity.y) < INERTIA_MIN_SPEED) return null;
  return velocity;
}

/*
How far a coast has travelled after `elapsed` milliseconds.

The curve is ease-out quadratic, whose slope at zero is 2 * distance /
duration; matching that to the release velocity fixes the distance at half of
velocity * duration, so the map leaves the finger at exactly the speed the
finger had and stops dead at the end.
*/
export function inertiaOffset(
  velocity: Point,
  elapsed: number,
  duration = INERTIA_DECAY_MS,
): Point {
  const t = clamp(elapsed / duration, 0, 1);
  const eased = 1 - (1 - t) * (1 - t);
  return { x: (velocity.x * duration * eased) / 2, y: (velocity.y * duration * eased) / 2 };
}

// --- Ramps ------------------------------------------------------------------

export function easeOutCubic(t: number): number {
  const p = clamp(t, 0, 1);
  return 1 - (1 - p) * (1 - p) * (1 - p);
}

/** How long an eased zoom takes. */
export const ZOOM_EASE_MS = 200;

/** True when the player has asked for less movement; then nothing is animated. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/*
Runs `step` once per frame with the elapsed time, until it is cancelled or it
returns false. The board and the lightbox both animate through this, so a
gesture that starts a new animation can cancel the old one the same way.
*/
export function runFrames(step: (elapsed: number) => boolean): Cancel {
  if (typeof requestAnimationFrame !== "function") {
    step(Number.POSITIVE_INFINITY);
    return () => {};
  }
  const start = performance.now();
  let frame = requestAnimationFrame(function tick(now) {
    if (step(now - start)) frame = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(frame);
}

/** The map's own box, read off its viewBox attribute. */
export function baseBoxOf(svg: SVGSVGElement, fallback: Box): Box {
  const parts = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((one) => !Number.isFinite(one)) || !parts[2] || !parts[3]) {
    return fallback;
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

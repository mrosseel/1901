import { describe, expect, it } from "vitest";
import {
  INERTIA_DECAY_MS,
  INERTIA_MAX_AGE_MS,
  INERTIA_MIN_SPEED,
  MAX_ZOOM,
  WHEEL_LINE_PX,
  baseBoxOf,
  centredView,
  clampedSize,
  createWheelAccumulator,
  easeOutCubic,
  fitAllWidth,
  inertiaOffset,
  inertiaVelocity,
  interpolateView,
  pannedView,
  placeView,
  toMapPoint,
  trackSample,
  wheelPixels,
  wheelZoomFactor,
  zoomedView,
  type Box,
  type Sample,
  type WheelStep,
} from "./viewbox";

/* A square map in a landscape window: the shape that makes every clamp show
   its work, because "fit all" is wider than the map itself. */
const MAP: Box = { x: 0, y: 0, w: 1000, h: 1000 };
const WIDE = { left: 0, top: 0, width: 800, height: 400 } as DOMRect;
const SQUARE = { left: 0, top: 0, width: 600, height: 600 } as DOMRect;

describe("fitting a map into a container", () => {
  it("widens the view rather than stretching the map", () => {
    expect(fitAllWidth(MAP, WIDE)).toBe(2000);
    expect(fitAllWidth(MAP, SQUARE)).toBe(1000);
  });

  it("falls back to the map's own width when the container has no size", () => {
    expect(fitAllWidth(MAP, { left: 0, top: 0, width: 0, height: 0 } as DOMRect)).toBe(1000);
  });

  it("keeps the view between fit-all and the zoom ceiling", () => {
    expect(clampedSize(MAP, SQUARE, 5000).w).toBe(1000);
    expect(clampedSize(MAP, SQUARE, 1).w).toBe(1000 / MAX_ZOOM);
    // The height follows the container's shape, so nothing is ever squashed.
    expect(clampedSize(MAP, WIDE, 2000)).toEqual({ w: 2000, h: 1000 });
  });
});

describe("keeping the view over the map", () => {
  it("clamps a box that would slide off the edge", () => {
    const box = placeView(MAP, { w: 400, h: 400 }, -50, 900);
    expect(box.x).toBe(0);
    expect(box.y).toBe(600);
  });

  it("centres on an axis where the view is bigger than the map", () => {
    // This is what stops a map from drifting into the corner of a wide window.
    const box = placeView(MAP, { w: 2000, h: 1000 }, 0, 0);
    expect(box.x).toBe(-500);
    expect(box.y).toBe(0);
  });

  it("centres the whole map when asked for the widest view", () => {
    expect(centredView(MAP, WIDE, 2000)).toEqual({ x: -500, y: 0, w: 2000, h: 1000 });
  });
});

describe("zooming and panning", () => {
  const view: Box = { x: 0, y: 0, w: 1000, h: 1000 };

  it("holds the point under the cursor still", () => {
    // The middle of the container is the middle of the map before and after.
    const zoomed = zoomedView(MAP, SQUARE, view, 300, 300, 2);
    expect(zoomed.w).toBe(500);
    expect(toMapPoint(zoomed, SQUARE, 300, 300)).toEqual({ x: 500, y: 500 });
  });

  it("cannot be zoomed past the ceiling, however hard it is pushed", () => {
    let box = view;
    for (let i = 0; i < 20; i++) box = zoomedView(MAP, SQUARE, box, 300, 300, 2);
    expect(box.w).toBeCloseTo(1000 / MAX_ZOOM, 6);
  });

  it("pans by screen pixels, at the current zoom", () => {
    const close = clampedSize(MAP, SQUARE, 500);
    const start = placeView(MAP, close, 250, 250);
    // Dragging right moves the view left over the map, by the same distance
    // on screen as under the finger.
    const moved = pannedView(MAP, SQUARE, start, 60, 0);
    expect(moved.x).toBeCloseTo(250 - (60 / 600) * 500, 6);
    expect(moved.y).toBe(start.y);
  });

  it("will not pan off the map", () => {
    const close = placeView(MAP, clampedSize(MAP, SQUARE, 500), 0, 0);
    expect(pannedView(MAP, SQUARE, close, 400, 400).x).toBe(0);
  });
});

describe("reading a wheel", () => {
  it("normalises every delta mode to pixels", () => {
    const table: [number, number, number][] = [
      // deltaY, deltaMode, expected pixels
      [100, 0, 100],
      [-100, 0, -100],
      [3, 1, 3 * WHEEL_LINE_PX],
      [-3, 1, -3 * WHEEL_LINE_PX],
      [1, 2, 800],
      [-2, 2, -1600],
    ];
    for (const [deltaY, deltaMode, expected] of table) {
      expect(wheelPixels(deltaY, deltaMode, 800)).toBe(expected);
    }
  });

  it("makes a Firefox line-mode notch zoom as much as a pixel-mode one", () => {
    // The bug: three raw lines zoomed 1.0045x, which read as nothing at all.
    expect(wheelZoomFactor(-3)).toBeCloseTo(1.0045, 4);
    const lines = wheelZoomFactor(wheelPixels(-3, 1, 800));
    const pixels = wheelZoomFactor(wheelPixels(-60, 0, 800));
    expect(lines).toBeCloseTo(pixels, 10);
    expect(lines).toBeGreaterThan(1.09);
  });
});

describe("gathering wheel deltas", () => {
  /* A hand-run scheduler, so a window can be closed exactly when the test says
     so rather than when a timer feels like it. */
  const manual = () => {
    let queued: (() => void) | null = null;
    return {
      schedule: (run: () => void) => {
        queued = run;
        return () => {
          queued = null;
        };
      },
      fire: () => {
        const run = queued;
        queued = null;
        run?.();
      },
      pending: () => queued !== null,
    };
  };

  it("applies one step for a flood of events, worth all of them", () => {
    const clock = manual();
    const steps: WheelStep[] = [];
    const wheel = createWheelAccumulator((step) => steps.push(step), clock.schedule);
    for (let i = 0; i < 20; i++) wheel.push({ deltaY: -5, deltaMode: 0, clientX: i, clientY: 0 }, 800);
    expect(steps).toHaveLength(0);
    clock.fire();
    expect(steps).toHaveLength(1);
    expect(steps[0].factor).toBeCloseTo(wheelZoomFactor(-100), 12);
    // The anchor is where the pointer ended the window, not where it started.
    expect(steps[0].clientX).toBe(19);
  });

  it("opens a new window after the last one closed", () => {
    const clock = manual();
    const steps: WheelStep[] = [];
    const wheel = createWheelAccumulator((step) => steps.push(step), clock.schedule);
    wheel.push({ deltaY: -10, deltaMode: 0, clientX: 0, clientY: 0 }, 800);
    clock.fire();
    wheel.push({ deltaY: -10, deltaMode: 0, clientX: 0, clientY: 0 }, 800);
    expect(clock.pending()).toBe(true);
    clock.fire();
    expect(steps).toHaveLength(2);
    expect(steps[1].factor).toBeCloseTo(steps[0].factor, 12);
  });

  it("drops what it has gathered when cancelled", () => {
    const clock = manual();
    const steps: WheelStep[] = [];
    const wheel = createWheelAccumulator((step) => steps.push(step), clock.schedule);
    wheel.push({ deltaY: -10, deltaMode: 0, clientX: 0, clientY: 0 }, 800);
    wheel.cancel();
    clock.fire();
    expect(steps).toHaveLength(0);
  });
});

describe("throwing the map", () => {
  const throwOf = (speed: number, ended = 0): Sample[] => [
    { x: 0, y: 0, t: 0 },
    { x: speed * 10, y: 0, t: 10 },
    { x: speed * 20, y: 0, t: 20 + ended },
  ];

  it("keeps only the last three samples", () => {
    let samples: Sample[] = [];
    for (let i = 0; i < 6; i++) samples = trackSample(samples, { x: i, y: 0, t: i });
    expect(samples.map((one) => one.x)).toEqual([3, 4, 5]);
  });

  it("reads a velocity from a fast release", () => {
    const velocity = inertiaVelocity(throwOf(2), 20);
    expect(velocity).not.toBeNull();
    expect(velocity!.x).toBeCloseTo(2, 6);
  });

  it("does not throw after a tap", () => {
    // Nothing moved: no velocity, so a tap can never start a coast.
    expect(inertiaVelocity([{ x: 5, y: 5, t: 0 }], 0)).toBeNull();
    expect(inertiaVelocity(throwOf(0), 20)).toBeNull();
    // A crawl under the floor is jitter inside the tap slop, not a throw.
    expect(inertiaVelocity(throwOf(INERTIA_MIN_SPEED / 2), 20)).toBeNull();
    // A finger that came to rest before lifting has a stale newest sample.
    expect(inertiaVelocity(throwOf(2), 20 + INERTIA_MAX_AGE_MS + 1)).toBeNull();
  });

  it("leaves at the release speed and comes to a full stop", () => {
    const velocity = { x: 2, y: -1 };
    expect(inertiaOffset(velocity, 0).x).toBe(0);
    expect(inertiaOffset(velocity, 0).y).toBeCloseTo(0, 12);
    // The slope at zero is the release velocity, to a millisecond's accuracy.
    expect(inertiaOffset(velocity, 1).x).toBeCloseTo(2, 1);
    const rest = inertiaOffset(velocity, INERTIA_DECAY_MS);
    expect(rest.x).toBeCloseTo((2 * INERTIA_DECAY_MS) / 2, 6);
    // Past the end it stops dead rather than drifting on.
    expect(inertiaOffset(velocity, INERTIA_DECAY_MS * 10)).toEqual(rest);
  });

  it("cannot coast the view off the map", () => {
    const close = placeView(MAP, clampedSize(MAP, SQUARE, 500), 0, 0);
    let box = close;
    let carried = { x: 0, y: 0 };
    const velocity = { x: 8, y: 8 };
    for (let ms = 0; ms <= INERTIA_DECAY_MS; ms += 16) {
      const offset = inertiaOffset(velocity, ms);
      box = pannedView(MAP, SQUARE, box, offset.x - carried.x, offset.y - carried.y);
      carried = offset;
    }
    // The same clamp as a live pan: hard against the map's top-left corner.
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
  });
});

describe("easing", () => {
  it("starts fast, ends at rest, and stays inside its bounds", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it("reaches exactly the asked-for zoom by the end of the ramp", () => {
    // The board applies the factor still owed each frame; the product is the
    // whole factor, so an eased double-tap lands where the jump would have.
    let applied = 1;
    let product = 1;
    for (let step = 0; step <= 12; step++) {
      const total = Math.pow(1.8, easeOutCubic(step / 12));
      product *= total / applied;
      applied = total;
    }
    expect(product).toBeCloseTo(1.8, 10);
  });

  it("rides one view over to another", () => {
    const from: Box = { x: 0, y: 0, w: 100, h: 100 };
    const to: Box = { x: 100, y: 50, w: 200, h: 200 };
    expect(interpolateView(from, to, 0)).toEqual(from);
    expect(interpolateView(from, to, 1)).toEqual(to);
    expect(interpolateView(from, to, 0.5)).toEqual({ x: 50, y: 25, w: 150, h: 150 });
  });
});

describe("reading a map's own box", () => {
  const fallback: Box = { x: 0, y: 0, w: 1524, h: 1357 };
  const svgWith = (viewBox: string | null): SVGSVGElement =>
    ({ getAttribute: () => viewBox }) as unknown as SVGSVGElement;

  it("takes the viewBox when there is one", () => {
    expect(baseBoxOf(svgWith("0 0 7300 6100"), fallback)).toEqual({ x: 0, y: 0, w: 7300, h: 6100 });
    expect(baseBoxOf(svgWith("-10,-20, 100, 200"), fallback)).toEqual({
      x: -10, y: -20, w: 100, h: 200,
    });
  });

  it("falls back rather than drawing a map with no size", () => {
    expect(baseBoxOf(svgWith(null), fallback)).toEqual(fallback);
    expect(baseBoxOf(svgWith("0 0 0 0"), fallback)).toEqual(fallback);
    expect(baseBoxOf(svgWith("nonsense"), fallback)).toEqual(fallback);
  });
});

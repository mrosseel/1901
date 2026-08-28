import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  baseBoxOf,
  centredView,
  clampedSize,
  fitAllWidth,
  pannedView,
  placeView,
  toMapPoint,
  zoomedView,
  type Box,
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

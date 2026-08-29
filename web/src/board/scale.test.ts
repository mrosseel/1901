import { describe, expect, it } from "vitest";

import {
  fitEnds,
  fitHead,
  orderRadius,
  orderStroke,
  HEAD_BODY,
  HEAD_MIN_WIDTH,
  MIN_BODY,
  ORDER_RADIUS_MAX_PX,
  ORDER_RADIUS_MIN_PX,
  ORDER_STROKE_MAX_PX,
  ORDER_STROKE_MIN_PX,
} from "./scale";

describe("fitEnds", () => {
  it("grants both clearances when the span can afford them", () => {
    const fit = fitEnds(400, 20, 30);
    expect(fit.start).toBe(20);
    expect(fit.end).toBe(30);
    expect(fit.body).toBe(350);
  });

  /* The bug this module exists for: Paris to Burgundy at fit-all zoom, where
     the two markers' clearances came to more than the span between them. */
  it("keeps half the span for the body when the clearances would eat it", () => {
    const fit = fitEnds(64, 21, 29);
    expect(fit.body).toBeCloseTo(32, 6);
    expect(fit.body / 64).toBeCloseTo(MIN_BODY, 6);
  });

  it("never leaves the body below the floor, however short the span", () => {
    for (const span of [1, 5, 12, 40, 64, 120, 1000]) {
      const fit = fitEnds(span, span * 3, span * 4);
      expect(fit.body).toBeGreaterThanOrEqual(span * MIN_BODY - 1e-9);
    }
  });

  it("trims the two ends in proportion", () => {
    const fit = fitEnds(100, 30, 60);
    expect(fit.end / fit.start).toBeCloseTo(2, 6);
    expect(fit.start + fit.end + fit.body).toBeCloseTo(100, 6);
  });

  it("always accounts for the whole span", () => {
    for (const [span, a, b] of [[300, 10, 10], [64, 21, 29], [8, 40, 40]]) {
      const fit = fitEnds(span, a, b);
      expect(fit.start + fit.end + fit.body).toBeCloseTo(span, 6);
    }
  });

  it("answers a zero span without dividing by it", () => {
    const fit = fitEnds(0, 10, 10);
    expect(fit.start).toBe(0);
    expect(fit.end).toBe(0);
    expect(fit.body).toBe(0);
  });

  it("treats a negative distance as no span at all", () => {
    expect(fitEnds(-50, 10, 10).body).toBe(0);
  });

  it("leaves the body whole when neither end asks for clearance", () => {
    expect(fitEnds(120, 0, 0)).toEqual({ start: 0, end: 0, body: 120 });
  });
});

describe("fitHead", () => {
  it("leaves a head that already fits alone", () => {
    expect(fitHead(100, 20, 11)).toEqual({ length: 20, half: 11 });
  });

  it("never lets the head outgrow its own arrow", () => {
    const head = fitHead(20, 60, 30);
    expect(head.length).toBeCloseTo(20 * HEAD_BODY, 6);
    expect(head.length).toBeLessThan(20);
  });

  it("narrows a shortened head so it keeps its shape", () => {
    const head = fitHead(30, 40, 20);
    expect(head.half).toBeLessThan(20);
    expect(head.half / head.length).toBeCloseTo(20 / 40, 6);
  });

  it("stops narrowing before the head is thinner than its shaft", () => {
    const head = fitHead(5, 200, 100);
    expect(head.half).toBeCloseTo(100 * HEAD_MIN_WIDTH, 6);
  });

  it("answers a bodiless arrow with no head", () => {
    expect(fitHead(0, 20, 11).length).toBe(0);
    expect(fitHead(-5, 20, 11).length).toBe(0);
  });
});

describe("orderRadius", () => {
  /* Twelve screen pixels is what the markers aim for, so an unclamped radius
     must come back untouched. */
  it("passes through a radius already inside the band", () => {
    expect(orderRadius(12 * 3.9, 3.9)).toBeCloseTo(12 * 3.9, 6);
  });

  it("lifts a radius the marker floor left too small on screen", () => {
    // Zoomed right in, markerRadius() hits its 8-unit floor and stops
    // tracking: 8 map units at 0.19 units per pixel is 42 screen pixels.
    expect(orderRadius(8, 0.19)).toBeCloseTo(ORDER_RADIUS_MAX_PX * 0.19, 6);
  });

  it("lifts a radius the marker ceiling left too small on screen", () => {
    expect(orderRadius(2, 5)).toBeCloseTo(ORDER_RADIUS_MIN_PX * 5, 6);
  });

  it("answers an unmeasured pane with the radius it was given", () => {
    expect(orderRadius(30, 0)).toBe(30);
  });
});

describe("orderStroke", () => {
  it("is three tenths of the radius while that reads on screen", () => {
    expect(orderStroke(40, 3.9)).toBeCloseTo(12, 6);
  });

  it("holds a floor in screen pixels, not in map units", () => {
    // A huge viewBox: 1.5 map units, the old floor, would be invisible here.
    expect(orderStroke(4, 20)).toBeCloseTo(ORDER_STROKE_MIN_PX * 20, 6);
  });

  it("holds a ceiling so a clamped radius cannot draw a blob", () => {
    expect(orderStroke(900, 20)).toBeCloseTo(ORDER_STROKE_MAX_PX * 20, 6);
  });

  it("answers an unmeasured pane with the plain fraction", () => {
    expect(orderStroke(40, 0)).toBeCloseTo(12, 6);
  });
});

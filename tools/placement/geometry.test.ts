import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISLODGED_BODY,
  LAPTOP_PANE,
  PHONE_PANE,
  candidatePoints,
  coveredFraction,
  covers,
  defaultDislodgedPoint,
  dislodgedCandidates,
  compareQuality,
  isPlaced,
  level,
  markerRadius,
  neighbours,
  proofGrid,
  qualityAt,
  rectsOverlap,
  refinementSteps,
  standardRadius,
  stressRadius,
  type Rect,
} from "./geometry.ts";

const CLASSICAL: Rect = { x: 0, y: 0, w: 1524, h: 1357 };

test("the marker radius matches the board's own arithmetic", () => {
  // board.ts: r = clamp(12 * view.w / paneWidth, 8, 60), view.w = fit-all on a
  // wide pane. Laptop pane is 1084x884, so fit-all is 1357 * 1084/884 = 1664.
  const laptop = markerRadius(CLASSICAL, LAPTOP_PANE);
  assert.ok(Math.abs(laptop - (12 * 1664.03) / 1084) < 0.05, "laptop radius " + laptop);
  assert.ok(Math.abs(laptop - 18.42) < 0.05);
});

test("a phone draws the same marker over more map, not less", () => {
  // The narrow pane opens stepped in by 1.6, and a constant-pixel marker then
  // covers more map units. Getting this backwards would let every audit pass.
  assert.ok(stressRadius(CLASSICAL) > standardRadius(CLASSICAL));
  assert.ok(Math.abs(markerRadius(CLASSICAL, PHONE_PANE) - 29.31) < 0.05);
});

test("the radius never leaves the range board.ts clamps to", () => {
  const tiny: Rect = { x: 0, y: 0, w: 10, h: 10 };
  const huge: Rect = { x: 0, y: 0, w: 400000, h: 400000 };
  assert.equal(markerRadius(tiny, LAPTOP_PANE), 8);
  assert.equal(markerRadius(huge, LAPTOP_PANE), 60);
});

test("overlap is measured as a fraction of the marker, not of the label", () => {
  const marker = { x: 100, y: 100 };
  const r = 10;
  // A box well clear of the marker.
  assert.equal(coveredFraction(marker, r, [{ x: 500, y: 500, w: 50, h: 50 }]), 0);
  // A box swallowing the marker whole.
  assert.equal(coveredFraction(marker, r, [{ x: 0, y: 0, w: 400, h: 400 }]), 1);
  // A box over exactly the right half.
  const half = coveredFraction(marker, r, [{ x: 100, y: 0, w: 400, h: 400 }]);
  assert.ok(Math.abs(half - 0.5) < 0.06, "half was " + half);
});

test("a graze is not a collision", () => {
  assert.equal(covers(0), false);
  assert.equal(covers(0.005), false);
  assert.equal(covers(0.5), true);
});

test("rectangles that only share an edge do not overlap", () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 10, h: 10 }), true);
});

test("cleanliness is compared in order, never blended", () => {
  const pole = { x: 0, y: 0 };
  const name: Rect[] = [{ x: -100, y: -100, w: 200, h: 200 }];
  const none: Rect[] = [];

  // The bug this replaced: a weighted sum let a small overlap outvote a long
  // walk, so the optimizer parked on an amber a single drag would have fixed.
  // Clean anywhere must beat dirty everywhere, however far away it is.
  const dirtyAtPole = qualityAt({ x: 0, y: 0 }, pole, 10, name, none, 0);
  const cleanFarAway = qualityAt({ x: 5000, y: 0 }, pole, 10, none, none, 0);
  assert.ok(compareQuality(cleanFarAway, dirtyAtPole) < 0);
  assert.ok(isPlaced(cleanFarAway));
  assert.ok(!isPlaced(dirtyAtPole));
});

test("a name outranks a supply centre, which outranks containment", () => {
  const pole = { x: 0, y: 0 };
  const box: Rect[] = [{ x: -100, y: -100, w: 200, h: 200 }];
  const none: Rect[] = [];
  const onName = qualityAt({ x: 0, y: 0 }, pole, 10, box, none, 0);
  const onSupply = qualityAt({ x: 0, y: 0 }, pole, 10, none, box, 0);
  const overhanging = qualityAt({ x: 0, y: 0 }, pole, 10, none, none, 1);
  assert.ok(compareQuality(onSupply, onName) < 0);
  assert.ok(compareQuality(overhanging, onSupply) < 0);
});

test("pole proximity only breaks ties between equally clean positions", () => {
  const pole = { x: 0, y: 0 };
  const near = qualityAt({ x: 5, y: 0 }, pole, 10, [], [], 0);
  const far = qualityAt({ x: 900, y: 0 }, pole, 10, [], [], 0);
  assert.ok(compareQuality(near, far) < 0);
  assert.equal(near.name, 0);
  assert.equal(near.supplyCentre, 0);
});

test("overlaps are bucketed, so invisible differences do not decide", () => {
  // Two positions a person would call equally clear must tie on overlap, and
  // let the tidier one win. Without buckets a hundredth of a percent decides
  // and the markers scatter.
  assert.equal(level(0.2001), level(0.2004));
  assert.equal(level(0.005), 0, "a graze is not a cover");
  assert.ok(level(0.5) > level(0.49));
});

test("a pattern search steps eight ways and shortens its stride", () => {
  const around = neighbours({ x: 10, y: 10 }, 2);
  assert.equal(around.length, 8);
  assert.ok(around.every((p) => Math.abs(p.x - 10) <= 2 && Math.abs(p.y - 10) <= 2));
  assert.ok(!around.some((p) => p.x === 10 && p.y === 10), "the point itself is not a move");
  const steps = refinementSteps(20);
  assert.ok(steps[0] > steps[steps.length - 1]);
  assert.ok(steps[steps.length - 1] <= 0.5, "it must end finer than a person can drag");
});

test("the proof sweep is fine, and stays within budget on a large province", () => {
  const small = proofGrid({ x: 0, y: 0, w: 40, h: 40 }, 1);
  assert.ok(small.length > 1200, "one map unit across a small province");
  const ocean = proofGrid({ x: 0, y: 0, w: 3000, h: 2000 }, 1, 24000);
  assert.ok(ocean.length <= 26000, "budget held, got " + ocean.length);
});

test("candidates cover the province and always include the point given", () => {
  const box: Rect = { x: 100, y: 200, w: 300, h: 150 };
  const pole = { x: 150, y: 250 };
  const points = candidatePoints(box, pole, 12);
  assert.ok(points.length > 20);
  assert.deepEqual(points[0], pole);
  assert.ok(points.every((p) => p.x >= box.x - 1 && p.x <= box.x + box.w + 1));
  assert.ok(points.every((p) => p.y >= box.y - 1 && p.y <= box.y + box.h + 1));
});

test("candidates stay within budget on a province the size of an ocean", () => {
  const box: Rect = { x: 0, y: 0, w: 4000, h: 3000 };
  assert.ok(candidatePoints(box, { x: 0, y: 0 }, 4, 600).length <= 700);
});

test("the dislodged marker starts where board.ts draws it", () => {
  const anchor = { x: 100, y: 100 };
  const away = defaultDislodgedPoint(anchor, 20);
  assert.deepEqual(away, { x: 123, y: 77 });
  // Up and to the right, so the two markers read as two units.
  assert.ok(away.x > anchor.x && away.y < anchor.y);
  assert.equal(dislodgedCandidates(anchor, 20)[0].x, away.x);
  assert.ok(DISLODGED_BODY < 1, "the dislodged body is drawn smaller");
});

test("dislodged candidates ring the unit at a few distances", () => {
  const points = dislodgedCandidates({ x: 0, y: 0 }, 10);
  const reaches = new Set(points.map((p) => Math.round(Math.hypot(p.x, p.y))));
  assert.ok(reaches.size >= 3, "expected several rings, got " + reaches.size);
  assert.ok(points.length > 20);
});

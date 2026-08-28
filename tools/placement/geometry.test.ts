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
  COAST_SEPARATION,
  baseKey,
  clearancePenalty,
  clearlyBetter,
  coastPenalty,
  compareQuality,
  edgeClearance,
  isPlaced,
  level,
  separationShortfall,
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
  const dirtyAtPole = qualityAt({ x: 0, y: 0 }, pole, 10, name, none, { containment: 0 });
  const cleanFarAway = qualityAt({ x: 5000, y: 0 }, pole, 10, none, none, { containment: 0 });
  assert.ok(compareQuality(cleanFarAway, dirtyAtPole) < 0);
  assert.ok(isPlaced(cleanFarAway));
  assert.ok(!isPlaced(dirtyAtPole));
});

test("a name outranks a supply centre, which outranks containment", () => {
  const pole = { x: 0, y: 0 };
  const box: Rect[] = [{ x: -100, y: -100, w: 200, h: 200 }];
  const none: Rect[] = [];
  const onName = qualityAt({ x: 0, y: 0 }, pole, 10, box, none, { containment: 0 });
  const onSupply = qualityAt({ x: 0, y: 0 }, pole, 10, none, box, { containment: 0 });
  const overhanging = qualityAt({ x: 0, y: 0 }, pole, 10, none, none, { containment: 1 });
  assert.ok(compareQuality(onSupply, onName) < 0);
  assert.ok(compareQuality(overhanging, onSupply) < 0);
});

test("RULE A: a coast marker on top of its base province is unreadable", () => {
  // The v2 failure exactly: stp/nc landed 2.6 map units from stp, at a marker
  // radius of 18. Two markers, one place, and no way to tell which is which.
  const radius = 18;
  const stp = { x: 1326.31, y: 78.61 };
  const onTop = separationShortfall({ x: 1323.75, y: 79.26 }, [stp], radius);
  assert.ok(onTop > 0.9, "coincident markers are the worst case");

  // A marker two and a half radii away is far enough and costs nothing.
  const apart = separationShortfall({ x: stp.x + COAST_SEPARATION * radius, y: stp.y }, [stp], radius);
  assert.equal(apart, 0);
  // And going further buys nothing more, which is what stops the rule from
  // flinging coast markers to the far side of the province.
  assert.equal(separationShortfall({ x: stp.x + 400, y: stp.y }, [stp], radius), 0);
});

test("RULE A: a base province standing on its own coast strip is the worse fault", () => {
  // Separation can be repaired by moving; standing inside your own coast
  // cannot, so it scores above any shortfall.
  assert.ok(coastPenalty(1, false) < coastPenalty(0, true));
  assert.equal(coastPenalty(0, false), 0);
  assert.equal(baseKey("stp/nc"), "stp");
  assert.equal(baseKey("stp"), "stp");
});

test("RULE A ranks above a supply centre and below a name", () => {
  const pole = { x: 0, y: 0 };
  const box: Rect[] = [{ x: -100, y: -100, w: 200, h: 200 }];
  const none: Rect[] = [];
  const onName = qualityAt({ x: 0, y: 0 }, pole, 10, box, none, { containment: 0 });
  const badCoast = qualityAt({ x: 0, y: 0 }, pole, 10, none, none, { containment: 0, coast: 1 });
  const onSupply = qualityAt({ x: 0, y: 0 }, pole, 10, none, box, { containment: 0 });
  assert.ok(compareQuality(badCoast, onName) < 0, "an illegible coast beats a hidden name");
  assert.ok(compareQuality(onSupply, badCoast) < 0, "sitting on an SC glyph beats an illegible coast");
});

test("RULE B: clearing the threshold is worth full credit and no more", () => {
  const radius = 10;
  const wanted = 4;
  assert.equal(clearancePenalty(wanted, wanted, radius), 0);
  assert.equal(clearancePenalty(wanted * 10, wanted, radius), 0, "extra room earns nothing");
  assert.ok(clearancePenalty(wanted / 2, wanted, radius) > 0);
  assert.ok(clearancePenalty(wanted / 2, wanted, radius) < clearancePenalty(0, wanted, radius));
  // The worst case is the centre buried in the box, a full radius in.
  assert.equal(clearancePenalty(-radius, wanted, radius), 1);
  // Nothing to clear is not a shortfall.
  assert.equal(clearancePenalty(Infinity, wanted, radius), 0);
});

test("RULE B: a threshold measured as negative still grades", () => {
  // Classical's hand table measures out slightly below zero: the owner lets a
  // marker touch the box of a nearby name. That has to stay a live rule that
  // prefers less overlap, not a switch that turns the term off.
  const radius = 10;
  const wanted = -0.6;
  assert.equal(clearancePenalty(0, wanted, radius), 0, "at the tolerated overlap, no penalty");
  assert.ok(clearancePenalty(-3, wanted, radius) > 0, "deeper than tolerated still costs");
  assert.ok(clearancePenalty(-6, wanted, radius) > clearancePenalty(-3, wanted, radius));
});

test("RULE B: clearance is measured from the marker's edge, not its centre", () => {
  const box: Rect[] = [{ x: 20, y: -5, w: 10, h: 10 }];
  // Centre at 0, radius 5, box starting at x=20: 20 to the box, 15 to the edge.
  assert.equal(edgeClearance({ x: 0, y: 0 }, 5, box), 15);
  // A marker over the box reports how deep it is in, not zero.
  assert.ok(edgeClearance({ x: 22, y: 0 }, 5, box) < 0);
  assert.equal(edgeClearance({ x: 0, y: 0 }, 5, []), Infinity);
});

test("RULE B: at full credit, the centred position wins", () => {
  const pole = { x: 0, y: 0 };
  const far: Rect[] = [{ x: 400, y: 400, w: 10, h: 10 }];
  const wanted = 2;
  const centred = qualityAt({ x: 0, y: 0 }, pole, 10, far, [], { containment: 0, wantedClearance: wanted });
  const drifted = qualityAt({ x: 30, y: 0 }, pole, 10, far, [], { containment: 0, wantedClearance: wanted });
  assert.equal(centred.clearance, 0);
  assert.equal(drifted.clearance, 0, "both clear the threshold");
  assert.ok(compareQuality(centred, drifted) < 0, "so the pole decides");
});

test("a hand-placed marker is never overruled for prettiness alone", () => {
  const pole = { x: 0, y: 0 };
  const hand = qualityAt({ x: 60, y: 0 }, pole, 10, [], [], { containment: 0 });
  const tidier = qualityAt({ x: 0, y: 0 }, pole, 10, [], [], { containment: 0 });
  assert.ok(compareQuality(tidier, hand) < 0, "the tool prefers the centre");
  assert.ok(!clearlyBetter(tidier, hand), "but that is not grounds to move a hand");

  // A real fault is grounds.
  const covering = qualityAt({ x: 0, y: 0 }, pole, 10, [{ x: -50, y: -50, w: 100, h: 100 }], [], {
    containment: 0,
  });
  assert.ok(clearlyBetter(hand, covering));
});

test("pole proximity only breaks ties between equally clean positions", () => {
  const pole = { x: 0, y: 0 };
  const near = qualityAt({ x: 5, y: 0 }, pole, 10, [], [], { containment: 0 });
  const far = qualityAt({ x: 900, y: 0 }, pole, 10, [], [], { containment: 0 });
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

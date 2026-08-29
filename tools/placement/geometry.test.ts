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
  BRIEF_PAIR_OFFSET,
  boxCovered,
  briefHalo,
  briefIsClean,
  compareBrief,
  discGap,
  rectAround,
  rectGap,
  rectsOverlap,
  type BriefQuality,
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
  // The floor is absolute: it keeps a marker tappable at full zoom. On a map
  // narrower than 200 units the ceiling would fall below it, and the floor
  // still has to win — clamp() answers with its high argument otherwise.
  const tiny: Rect = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(markerRadius(tiny, LAPTOP_PANE), 8);

  /*
  The ceiling is a safety rail rather than a working limit. At the two panes
  the board opens in, a marker lands between one and two percent of the map's
  width, so a twenty-fifth never cuts — which is the point: the flat 60 units
  it replaced DID cut, on every map wider than about 5000 units.
  */
  for (const width of [761, 1524, 7300, 400000]) {
    const box: Rect = { x: 0, y: 0, w: width, h: Math.round(width * 0.9) };
    for (const pane of [LAPTOP_PANE, PHONE_PANE]) {
      const r = markerRadius(box, pane);
      assert.ok(r <= Math.max(8, width / 25) + 1e-9, "within the ceiling at " + width);
      assert.ok(r >= 8 - 1e-9, "and never under the floor");
    }
  }
});

test("the marker keeps its presence on a map drawn at another scale", () => {
  // The flat 60-unit ceiling this replaced was chosen on classical, where it
  // never binds, and left sailho — five times wider — with markers thinner
  // than its own borders.
  const classical: Rect = { x: 0, y: 0, w: 1524, h: 1357 };
  const sailho: Rect = { x: 0, y: 0, w: 7300, h: 7695 };

  // Classical must not have moved by so much as a hundredth.
  assert.equal(Number(markerRadius(classical, LAPTOP_PANE).toFixed(2)), 18.42);

  // And a marker should cover about the same share of either map.
  const share = (box: Rect) => markerRadius(box, LAPTOP_PANE) / box.w;
  assert.ok(share(sailho) > share(classical) * 0.8);
  assert.ok(share(sailho) < share(classical) * 1.5);
  assert.ok(markerRadius(sailho, LAPTOP_PANE) > 60, "the old ceiling no longer binds");
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

// --- the brief code label ---------------------------------------------------

test("a label box is centred on the point it is anchored at", () => {
  const box = rectAround({ x: 100, y: 50 }, 20, 10);
  assert.deepEqual(box, { x: 90, y: 45, w: 20, h: 10 });
});

test("box gaps are measured edge to edge, and are zero when they touch", () => {
  const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(rectGap(a, { x: 13, y: 0, w: 5, h: 5 }), 3);
  assert.equal(rectGap(a, { x: 5, y: 5, w: 10, h: 10 }), 0, "overlapping is zero");
  assert.equal(Math.round(rectGap(a, { x: 13, y: 14, w: 2, h: 2 })), 5, "diagonal gap");
});

test("a disc reaching into a label box gives a negative gap", () => {
  const box: Rect = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(discGap(box, { x: 20, y: 5 }, 4), 6);
  assert.equal(discGap(box, { x: 5, y: 5 }, 4), -4, "buried, and the depth is kept");
});

test("coverage of a label box counts discs and boxes alike", () => {
  const box: Rect = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(boxCovered(box, [], []), 0);
  assert.equal(boxCovered(box, [{ centre: { x: 5, y: 5 }, radius: 40 }], []), 1);
  assert.equal(boxCovered(box, [], [{ x: -100, y: -100, w: 1000, h: 1000 }]), 1);
  const half = boxCovered(box, [], [{ x: 0, y: 0, w: 5, h: 10 }]);
  assert.ok(Math.abs(half - 0.5) < 0.02, "half the box, got " + half);
});

test("the first halo spot is exactly where the board draws a code today", () => {
  const r = 18;
  const anchor = { x: 200, y: 300 };
  const label = rectAround(anchor, 30, 14);
  const halo = briefHalo(anchor, r, label);
  // board.ts puts the code's middle at anchor.y + r * 1.95 when a unit stands
  // on the anchor. The ladder's first rung has to agree, or the table would
  // move every code the moment it shipped.
  assert.equal(halo[0].x, anchor.x);
  assert.ok(Math.abs(halo[0].y - (anchor.y + r * BRIEF_PAIR_OFFSET)) < 0.001, "got " + halo[0].y);
});

test("the halo goes below, then beside, then above, and widens", () => {
  const r = 10;
  const anchor = { x: 0, y: 0 };
  const halo = briefHalo(anchor, r, rectAround(anchor, 24, 12));
  assert.ok(halo[0].y > 0 && halo[0].x === 0, "below first");
  assert.ok(halo[1].x > 0 && halo[1].y === 0, "then one side");
  assert.ok(halo[2].x < 0 && halo[2].y === 0, "then the other");
  assert.ok(halo[3].y < 0 && halo[3].x === 0, "then above");
  // A wide code offset sideways has to clear the marker by its own half-width,
  // not by the vertical figure, or it sits half under the piece.
  assert.ok(halo[1].x >= r + 12, "sideways offset clears the marker, got " + halo[1].x);
  const rungs = new Set(halo.map((p) => Math.round(Math.hypot(p.x, p.y))));
  assert.ok(rungs.size >= 4, "several rungs, got " + rungs.size);
});

const CLEAN_CODE: BriefQuality = {
  stray: 0, unit: 0, supplyCentre: 0, overhang: 0, neighbour: 0, clearance: 0, pairing: 0, drift: 0,
};

test("a code that has left its province is the fault settled first", () => {
  const home: BriefQuality = { ...CLEAN_CODE, unit: 0.4, supplyCentre: 0.4, overhang: 1, clearance: 2, pairing: 1, drift: 9 };
  const gone: BriefQuality = { ...CLEAN_CODE, stray: 1 };
  assert.ok(compareBrief(home, gone) < 0, "a code in the wrong province tells a reader something false");
  assert.ok(!briefIsClean(home) && !briefIsClean(gone));
  assert.ok(briefIsClean(CLEAN_CODE));
});

test("a readable code leaning over a border beats a buried one inside it", () => {
  // The same ruling compareQuality() makes for markers, where covering a name
  // outranks containment: a province narrower than the code naming it still
  // has to be named, and a code under a marker is not there at all.
  const leaning: BriefQuality = { ...CLEAN_CODE, overhang: 1 };
  const buried: BriefQuality = { ...CLEAN_CODE, unit: 0.5 };
  assert.ok(compareBrief(leaning, buried) < 0);
  // But leaving the province is still worse than either.
  assert.ok(compareBrief(buried, { ...CLEAN_CODE, stray: 1 }) < 0);
});

test("a neighbour's marker is scored below the code's own containment", () => {
  /*
  A neighbour's piece is only sometimes on the board, and most provinces are
  empty most of the time. Ranking it with the code's own piece was measured on
  twentytwenty, whose provinces are smaller than the codes naming them: it
  drove 80 collisions to 89 by pushing every code off its own anchor and into
  the next province's marker.
  */
  const onNeighbour: BriefQuality = { ...CLEAN_CODE, neighbour: 0.5 };
  const leaning: BriefQuality = { ...CLEAN_CODE, overhang: 1 };
  assert.ok(compareBrief(leaning, onNeighbour) < 0, "a marker hides a code; a border does not");
  assert.ok(compareBrief(onNeighbour, { ...CLEAN_CODE, unit: 0.5 }) < 0, "its own piece still outranks it");
  /*
  And it outranks the supply dot, which was measured rather than assumed: with
  the dot ranked higher the search traded "off the dot" for "onto a piece" on
  every crowded map.
  */
  assert.ok(compareBrief(onNeighbour, { ...CLEAN_CODE, supplyCentre: 0.5 }) > 0);
  // Last among the faults, but still a fault: it is reported, not ignored.
  assert.ok(!briefIsClean(onNeighbour));
  assert.ok(compareBrief(CLEAN_CODE, onNeighbour) < 0);
});

test("among clean positions the one beside its own piece wins", () => {
  const beside: BriefQuality = { ...CLEAN_CODE, drift: 3 };
  const adrift: BriefQuality = { ...CLEAN_CODE, pairing: 1 };
  assert.ok(compareBrief(beside, adrift) < 0);
  assert.ok(briefIsClean(beside) && briefIsClean(adrift));
  // But cleanliness still outranks pairing: a code under the marker loses.
  assert.ok(compareBrief(adrift, { ...CLEAN_CODE, unit: 0.6 }) < 0);
});

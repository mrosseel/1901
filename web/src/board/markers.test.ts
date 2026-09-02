import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKER_STYLE,
  MARKER_STYLES,
  isMarkerStyle,
  markerBody,
  markerDetail,
  markerMark,
  markerStroke,
  type MarkerStyle,
} from "./markers";

const AT = { x: 400, y: 300 };
const R = 20;
const STYLES = MARKER_STYLES.map((one) => one.name);
const KINDS: Array<[MarkerStyle, boolean]> = STYLES.flatMap((style) => [
  [style, false] as [MarkerStyle, boolean],
  [style, true] as [MarkerStyle, boolean],
]);

/* Every number in a path, which is every coordinate: the drawings are written
   with no arcs, so nothing in one is a flag rather than a length. */
function numbers(node: SVGElement): number[] {
  const d = node.getAttribute("d") || node.getAttribute("points") || "";
  return (d.match(/-?\d*\.?\d+/g) || []).map(Number);
}

/* Where the drawing actually is, in map units. A path is written about the
   origin and moved by a transform; a polygon carries its position in its own
   points. */
function extent(node: SVGElement): { dx: number; dy: number } {
  const at = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(node.getAttribute("transform") || "");
  const origin = at ? { x: 0, y: 0 } : AT;
  const all = numbers(node);
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < all.length; i += 2) {
    dx = Math.max(dx, Math.abs(all[i] - origin.x));
    dy = Math.max(dy, Math.abs(all[i + 1] - origin.y));
  }
  return { dx, dy };
}

describe("the marker styles", () => {
  it("offers the default among them", () => {
    expect(STYLES).toContain(DEFAULT_MARKER_STYLE);
    expect(isMarkerStyle(DEFAULT_MARKER_STYLE)).toBe(true);
    expect(isMarkerStyle("wooden-blocks")).toBe(false);
  });

  /*
  The contract with the placement table. dipmap fitted the names and the
  supply centre glyphs around a marker of radius r, so a piece that reached
  past r would sit on a name nobody measured it against.
  */
  it.each(KINDS)("keeps %s inside the radius it was given (fleet: %s)", (style, isFleet) => {
    const reach = extent(markerBody(style, AT, R, isFleet));
    // The strategic fleet's apex is the one deliberate exception: a triangle
    // balanced on its centroid has to be taller than it is wide.
    const up = style === "strategic" && isFleet ? R * 1.34 : R;
    expect(reach.dx).toBeLessThanOrEqual(R + 0.01);
    expect(reach.dy).toBeLessThanOrEqual(up + 0.01);
  });

  /*
  A body is stroked as a unit and stroked empty as a build preview, so it has
  to be one element either way.
  */
  it.each(KINDS)("draws %s as a single element (fleet: %s)", (style, isFleet) => {
    const body = markerBody(style, AT, R, isFleet);
    expect(body.childElementCount).toBe(0);
  });

  /* An arc's two flags are 0 or 1 and are not lengths, and every number in a
     drawing is scaled by the radius. So the drawings carry no arcs. */
  it.each(KINDS)("writes %s with no arc commands (fleet: %s)", (style, isFleet) => {
    const d = markerBody(style, AT, R, isFleet).getAttribute("d");
    if (d) expect(d).not.toMatch(/[Aa]/);
    const mark = markerMark(style, AT, R, isFleet)?.getAttribute("d");
    if (mark) expect(mark).not.toMatch(/[Aa]/);
  });

  it("letters the strategic pieces and nothing else", () => {
    expect(markerMark("strategic", AT, R, false)?.textContent).toBe("A");
    expect(markerMark("strategic", AT, R, true)?.textContent).toBe("F");
    // A cannon, a ship, a helmet and a trireme say which kind they are by
    // being one. A letter on them would say it twice.
    for (const style of ["pretty", "ancient"] as MarkerStyle[]) {
      expect(markerMark(style, AT, R, false)).toBeNull();
      expect(markerMark(style, AT, R, true)).toBeNull();
    }
  });

  /*
  The detail lines are decoration and nothing else. Every style that has them
  says which kind of unit it is without them, so a board that dropped them
  would lose looks and no meaning.
  */
  it.each(KINDS)("keeps %s readable without its detail (fleet: %s)", (style, isFleet) => {
    const detail = markerDetail(style, AT, R, isFleet);
    if (style === "strategic") {
      expect(detail).toBeNull();
      return;
    }
    expect(detail).not.toBeNull();
    // Inside the same circle as the piece it decorates.
    expect(extent(detail!).dx).toBeLessThanOrEqual(R + 0.01);
    expect(extent(detail!).dy).toBeLessThanOrEqual(R + 0.01);
    expect(detail!.getAttribute("d")).not.toMatch(/[Aa]/);
  });

  /*
  A sixth of a radius makes a circle a token and makes a cannon a blob: the
  barrel is a third of a radius across, so that weight closes it from both
  sides. The busier drawings are outlined lighter for that reason.
  */
  it("outlines a busy piece more lightly than a plain one", () => {
    const plain = markerStroke("strategic", R, false);
    for (const style of ["pretty", "ancient"] as MarkerStyle[]) {
      expect(markerStroke(style, R, false)).toBeLessThan(plain);
    }
    // An ordered unit is ringed heavier than a quiet one, in every style.
    for (const style of STYLES) {
      expect(markerStroke(style, R, true)).toBeGreaterThan(markerStroke(style, R, false));
    }
    // A marker shrunk to a floor still gets a line somebody can see.
    expect(markerStroke("pretty", 1, false)).toBeGreaterThanOrEqual(1);
  });

  /* Nothing here is anybody else's art. The drawings were written from a
     description of what other sites draw, not off their files. */
  it("gives every style a drawing of its own", () => {
    const drawn = new Set(
      KINDS.map(([style, isFleet]) =>
        markerBody(style, AT, R, isFleet).getAttribute("d"),
      ).filter(Boolean),
    );
    // One per path-drawn piece, minus the shield both heraldic pieces share.
    expect(drawn.size).toBe(KINDS.length - 2 - 1);
  });

  /* One shield body for both, told apart by the mark inside it, which is what
     webDiplomacy's client does. */
  it("gives both heraldic pieces one body and two marks", () => {
    const army = markerBody("heraldic", AT, R, false).getAttribute("d");
    expect(markerBody("heraldic", AT, R, true).getAttribute("d")).toBe(army);
    const star = markerMark("heraldic", AT, R, false)!.getAttribute("d");
    const anchor = markerMark("heraldic", AT, R, true)!.getAttribute("d");
    expect(star).not.toBe(anchor);
  });

  /*
  The fleet triangle balances on the point the placement table measured.

  The old one ran 1.1r up and 0.75r down, which put its centre of area 0.13r
  low and its bounding box 0.18r high: it sat on neither. An apex twice as far
  out as the base is the shape whose centroid is the anchor.
  */
  it("balances the strategic fleet on its anchor", () => {
    const points = numbers(markerBody("strategic", AT, R, true));
    const ys = [points[1], points[3], points[5]];
    expect((ys[0] + ys[1] + ys[2]) / 3).toBeCloseTo(AT.y, 6);
    expect(markerMark("strategic", AT, R, true)!.getAttribute("y")).toBe(String(AT.y));
  });
});

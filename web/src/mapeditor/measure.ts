/*
The map, measured — the browser half of tools/placement, brought in-app.

tools/placement/browser.ts asks these same questions through playwright's
page.evaluate. A function handed to page.evaluate is serialised and re-parsed
inside the page, so it can see nothing this file could export to it; that is
why the two are not one module and never can be while playwright drives a
separate page. What they DO share is the vocabulary they answer in
(tools/placement/rules.ts) and every threshold and formula the answers are
judged by (geometry.ts) — so the two can disagree about a pixel of a label
box, and cannot disagree about what a violation is.

The measurements are taken on a SECOND copy of the map, parked off screen,
never on the board the person is looking at. Measuring needs every layer live
— a display:none element has no bounding box and no screen CTM — and the
tool's way of getting that is to switch every layer to visibility:hidden and
leave it that way. Doing that to the visible board would erase the map.
*/

import type { MapGeometry, TerrainKind } from "../../../tools/placement/rules.ts";
import type { Geometry } from "./violations.ts";
import type { Point, Rect } from "../../../tools/placement/geometry.ts";
import { COAST_REACH, isCoast } from "../../../tools/placement/rules.ts";
import { BRIEF_FONT_FRACTION, BRIEF_HALO_FRACTION } from "../../../tools/placement/geometry.ts";

/*
How wide the off-screen copy is laid out.

Any width would do — every measurement is mapped back into map units through
the screen CTM — but the number decides how much floating-point room the
mapping has, and 1200 is what tools/placement lays its own copy out at. Using
the same one keeps the two sets of numbers comparable to the decimal.
*/
const MEASURE_WIDTH_PX = 1200;

/** What createGeometry hands back: the map's shape, and a live oracle. */
export interface MeasuredMap extends Geometry {
  map: MapGeometry;
  /** Releases the off-screen copy. */
  destroy(): void;
}

function baseOf(key: string): string {
  return key.includes("/") ? key.slice(0, key.indexOf("/")) : key;
}

function unionBox(boxes: Rect[]): Rect {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  return boxes.reduce((a, b) => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x: x,
      y: y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      h: Math.max(a.y + a.h, b.y + b.h) - y,
    };
  });
}

/*
Boxes that sit within a letter's width of each other, merged into words.

Grouping in these files means nothing: one map ships a <text> per name, the
next a <path> per letter, a third five names in one <g>. Taking a group whole
makes one label out of half a continent; taking every leaf makes a label of
every letter, with gaps between them a marker could sit in and score zero. So
the leaves are measured and then clustered — neighbours decided on the leaves
as measured, each connected group unioned once at the end, because growing a
box and asking what it now touches is how a merge eats a whole map.
*/
function mergeBoxes(boxes: Rect[]): Rect[] {
  if (boxes.length < 2) return boxes;
  const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] || 1;
  const gap = typical * 0.6;

  const parent = boxes.map((_box, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (
        a.x - gap < b.x + b.w &&
        b.x - gap < a.x + a.w &&
        a.y - gap < b.y + b.h &&
        b.y - gap < a.y + a.h
      ) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[rb] = ra;
      }
    }
  }

  const groups = new Map<number, Rect[]>();
  boxes.forEach((box, i) => {
    const root = find(i);
    const held = groups.get(root);
    if (held) held.push(box);
    else groups.set(root, [box]);
  });
  return Array.from(groups.values()).map(unionBox);
}

function layerLabel(node: Element): string {
  return (
    node.getAttribute("inkscape:label") ||
    node.getAttributeNS("http://www.inkscape.org/namespaces/inkscape", "label") ||
    node.id ||
    ""
  );
}

/*
Lays the map out off screen and takes every measurement in one pass.

`svgText` is the same bytes the board loaded, so the two are looking at the
same picture. The copy is left in the document for as long as the editor is
open: the containment tests below need its live geometry on every drag.
*/
export function createGeometry(svgText: string, terrain: TerrainKind): MeasuredMap {
  const stage = document.createElement("div");
  // Off screen rather than hidden: `display:none` and `visibility:hidden` on
  // the container would both cost the geometry this whole file is here for.
  stage.style.cssText =
    "position:fixed;left:-100000px;top:0;width:" +
    MEASURE_WIDTH_PX +
    "px;pointer-events:none;opacity:0";
  document.body.appendChild(stage);

  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    stage.remove();
    throw new Error("the map did not parse");
  }
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  svg.setAttribute("width", String(MEASURE_WIDTH_PX));
  svg.removeAttribute("height");
  stage.appendChild(svg);

  const notes: string[] = [];

  /*
  Which layers the map actually paints is settled BEFORE anything is switched
  on, because it decides what a marker can be accused of covering: a label set
  the map ships turned off is not on the board.
  */
  const painted = new WeakSet<Element>();
  svg.querySelectorAll("g").forEach((layer) => {
    if (getComputedStyle(layer).display !== "none") painted.add(layer);
  });
  svg.querySelectorAll("g").forEach((layer) => {
    layer.setAttribute("style", (layer.getAttribute("style") || "") + ";display:inline;visibility:hidden");
  });

  const ctm = svg.getScreenCTM();
  if (!ctm) {
    stage.remove();
    throw new Error("the map has no screen CTM");
  }
  const toMap = ctm.inverse();
  const probe = svg.createSVGPoint();

  const rectOf = (node: Element): Rect | null => {
    const client = (node as SVGGraphicsElement).getBoundingClientRect();
    if (!client.width && !client.height) return null;
    // Corners through the inverse CTM, then the box around them: a rotated
    // label gives a slightly generous box, which is the safe direction.
    const corners = [
      [client.left, client.top],
      [client.right, client.top],
      [client.right, client.bottom],
      [client.left, client.bottom],
    ].map(([x, y]) => {
      probe.x = x;
      probe.y = y;
      return probe.matrixTransform(toMap);
    });
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  };

  const parts = (svg.getAttribute("viewBox") || "0 0 1524 1357").trim().split(/[\s,]+/).map(Number);
  const viewBox: Rect = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  const mapArea = viewBox.w * viewBox.h;

  const collectLeaves = (root: Element, out: Rect[]): void => {
    const kids = Array.from(root.children).filter((node) => node instanceof SVGGraphicsElement);
    if (kids.length === 0) {
      const box = rectOf(root);
      // A "leaf" the size of a continent is a background rectangle, not a
      // name: measuring it would put every marker on a label.
      if (box && box.w > 0 && box.h > 0 && box.w * box.h < mapArea * 0.25) out.push(box);
      return;
    }
    kids.forEach((kid) => collectLeaves(kid, out));
  };

  /*
  Layer naming is per generator, not per standard: "names" on one map,
  "FullLabelLayer" and "BriefLabelLayer" on another, "SupplyCenterLayer" where
  a third writes "supply-centers". So the name is normalised to bare letters
  before it is matched, and a map shipping two label sets has both counted — a
  marker must miss whichever one is drawn.
  */
  const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const layersMatching = (test: (name: string) => boolean): Element[] =>
    Array.from(svg.children).filter(
      (node) => node.tagName.toLowerCase() === "g" && test(normalise(layerLabel(node))),
    );

  const labelLeaves: Rect[] = [];
  const nameLayers = layersMatching(
    (name) => name.includes("name") || name.includes("label"),
  ).filter((layer) => painted.has(layer));
  nameLayers.forEach((layer) => collectLeaves(layer, labelLeaves));
  if (nameLayers.length === 0) notes.push("this map has no names layer");

  const scLeaves: Rect[] = [];
  const scLayers = layersMatching((name) => name.includes("supplycent")).filter((layer) =>
    painted.has(layer),
  );
  scLayers.forEach((layer) => collectLeaves(layer, scLeaves));
  if (scLayers.length === 0) notes.push("this map has no supply-centres layer");

  // --- anchors, exactly as board.ts reads them -----------------------------
  const anchors = new Map<string, Point>();
  svg.querySelectorAll<SVGGraphicsElement>('[id$="Center"]').forEach((node) => {
    const key = node.id.slice(0, -"Center".length);
    if (!key) return;
    const box = rectOf(node);
    if (box && box.w > 0 && box.h > 0) {
      anchors.set(key, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
      return;
    }
    const match = /^\s*[mM]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(node.getAttribute("d") || "");
    if (match) anchors.set(key, { x: parseFloat(match[1]), y: parseFloat(match[2]) });
  });

  // --- province hit shapes -------------------------------------------------
  const provinceLayer = svg.querySelector("#provinces");
  const shapesByKey = new Map<string, SVGGeometryElement[]>();
  const everyShape: SVGGeometryElement[] = [];
  if (provinceLayer) {
    Array.from(provinceLayer.children).forEach((shape) => {
      if (!(shape instanceof SVGGeometryElement) || !shape.id) return;
      const list = shapesByKey.get(shape.id) || [];
      list.push(shape);
      shapesByKey.set(shape.id, list);
      everyShape.push(shape);
    });
  } else {
    notes.push("this map has no #provinces layer");
  }

  /*
  Which shapes a key owns, the same rule the board uses: a base province owns
  its own outline and every coast drawn on top of it, a coast owns only
  itself. A map draws a province with coasts as several shapes and the coast
  shapes come later in the layer, so they are painted over the base one.
  */
  const shapesFor = (key: string): SVGGeometryElement[] => {
    const own = (shapesByKey.get(key) || []).slice();
    if (key !== baseOf(key)) return own;
    shapesByKey.forEach((list, id) => {
      if (id !== key && baseOf(id) === key) own.push(...list);
    });
    return own;
  };

  const keys = new Set<string>();
  anchors.forEach((_value, key) => keys.add(key));
  shapesByKey.forEach((_value, key) => keys.add(key));

  const provinces = Array.from(keys)
    .sort()
    .map((key) => {
      const own = shapesFor(key);
      const boxes = own.map(rectOf).filter(Boolean) as Rect[];
      return { key: key, box: unionBox(boxes), anchor: anchors.get(key) || null, shapes: own.length };
    });

  const map: MapGeometry = {
    viewBox: viewBox,
    provinces: provinces,
    labels: mergeBoxes(labelLeaves),
    supplyCentres: mergeBoxes(scLeaves),
    /* The same pair board.ts looks for, and by the same ids: it switches them
       with the visibility attribute only when it finds both. */
    drawsBriefLabels: Boolean(
      svg.querySelector("#BriefLabelLayer") && svg.querySelector("#FullLabelLayer"),
    ),
    anchorsWithoutShape: provinces.filter((p) => p.anchor && p.shapes === 0).map((p) => p.key),
    shapesWithoutAnchor: provinces.filter((p) => !p.anchor && p.shapes > 0).map((p) => p.key),
    notes: notes,
  };

  /*
  isPointInFill reads its point in the SHAPE's own user space, not the map's.
  Some generators put the whole province layer under a transform — the 1900
  map ships translate(0,713) scale(0.1,-0.1) — while the anchors sit
  untransformed beside it. Handing a map-space point straight to such a shape
  answers a different question and calls almost every anchor misplaced. So
  each shape carries the matrix from map space into its own, worked out
  through the screen, which is the one space they share.
  */
  const intoShape = new WeakMap<Element, DOMMatrix | null>();
  const matrixFor = (shape: SVGGraphicsElement): DOMMatrix | null => {
    if (intoShape.has(shape)) return intoShape.get(shape) || null;
    const own = shape.getScreenCTM();
    const matrix = own ? own.inverse().multiply(ctm) : null;
    intoShape.set(shape, matrix);
    return matrix;
  };

  const hits = (shape: SVGGeometryElement, x: number, y: number): boolean => {
    const matrix = matrixFor(shape);
    probe.x = x;
    probe.y = y;
    const local = matrix ? probe.matrixTransform(matrix) : probe;
    return shape.isPointInFill(local);
  };

  const inAny = (shapes: SVGGeometryElement[], x: number, y: number): boolean =>
    shapes.some((shape) => hits(shape, x, y));

  /*
  The outline of a coast strip, as points, cached per key.

  A coast strip is usually narrower than a marker, and a fleet is SUPPOSED to
  sit across the shoreline, so the ordinary "does the whole disc fit" test
  fails every correct coast placement. The coast question is different: does
  the centre stand on the province at all, does it hug its own strip, and does
  its edge stay off any OTHER land. Walking the strip is what "hug" is
  measured against, and getTotalLength on a path is not cheap enough to redo
  between two frames of a drag.
  */
  const outlines = new Map<string, Point[]>();
  const outlineOf = (key: string): Point[] => {
    const held = outlines.get(key);
    if (held) return held;
    const points: Point[] = [];
    for (const shape of shapesByKey.get(key) || []) {
      const length = shape.getTotalLength();
      if (!length) continue;
      const count = Math.max(24, Math.min(400, Math.round(length / 3)));
      const matrix = matrixFor(shape);
      const back = matrix ? matrix.inverse() : null;
      for (let i = 0; i < count; i++) {
        const at = shape.getPointAtLength((length * i) / count);
        probe.x = at.x;
        probe.y = at.y;
        const mapped = back ? probe.matrixTransform(back) : at;
        points.push({ x: mapped.x, y: mapped.y });
      }
    }
    outlines.set(key, points);
    return points;
  };

  const insideCoast = (key: string, centre: Point, radius: number, samples: number): boolean => {
    const base = baseOf(key);
    const home = everyShape.filter((shape) => shape.id === base || baseOf(shape.id) === base);
    const others = everyShape.filter((shape) => !home.includes(shape));
    if (!inAny(home, centre.x, centre.y)) return false;

    const strip = shapesByKey.get(key) || [];
    let nearest = Infinity;
    for (const at of outlineOf(key)) {
      const d = Math.hypot(at.x - centre.x, at.y - centre.y);
      if (d < nearest) nearest = d;
    }
    const hugs = inAny(strip, centre.x, centre.y) || nearest <= COAST_REACH * radius;
    if (!hugs) return false;

    for (let i = 0; i < samples; i++) {
      const angle = (2 * Math.PI * i) / samples;
      const x = centre.x + Math.cos(angle) * radius;
      const y = centre.y + Math.sin(angle) * radius;
      if (inAny(home, x, y)) continue;
      const neighbour = others.find((shape) => hits(shape, x, y));
      // Only another LAND province is a fault: a fleet's marker leaning out
      // over open water is what a coast marker looks like.
      if (neighbour && terrain[baseOf(neighbour.id)] !== "sea") return false;
    }
    return true;
  };

  /** The edge of a disc, walked, plus its centre. */
  const EDGE_SAMPLES = 24;

  const insideDisc = (key: string, centre: Point, radius: number): boolean => {
    if (isCoast(key)) return insideCoast(key, centre, radius, EDGE_SAMPLES);
    const shapes = shapesFor(key);
    if (shapes.length === 0) return false;
    if (!inAny(shapes, centre.x, centre.y)) return false;
    for (let i = 0; i < EDGE_SAMPLES; i++) {
      const angle = (2 * Math.PI * i) / EDGE_SAMPLES;
      if (!inAny(shapes, centre.x + Math.cos(angle) * radius, centre.y + Math.sin(angle) * radius)) {
        return false;
      }
    }
    return true;
  };

  const insideBox = (key: string, centre: Point, halfW: number, halfH: number): boolean => {
    const shapes = shapesFor(key);
    if (shapes.length === 0) return false;
    if (!inAny(shapes, centre.x, centre.y)) return false;
    const corners: Array<[number, number]> = [
      [-halfW, -halfH],
      [halfW, -halfH],
      [halfW, halfH],
      [-halfW, halfH],
    ];
    const perSide = 6;
    for (let side = 0; side < 4; side++) {
      const from = corners[side];
      const to = corners[(side + 1) % 4];
      for (let step = 0; step < perSide; step++) {
        const t = step / perSide;
        const x = centre.x + from[0] + (to[0] - from[0]) * t;
        const y = centre.y + from[1] + (to[1] - from[1]) * t;
        if (!inAny(shapes, x, y)) return false;
      }
    }
    return true;
  };

  /*
  How big a three-letter code actually is, asked of the engine that draws it.

  "MID" and "BUL" are not the same width, and a box guessed at 0.6em a letter
  is wrong by enough to put a code on a marker. It is measured on a canvas
  rather than with getBBox because getBBox on a <text> returns the font's LINE
  box — the room an accented capital and a descender would need — which for
  three capitals is nearly twice the ink that is drawn. The halo is a stroke
  laid under the fill, sticking out half its width all round, so a whole width
  is added to each dimension.
  */
  const context = document.createElement("canvas").getContext("2d");
  const briefSizes = new Map<string, { w: number; h: number }>();
  const briefSize = (key: string, fontSize: number): { w: number; h: number } => {
    const code = baseOf(key).slice(0, 3).toUpperCase();
    const cacheKey = code + "@" + fontSize;
    const held = briefSizes.get(cacheKey);
    if (held) return held;
    /* The halo is a fraction of the MARKER radius, not of the font size, and
       the font size handed in is that radius times BRIEF_FONT_FRACTION.
       Dividing back out keeps both numbers the board's own pair. */
    const halo = (fontSize / BRIEF_FONT_FRACTION) * BRIEF_HALO_FRACTION;
    let size = { w: code.length * fontSize * 0.62 + halo, h: fontSize * 0.72 + halo };
    if (context) {
      context.font = "700 " + fontSize + "px system-ui, sans-serif";
      const metrics = context.measureText(code);
      const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
      const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
      if (width > 0 && height > 0) size = { w: width + halo, h: height + halo };
    }
    briefSizes.set(cacheKey, size);
    return size;
  };

  return {
    map: map,
    insideDisc: insideDisc,
    insideBox: insideBox,
    briefSize: briefSize,
    destroy: () => stage.remove(),
  };
}

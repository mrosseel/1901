/*
The browser half of the tool.

Province outlines are arbitrary paths, and the only honest way to ask whether
a point is inside one is to ask an SVG engine: isPointInFill on the real
geometry. Label boxes have the same problem — a name may be live text, or
glyph outlines, under any stack of transforms — so they are measured with
getBoundingClientRect and mapped back into map units through the screen CTM,
which is the one route that survives every transform.

Nothing here decides anything. It measures, and it draws what it is told to.
*/

import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync } from "node:fs";
import type { Point, Rect } from "./geometry.ts";

/*
The tool brings no browser of its own: playwright-core is the driver only.
CHROME_PATH wins, then whatever the machine has.
*/
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.HOME + "/.nix-profile/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/run/current-system/sw/bin/chromium",
];

export function findChrome(): string {
  for (const path of CHROME_CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  throw new Error(
    "no Chromium found — set CHROME_PATH to a Chrome or Chromium binary",
  );
}

export async function openBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: findChrome(),
    args: ["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1"],
  });
}

export interface ProvinceGeometry {
  key: string;
  /** The union bounding box of every shape the key is drawn with. */
  box: Rect;
  /** The anchor the map ships, or null when it has no <key>Center path. */
  anchor: Point | null;
  /** How many hit shapes the key has; zero means the map cannot draw it. */
  shapes: number;
}

export interface MapGeometry {
  viewBox: Rect;
  provinces: ProvinceGeometry[];
  /** Name labels, one box per word-sized group. */
  labels: Rect[];
  /** Supply centre glyphs, likewise. */
  supplyCentres: Rect[];
  /*
  Whether the map ships its own brief labels. A jDip-converted map carries
  BriefLabelLayer and FullLabelLayer, and the board shows one and hides the
  other rather than drawing anything — so a brief position computed for such a
  map would be a number nothing reads. Their codes are the map author's own
  work and are left where they were put.
  */
  drawsBriefLabels: boolean;
  /** Anchors with no hit shape, and shapes with no anchor. */
  anchorsWithoutShape: string[];
  shapesWithoutAnchor: string[];
  notes: string[];
}

/*
Loads a map and takes every measurement in one pass.

The layers a map ships hidden — the province hit shapes, the centre anchors —
are switched to visibility:hidden rather than shown, exactly as board.ts does
it: that keeps their geometry live for getBBox and getScreenCTM without
painting anything.
*/
export async function measureMap(page: Page, svgText: string): Promise<MapGeometry> {
  await page.setContent(
    "<!doctype html><html><head><style>html,body{margin:0;padding:0}" +
      "svg{display:block;width:1200px;height:auto}</style></head><body>" +
      svgText +
      "</body></html>",
    { waitUntil: "load" },
  );
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const svg = document.querySelector("svg") as SVGSVGElement;
    const notes: string[] = [];

    const label = (node: Element): string =>
      node.getAttribute("inkscape:label") ||
      node.getAttributeNS("http://www.inkscape.org/namespaces/inkscape", "label") ||
      node.id ||
      "";

    /*
    Which layers the map actually paints is settled first, because it decides
    what a marker can be accused of covering: a label set the map ships
    switched off is not on the board. Then everything is switched on, because
    every measurement below needs live geometry — a display:none element has
    no box and no screen CTM, and the CTM is what the transform arithmetic
    depends on. visibility:hidden keeps the geometry and paints nothing.

    The styles are deliberately not put back. Every later question about this
    map — is this point inside that province, where is its deepest point —
    needs the same live geometry, and the page is never shown to anyone.
    */
    const painted = new WeakSet<Element>();
    Array.prototype.forEach.call(svg.querySelectorAll("g"), (layer: Element) => {
      if (getComputedStyle(layer).display !== "none") painted.add(layer);
    });
    Array.prototype.forEach.call(svg.querySelectorAll("g"), (layer: Element) => {
      const style = layer.getAttribute("style") || "";
      layer.setAttribute("style", style + ";display:inline;visibility:hidden");
    });

    const ctm = svg.getScreenCTM();
    if (!ctm) throw new Error("the map has no screen CTM");
    const toMap = ctm.inverse();

    const rectOf = (node: Element): { x: number; y: number; w: number; h: number } | null => {
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
        const point = svg.createSVGPoint();
        point.x = x;
        point.y = y;
        return point.matrixTransform(toMap);
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

    const viewBoxAttr = (svg.getAttribute("viewBox") || "0 0 1524 1357")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const viewBox = { x: viewBoxAttr[0], y: viewBoxAttr[1], w: viewBoxAttr[2], h: viewBoxAttr[3] };
    const mapArea = viewBox.w * viewBox.h;

    /*
    Labels are measured leaf by leaf and then clustered back into words.

    Grouping in these files means nothing: one map ships a <text> per name,
    the next ships a <path> per letter, and a third wraps five names in one
    <g>. Taking a group's box whole makes one label out of half a continent;
    taking every leaf makes a label out of every letter, with gaps between
    them a marker could sit in and score zero. So the leaves are measured —
    they are the only honest unit — and boxes that sit within a letter's
    width of each other are merged until nothing more touches, which
    reconstructs words and lines whatever the file did.
    */
    const collectLeaves = (root: Element, out: Array<{ x: number; y: number; w: number; h: number }>) => {
      const kids = Array.prototype.filter.call(
        root.children,
        (node: Element) => node instanceof SVGGraphicsElement,
      ) as Element[];
      if (kids.length === 0) {
        const box = rectOf(root);
        if (box && box.w > 0 && box.h > 0 && box.w * box.h < mapArea * 0.25) out.push(box);
        return;
      }
      kids.forEach((kid) => collectLeaves(kid, out));
    };

    const mergeBoxes = (
      boxes: Array<{ x: number; y: number; w: number; h: number }>,
    ): Array<{ x: number; y: number; w: number; h: number }> => {
      if (boxes.length < 2) return boxes;
      /*
      Neighbours are decided on the leaves as they were measured, and each
      connected group is unioned once at the end. Growing a box and then
      asking what it now touches is how a merge eats a whole map: the union
      of two words reaches a third, that reaches a fourth, and the answer is
      one label the size of Europe.
      */
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
      const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
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
            union(i, j);
          }
        }
      }

      const groups = new Map<number, { x: number; y: number; w: number; h: number }>();
      boxes.forEach((box, i) => {
        const root = find(i);
        const held = groups.get(root);
        if (!held) {
          groups.set(root, { ...box });
          return;
        }
        const x = Math.min(held.x, box.x);
        const y = Math.min(held.y, box.y);
        groups.set(root, {
          x: x,
          y: y,
          w: Math.max(held.x + held.w, box.x + box.w) - x,
          h: Math.max(held.y + held.h, box.y + box.h) - y,
        });
      });
      return Array.from(groups.values());
    };

    const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const layersMatching = (test: (name: string) => boolean): Element[] =>
      (Array.prototype.filter.call(svg.children, (node: Element) => {
        return node.tagName.toLowerCase() === "g" && test(normalise(label(node)));
      }) as Element[]);

    /*
    Layer naming is per generator, not per standard: "names" on one map,
    "FullLabelLayer" and "BriefLabelLayer" on another, "SupplyCenterLayer"
    where a third writes "supply-centers". So the name is normalised to bare
    letters before it is matched, and a map that ships two alternative label
    sets has both counted — a marker must miss whichever one is drawn.
    */
    const labelLeaves: Array<{ x: number; y: number; w: number; h: number }> = [];
    const nameLayers = layersMatching((name) => name.includes("name") || name.includes("label")).filter(
      (layer) => painted.has(layer),
    );
    nameLayers.forEach((layer) => collectLeaves(layer, labelLeaves));
    if (nameLayers.length === 0) notes.push("this map has no names layer");
    const labels = mergeBoxes(labelLeaves);

    const scLeaves: Array<{ x: number; y: number; w: number; h: number }> = [];
    const scLayers = layersMatching((name) => name.includes("supplycent")).filter((layer) =>
      painted.has(layer),
    );
    scLayers.forEach((layer) => collectLeaves(layer, scLeaves));
    if (scLayers.length === 0) notes.push("this map has no supply-centres layer");
    const supplyCentres = mergeBoxes(scLeaves);

    // --- anchors, exactly as board.ts reads them --------------------------
    const anchors = new Map<string, { x: number; y: number }>();
    Array.prototype.forEach.call(
      svg.querySelectorAll('[id$="Center"]'),
      (node: SVGGraphicsElement) => {
        const key = node.id.slice(0, -"Center".length);
        if (!key) return;
        const box = rectOf(node);
        if (box && box.w > 0 && box.h > 0) {
          anchors.set(key, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
          return;
        }
        const d = node.getAttribute("d") || "";
        const match = /^\s*[mM]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d);
        if (match) anchors.set(key, { x: parseFloat(match[1]), y: parseFloat(match[2]) });
      },
    );

    // --- province hit shapes ---------------------------------------------
    const provinceLayer = svg.querySelector("#provinces");
    const shapesByKey = new Map<string, Element[]>();
    if (provinceLayer) {
      Array.prototype.forEach.call(provinceLayer.children, (shape: Element) => {
        if (!shape.id) return;
        const list = shapesByKey.get(shape.id) || [];
        list.push(shape);
        shapesByKey.set(shape.id, list);
      });
    } else {
      notes.push("this map has no #provinces layer");
    }

    const base = (key: string) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : key);

    /*
    Which shapes a key owns, the same rule the board uses: a base province
    owns its own outline and every coast drawn on top of it, a coast owns
    only itself.
    */
    const shapesFor = (key: string): Element[] => {
      const own = shapesByKey.get(key) || [];
      if (key !== base(key)) return own;
      const all = own.slice();
      shapesByKey.forEach((list, id) => {
        if (id !== key && base(id) === key) all.push(...list);
      });
      return all;
    };

    const keys = new Set<string>();
    anchors.forEach((_value, key) => keys.add(key));
    shapesByKey.forEach((_value, key) => keys.add(key));

    const provinces = Array.from(keys)
      .sort()
      .map((key) => {
        const own = shapesFor(key);
        const boxes = own.map(rectOf).filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>;
        const union = boxes.length
          ? boxes.reduce((a, b) => {
              const x = Math.min(a.x, b.x);
              const y = Math.min(a.y, b.y);
              return {
                x: x,
                y: y,
                w: Math.max(a.x + a.w, b.x + b.w) - x,
                h: Math.max(a.y + a.h, b.y + b.h) - y,
              };
            })
          : { x: 0, y: 0, w: 0, h: 0 };
        return {
          key: key,
          box: union,
          anchor: anchors.get(key) || null,
          shapes: own.length,
        };
      });

    return {
      viewBox: viewBox,
      provinces: provinces,
      labels: labels,
      supplyCentres: supplyCentres,
      /* The same pair board.ts looks for, and by the same ids: it switches
         them with the visibility attribute only when it finds both. */
      drawsBriefLabels: Boolean(
        svg.querySelector("#BriefLabelLayer") && svg.querySelector("#FullLabelLayer"),
      ),
      anchorsWithoutShape: provinces.filter((p) => p.anchor && p.shapes === 0).map((p) => p.key),
      shapesWithoutAnchor: provinces.filter((p) => !p.anchor && p.shapes > 0).map((p) => p.key),
      notes: notes,
    };
  });
}

/*
The pole of inaccessibility of every province: the interior point furthest
from any border — the deepest place a marker can stand.

Not the centroid. A centroid is the average of an area, and the average of a
crescent, a horseshoe or a province wrapped around a bay lands outside the
province altogether; the average of a province with a long tail lands in the
tail. The pole is what a cartographer means by "the middle of it".

It is computed here rather than in Node because both halves of the answer are
native to the browser: isPointInFill decides what is interior, and the outline
walked with getPointAtLength gives the border to measure against. The search
is a coarse lattice refined twice around its own best cell, which lands within
about a border-sample of the true pole and costs nothing.
*/
export interface Pole {
  key: string;
  point: Point;
  /** How far the pole is from the nearest border: the province's half-width. */
  clearance: number;
}

export async function computePoles(page: Page, keys: string[]): Promise<Pole[]> {
  return page.evaluate((wanted: string[]) => {
    const svg = document.querySelector("svg") as SVGSVGElement;
    const layer = svg.querySelector("#provinces");
    const probe = svg.createSVGPoint();
    const base = (key: string) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : key);

    // Same transform problem as testInside, and the same fix, in both
    // directions: getBBox and getPointAtLength answer in the shape's own
    // space, and everything else here is in map units.
    const svgCTM = svg.getScreenCTM();
    const matricesFor = (shape: SVGGraphicsElement) => {
      const own = shape.getScreenCTM();
      if (!own || !svgCTM) return null;
      return { toShape: own.inverse().multiply(svgCTM), toMap: svgCTM.inverse().multiply(own) };
    };

    const shapesFor = (key: string): SVGGeometryElement[] => {
      if (!layer) return [];
      const found: SVGGeometryElement[] = [];
      Array.prototype.forEach.call(layer.children, (shape: Element) => {
        if (!(shape instanceof SVGGeometryElement)) return;
        if (shape.id === key) found.push(shape);
        else if (key === base(key) && base(shape.id) === key) found.push(shape);
      });
      return found;
    };

    const out: Array<{ key: string; point: { x: number; y: number }; clearance: number }> = [];

    for (const key of wanted) {
      const shapes = shapesFor(key);
      if (shapes.length === 0) continue;

      // The border as a cloud of points. Sampling the outline rather than
      // reading path data keeps every command type — arcs, curves, several
      // subpaths — working without a parser.
      const border: Array<[number, number]> = [];
      let box: { x: number; y: number; w: number; h: number } | null = null;
      const matrices = new Map<SVGGeometryElement, ReturnType<typeof matricesFor>>();
      for (const shape of shapes) {
        const m = matricesFor(shape);
        matrices.set(shape, m);
        const bb = shape.getBBox();
        // The box's corners through the matrix, so a flipped or scaled layer
        // still gives a box in map units.
        const corners = [
          [bb.x, bb.y],
          [bb.x + bb.width, bb.y],
          [bb.x + bb.width, bb.y + bb.height],
          [bb.x, bb.y + bb.height],
        ].map(([x, y]) => {
          probe.x = x;
          probe.y = y;
          return m ? probe.matrixTransform(m.toMap) : { x: x, y: y };
        });
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        const mapped = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        };
        box = box
          ? {
              x: Math.min(box.x, mapped.x),
              y: Math.min(box.y, mapped.y),
              w: Math.max(box.x + box.w, mapped.x + mapped.w) - Math.min(box.x, mapped.x),
              h: Math.max(box.y + box.h, mapped.y + mapped.h) - Math.min(box.y, mapped.y),
            }
          : mapped;
        const length = shape.getTotalLength();
        if (!length) continue;
        /*
        The outline is walked with getPointAtLength, which re-measures the
        path on every call, so this count is most of what the tool costs.
        Four hundred points round a province sit closer together than a
        marker is wide on every map here, which is finer than the clearance
        estimate needs.
        */
        const count = Math.max(24, Math.min(400, Math.round(length / 3)));
        for (let i = 0; i < count; i++) {
          const at = shape.getPointAtLength((length * i) / count);
          probe.x = at.x;
          probe.y = at.y;
          const mappedPoint = m ? probe.matrixTransform(m.toMap) : at;
          border.push([mappedPoint.x, mappedPoint.y]);
        }
      }
      if (!box || border.length === 0) continue;

      // A grid over the border points, so "how far is the nearest border"
      // does not walk the whole cloud for every candidate.
      const cell = Math.max(Math.max(box.w, box.h) / 64, 1);
      const buckets = new Map<string, Array<[number, number]>>();
      const keyOf = (x: number, y: number) =>
        Math.floor(x / cell) + ":" + Math.floor(y / cell);
      for (const point of border) {
        const id = keyOf(point[0], point[1]);
        const list = buckets.get(id);
        if (list) list.push(point);
        else buckets.set(id, [point]);
      }
      const clearanceAt = (x: number, y: number): number => {
        let best = Infinity;
        for (let ring = 0; ring < 40; ring++) {
          const cx = Math.floor(x / cell);
          const cy = Math.floor(y / cell);
          for (let i = cx - ring; i <= cx + ring; i++) {
            for (let j = cy - ring; j <= cy + ring; j++) {
              // Only the newly reached ring, not the block already walked.
              if (ring > 0 && i > cx - ring && i < cx + ring && j > cy - ring && j < cy + ring) continue;
              const list = buckets.get(i + ":" + j);
              if (!list) continue;
              for (const point of list) {
                const d = Math.hypot(point[0] - x, point[1] - y);
                if (d < best) best = d;
              }
            }
          }
          // Once the nearest hit is closer than the ring already searched,
          // nothing further out can beat it.
          if (best <= ring * cell) return best;
        }
        return best === Infinity ? 0 : best;
      };

      const inside = (x: number, y: number): boolean => {
        for (const shape of shapes) {
          const m = matrices.get(shape);
          probe.x = x;
          probe.y = y;
          const local = m ? probe.matrixTransform(m.toShape) : probe;
          if (shape.isPointInFill(local)) return true;
        }
        return false;
      };

      let best = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      let bestClearance = -1;
      let region = box;
      let steps = 32;
      for (let pass = 0; pass < 3; pass++) {
        const stepX = region.w / steps;
        const stepY = region.h / steps;
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; j <= steps; j++) {
            const x = region.x + i * stepX;
            const y = region.y + j * stepY;
            if (!inside(x, y)) continue;
            const clearance = clearanceAt(x, y);
            if (clearance > bestClearance) {
              bestClearance = clearance;
              best = { x: x, y: y };
            }
          }
        }
        // Refine around the winner, at a quarter of the span each time.
        region = {
          x: best.x - region.w / 8,
          y: best.y - region.h / 8,
          w: region.w / 4,
          h: region.h / 4,
        };
        steps = 12;
      }

      out.push({ key: key, point: best, clearance: Math.max(0, bestClearance) });
    }
    return out;
  }, keys);
}

/*
Asks the map which of a batch of points fall inside which province. One round
trip for the whole variant: the page expands each centre into its own ring of
edge samples, so only the centres cross the wire.
*/
export interface InsideRequest {
  key: string;
  centres: Array<[number, number]>;
  radius: number;
  samples: number;
  /*
  Half the width and half the height of a BOX to test instead of a disc, for
  the brief code labels: a three-letter label is a wide, short rectangle, and
  asking whether the circle around it fits inside a province rules out a great
  many places the label itself sits in comfortably.
  */
  box?: [number, number];
}

export async function testInside(
  page: Page,
  requests: InsideRequest[],
): Promise<Record<string, boolean[]>> {
  return page.evaluate((batch: InsideRequest[]) => {
    const svg = document.querySelector("svg") as SVGSVGElement;
    const layer = svg.querySelector("#provinces");
    const point = svg.createSVGPoint();
    const base = (key: string) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : key);

    /*
    isPointInFill reads its point in the SHAPE's own user space, not the map's.
    Some generators put the whole province layer under a transform — the 1900
    map ships translate(0,713) scale(0.1,-0.1) — while the anchors sit
    untransformed beside it. Handing a map-space point straight to a shape
    under such a layer answers a different question and calls almost every
    anchor misplaced. So each shape carries the matrix from map space into its
    own, worked out through the screen, which is the one space they share.
    */
    const svgCTM = svg.getScreenCTM();
    const intoShape = new WeakMap<Element, DOMMatrix>();
    const matrixFor = (shape: SVGGraphicsElement): DOMMatrix | null => {
      const held = intoShape.get(shape);
      if (held) return held;
      const own = shape.getScreenCTM();
      if (!own || !svgCTM) return null;
      const matrix = own.inverse().multiply(svgCTM);
      intoShape.set(shape, matrix);
      return matrix;
    };

    const shapesFor = (key: string): SVGGeometryElement[] => {
      if (!layer) return [];
      const found: SVGGeometryElement[] = [];
      Array.prototype.forEach.call(layer.children, (shape: Element) => {
        if (!(shape instanceof SVGGeometryElement)) return;
        if (shape.id === key) found.push(shape);
        else if (key === base(key) && base(shape.id) === key) found.push(shape);
      });
      return found;
    };

    const answer: Record<string, boolean[]> = {};
    for (const request of batch) {
      const shapes = shapesFor(request.key);
      const inside = (x: number, y: number) => {
        for (const shape of shapes) {
          const matrix = matrixFor(shape);
          point.x = x;
          point.y = y;
          const local = matrix ? point.matrixTransform(matrix) : point;
          if (shape.isPointInFill(local)) return true;
        }
        return false;
      };
      /*
      The outline the whole shape has to fit inside, as offsets from a centre:
      a ring for a marker, a rectangle walked corner to corner for a label.
      */
      const outline: Array<[number, number]> = [];
      if (request.box) {
        const [hw, hh] = request.box;
        const corners: Array<[number, number]> = [
          [-hw, -hh],
          [hw, -hh],
          [hw, hh],
          [-hw, hh],
        ];
        const perSide = Math.max(1, Math.round(request.samples / 4));
        for (let i = 0; i < 4; i++) {
          const from = corners[i];
          const to = corners[(i + 1) % 4];
          for (let step = 0; step < perSide; step++) {
            const t = step / perSide;
            outline.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
          }
        }
      } else {
        for (let i = 0; i < request.samples; i++) {
          const angle = (2 * Math.PI * i) / request.samples;
          outline.push([Math.cos(angle) * request.radius, Math.sin(angle) * request.radius]);
        }
      }

      answer[request.key] = request.centres.map(([cx, cy]) => {
        if (shapes.length === 0) return false;
        if (!inside(cx, cy)) return false;
        // The whole marker has to fit, so its edge is walked as well.
        for (const [dx, dy] of outline) {
          if (!inside(cx + dx, cy + dy)) return false;
        }
        return true;
      });
    }
    return answer;
  }, requests);
}

/*
How big a brief code actually is, asked of the engine that will draw it.

The board sets a font size, a bold weight, a letter spacing and a halo width,
and hands the rest to the font. "MID" and "BUL" are not the same width, and a
three-letter box guessed at 0.6em a letter is wrong by enough to put a code on
a marker. So each code is laid out once with the board's own declarations and
measured.

It is measured on a canvas rather than with getBBox, and that is the whole
point of the function. getBBox on a <text> returns the font's LINE box — full
ascent and descent, the room a lower-case "g" and an accented capital would
need — which for a code of three capitals is nearly twice the height of the
ink that is actually drawn. Placing against the line box treats a code as far
taller than it looks, and on a map with a large marker radius that is the
difference between a code fitting its province and being shoved out of it.
actualBoundingBoxAscent and its three siblings give the ink, which is what a
reader sees and what a collision is with.

The halo is a stroke laid down under the fill by paint-order. It sticks out
half its width all round, so a whole width is added to each dimension.
*/
export interface BriefBox {
  key: string;
  w: number;
  h: number;
}

export async function measureBriefBoxes(
  page: Page,
  codes: Array<{ key: string; text: string }>,
  fontSize: number,
  strokeWidth: number,
): Promise<BriefBox[]> {
  return page.evaluate(
    (input: { codes: Array<{ key: string; text: string }>; fontSize: number; strokeWidth: number }) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("this browser has no 2d canvas to measure text with");
      /*
      The size is given in px because that is the only unit a canvas has, and
      the answer is used as map units. That is exact rather than approximate:
      both the canvas and the SVG lay the text out at the same multiple of the
      font's own units, so the ratio of ink to font size is the same number in
      either space.
      */
      ctx.font = "700 " + input.fontSize + "px system-ui, sans-serif";
      // Supported in Chromium; older engines ignore it, and a four-hundredth
      // of an em over three letters is below the resolution of the decision.
      (ctx as unknown as { letterSpacing: string }).letterSpacing = "0.04em";

      const out: Array<{ key: string; w: number; h: number }> = [];
      const cache = new Map<string, { w: number; h: number }>();
      for (const code of input.codes) {
        let box = cache.get(code.text);
        if (!box) {
          const m = ctx.measureText(code.text);
          const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight || m.width;
          const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || input.fontSize * 0.72;
          box = { w: w + input.strokeWidth, h: h + input.strokeWidth };
          cache.set(code.text, box);
        }
        out.push({ key: code.key, w: box.w, h: box.h });
      }
      return out;
    },
    { codes: codes, fontSize: fontSize, strokeWidth: strokeWidth },
  );
}

/*
Whether a coast marker sits where a coast marker should.

A named coast — "stp/nc", "bul/ec" — is drawn on the map as a thin strip along
a shoreline, often narrower than a marker. Asking such a strip to contain a
whole marker is asking the wrong question: it rules out nearly every position,
forces the marker to shrink, and leaves the coast crowded against its own base
province. A fleet on the north coast of St Petersburg standing half on the
land and half in the water is not a defect. It is what a fleet on a coast
LOOKS like, and it is how every hand-drawn Diplomacy map has ever shown one.

So a coast marker is judged on three things instead of containment:

  belongs   its centre is inside its own coast strip, or inside the base
            province the strip belongs to — it is standing on its own ground
  hugs      its centre is no further than a marker's reach from the strip
            itself, so a coast marker cannot wander inland and claim to be a
            coast
  unclaimed nothing it overhangs is a DIFFERENT land province. Sea and open
            water are free, because no reader thinks a unit belongs to the
            water it is dipped in; another country is the ambiguity that
            matters, and it is the same rule the overhang probe uses.
*/
export interface CoastRequest {
  /** The coast key, e.g. "stp/nc". */
  key: string;
  /** The base province whose ground the coast may also stand on. */
  base: string;
  centres: Array<[number, number]>;
  radius: number;
  samples: number;
  /** How far from its own strip the centre may stray, in map units. */
  reach: number;
}

export interface CoastResult {
  ok: boolean;
  /** Perimeter samples over another land province — the fault worth counting. */
  land: number;
  sea: number;
  open: number;
}

export async function probeCoasts(
  page: Page,
  requests: CoastRequest[],
  terrain: Record<string, "sea" | "land" | "unknown">,
): Promise<Record<string, CoastResult[]>> {
  return page.evaluate(
    (input: { batch: CoastRequest[]; terrain: Record<string, string> }) => {
      const svg = document.querySelector("svg") as SVGSVGElement;
      const layer = svg.querySelector("#provinces");
      const probe = svg.createSVGPoint();
      const base = (key: string) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : key);

      const svgCTM = svg.getScreenCTM();
      const matrices = new WeakMap<Element, DOMMatrix | null>();
      const intoShape = (shape: SVGGraphicsElement): DOMMatrix | null => {
        if (matrices.has(shape)) return matrices.get(shape) || null;
        const own = shape.getScreenCTM();
        const matrix = own && svgCTM ? own.inverse().multiply(svgCTM) : null;
        matrices.set(shape, matrix);
        return matrix;
      };
      const hits = (shape: SVGGeometryElement, x: number, y: number): boolean => {
        const matrix = intoShape(shape);
        probe.x = x;
        probe.y = y;
        const local = matrix ? probe.matrixTransform(matrix) : probe;
        return shape.isPointInFill(local);
      };

      const all: SVGGeometryElement[] = [];
      if (layer) {
        Array.prototype.forEach.call(layer.children, (shape: Element) => {
          if (shape instanceof SVGGeometryElement) all.push(shape);
        });
      }

      const answer: Record<string, CoastResult[]> = {};
      for (const request of input.batch) {
        // The strip itself, and the whole province it belongs to.
        const strip = all.filter((shape) => shape.id === request.key);
        const home = all.filter(
          (shape) => shape.id === request.base || base(shape.id) === request.base,
        );
        const others = all.filter((shape) => !home.includes(shape));

        // The strip's outline as points, for the "hugs its own coast" test.
        const outline: Array<[number, number]> = [];
        for (const shape of strip) {
          const length = shape.getTotalLength();
          if (!length) continue;
          const count = Math.max(24, Math.min(400, Math.round(length / 3)));
          const matrix = intoShape(shape);
          const back = matrix ? matrix.inverse() : null;
          for (let i = 0; i < count; i++) {
            const at = shape.getPointAtLength((length * i) / count);
            probe.x = at.x;
            probe.y = at.y;
            const mapped = back ? probe.matrixTransform(back) : at;
            outline.push([mapped.x, mapped.y]);
          }
        }

        answer[request.key] = request.centres.map(([cx, cy]) => {
          const belongs = home.some((shape) => hits(shape, cx, cy));
          if (!belongs) return { ok: false, land: 0, sea: 0, open: 0 };

          let nearest = Infinity;
          for (const point of outline) {
            const d = Math.hypot(point[0] - cx, point[1] - cy);
            if (d < nearest) nearest = d;
          }
          const insideStrip = strip.some((shape) => hits(shape, cx, cy));
          const hugs = insideStrip || nearest <= request.reach;

          let land = 0;
          let sea = 0;
          let open = 0;
          for (let i = 0; i < request.samples; i++) {
            const angle = (2 * Math.PI * i) / request.samples;
            const x = cx + Math.cos(angle) * request.radius;
            const y = cy + Math.sin(angle) * request.radius;
            if (home.some((shape) => hits(shape, x, y))) continue;
            const neighbour = others.find((shape) => hits(shape, x, y));
            if (!neighbour) open++;
            else if (input.terrain[base(neighbour.id)] === "sea") sea++;
            else land++;
          }
          return { ok: hugs && land === 0, land: land, sea: sea, open: open };
        });
      }
      return answer;
    },
    { batch: requests, terrain: terrain },
  );
}

/*
Which provinces are sea and which are land, read off the map itself.

The server has no endpoint for it and the SVG has no attribute for it, but the
map already says so in the only language a map has: sea is painted one colour
and land another. So the topmost painted element under each province's pole is
asked for its fill, the fills are counted, and the two that almost every
province shares are the two terrains. Sea is whichever of them is also under
the map's far corner, which on every map in this set is open water.

This is a heuristic and it is reported, not trusted silently — it only ever
decides which way a marker is allowed to overhang, and the report lists the
call for every province so a wrong one is visible.
*/
export interface Terrain {
  seaFill: string | null;
  landFill: string | null;
  kind: Record<string, "sea" | "land" | "unknown">;
}

export async function classifyTerrain(page: Page, poles: Pole[]): Promise<Terrain> {
  return page.evaluate((points: Pole[]) => {
    const svg = document.querySelector("svg") as SVGSVGElement;
    const ctm = svg.getScreenCTM();
    const probe = svg.createSVGPoint();

    // The fill of the topmost thing actually painted at a map point.
    const fillAt = (x: number, y: number): string | null => {
      if (!ctm) return null;
      probe.x = x;
      probe.y = y;
      const screen = probe.matrixTransform(ctm);
      const stack = document.elementsFromPoint(screen.x, screen.y);
      for (const node of stack) {
        if (!(node instanceof SVGGraphicsElement)) continue;
        const fill = getComputedStyle(node).fill;
        if (!fill || fill === "none" || fill === "rgba(0, 0, 0, 0)") continue;
        return fill;
      }
      return null;
    };

    const fills = new Map<string, number>();
    const byKey: Record<string, string | null> = {};
    for (const pole of points) {
      const fill = fillAt(pole.point.x, pole.point.y);
      byKey[pole.key] = fill;
      if (fill) fills.set(fill, (fills.get(fill) || 0) + 1);
    }

    const ranked = Array.from(fills.entries()).sort((a, b) => b[1] - a[1]);
    const box = svg.viewBox.baseVal;
    // A hand's width in from the corner: far enough to miss a border stroke,
    // near enough that no map puts a province there.
    const cornerFill = fillAt(box.x + box.width * 0.02, box.y + box.height * 0.02);

    let seaFill: string | null = null;
    let landFill: string | null = null;
    if (ranked.length) {
      const top = ranked.slice(0, 2).map((entry) => entry[0]);
      if (cornerFill && top.includes(cornerFill)) {
        seaFill = cornerFill;
        landFill = top.find((fill) => fill !== cornerFill) || null;
      } else {
        // No corner match: fall back to the two most common fills and leave
        // the call to the report rather than guessing which is which.
        landFill = top[0] || null;
        seaFill = top[1] || null;
      }
    }

    const kind: Record<string, "sea" | "land" | "unknown"> = {};
    for (const pole of points) {
      const fill = byKey[pole.key];
      kind[pole.key] = fill === seaFill ? "sea" : fill === landFill ? "land" : "unknown";
    }
    return { seaFill: seaFill, landFill: landFill, kind: kind };
  }, poles);
}

/*
What a marker at a point would actually do: how far its centre is from the
province border, and — for the part of it that hangs out — whose ground it
hangs over.

Overhanging into open sea or off the edge of the map costs a reader nothing,
because no one could think the unit belonged to the water. Overhanging into a
neighbouring LAND province is the ambiguity worth avoiding, because that
province is a plausible alternative owner. So the perimeter samples that fall
outside are counted by what they fall into.
*/
export interface OverhangRequest {
  key: string;
  centres: Array<[number, number]>;
  radius: number;
  samples: number;
}

export interface OverhangResult {
  /** Is the centre itself inside the province? */
  inside: boolean;
  /** Distance from the centre to the nearest border, in map units. */
  clearance: number;
  /** Perimeter samples falling into another land province. */
  land: number;
  /** Perimeter samples falling into another sea province. */
  sea: number;
  /** Perimeter samples falling outside every province. */
  open: number;
}

export async function probeOverhang(
  page: Page,
  requests: OverhangRequest[],
  terrain: Record<string, "sea" | "land" | "unknown">,
): Promise<Record<string, OverhangResult[]>> {
  return page.evaluate(
    (input: { batch: OverhangRequest[]; terrain: Record<string, string> }) => {
      const svg = document.querySelector("svg") as SVGSVGElement;
      const layer = svg.querySelector("#provinces");
      const probe = svg.createSVGPoint();
      const base = (key: string) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : key);

      const svgCTM = svg.getScreenCTM();
      const matrices = new WeakMap<Element, DOMMatrix | null>();
      const intoShape = (shape: SVGGraphicsElement): DOMMatrix | null => {
        if (matrices.has(shape)) return matrices.get(shape) || null;
        const own = shape.getScreenCTM();
        const matrix = own && svgCTM ? own.inverse().multiply(svgCTM) : null;
        matrices.set(shape, matrix);
        return matrix;
      };

      const all: SVGGeometryElement[] = [];
      if (layer) {
        Array.prototype.forEach.call(layer.children, (shape: Element) => {
          if (shape instanceof SVGGeometryElement) all.push(shape);
        });
      }

      const hits = (shape: SVGGeometryElement, x: number, y: number): boolean => {
        const matrix = intoShape(shape);
        probe.x = x;
        probe.y = y;
        const local = matrix ? probe.matrixTransform(matrix) : probe;
        return shape.isPointInFill(local);
      };

      const answer: Record<string, OverhangResult[]> = {};
      for (const request of input.batch) {
        const own = all.filter(
          (shape) => shape.id === request.key || (request.key === base(request.key) && base(shape.id) === request.key),
        );
        const others = all.filter((shape) => !own.includes(shape));

        // The province's own outline as points, for the clearance figure.
        const border: Array<[number, number]> = [];
        for (const shape of own) {
          const length = shape.getTotalLength();
          if (!length) continue;
          const count = Math.max(24, Math.min(400, Math.round(length / 3)));
          const matrix = intoShape(shape);
          const back = matrix ? matrix.inverse() : null;
          for (let i = 0; i < count; i++) {
            const at = shape.getPointAtLength((length * i) / count);
            probe.x = at.x;
            probe.y = at.y;
            const mapped = back ? probe.matrixTransform(back) : at;
            border.push([mapped.x, mapped.y]);
          }
        }

        answer[request.key] = request.centres.map(([cx, cy]) => {
          const inside = own.some((shape) => hits(shape, cx, cy));
          let clearance = Infinity;
          for (const point of border) {
            const d = Math.hypot(point[0] - cx, point[1] - cy);
            if (d < clearance) clearance = d;
          }
          let land = 0;
          let sea = 0;
          let open = 0;
          for (let i = 0; i < request.samples; i++) {
            const angle = (2 * Math.PI * i) / request.samples;
            const x = cx + Math.cos(angle) * request.radius;
            const y = cy + Math.sin(angle) * request.radius;
            if (own.some((shape) => hits(shape, x, y))) continue;
            const neighbour = others.find((shape) => hits(shape, x, y));
            if (!neighbour) open++;
            else if (input.terrain[base(neighbour.id)] === "sea") sea++;
            else land++;
          }
          return {
            inside: inside,
            clearance: clearance === Infinity ? 0 : clearance,
            land: land,
            sea: sea,
            open: open,
          };
        });
      }
      return answer;
    },
    { batch: requests, terrain: terrain },
  );
}

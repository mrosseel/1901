/*
Putting a province's name inside the province.

jDip positions its labels by hand, in its own renderer, at sizes it wrote
without CSS units — which meant every browser drew them at the 16px default
and nobody could see where they actually fell. Once the restyle gives the
labels the size jDip intended, the truth comes out: on sailho a great many
names spill over their own borders, and a name lying across three provinces
tells a reader nothing about which one it belongs to.

So this is an audit with a repair attached. Each label is measured against the
province it names; the ones that escape are moved back in, shrunk if moving is
not enough, and reported as unfixable if neither works — with jDip's own
three-letter brief label offered as the fallback text, which is exactly what
jDip does when a name will not fit.

The repair is coordinated with the unit markers rather than blind to them. A
label that dodges its border and lands on the spot placements/<key>.json puts
a unit has not been fixed, it has been moved from one collision to another, so
the marker and its dislodged partner are obstacles the search must clear by
the same margin RULE B measures.

What this may change: the x and y of a <text>, the translate of a rotated one,
and a font-size. What it may not: the number of elements, their ids, their
order, or one coordinate anywhere in #provinces, #province-centers or
#MapLayer. checkLabelStructure() below is the guarantee.
*/

import type { Page } from "playwright-core";

export interface MarkerSpot {
  unit: [number, number];
  dislodged: [number, number];
  scale: number;
}

/*
How much of a name may hang over its border before anyone would call it out.

Not zero. A descender crossing a coastline by a hair is not what the owner
meant by "labels out of bounds", and demanding an exact zero on a nine-by-nine
lattice makes the search fail on labels that are visibly fine — which is what
the first run did, and it then reached for the brief label and replaced two
dozen readable names with three-letter codes.
*/
export const SPILL_TOLERANCE = 0.03;

/*
And how far out it has to be before the name is worth giving up on.

Between the tolerance and this, a label that cannot be repaired is simply left
where jDip put it and reported. Above it the name is genuinely unreadable as a
label for that province, and jDip's own brief code says more.
*/
export const ABBREVIATE_ABOVE = 0.08;

export interface LabelAuditOptions {
  /** The approved placement table, so labels can keep clear of the markers. */
  placements: Record<string, MarkerSpot>;
  /** The board's marker radius on this map, in map units. */
  radius: number;
  /** RULE B's margin, in marker radii, applied between label and marker. */
  minClearanceRadii: number;
  /** How far a label may shrink before it stops matching its neighbours. */
  scales: number[];
  /** How much of a box may hang over the border and still count as inside. */
  tolerance: number;
  /** Above this much spill, an unfixable name is replaced by its brief code. */
  abbreviateAbove: number;
  /** province key → jDip's own three-letter label, the last resort. */
  brief: Record<string, string>;
}

export interface LabelLine {
  /** Index of this <text> among all texts in the label layer. */
  index: number;
  text: string;
  /** Where the line is anchored, in map units. */
  x: number;
  y: number;
  /** Set when the line is positioned by a transform rather than by x/y. */
  transform: string | null;
}

export interface LabelFit {
  /** The province this label names, decided by hit-testing its own box. */
  province: string | null;
  text: string;
  lines: LabelLine[];
  /** Did the label sit inside its province before anything was done? */
  fitted: boolean;
  /** How far outside it reached, as a share of its own box, before. */
  spillBefore: number;
  /** And after the repair. */
  spillAfter: number;
  /** The move applied, in map units. */
  moved: [number, number];
  /** The size it ended at, as a fraction of the one it started with. */
  scale: number;
  /** Nothing worked: the name is too big for the province at any size. */
  unfixable: boolean;
  /*
  The name fits its province; what it could not do is get clear of the unit
  marker. That is a different complaint with a different fix — the marker is
  the thing that moves next, in the placement pass — so it is not counted as a
  label that will not fit, and the name is left where jDip put it.
  */
  blockedByMarker: boolean;
  /** The brief label offered instead, when there is one. */
  fallback: string | null;
  /** Distance from the label's box to the province's unit marker, after. */
  markerGap: number;
}

/*
Measures every label, repairs the ones that escape, and says what it did.

All of it happens in the page, because every question here is one only an SVG
engine can answer: where a run of text actually lands once a font has been
applied, and whether that box is inside an arbitrary path. The search is a
lattice of offsets around the label's own position, ranked by how little it
moves — jDip's layout is a starting point worth respecting, and the smallest
correction that works is the one least likely to surprise the owner.
*/
export async function auditLabels(
  page: Page,
  svg: string,
  options: LabelAuditOptions,
): Promise<LabelFit[]> {
  await page.setContent(
    "<!doctype html><html><head><style>html,body{margin:0}svg{display:block;width:1200px;height:auto}</style>" +
      "</head><body>" + svg + "</body></html>",
    { waitUntil: "load" },
  );
  await page.waitForTimeout(250);

  return page.evaluate((input: LabelAuditOptions) => {
    const svgRoot = document.querySelector("svg") as SVGSVGElement;
    const provinceLayer = svgRoot.querySelector("#provinces");
    const labelLayer = svgRoot.querySelector("#FullLabelLayer");
    const probe = svgRoot.createSVGPoint();
    const ctm = svgRoot.getScreenCTM();
    if (!ctm || !labelLayer) return [];
    const toMap = ctm.inverse();
    const base = (key: string) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : key);

    /* Live geometry, nothing painted — the same trick the rest of the tooling
       uses, because a hidden layer has no box and no CTM. */
    Array.prototype.forEach.call(svgRoot.querySelectorAll("g"), (layer: Element) => {
      layer.setAttribute("style", (layer.getAttribute("style") || "") + ";display:inline;visibility:hidden");
    });

    // --- the province shapes, and how to ask what is inside one ------------

    const shapesByBase = new Map<string, SVGGeometryElement[]>();
    if (provinceLayer) {
      Array.prototype.forEach.call(provinceLayer.children, (node: Element) => {
        if (!(node instanceof SVGGeometryElement) || !node.id) return;
        const key = base(node.id);
        const list = shapesByBase.get(key) || [];
        list.push(node);
        shapesByBase.set(key, list);
      });
    }
    const matrices = new Map<SVGGeometryElement, DOMMatrix | null>();
    const intoShape = (shape: SVGGeometryElement): DOMMatrix | null => {
      if (matrices.has(shape)) return matrices.get(shape) || null;
      const own = shape.getScreenCTM();
      const matrix = own ? own.inverse().multiply(ctm) : null;
      matrices.set(shape, matrix);
      return matrix;
    };
    const insideProvince = (key: string, x: number, y: number): boolean => {
      const shapes = shapesByBase.get(key);
      if (!shapes) return false;
      for (const shape of shapes) {
        const matrix = intoShape(shape);
        probe.x = x;
        probe.y = y;
        const local = matrix ? probe.matrixTransform(matrix) : probe;
        if (shape.isPointInFill(local)) return true;
      }
      return false;
    };
    const provinceAt = (x: number, y: number): string | null => {
      let found: string | null = null;
      if (!provinceLayer) return null;
      Array.prototype.forEach.call(provinceLayer.children, (node: Element) => {
        if (!(node instanceof SVGGeometryElement) || !node.id) return;
        const matrix = intoShape(node);
        probe.x = x;
        probe.y = y;
        const local = matrix ? probe.matrixTransform(matrix) : probe;
        if (node.isPointInFill(local)) found = base(node.id);
      });
      return found;
    };

    // --- the labels, and how they group into names ------------------------

    interface Box { x: number; y: number; w: number; h: number }
    const boxOf = (node: SVGGraphicsElement): Box | null => {
      const client = node.getBoundingClientRect();
      if (!client.width && !client.height) return null;
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
    const union = (boxes: Box[]): Box => {
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      return {
        x: x,
        y: y,
        w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
        h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
      };
    };

    const texts = Array.prototype.slice.call(labelLayer.querySelectorAll("text")) as SVGGraphicsElement[];
    const anchorOf = (node: SVGGraphicsElement) => {
      const transform = node.getAttribute("transform");
      const move = transform && /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(transform);
      if (move) return { x: Number(move[1]), y: Number(move[2]), transform: transform };
      return {
        x: Number(node.getAttribute("x") || 0),
        y: Number(node.getAttribute("y") || 0),
        transform: null as string | null,
      };
    };

    /*
    A name may be written as several <text> lines — "Village of" then
    "Aeolus" — and they have to move together or the name comes apart. They
    are recognised the way they are written: adjacent in the file, anchored at
    the same x, and a line apart vertically.
    */
    const groups: SVGGraphicsElement[][] = [];
    let current: SVGGraphicsElement[] = [];
    /*
    Lines are joined by where they LAND, not by the attribute that put them
    there. Matching anchor x works for an upright two-line name and fails for
    a rotated one, whose lines each carry their own translate — which is how
    "Prometheus'" and "Cliff" came apart, and were then judged and abbreviated
    as if they were two different names.
    */
    const rotationOf = (node: SVGGraphicsElement): string => {
      const hit = /rotate\(\s*(-?[\d.]+)/.exec(node.getAttribute("transform") || "");
      return hit ? hit[1] : "";
    };
    const stacked = (a: SVGGraphicsElement, b: SVGGraphicsElement): boolean => {
      const first = boxOf(a);
      const second = boxOf(b);
      if (!first || !second) return false;
      /*
      A rotated name's lines march off diagonally, so their upright boxes do
      not sit one above the other and the test below misses them — which split
      "Amazon Village" in two and abbreviated half of it. Lines turned through
      the same angle and anchored a line apart are one name.
      */
      const turn = rotationOf(a);
      if (turn && turn === rotationOf(b)) {
        const from = anchorOf(a);
        const to = anchorOf(b);
        const line = Math.max(first.h, second.h);
        if (Math.hypot(to.x - from.x, to.y - from.y) < line * 2) return true;
      }
      const overlap = Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x);
      const narrower = Math.min(first.w, second.w);
      if (overlap < narrower * 0.4) return false;
      const gap = second.y - (first.y + first.h);
      return gap > -first.h * 0.5 && gap < Math.max(first.h, second.h) * 0.9;
    };
    for (const node of texts) {
      if (current.length === 0) {
        current.push(node);
        continue;
      }
      if (stacked(current[current.length - 1], node)) current.push(node);
      else {
        groups.push(current);
        current = [node];
      }
    }
    if (current.length) groups.push(current);

    // --- how much of a box escapes its province ---------------------------

    /* Sampled on a lattice over the box: a corner test alone calls a name
       lying across a bay "inside" whenever its four corners happen to land on
       land. Nine by nine is finer than anything a reader could see. */
    const spillOf = (key: string, box: Box): number => {
      let outside = 0;
      let total = 0;
      const steps = 9;
      for (let i = 0; i < steps; i++) {
        for (let j = 0; j < steps; j++) {
          const x = box.x + (box.w * (i + 0.5)) / steps;
          const y = box.y + (box.h * (j + 0.5)) / steps;
          total++;
          if (!insideProvince(key, x, y)) outside++;
        }
      }
      return total === 0 ? 0 : outside / total;
    };

    const boxToPoint = (box: Box, px: number, py: number): number => {
      const dx = Math.max(box.x - px, 0, px - (box.x + box.w));
      const dy = Math.max(box.y - py, 0, py - (box.y + box.h));
      return Math.hypot(dx, dy);
    };

    // --- the pass ----------------------------------------------------------

    const out: Array<Record<string, unknown>> = [];
    const wanted = input.minClearanceRadii * input.radius;

    for (const group of groups) {
      const original = group.map((node) => boxOf(node)).filter(Boolean) as Box[];
      if (original.length === 0) continue;
      const whole = union(original);
      const text = group.map((node) => (node.textContent || "").trim()).join(" ");
      const province = provinceAt(whole.x + whole.w / 2, whole.y + whole.h / 2) ||
        provinceAt(anchorOf(group[0]).x, anchorOf(group[0]).y);

      const lines: LabelLine[] = group.map((node) => {
        const anchor = anchorOf(node);
        return {
          index: texts.indexOf(node),
          text: (node.textContent || "").trim(),
          x: anchor.x,
          y: anchor.y,
          transform: anchor.transform,
        };
      });

      if (!province) {
        out.push({
          province: null, text: text, lines: lines, fitted: false,
          spillBefore: 1, spillAfter: 1, moved: [0, 0], scale: 1,
          unfixable: true, blockedByMarker: false, fallback: null, markerGap: 0,
        });
        continue;
      }

      const spillBefore = spillOf(province, whole);
      const spot = input.placements[province];
      const markerRadius = input.radius * ((spot && spot.scale) || 1);

      /* Clear of the marker as well as inside the border. A label that dodges
         its own border onto the unit has not been repaired. */
      const clearsMarkers = (box: Box): boolean => {
        if (!spot) return true;
        if (boxToPoint(box, spot.unit[0], spot.unit[1]) < markerRadius + wanted) return false;
        if (boxToPoint(box, spot.dislodged[0], spot.dislodged[1]) < markerRadius * 0.82 + wanted) return false;
        return true;
      };

      if (spillBefore <= input.tolerance && clearsMarkers(whole)) {
        out.push({
          province: province, text: text, lines: lines, fitted: true,
          spillBefore: spillBefore, spillAfter: spillBefore, moved: [0, 0], scale: 1,
          unfixable: false, blockedByMarker: false, fallback: null,
          markerGap: spot ? boxToPoint(whole, spot.unit[0], spot.unit[1]) - markerRadius : Infinity,
        });
        continue;
      }

      // The province's own extent, which bounds where the label may go.
      const shapes = shapesByBase.get(province) || [];
      let bounds: Box | null = null;
      for (const shape of shapes) {
        const box = boxOf(shape as unknown as SVGGraphicsElement);
        if (box) bounds = bounds ? union([bounds, box]) : box;
      }
      if (!bounds) bounds = whole;

      let best: { dx: number; dy: number; scale: number; spill: number; move: number } | null = null;

      for (const scale of input.scales) {
        // One reflow per size, not per position: the boxes are measured once
        // at this size and then simply translated.
        if (scale !== 1) {
          for (const node of group) {
            const size = parseFloat(getComputedStyle(node).fontSize) || 0;
            node.setAttribute("font-size", String(size * scale));
          }
        }
        const scaled = group.map((node) => boxOf(node)).filter(Boolean) as Box[];
        const scaledWhole = union(scaled);

        const step = Math.max(scaledWhole.h / 2, 4);
        const spanX = Math.max(bounds.w, scaledWhole.w);
        const spanY = Math.max(bounds.h, scaledWhole.h);
        const cols = Math.min(40, Math.max(3, Math.round(spanX / step)));
        const rows = Math.min(40, Math.max(3, Math.round(spanY / step)));

        for (let i = 0; i <= cols; i++) {
          for (let j = 0; j <= rows; j++) {
            const targetX = bounds.x + (bounds.w * i) / cols - scaledWhole.w / 2;
            const targetY = bounds.y + (bounds.h * j) / rows - scaledWhole.h / 2;
            const dx = targetX - scaledWhole.x;
            const dy = targetY - scaledWhole.y;
            const moved = { x: scaledWhole.x + dx, y: scaledWhole.y + dy, w: scaledWhole.w, h: scaledWhole.h };
            if (!clearsMarkers(moved)) continue;
            const spill = spillOf(province, moved);
            if (spill > input.tolerance) continue;
            const move = Math.hypot(dx, dy);
            /* The smallest correction that works. jDip put the name where it
               did for a reason, and a label that jumps across its province is
               a worse surprise than one that shuffles clear. */
            if (!best || spill < best.spill || (spill === best.spill && move < best.move)) {
              best = { dx: dx, dy: dy, scale: scale, spill: spill, move: move };
            }
          }
        }
        // Put the size back before trying the next one.
        for (const node of group) node.removeAttribute("font-size");
        if (best) break;
      }

      if (!best) {
        /* Nothing fits. Whether that is worth replacing the name over depends
           on how badly it was out: a name a hair over its border stays. */
        const bad = spillBefore > input.abbreviateAbove;
        out.push({
          province: province, text: text, lines: lines,
          fitted: spillBefore <= input.tolerance,
          spillBefore: spillBefore, spillAfter: spillBefore, moved: [0, 0], scale: 1,
          unfixable: true,
          blockedByMarker: spillBefore <= input.tolerance,
          fallback: bad ? input.brief[province] || null : null,
          markerGap: spot ? boxToPoint(whole, spot.unit[0], spot.unit[1]) - markerRadius : Infinity,
        });
        continue;
      }

      const finalBox = { x: whole.x + best.dx, y: whole.y + best.dy, w: whole.w, h: whole.h };
      out.push({
        province: province,
        text: text,
        lines: lines,
        fitted: spillBefore === 0,
        spillBefore: spillBefore,
        spillAfter: best.spill,
        moved: [best.dx, best.dy],
        scale: best.scale,
        unfixable: false,
        blockedByMarker: false,
        fallback: null,
        markerGap: spot ? boxToPoint(finalBox, spot.unit[0], spot.unit[1]) - markerRadius : Infinity,
      });
    }
    return out;
  }, options) as unknown as Promise<LabelFit[]>;
}

/*
Applies the repairs to the map text.

A line is moved by rewriting whatever positions it: the x and y attributes for
an ordinary label, the translate of a rotated one. A shrunk line gains an
explicit font-size. Nothing else about the element is touched, and the
elements are rewritten in place, so the file keeps its order and its ids.
*/
export function applyLabelFixes(
  svg: string,
  verdicts: LabelFit[],
  sizes: Map<number, number>,
): { svg: string; moved: number; shrunk: number; abbreviated: number } {
  const byIndex = new Map<number, { dx: number; dy: number; scale: number; fallback: string | null }>();
  let moved = 0;
  let shrunk = 0;
  let abbreviated = 0;
  for (const verdict of verdicts) {
    const shifts = verdict.moved[0] !== 0 || verdict.moved[1] !== 0;
    const shrinks = verdict.scale !== 1;
    const abbreviates = verdict.unfixable && Boolean(verdict.fallback);
    if (!shifts && !shrinks && !abbreviates) continue;
    if (shifts) moved++;
    if (shrinks) shrunk++;
    if (abbreviates) abbreviated++;
    for (const line of verdict.lines) {
      byIndex.set(line.index, {
        dx: verdict.moved[0],
        dy: verdict.moved[1],
        scale: verdict.scale,
        fallback: abbreviates ? verdict.fallback : null,
      });
    }
  }

  // The label layer only, found by walking the <text> elements in order.
  const layerStart = svg.indexOf('<g id="FullLabelLayer"');
  if (layerStart < 0) return { svg: svg, moved: 0, shrunk: 0, abbreviated: 0 };
  const layerEnd = svg.indexOf("</g>", layerStart);
  const head = svg.slice(0, layerStart);
  const body = svg.slice(layerStart, layerEnd);
  const tail = svg.slice(layerEnd);

  let index = 0;
  /* Only the first line of an abbreviated name keeps any text; the rest are
     emptied, because "Aeo" is one line where "Village of / Aeolus" was two. */
  const usedFallback = new Set<string>();
  const rewritten = body.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/g, (whole, attrs: string, inner: string) => {
    const fix = byIndex.get(index++);
    if (!fix) return whole;
    let out = attrs;

    if (fix.dx !== 0 || fix.dy !== 0) {
      const move = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(out);
      if (move) {
        const x = Number(move[1]) + fix.dx;
        const y = Number(move[2]) + fix.dy;
        out = out.replace(move[0], "translate(" + round(x) + "," + round(y) + ")");
      } else {
        out = setAttr(out, "x", round(Number(readAttr(out, "x") || 0) + fix.dx));
        out = setAttr(out, "y", round(Number(readAttr(out, "y") || 0) + fix.dy));
      }
    }
    if (fix.scale !== 1) {
      out = setAttr(out, "data-shrunk", fix.scale);
    }
    if (fix.fallback) {
      const first = !usedFallback.has(fix.fallback);
      usedFallback.add(fix.fallback);
      return "<text" + out + ">" + (first ? fix.fallback : "") + "</text>";
    }
    return "<text" + out + ">" + inner + "</text>";
  });

  return { svg: head + rewritten + tail, moved: moved, shrunk: shrunk, abbreviated: abbreviated };
}

function readAttr(attrs: string, name: string): string | null {
  const hit = new RegExp("\\b" + name + '="([^"]*)"').exec(attrs);
  return hit ? hit[1] : null;
}

function setAttr(attrs: string, name: string, value: string | number): string {
  const hit = new RegExp("\\b" + name + '="[^"]*"').exec(attrs);
  if (hit) return attrs.replace(hit[0], name + '="' + value + '"');
  return attrs + " " + name + '="' + value + '"';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/*
What the label pass is allowed to have changed.

Positions and sizes, and nothing else. The element count, their order, their
ids and their text must all survive — except where a name was replaced by its
brief label, which is reported separately and by name.
*/
export function checkLabelStructure(before: string, after: string): string[] {
  const problems: string[] = [];
  const count = (svg: string) => (svg.match(/<text\b/g) || []).length;
  if (count(before) !== count(after)) {
    problems.push("text element count changed: " + count(before) + " -> " + count(after));
  }
  const ids = (svg: string) => (svg.match(/\bid="[^"]*"/g) || []).sort().join("|");
  if (ids(before) !== ids(after)) problems.push("the set of ids changed");
  return problems;
}

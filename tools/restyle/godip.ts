/*
Puts one of godip's OWN maps into a named style (ADR-024).

The other applier, restyle.ts, works on maps converted from jDip, and it has
it easy: those maps paint every province through a semantic class — `nopower`,
`seapoly`, `neutral` — so a new stylesheet restyles the whole board without
touching a single element. No godip map has a class of any kind. Classical
paints its landmass as one path with `style="fill:#f4d7b5"` over a
sea-coloured rect, and the twenty-two maps drawn after it do the same thing
with more paths. There is nothing to select on. What there is, is a palette.

So this applier substitutes VALUES: it works out which colour this particular
map paints sea in and which it paints land in, and rewrites those two values —
everywhere they are painted — to the style's. That is a more fragile thing
than painting by class, and the whole design here is about making the
fragility visible:

  - the palette is not guessed from the tone. The adjudicator is asked which
    provinces are sea (`/variants/<key>/provinces.json`), the map is asked
    what it paints under each of those provinces, and the answer is a vote.
    A map whose vote is not decisive is REPORTED AND LEFT ALONE rather than
    restyled into something nobody looked at.
  - only fills the vote identified are touched. Black stays black: on these
    maps it is the coastline's drop shadow and the outlines of the names.
  - every output goes through the same structural lock as the other applier,
    widened to godip's own layer names.

What it changes: the two terrain values, an impassable hatch where the map has
one, the strength of the paper grain, the province border stroke, and the
typography of the names layer. What it does not change: one coordinate, one
id, one element.
*/

import {
  carryLength,
  carryTone,
  colourDistance,
  compareStructure,
  compareWholeGeometry,
  luma,
  parseColour,
  toHex,
  viewBoxWidth,
  type StructureDiff,
} from "./tokens.ts";
import type { LoadedStyle } from "./styles.ts";
import type { Page } from "playwright-core";

/*
The layers a godip map keeps its meaning in, and which must survive untouched.

`provinces` is what the board hit-tests a tap against; `province-centers` is
the anchor table every marker is placed from. They are the same two names the
jDip maps use, so the lock list is shared — see LOCKED_LAYERS — and these are
the ones added for godip's own art: the terrain, the borders and the names.
*/
export const GODIP_LOCKED_LAYERS = [
  "provinces",
  "province-centers",
  "supply-centers",
  "background",
  "foreground",
  "names",
];

/** A province and the terrain the adjudicator says it is. */
export interface ProvinceType {
  key: string;
  /** "sea", "land", "coast" (land a fleet may sit on), or "other". */
  type: string;
}

/** What the browser measured about one map. */
export interface MapProbe {
  /** The map's own viewBox width. */
  width: number;
  /** What is painted at the map's corners, where only the backdrop is. */
  backdrop: string | null;
  /** Province key → the fill painted under its shape, as #rrggbb or url(#id). */
  underProvince: Record<string, string>;
  /** Every fill the art paints, with the fraction of the map it covers. */
  coverage: Array<{ fill: string; fraction: number }>;
  /*
  Fills painted by a shape that covers the whole map.

  Every one of these maps lays a paper-noise rect over the finished art, and
  it is on top of everything: sampled naively it would be the only colour the
  map has. It is separated out here — and it is also how the grain is found.
  */
  overlays: Array<{ fill: string; opacity: number; id: string | null }>;
  /** One entry per <text>, with the fill painted under it. */
  labels: Array<{ index: number; text: string; over: string | null; italic: boolean }>;
  /** Provinces the map draws no shape for, so nothing could be sampled. */
  unsampled: string[];
}

/** What the vote decided this map's palette is. */
export interface Palette {
  ok: boolean;
  /** Why not, when it is not. One line, for the coverage table. */
  reason: string;
  sea: string;
  land: string;
  /** Share of the sea and land votes the winning tone took, 0..1. */
  seaConfidence: number;
  landConfidence: number;
  /** The hatch a map paints impassable ground with, by pattern id. */
  impassablePattern: string | null;
  /** The paper-noise pattern laid over the finished map, by pattern id. */
  grainPattern: string | null;
  /*
  Other tones the art paints in quantity: a second land, an inland lake.

  They are carried rather than flattened — each keeps the lightness step it
  had from the base tone it is nearest — because a map that draws two shades
  of land means the two shades.
  */
  extras: Array<{ fill: string; near: "sea" | "land"; fraction: number }>;
}

// --- measuring --------------------------------------------------------------

/*
Everything the browser has to answer, in one page.

The map is loaded, the layers it ships hidden are switched to
visibility:hidden — geometry live, nothing painted, exactly as the placement
tool does it — and then three questions are asked of the real rendering
engine: what is painted under each province, what is painted under each name,
and how much of the map each colour covers. Nothing here decides anything.
*/
export async function probeMap(page: Page, svg: string): Promise<MapProbe> {
  await page.setContent(
    "<!doctype html><html><head><style>html,body{margin:0}svg{display:block;width:1000px;height:auto}</style>" +
      "</head><body>" + svg + "</body></html>",
    { waitUntil: "load" },
  );
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const root = document.querySelector("svg") as SVGSVGElement;
    const box = root.viewBox.baseVal;

    /* The three layers that carry meaning rather than art. They ship hidden,
       and they are shown to the geometry engine without being painted. */
    const hiddenLayers = ["provinces", "province-centers", "supply-centers"];
    const layerOf = (name: string): Element | null =>
      root.querySelector('[id="' + name + '"]') ||
      root.querySelector('[inkscape\\:label="' + name + '"]');

    for (const one of hiddenLayers) {
      const layer = layerOf(one);
      if (layer) {
        layer.setAttribute(
          "style",
          (layer.getAttribute("style") || "") + ";display:inline;visibility:hidden",
        );
      }
    }

    const hex = (value: string): string => {
      const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value.trim());
      if (!rgb) return value.trim().replace(/"/g, "");
      const part = (one: string) => Math.round(Number(one)).toString(16).padStart(2, "0");
      return "#" + part(rgb[1]) + part(rgb[2]) + part(rgb[3]);
    };

    /* The art: every painted shape that is not one of the meaning layers. A
       shape inside a hidden layer would otherwise answer for the colour under
       itself, which is invisible ink. */
    const inHiddenLayer = (node: Element): boolean => {
      let cursor: Element | null = node;
      while (cursor && cursor !== root) {
        const id = cursor.getAttribute("id") || "";
        const label = cursor.getAttribute("inkscape:label") || "";
        if (hiddenLayers.includes(id) || hiddenLayers.includes(label)) return true;
        cursor = cursor.parentElement;
      }
      return false;
    };

    /*
    A drawn shape, and how to get a point in the map into its own coordinates.

    Most are ordinary elements and are their own geometry. Some are not: North
    Sea Wars paints its entire landmass with a single <use> pointing at a path
    in the defs, and a probe that only looks at ordinary elements sees nothing
    there but the sea rect underneath — which is how that map first came out
    with its land and its sea "the same colour". A <use> is followed to what
    it draws, carrying the fill the reference itself sets.
    */
    interface Drawn { node: SVGGeometryElement; paint: Element }
    const art: Drawn[] = [];
    const nodes = root.querySelectorAll("path,rect,polygon,circle,ellipse,polyline,use");
    for (const node of Array.prototype.slice.call(nodes) as Element[]) {
      if (inHiddenLayer(node)) continue;
      if (node instanceof SVGGeometryElement) {
        art.push({ node: node, paint: node });
        continue;
      }
      if (!(node instanceof SVGUseElement)) continue;
      const href = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
      if (!href.startsWith("#")) continue;
      const target = root.querySelector('[id="' + href.slice(1) + '"]');
      if (target instanceof SVGGeometryElement) art.push({ node: target, paint: node });
    }

    const probe = root.createSVGPoint();
    const ctm = root.getScreenCTM();
    if (!ctm) throw new Error("the map has no screen CTM");
    const toMap = ctm.inverse();
    const mapArea = box.width * box.height;

    interface Shape {
      fill: string;
      opacity: number;
      id: string | null;
      into: DOMMatrix | null;
      overlay: boolean;
      node: SVGGeometryElement;
    }
    const shapes: Shape[] = art.map((drawn) => {
      const node = drawn.node;
      /* The paint is the reference's when the shape is drawn through one: a
         <use> sets the fill, and the path in the defs is only the outline. */
      const computed = getComputedStyle(drawn.paint);
      /* And so is the placement — but the referenced path may carry a
         transform of its own, which the reference's CTM does not include. */
      const referenced = drawn.paint !== node;
      const ownTransform = node.transform.baseVal.consolidate();
      const useCTM = drawn.paint.getScreenCTM();
      const own = referenced
        ? (useCTM && ownTransform ? useCTM.multiply(ownTransform.matrix) : useCTM)
        : node.getScreenCTM();
      let area = 0;
      try {
        const bb = node.getBBox();
        area = bb.width * bb.height;
      } catch { /* a shape with no geometry has no area */ }
      const opacity = Number(computed.fillOpacity || "1");
      return {
        fill: hex(computed.fill),
        opacity: Number.isFinite(opacity) ? opacity : 1,
        id: drawn.paint.getAttribute("id"),
        into: own ? own.inverse().multiply(ctm) : null,
        /*
        A wash over the art rather than part of it: it covers the whole map,
        it is painted with a pattern, and it is nearly transparent. All three,
        because two of these maps also paint a full-map rect in the impassable
        hatch at full strength — the unplayable ground beyond the board — and
        that is terrain, not a wash.
        */
        overlay: area > mapArea * 0.9 && computed.fill.includes("url(") && opacity < 0.5,
        node: node,
      };
    });

    /* The topmost art painted at one point in map coordinates. Document order
       is painting order, so the last shape that contains the point wins. */
    const under = (x: number, y: number, withOverlays: boolean): string | null => {
      let top: string | null = null;
      for (const shape of shapes) {
        if (shape.fill === "none" || shape.fill === "") continue;
        if (!withOverlays && shape.overlay) continue;
        probe.x = x;
        probe.y = y;
        const local = shape.into ? probe.matrixTransform(shape.into) : probe;
        try {
          if (shape.node.isPointInFill(local)) top = shape.fill;
        } catch { /* a shape with no fill geometry cannot be stood on */ }
      }
      return top;
    };

    /*
    Points inside one province, in map coordinates.

    The province's own hit shape is the authority on where the province IS, so
    the points are taken from inside it: a grid across its box, keeping the
    ones that land in the fill. Several, not one, because one is too easy to
    get wrong — the centre of a long thin province's box is outside the
    province, and a coastal province's centre can sit on the wrong side of its
    own coastline. What the province is painted in is then the tone that most
    of its inside is painted in, which is what an eye would say too.
    */
    const pointsInside = (drawn: Drawn): Array<{ x: number; y: number }> => {
      const shape = drawn.node;
      let bb: DOMRect;
      try { bb = shape.getBBox(); } catch { return []; }
      const referenced = drawn.paint !== shape;
      const ownTransform = shape.transform.baseVal.consolidate();
      const useCTM = drawn.paint.getScreenCTM();
      const own = referenced
        ? (useCTM && ownTransform ? useCTM.multiply(ownTransform.matrix) : useCTM)
        : shape.getScreenCTM();
      const intoMap = own ? toMap.multiply(own) : null;
      const found: Array<{ x: number; y: number }> = [];
      const steps = 7;
      for (let i = 1; i < steps; i++) {
        for (let j = 1; j < steps; j++) {
          probe.x = bb.x + (bb.width * i) / steps;
          probe.y = bb.y + (bb.height * j) / steps;
          try {
            if (!shape.isPointInFill(probe)) continue;
          } catch { return []; }
          const mapped = intoMap ? probe.matrixTransform(intoMap) : probe;
          found.push({ x: mapped.x, y: mapped.y });
        }
      }
      return found;
    };

    const provinces = layerOf("provinces");
    const underProvince: Record<string, string> = {};
    const unsampled: string[] = [];
    if (provinces) {
      const shapeNodes = provinces.querySelectorAll("path,polygon,rect,circle,ellipse,use");
      for (const node of Array.prototype.slice.call(shapeNodes) as Element[]) {
        const id = node.getAttribute("id");
        if (!id) continue;
        /* A hit shape can be a reference too — North Sea Wars draws two of
           its provinces that way — and it is followed like any other. */
        let drawn: Drawn | null = null;
        if (node instanceof SVGGeometryElement) drawn = { node: node, paint: node };
        else if (node instanceof SVGUseElement) {
          const href = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
          const target = href.startsWith("#")
            ? root.querySelector('[id="' + href.slice(1) + '"]')
            : null;
          if (target instanceof SVGGeometryElement) drawn = { node: target, paint: node };
        }
        if (!drawn) continue;
        const points = pointsInside(drawn);
        const seen = new Map<string, number>();
        for (const point of points) {
          const fill = under(point.x, point.y, false);
          if (fill) seen.set(fill, (seen.get(fill) || 0) + 1);
        }
        let winner = "";
        let best = 0;
        for (const [fill, count] of seen) {
          if (count > best) { winner = fill; best = count; }
        }
        if (winner) underProvince[id] = winner;
        else unsampled.push(id);
      }
    }

    // How much of the map each colour covers, over a plain grid.
    const N = 48;
    const tally = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const fill = under(
          box.x + (box.width * (i + 0.5)) / N,
          box.y + (box.height * (j + 0.5)) / N,
          false,
        );
        if (fill) tally.set(fill, (tally.get(fill) || 0) + 1);
      }
    }

    // The names, and what each one stands on.
    const labels: Array<{ index: number; text: string; over: string | null; italic: boolean }> = [];
    const texts = root.querySelectorAll("text");
    for (let i = 0; i < texts.length; i++) {
      const node = texts[i] as SVGGraphicsElement;
      const client = node.getBoundingClientRect();
      probe.x = client.left + client.width / 2;
      probe.y = client.top + client.height / 2;
      let point = probe.matrixTransform(toMap);
      if (!client.width && !client.height) {
        const own = node.getScreenCTM();
        probe.x = Number(node.getAttribute("x") || 0);
        probe.y = Number(node.getAttribute("y") || 0);
        point = (own ? probe.matrixTransform(own) : probe).matrixTransform(toMap);
      }
      labels.push({
        index: i,
        text: (node.textContent || "").trim().slice(0, 40),
        over: under(point.x, point.y, false),
        italic: getComputedStyle(node).fontStyle === "italic",
      });
    }

    /*
    What is painted at the map's corners.

    On a map with no sea province at all — Pure is seven circles on a ground —
    there is no vote to take, and the backdrop is the only thing that can say
    what the ground tone is. It is read at the four corners, where nothing but
    the backdrop is ever drawn.
    */
    const corners = [
      [box.x + box.width * 0.01, box.y + box.height * 0.01],
      [box.x + box.width * 0.99, box.y + box.height * 0.01],
      [box.x + box.width * 0.01, box.y + box.height * 0.99],
      [box.x + box.width * 0.99, box.y + box.height * 0.99],
    ];
    const atCorner = new Map<string, number>();
    for (const [x, y] of corners) {
      const fill = under(x, y, false);
      if (fill) atCorner.set(fill, (atCorner.get(fill) || 0) + 1);
    }
    let backdrop: string | null = null;
    let backdropCount = 0;
    for (const [fill, count] of atCorner) {
      if (count > backdropCount) { backdrop = fill; backdropCount = count; }
    }

    return {
      width: box.width,
      backdrop: backdrop,
      underProvince: underProvince,
      coverage: Array.from(tally.entries())
        .map(([fill, n]) => ({ fill: fill, fraction: n / (N * N) }))
        .sort((a, b) => b.fraction - a.fraction),
      overlays: shapes.filter((one) => one.overlay)
        .map((one) => ({ fill: one.fill, opacity: one.opacity, id: one.id })),
      labels: labels,
      unsampled: unsampled,
    } as MapProbe;
  }) as Promise<MapProbe>;
}

// --- deciding ---------------------------------------------------------------

/** The pattern a url(#id) fill points at, or null for a plain colour. */
export function patternId(fill: string): string | null {
  const hit = /^url\(["']?#([^)"']+)["']?\)/.exec(fill.trim());
  return hit ? hit[1] : null;
}

/*
How decisive a vote has to be before its winner is believed.

Two thirds is not a tuning knob so much as a definition: below it the map is
painting its sea in more than one way, and a substitution that rewrites one of
those ways produces a board with two seas. Such a map ships unstyled and says
so, which is the whole point of counting the votes.
*/
export const VOTE_THRESHOLD = 2 / 3;

/** A tone dark enough to be an outline or a drop shadow rather than terrain. */
export const INK_LUMA = 0.16;

/*
How many dark strokes per province make a foreground layer decoration.

Every map that draws borders and nothing else comes in under four strokes per
province; North Sea Wars, which draws a celtic knot round the board, comes in
at twenty-four. Six is the gap.
*/
export const DECORATION_RATIO = 6;

/*
Works out which colour this map paints sea in, and which it paints land in.

The adjudicator says which provinces are sea; the map says what is painted
under each one. Every province is one vote, and the winner has to take two
thirds of them. Nothing about the colour itself is used to decide — a khaki
sea and a white land are as readable as a blue one, and two of these
twenty-three maps are exactly that.
*/
export function classifyPalette(probe: MapProbe, provinces: ProvinceType[]): Palette {
  const empty: Palette = {
    ok: false,
    reason: "",
    sea: "",
    land: "",
    seaConfidence: 0,
    landConfidence: 0,
    impassablePattern: null,
    grainPattern: null,
    extras: [],
  };

  const vote = (kinds: string[]): { winner: string; share: number; total: number } => {
    const counted = new Map<string, number>();
    let total = 0;
    for (const province of provinces) {
      /*
      A named coast — "spa/nc", "bul/ec" — votes for nothing.

      The adjudicator calls it sea, because that is what a fleet needs it to
      be, and the map paints it as part of the land province it belongs to,
      because that is where it is. Counted as a sea province it says the land
      tone is the sea tone, which on a map with a coast for every second
      province is enough to lose the vote. Classical, Cold War and Twenty
      Twenty all failed on exactly this before it was excluded.
      */
      if (province.key.includes("/")) continue;
      if (!kinds.includes(province.type)) continue;
      const fill = probe.underProvince[province.key];
      if (!fill || fill === "none") continue;
      // A hatch under a province is impassable ground showing through, not a
      // terrain tone, and it never wins a terrain vote.
      if (patternId(fill)) continue;
      counted.set(fill, (counted.get(fill) || 0) + 1);
      total++;
    }
    let winner = "";
    let best = 0;
    for (const [fill, count] of counted) {
      if (count > best) { winner = fill; best = count; }
    }
    return { winner: winner, share: total ? best / total : 0, total: total };
  };

  // A coast is land a fleet may also stand on, and it is painted as land.
  const sea = vote(["sea"]);
  const land = vote(["land", "coast"]);

  /*
  A variant with no sea at all — Pure is seven circles on a ground — has no
  vote to take, and no need of one: the ground is whatever is painted at the
  map's corners, where nothing else ever is. This is the one place a tone is
  read from the art rather than voted on, and it is safe because there is only
  one thing it could be.
  */
  const anySea = provinces.some((one) => one.type === "sea");
  if (!anySea && land.total > 0 && probe.backdrop && probe.backdrop !== land.winner) {
    return {
      ok: true,
      reason: "",
      sea: probe.backdrop,
      land: land.winner,
      seaConfidence: 1,
      landConfidence: land.share,
      impassablePattern: null,
      grainPattern: probe.overlays.map((one) => patternId(one.fill)).find(Boolean) || null,
      extras: [],
    };
  }

  if (sea.total === 0 || land.total === 0) {
    return {
      ...empty,
      reason: sea.total === 0
        ? "this variant has no sea province to read a water tone from"
        : "no land province could be sampled on this map",
    };
  }
  if (sea.share < VOTE_THRESHOLD || land.share < VOTE_THRESHOLD) {
    return {
      ...empty,
      reason: "the palette vote was not decisive: sea " +
        Math.round(sea.share * 100) + "% of " + sea.total + ", land " +
        Math.round(land.share * 100) + "% of " + land.total +
        " — this map paints its terrain in more tones than a substitution can carry",
    };
  }
  if (sea.winner === land.winner) {
    return {
      ...empty,
      reason: "sea and land are painted the same colour (" + sea.winner +
        "), so there is nothing to substitute apart",
    };
  }

  /* The hatch, and the grain. A pattern painted under a province or over a
     patch of the art is impassable ground; a pattern covering the whole map
     is the paper noise. */
  const grain = probe.overlays.map((one) => patternId(one.fill)).find(Boolean) || null;
  let hatch: string | null = null;
  for (const one of probe.coverage) {
    const id = patternId(one.fill);
    if (id && id !== grain) { hatch = id; break; }
  }

  /* The rest of the palette: anything else the art paints in quantity, filed
     against whichever base tone it is nearer. Ink — the coast shadow, the
     outlines round the names — is left alone. */
  const extras: Palette["extras"] = [];
  for (const one of probe.coverage) {
    if (one.fill === sea.winner || one.fill === land.winner) continue;
    if (patternId(one.fill)) continue;
    if (one.fraction < 0.005) continue;
    if (luma(one.fill) < INK_LUMA) continue;
    extras.push({
      fill: one.fill,
      near: colourDistance(one.fill, sea.winner) < colourDistance(one.fill, land.winner)
        ? "sea"
        : "land",
      fraction: one.fraction,
    });
  }

  return {
    ok: true,
    reason: "",
    sea: sea.winner,
    land: land.winner,
    seaConfidence: sea.share,
    landConfidence: land.share,
    impassablePattern: hatch,
    grainPattern: grain,
    extras: extras,
  };
}

/*
Every fill value this map paints, and what the style paints it with instead.

The two base tones go to the style's two. An extra tone goes to the style's
base tone shifted by the lightness step it had from the map's own, so a map
that draws two shades of land still draws two. A hatch is left to the pattern
rewrite, which needs the definition rather than the value — unless the style
paints impassable ground as a flat colour, in which case the value goes here
after all.
*/
export function planSubstitutions(palette: Palette, style: LoadedStyle): Map<string, string> {
  const plan = new Map<string, string>();
  plan.set(palette.sea.toLowerCase(), style.terrain.sea);
  plan.set(palette.land.toLowerCase(), style.terrain.land);
  for (const extra of palette.extras) {
    const base = extra.near === "sea" ? palette.sea : palette.land;
    const target = extra.near === "sea" ? style.terrain.sea : style.terrain.land;
    plan.set(extra.fill.toLowerCase(), carryTone(target, base, extra.fill));
  }
  if (palette.impassablePattern && !patternId(style.terrain.impassable)) {
    plan.set("url(#" + palette.impassablePattern + ")", style.terrain.impassable);
  }
  return plan;
}

// --- rewriting --------------------------------------------------------------

/** The `<defs>` block and the `<style>` block, which fill substitution skips. */
function protectedRanges(svg: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const name of ["defs", "style"]) {
    const open = new RegExp("<" + name + "\\b[^>]*>", "g");
    let hit: RegExpExecArray | null;
    while ((hit = open.exec(svg)) !== null) {
      const close = svg.indexOf("</" + name + ">", hit.index);
      ranges.push([hit.index, close < 0 ? svg.length : close + name.length + 3]);
    }
  }
  return ranges;
}

/** A colour written any of the ways SVG allows, as one comparable spelling. */
export function normaliseFill(value: string): string {
  const text = value.trim().replace(/\s+/g, " ").toLowerCase();
  const rgb = parseColour(text);
  return rgb ? toHex(rgb) : text.replace(/["']/g, "").replace(/\(\s*/g, "(").replace(/\s*\)/g, ")");
}

/*
Rewrites every fill the plan names, wherever the map paints it.

Both spellings are handled — `fill="#f4d7b5"` and `style="…;fill:#f4d7b5;…"` —
because godip's maps use both, sometimes on the same element. What is NOT
touched is anything inside `<defs>` or `<style>`: the definitions are rewritten
whole, by the pattern pass, and the map's stylesheet is an embedded font.
*/
export function replaceFills(
  svg: string,
  plan: Map<string, string>,
): { svg: string; counts: Map<string, number> } {
  const skip = protectedRanges(svg);
  const guarded = (index: number) => skip.some(([a, b]) => index >= a && index < b);
  const counts = new Map<string, number>();
  const lookup = new Map<string, string>();
  for (const [from, to] of plan) lookup.set(normaliseFill(from), to);

  const swap = (whole: string, before: string, value: string, after: string, index: number) => {
    if (guarded(index)) return whole;
    const target = lookup.get(normaliseFill(value));
    if (target === undefined) return whole;
    const key = normaliseFill(value);
    counts.set(key, (counts.get(key) || 0) + 1);
    return before + target + after;
  };

  let out = svg.replace(
    /(\bfill=")([^"]*)(")/g,
    (whole, before: string, value: string, after: string, index: number) =>
      swap(whole, before, value, after, index),
  );
  out = out.replace(
    /(fill\s*:\s*)([^;"'}]+)([;"'}])/g,
    (whole, before: string, value: string, after: string, index: number) =>
      swap(whole, before, value, after, index),
  );
  return { svg: out, counts: counts };
}

/** One `<pattern id="…">…</pattern>` replaced by another, keeping the id. */
export function replacePattern(svg: string, id: string, definition: string): string | null {
  const open = new RegExp('<pattern\\b[^>]*\\bid="' + id + '"[^>]*?(/)?>').exec(svg);
  if (!open) return null;
  const end = open[1]
    ? open.index + open[0].length
    : svg.indexOf("</pattern>", open.index) + "</pattern>".length;
  /* The style's own pattern, renamed to the id this map already points at, so
     no reference changes and no id is added or lost. */
  const renamed = definition.replace(/\bid="[^"]*"/, 'id="' + id + '"');
  return svg.slice(0, open.index) + renamed + svg.slice(end);
}

/** The text of one layer, found by id or by the editor's label. */
export function godipLayer(svg: string, name: string): { start: number; end: number } | null {
  const open = new RegExp(
    '<g\\b[^>]*\\b(?:id|inkscape:label)="' + name + '"[^>]*?(/)?>',
  ).exec(svg);
  if (!open) return null;
  if (open[1]) return { start: open.index, end: open.index + open[0].length };
  let depth = 1;
  const scan = /<g\b[^>]*?(\/)?>|<\/g>/g;
  scan.lastIndex = open.index + open[0].length;
  let step: RegExpExecArray | null;
  while ((step = scan.exec(svg)) !== null) {
    if (step[0] === "</g>") depth--;
    else if (!step[1]) depth++;
    if (depth === 0) return { start: open.index, end: step.index + step[0].length };
  }
  return { start: open.index, end: svg.length };
}

/** One declaration set on an inline style attribute, replacing any it had. */
export function setStyleProps(style: string, props: Record<string, string>): string {
  const parts = style.split(";").map((one) => one.trim()).filter(Boolean);
  const kept = parts.filter((one) => {
    const name = one.slice(0, one.indexOf(":")).trim();
    return !(name in props);
  });
  for (const [name, value] of Object.entries(props)) kept.push(name + ":" + value);
  return kept.join(";");
}

function withStyle(tag: string, props: Record<string, string>): string {
  const existing = /\bstyle="([^"]*)"/.exec(tag);
  const next = setStyleProps(existing ? existing[1] : "", props);
  if (existing) return tag.replace(existing[0], 'style="' + next + '"');
  return tag.replace(/(\/?)>$/, ' style="' + next + '"$1>');
}

// --- detection, separated from application ----------------------------------

/*
The two decisions the rewrite below makes about the map rather than the style.

They are pulled out because they are DETECTION: they depend on the map and not
on which style is being applied, they are the expensive half, and they are
what a style plan carries so that a second applier — the Go one that composes
maps at serve time — can do the mechanical half without a browser (ADR-026).

Both read the original map. Neither is disturbed by the fill substitution that
runs before them in the rewrite: that pass changes `fill` values outside
`<defs>` and nothing else, so no stroke, no element and no text moves.
*/
const SHAPE = /<(path|polygon|polyline|rect|circle|ellipse)\b([^>]*)>/g;

/** A dark hairline, which is a province border, rather than art or a frame. */
export function isBorderStroke(body: string): boolean {
  const inline = /\bstyle="([^"]*)"/.exec(body);
  const declared = inline ? inline[1] : "";
  if (/filter\s*:/.test(declared) || /\bfilter="/.test(body)) return false;
  const stroke = /(?:^|;)\s*stroke\s*:\s*([^;]+)/.exec(declared) ||
    /\bstroke="([^"]+)"/.exec(body);
  if (!stroke) return false;
  const colour = stroke[1].trim();
  return colour !== "none" && luma(colour) <= 0.4;
}

export interface BorderPlan {
  /** The map has a foreground layer to look in. */
  found: boolean;
  /** Dark strokes in it. */
  candidates: number;
  /** Provinces the probe could sample, which the count is judged against. */
  provinceCount: number;
  /** The layer is drawing rather than borders, so it is left exactly as-is. */
  decoration: boolean;
}

export function borderPlan(svg: string, probe: MapProbe): BorderPlan {
  const layer = godipLayer(svg, "foreground");
  if (!layer) {
    return { found: false, candidates: 0, provinceCount: 0, decoration: false };
  }
  const text = svg.slice(layer.start, layer.end);
  let candidates = 0;
  for (const hit of text.matchAll(SHAPE)) {
    if (isBorderStroke(hit[2])) candidates++;
  }
  const provinceCount = Object.keys(probe.underProvince).length || 1;
  return {
    found: true,
    candidates: candidates,
    provinceCount: provinceCount,
    decoration: candidates > provinceCount * DECORATION_RATIO,
  };
}

export interface NamePlan {
  /** The map has a names layer with live text. */
  found: boolean;
  /** One verdict per `<text>` in that layer, in document order. */
  kinds: Array<"land" | "sea">;
}

/*
Which face each name is set in, decided once, from the art under it.

A name over water is a water name. The label's own rendered centre was
hit-tested against the art by the probe; here that answer is turned into a
verdict. A name over nothing falls back to how the map itself set it — these
maps use italics for water, which is classical's convention.
*/
export function namePlan(svg: string, palette: Palette, probe: MapProbe): NamePlan {
  const names = godipLayer(svg, "names");
  if (!names) return { found: false, kinds: [] };
  const text = svg.slice(names.start, names.end);
  const kinds: Array<"land" | "sea"> = [];
  let index = 0;
  for (const hit of text.matchAll(/<text\b[^>]*>/g)) {
    void hit;
    const label = probe.labels[index++];
    const over = label ? label.over : null;
    if (over && normaliseFill(over) === normaliseFill(palette.sea)) kinds.push("sea");
    else if (over) kinds.push("land");
    else kinds.push(label && label.italic ? "sea" : "land");
  }
  return { found: true, kinds: kinds };
}

export interface GodipRestyleOptions {
  /** Lay the style's grain over the map, where the map has a grain layer. */
  grain: boolean;
  /** Restyle the province borders as well as the terrain. */
  borders: boolean;
}

export interface GodipRestyleResult {
  svg: string;
  notes: string[];
  /** Names set as land, and names set as water. */
  landNames: number;
  seaNames: number;
}

/*
The whole rewrite, in the order the map is read.

Nothing in here adds, removes or moves an element. The four things it does are
each one property: a fill value, a pattern's insides, a stroke, a text's
typography.
*/
export function restyleGodipMap(
  original: string,
  style: LoadedStyle,
  palette: Palette,
  probe: MapProbe,
  options: GodipRestyleOptions,
): GodipRestyleResult {
  const notes: string[] = [];
  const width = viewBoxWidth(original);
  const carry = (value: number) => carryLength(value, style.referenceWidth, width, 1);
  let svg = original;

  // 1. The terrain, by value.
  const plan = planSubstitutions(palette, style);
  const swapped = replaceFills(svg, plan);
  svg = swapped.svg;
  for (const [from, to] of plan) {
    const count = swapped.counts.get(normaliseFill(from)) || 0;
    notes.push("fill " + from + " -> " + to + " on " + count + " element(s)");
  }

  /*
  2. The impassable hatch. The style ships its own, and the map already points
  at a pattern by id: the definition is swapped and the id kept, so every
  reference to it still resolves and no id is added or lost.
  */
  const styleHatch = patternId(style.terrain.impassable);
  if (palette.impassablePattern && styleHatch && style.defs.length) {
    const definition = style.defs.find((one) => one.includes('id="' + styleHatch + '"'));
    const replaced = definition
      ? replacePattern(svg, palette.impassablePattern, definition)
      : null;
    if (replaced) {
      svg = replaced;
      notes.push("swapped the insides of #" + palette.impassablePattern +
        " for the style's hatch, keeping the id");
    } else {
      notes.push("the style's hatch could not be matched to #" + palette.impassablePattern +
        "; the map keeps its own");
    }
  } else if (palette.impassablePattern && !styleHatch) {
    notes.push("this style paints impassable ground as a flat colour, so #" +
      palette.impassablePattern + " was substituted by value");
  }

  /*
  3. The grain. Every one of these maps lays a paper noise over the finished
  art; a style either wants it at its own strength or does not want it. The
  texture stays the map's own — it is a photograph of paper, not a style
  decision — and only its strength changes.
  */
  const grainOverlay = probe.overlays.find((one) => patternId(one.fill));
  if (grainOverlay && grainOverlay.id) {
    const wanted = options.grain && style.grain ? style.grain.opacity : 0;
    const tag = new RegExp('<[a-z]+\\b[^>]*\\bid="' + grainOverlay.id + '"[^>]*?>').exec(svg);
    if (tag) {
      svg = svg.slice(0, tag.index) +
        withStyle(tag[0], { "fill-opacity": String(wanted) }) +
        svg.slice(tag.index + tag[0].length);
      notes.push(wanted
        ? "the map's paper grain set to the style's strength, " + wanted
        : "this style carries no grain, so the map's paper noise was turned off");
    }
  } else if (style.grain && options.grain) {
    notes.push("this map lays down no grain of its own, and none was added");
  }

  /*
  4. The province borders.

  They are the strokes in the foreground layer, which on a godip map is where
  the province edges and the impassable hatches live — the coastline's drop
  shadow is in the background layer, under the land, and is left alone
  because a soft dark edge under a coast is the drawing, not the styling.

  Only a dark hairline is touched. A white outline in this layer is part of a
  name, and a heavy stroke is a frame.

  And the layer has to be borders and little else. North Sea Wars draws a
  celtic knot round its board — 774 small black strokes for 33 provinces — and
  recolouring those to a hairline unpicked the knot into a row of stripes. A
  foreground carrying many times more strokes than the map has provinces is
  decoration, and decoration is drawing rather than styling.
  */
  const borders = borderPlan(original, probe);

  if (options.borders) {
    const layer = godipLayer(svg, "foreground");
    if (!borders.found || !layer) {
      notes.push("this map has no foreground layer; its borders were left as drawn");
    } else {
      const text = svg.slice(layer.start, layer.end);
      if (borders.decoration) {
        notes.push("the foreground holds " + borders.candidates + " dark strokes for " +
          borders.provinceCount + " provinces, which is decoration rather than borders: " +
          "they were left exactly as drawn");
      } else {
        let restyled = 0;
        const redrawn = text.replace(SHAPE, (whole: string, tag: string, body: string) => {
          if (!isBorderStroke(body)) return whole;
          restyled++;
          return withStyle(whole, {
            stroke: style.border.stroke,
            "stroke-width": String(carry(style.border.width)),
            "stroke-opacity": String(style.border.opacity),
            "stroke-linejoin": style.border.linejoin,
          });
        });
        svg = svg.slice(0, layer.start) + redrawn + svg.slice(layer.end);
        notes.push("restyled " + restyled + " province border stroke(s) in #foreground");
      }
    }
  }

  /*
  5. The names.

  Which face a name is set in follows what it stands on, asked of the map the
  same way the other applier asks it: the label's own rendered centre is
  hit-tested against the art, and the terrain underneath decides. A name over
  nothing falls back to how the map itself set it — these maps use italics for
  water, which is classical's own convention and the one every style keeps.

  Sizes are not touched. godip's names are hand-set to fit their provinces,
  and classical's placement table was measured against the boxes they make.
  */
  let landNames = 0;
  let seaNames = 0;
  const named = namePlan(original, palette, probe);
  const names = godipLayer(svg, "names");
  if (named.found && names) {
    const halo = (one: typeof style.typography.land) =>
      one.halo
        ? {
            "paint-order": "stroke",
            stroke: one.halo.color,
            "stroke-width": String(carry(one.halo.width)),
            "stroke-linejoin": "round",
            "stroke-linecap": "round",
          }
        : { stroke: "none" };

    let index = 0;
    /* A tspan inherits the kind of the text it belongs to, and the rewrite
       walks the two in document order, so the last verdict is carried. */
    let lastKind: "land" | "sea" = "land";
    const text = svg.slice(names.start, names.end).replace(
      /<(text|tspan)\b([^>]*)>/g,
      (whole: string, tag: string) => {
        let kind: "land" | "sea";
        if (tag === "text") {
          kind = named.kinds[index++] || "land";
          if (kind === "sea") seaNames++;
          else landNames++;
          lastKind = kind;
        } else {
          kind = lastKind;
        }
        const face = kind === "sea" ? style.typography.sea : style.typography.land;
        return withStyle(whole, {
          "font-family": face.family,
          "font-weight": face.weight,
          "font-style": face.style,
          "letter-spacing": String(carry(face.letterSpacing)),
          fill: face.fill,
          ...halo(face),
        });
      },
    );
    svg = svg.slice(0, names.start) + text + svg.slice(names.end);
    notes.push("set " + (landNames + seaNames) + " name(s) in the style's typography: " +
      landNames + " land, " + seaNames + " water");
    /*
    The faces, where the style embeds any and the map does not already carry
    them. They go into the map's own <style> block, which every godip map has
    for exactly this purpose.
    */
    if (style.fontFaces && !svg.includes("@font-face")) {
      const block = /<style\b[^>]*>/.exec(svg);
      if (block) {
        svg = svg.slice(0, block.index + block[0].length) + "\n" + style.fontFaces + "\n" +
          svg.slice(block.index + block[0].length);
        notes.push("embedded the style's font faces: this map carried none");
      } else {
        notes.push("this map has no <style> block, so the style's faces could not be embedded");
      }
    }
  } else {
    notes.push("this map has no names layer with live text: its names are drawn as outlines, " +
      "so the typography is the map's own");
  }

  return { svg: svg, notes: notes, landNames: landNames, seaNames: seaNames };
}

/*
The structural lock: godip's own layer names, and then the whole document.

This applier adds nothing — no overlay, no definition, no font element it did
not put inside a <style> that was already there — so it can be held to the
stricter promise the other one cannot: every element in the file, in order,
with the geometry it had.
*/
export function checkGodipStructure(original: string, styled: string): StructureDiff {
  const diff = compareStructure(original, styled, GODIP_LOCKED_LAYERS);
  const whole = compareWholeGeometry(original, styled);
  if (whole.length) {
    diff.ok = false;
    diff.problems.push(...whole);
  }
  return diff;
}

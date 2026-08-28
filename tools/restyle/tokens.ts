/*
The classical map's visual system, read off the map itself.

godip's classical map is a hand-drawn Inkscape file. Nothing in it is written
down as a design system, but the system is there and it is small: two fills, a
blurred coastline, a hatch, a noise wash, one border weight and two kinds of
name. This module finds those and nothing else, so the pilot maps are restyled
from what classical actually IS rather than from what someone remembers of it.

Everything here is pure text over the two SVGs — no browser, no parsing of
path data, and nothing that could move a coordinate. The one thing this module
is not allowed to do is change geometry, and the easiest way to guarantee that
is to never look at any.
*/

export interface Typography {
  /** The family stack, most specific first. */
  family: string;
  weight: string;
  style: string;
  /** Letter spacing in classical's own units, per 1524 map units of width. */
  letterSpacing: number;
  /** Font size likewise, kept for reference; sizes are NOT overridden. */
  size: number;
  fill: string;
}

export interface ClassicalTokens {
  /** The width classical's own numbers are quoted against. */
  referenceWidth: number;
  /** The parchment the land is painted in. */
  landFill: string;
  /** The tone the sea and the map's ground are painted in. */
  seaFill: string;
  /** The frame classical draws round its background rect. */
  frameStroke: string;
  /** Province border colour, and its width per referenceWidth units. */
  borderStroke: string;
  borderWidth: number;
  /** The coastline's soft drop shadow: colour, width, and blur deviation. */
  shadowStroke: string;
  shadowWidth: number;
  shadowBlur: number;
  /** The diagonal hatch impassable terrain is filled with, as SVG. */
  impassablePattern: string;
  impassablePatternId: string;
  /** The paper-grain wash laid over the whole map, and how strong it is. */
  noisePattern: string;
  noisePatternId: string;
  noiseOpacity: number;
  /** The @font-face rules, verbatim, so the styled map carries its own face. */
  fontFaces: string;
  /** A province name, and a sea name. */
  land: Typography;
  sea: Typography;
  /** Sea names set as an abbreviation are tracked out this much. */
  seaAbbrevLetterSpacing: number;
}

/* Presentation-only properties. If a rewrite ever emits anything outside this
   set it is no longer a restyle, so the list is the contract. */
export const PRESENTATION_PROPERTIES = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "text-anchor",
  "filter",
  "opacity",
];

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error("the classical map has no " + what + "; it cannot be the style source");
  }
  return value;
}

/** The value of one property out of an inline style attribute. */
export function styleProp(style: string, name: string): string | null {
  const hit = new RegExp("(?:^|;)\\s*" + name + "\\s*:\\s*([^;]+)").exec(style);
  return hit ? hit[1].trim() : null;
}

/** The first element in `svg` whose id is `id`, as raw text. */
export function elementById(svg: string, id: string): string | null {
  const hit = new RegExp('<\\w+\\b[^>]*\\bid="' + id + '"[^>]*>').exec(svg);
  return hit ? hit[0] : null;
}

/*
A whole `<pattern id="...">…</pattern>`, children included.

The self-closing test is done on the matched text rather than by a capture
group, because `[^>]*` will happily eat the closing slash and then report the
tag as open — at which point the slice runs on to the NEXT pattern's close and
returns two patterns as one. That produced a styled map carrying the same
pattern id twice, which in SVG means every reference to it is ambiguous.
*/
export function patternById(svg: string, id: string): string | null {
  const open = new RegExp('<pattern\\b[^>]*\\bid="' + id + '"[^>]*?>').exec(svg);
  if (!open) return null;
  if (open[0].endsWith("/>")) return open[0];
  const end = svg.indexOf("</pattern>", open.index);
  return end < 0 ? null : svg.slice(open.index, end + "</pattern>".length);
}

function attr(tag: string, name: string): string | null {
  const hit = new RegExp("\\b" + name + '="([^"]*)"').exec(tag);
  return hit ? hit[1] : null;
}

/*
Strips the editor's own attributes off a fragment lifted out of classical.

classical is an Inkscape document and declares `xmlns:inkscape` and
`xmlns:sodipodi` at its root. A jDip map declares neither, so a pattern
carrying `inkscape:collect="always"` is a namespace error the moment it lands
there — and SVG is XML, which does not forgive. Inline in an HTML page nothing
happens, because that is parsed as HTML; served on its own, or loaded as an
image, the whole map fails to render and shows as a broken icon. Which is
exactly how it was found.

The attributes carry no visual meaning — they are Inkscape's bookkeeping — so
dropping them changes nothing but the well-formedness.
*/
export function stripEditorAttributes(fragment: string): string {
  return fragment.replace(/\s+(?:inkscape|sodipodi|dc|cc|rdf):[\w-]+="[^"]*"/g, "");
}

/*
Pulls the whole system out of classical's map.svg.

Where the numbers come from, so a future reader can check them against the
file rather than trusting this comment:

  background-rect   the full-map rectangle. Its fill is what classical uses
                    for sea and for the ground the map sits on; its stroke is
                    the hairline frame round the edge.
  path838           the entire landmass as one filled path. Its fill is the
                    parchment. Classical paints sea once and land over it,
                    which is why there are only two tones on the whole map.
  Shape             the same landmass again, stroked and blurred, under the
                    parchment: the soft shadow that makes a coast look drawn.
  foreground        province borders, all of them fill:none stroke:#000 at
                    one unit, and the impassable islands filled with a hatch.
  Noise             a paper grain laid over everything at five percent.
  names             two kinds of text and no others.
*/
export function extractClassical(svg: string): ClassicalTokens {
  const referenceWidth = (() => {
    const box = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg);
    if (!box) return 1524;
    const parts = box[1].trim().split(/[\s,]+/).map(Number);
    return parts[2] || 1524;
  })();

  const background = must(elementById(svg, "background-rect"), "background rect");
  const backgroundStyle = must(attr(background, "style"), "style on the background rect");
  const seaFill = must(styleProp(backgroundStyle, "fill"), "background fill");
  const frameStroke = styleProp(backgroundStyle, "stroke") || "none";

  // The landmass path carries only a fill, which is the whole point of it.
  const landPath = must(
    /<path\b[^>]*style="fill:(#[0-9a-fA-F]{3,6})"[^>]*\/>/.exec(svg),
    "single-fill landmass path",
  );
  const landFill = landPath[1];

  const shadow = must(elementById(svg, "Shape"), "coastline shadow path");
  const shadowStyle = must(attr(shadow, "style"), "style on the coastline shadow");
  const shadowStroke = styleProp(shadowStyle, "stroke") || "#000000";
  const shadowWidth = Number(styleProp(shadowStyle, "stroke-width") || 4);
  const blurRef = /<feGaussianBlur\b[^>]*stdDeviation="([\d.]+)"/.exec(svg);
  const shadowBlur = blurRef ? Number(blurRef[1]) : 5.76;

  /*
  The border weight is read off a real border rather than assumed. Classical's
  foreground is nothing but borders, so the first fill:none stroked path in it
  is representative — and they are in fact all identical.
  */
  const foreground = svg.slice(svg.indexOf('inkscape:label="foreground"'));
  const border = must(
    /style="fill:none;fill-rule:evenodd;stroke:(#[0-9a-fA-F]{3,6});stroke-width:([\d.]+)"/.exec(foreground),
    "province border in the foreground layer",
  );

  const impassablePattern = must(patternById(svg, "impassableStripes"), "impassableStripes pattern");
  const noise = must(elementById(svg, "Noise"), "noise rect");
  const noiseStyle = must(attr(noise, "style"), "style on the noise rect");
  const noiseRef = must(styleProp(noiseStyle, "fill"), "noise fill");
  const noisePatternId = must(/url\(#([^)]+)\)/.exec(noiseRef), "noise pattern reference")[1];
  /*
  Inkscape writes a pattern that only points at another pattern, so the chain
  is followed to the one that actually holds the tile.
  */
  const noiseChain: string[] = [];
  let cursor: string | null = noisePatternId;
  for (let hop = 0; cursor && hop < 4; hop++) {
    const pattern: string | null = patternById(svg, cursor);
    if (!pattern) break;
    noiseChain.push(pattern);
    const href = /xlink:href="#([^"]+)"/.exec(pattern);
    cursor = href ? href[1] : null;
  }

  const fontFaces = svg.match(/@font-face\s*\{[^}]*\}/g) || [];
  if (fontFaces.length === 0) throw new Error("the classical map embeds no @font-face rules");

  /*
  The land sample has to be a name that is actually SET bold and tracked.
  Classical's names layer opens with a text that uses the Bold face but still
  says font-weight:normal and carries no tracking — an Inkscape leftover —
  and taking the first match got the face right and everything else wrong.
  */
  const land = must(
    /<text\b[^>]*style="([^"]*font-weight:bold[^"]*font-family:LibreBaskerville-Bold[^"]*letter-spacing:[^"]*)"/.exec(svg) ||
      /<text\b[^>]*style="([^"]*font-family:LibreBaskerville-Bold[^"]*)"/.exec(svg),
    "a bold province name",
  )[1];
  const sea = must(
    /<text\b[^>]*style="([^"]*font-family:LibreBaskerville-Italic[^"]*letter-spacing:3[^"]*)"/.exec(svg),
    "an italic, tracked-out sea name",
  )[1];

  const typography = (style: string): Typography => ({
    family: must(styleProp(style, "font-family"), "font-family on a name"),
    weight: styleProp(style, "font-weight") || "normal",
    style: styleProp(style, "font-style") || "normal",
    letterSpacing: Number(styleProp(style, "letter-spacing") || 0),
    size: parseFloat(styleProp(style, "font-size") || "16"),
    fill: styleProp(style, "fill") || "#000000",
  });

  const seaType = typography(sea);
  return {
    referenceWidth: referenceWidth,
    landFill: landFill,
    seaFill: seaFill,
    frameStroke: frameStroke,
    borderStroke: border[1],
    borderWidth: Number(border[2]),
    shadowStroke: shadowStroke,
    shadowWidth: shadowWidth,
    shadowBlur: shadowBlur,
    impassablePattern: stripEditorAttributes(impassablePattern),
    impassablePatternId: "impassableStripes",
    noisePattern: stripEditorAttributes(noiseChain.join("\n")),
    noisePatternId: noisePatternId,
    noiseOpacity: Number(styleProp(noiseStyle, "fill-opacity") || 0.05),
    fontFaces: fontFaces.join("\n"),
    land: typography(land),
    sea: { ...seaType, letterSpacing: 0 },
    seaAbbrevLetterSpacing: seaType.letterSpacing,
  };
}

// --- carrying a number from classical's map onto another one ---------------

/*
Classical's numbers are quoted in its own map units, and those mean nothing on
a map drawn eight times larger. A border that reads as a hairline on a
1524-unit map has to be 4.8 units on a 7300-unit one to look the same, and 48
units inside a layer that the map then scales by a tenth.

So every length crosses over as a FRACTION of the map's width, and is then
divided by whatever scale the layer it lands in already applies. This is the
only arithmetic in the restyle, and it touches presentation lengths only —
never a coordinate.
*/
export function carryLength(value: number, from: number, to: number, layerScale = 1): number {
  const scaled = (value / from) * to / (layerScale || 1);
  return Math.round(scaled * 1000) / 1000;
}

/** The uniform scale a transform applies, or 1 when it only moves things. */
export function transformScale(transform: string | null): number {
  if (!transform) return 1;
  const hit = /scale\(\s*(-?[\d.]+)/.exec(transform);
  if (!hit) return 1;
  return Math.abs(Number(hit[1])) || 1;
}

/** The `transform` attribute of one layer, by id. */
export function layerTransform(svg: string, id: string): string | null {
  const tag = elementById(svg, id);
  return tag ? attr(tag, "transform") : null;
}

/** The map's own viewBox width. */
export function viewBoxWidth(svg: string): number {
  const box = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg);
  if (!box) throw new Error("this map has no viewBox");
  const parts = box[1].trim().split(/[\s,]+/).map(Number);
  if (!parts[2]) throw new Error("this map's viewBox has no width");
  return parts[2];
}

// --- the structural guarantee ----------------------------------------------

/*
What a restyle is allowed to have changed, checked rather than promised.

A styled map is served to the same board, hit-tested by the same code and
placed against the same anchor table as the original. If the restyle moved
one coordinate or renamed one id, every one of those breaks quietly — a
province stops being clickable, or a marker sits somewhere it was never
measured for. So the two files are compared element by element, and the tool
refuses to write a file that fails.

Geometry is compared as raw attribute text: `d`, `points`, `x`, `y`, `cx`,
`cy`, `r`, `width`, `height`, `transform` and `viewBox` must be identical
strings. Presentation attributes are expected to differ and are ignored.
*/
export const GEOMETRY_ATTRIBUTES = [
  "d", "points", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "width", "height",
  "transform", "viewBox", "patternUnits", "gradientUnits",
];

export interface StructureSummary {
  /** Every element's tag, in document order. */
  tags: string[];
  /** Every id, sorted. */
  ids: string[];
  /** id or ordinal → the geometry attributes that element carries. */
  geometry: Map<string, string>;
}

/*
A summary built by scanning tags rather than by parsing XML.

Parsing would be tidier, but a DOM parser normalises as it goes — attribute
order, self-closing forms, entity spelling — and a check that compares two
normalised documents cannot see a change the parser smoothed over. Reading the
raw tags compares what will actually be served.
*/
export function summariseStructure(svg: string): StructureSummary {
  const tags: string[] = [];
  const ids: string[] = [];
  const geometry = new Map<string, string>();
  const pattern = /<([A-Za-z_][\w:.-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let match: RegExpExecArray | null;
  let ordinal = 0;
  while ((match = pattern.exec(svg)) !== null) {
    const tag = match[1];
    if (tag === "?xml" || tag.startsWith("!")) continue;
    const body = match[2];
    tags.push(tag);
    const id = /\bid="([^"]*)"/.exec(body);
    const key = id ? "#" + id[1] : "@" + ordinal;
    if (id) ids.push(id[1]);
    const parts: string[] = [];
    for (const name of GEOMETRY_ATTRIBUTES) {
      const hit = new RegExp("\\b" + name + '="([^"]*)"').exec(body);
      if (hit) parts.push(name + "=" + hit[1]);
    }
    geometry.set(key, parts.join("|"));
    ordinal++;
  }
  ids.sort();
  return { tags: tags, ids: ids, geometry: geometry };
}

/*
The layers a restyle is forbidden to touch in any way at all.

These five are the ones the rest of the system reads. `#provinces` is what the
board hit-tests a tap against and what the placement tool asks "is this point
inside". `#province-centers` is the anchor table. `#MapLayer` is the art whose
outlines those two describe. The two label layers are the obstacles every
placement was measured against. Change an element in any of them and something
breaks quietly somewhere else — a province stops being clickable, a marker
sits where nothing measured it.

Outside these, a restyle may add: patterns and filters it needs in `<defs>`,
its stylesheet, and an overlay in a drawing layer that ships empty. Those
additions are listed in the report rather than waved through.
*/
export const LOCKED_LAYERS = [
  "provinces",
  "province-centers",
  "MapLayer",
  "FullLabelLayer",
  "BriefLabelLayer",
];

/** One layer's text, from its opening tag to its matching close. */
export function layerText(svg: string, id: string): string | null {
  const open = new RegExp('<g\\b[^>]*\\bid="' + id + '"[^>]*?(/)?>').exec(svg);
  if (!open) return null;
  if (open[1]) return open[0];
  // Nested <g> is possible, so the close is found by counting depth.
  let depth = 1;
  const scan = /<g\b[^>]*?(\/)?>|<\/g>/g;
  scan.lastIndex = open.index + open[0].length;
  let step: RegExpExecArray | null;
  while ((step = scan.exec(svg)) !== null) {
    if (step[0] === "</g>") depth--;
    else if (!step[1]) depth++;
    if (depth === 0) return svg.slice(open.index, step.index + step[0].length);
  }
  return svg.slice(open.index);
}

export interface StructureDiff {
  ok: boolean;
  problems: string[];
  /** Elements in the locked layers, which must not have changed. */
  lockedElements: number;
  /** Whole-document counts, which may differ by the documented additions. */
  totalBefore: number;
  totalAfter: number;
  /** Every id the restyle introduced, all of which must sit outside the lock. */
  addedIds: string[];
}

/*
Compares two maps and says, in words, anything a restyle must not have done.

Each locked layer is compared on its own so a failure names the layer, and the
whole document is counted as well so an addition can never hide inside one.
*/
export function compareStructure(original: string, styled: string): StructureDiff {
  const problems: string[] = [];
  let lockedElements = 0;

  for (const id of LOCKED_LAYERS) {
    const before = layerText(original, id);
    const after = layerText(styled, id);
    if (before === null && after === null) continue;
    if (before === null || after === null) {
      problems.push("layer #" + id + (before ? " was removed" : " was added"));
      continue;
    }
    const a = summariseStructure(before);
    const b = summariseStructure(after);
    lockedElements += a.tags.length;

    if (a.tags.length !== b.tags.length) {
      problems.push("#" + id + ": element count changed, " + a.tags.length + " -> " + b.tags.length);
      continue;
    }
    for (let i = 0; i < a.tags.length; i++) {
      if (a.tags[i] !== b.tags[i]) {
        problems.push("#" + id + ": element " + i + " changed tag, " + a.tags[i] + " -> " + b.tags[i]);
        break;
      }
    }
    const lost = a.ids.filter((one) => !b.ids.includes(one));
    const gained = b.ids.filter((one) => !a.ids.includes(one));
    if (lost.length) problems.push("#" + id + ": ids lost — " + lost.slice(0, 8).join(", "));
    if (gained.length) problems.push("#" + id + ": ids added — " + gained.slice(0, 8).join(", "));

    for (const [key, value] of a.geometry) {
      const other = b.geometry.get(key);
      if (other === undefined) {
        problems.push("#" + id + ": element " + key + " is gone");
        break;
      }
      if (other !== value) {
        problems.push(
          "#" + id + ": element " + key + " moved — " + value.slice(0, 80) + " -> " + other.slice(0, 80),
        );
        break;
      }
    }
  }

  const whole = summariseStructure(original);
  const wholeStyled = summariseStructure(styled);
  const addedIds = wholeStyled.ids.filter((id) => !whole.ids.includes(id));
  const lostIds = whole.ids.filter((id) => !wholeStyled.ids.includes(id));
  if (lostIds.length) problems.push("ids lost from the document: " + lostIds.slice(0, 8).join(", "));

  return {
    ok: problems.length === 0,
    problems: problems,
    lockedElements: lockedElements,
    totalBefore: whole.tags.length,
    totalAfter: wholeStyled.tags.length,
    addedIds: addedIds,
  };
}

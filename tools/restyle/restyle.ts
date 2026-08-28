/*
Restyles a converted jDip map in godip's classical parchment style (D-016).

    node restyle.ts --variant sailho --variant jdip1900
    node restyle.ts --all

jDip's maps are correct and unlovely: flat #B5DEF8 sea, flat #F7DB94 land, a
black backdrop, and labels in whatever serif the browser has. godip's classical
map is the house style — two paper tones, a hairline border, a diagonal hatch
over impassable ground, a grain wash, and Libre Baskerville set bold for land
and italic for water. This tool reads that system off classical's own map.svg
and applies it to a jDip one.

It is a restyle and nothing else. Every jDip map paints its provinces through
semantic CSS classes — `nopower`, `water`, `seapoly`, `neutral` — so almost
all of the work is done by replacing the stylesheet, and not one drawing
element is touched. The exceptions are counted, checked and reported:

  - patterns and font faces are added to <defs>
  - the grain overlay goes into HighestOrderLayer, which ships empty
  - the black backdrop rect has its fill attribute rewritten
  - label <text> elements gain a class saying whether they name land or water

Which of those a label gets is decided by asking the map, not by reading the
name: the label's own rendered position is hit-tested against the art, and the
class of the shape underneath it decides. Anything that lands on no shape is
reported as unclassifiable rather than guessed at.

Nothing here may move a coordinate, rename an id or add an element to the five
layers the board and the placement table depend on. That is not a promise, it
is a check — see compareStructure() — and the tool refuses to write a file
that fails it.
*/

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../placement/browser.ts";
import { MIN_CLEARANCE_RADII } from "../placement/geometry.ts";
import {
  carryLength,
  compareStructure,
  extractClassical,
  layerTransform,
  transformScale,
  viewBoxWidth,
  type ClassicalTokens,
  type StructureDiff,
} from "./tokens.ts";
import {
  ABBREVIATE_ABOVE,
  SPILL_TOLERANCE,
  applyLabelFixes,
  auditLabels,
  checkLabelStructure,
  type LabelFit,
  type MarkerSpot,
} from "./labels.ts";
import type { Page } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANTS = resolve(HERE, "..", "..", "variants1901");
const OUT = join(HERE, "out");
const PLACEMENTS = resolve(HERE, "..", "..", "placements");

/*
Which of a jDip map's classes mean what.

This is the whole of the per-map knowledge the tool carries, and it is checked
against the map rather than assumed: a class named here that the map does not
use is reported, and a class the map DOES use that is named nowhere is
reported as unmapped, because an unmapped class is a province that would keep
its jDip colour and stand out like a bruise.

The three groups are the only distinctions classical draws: paper, water, and
ground nobody can enter.
*/
/* Every rule the restyle emits is qualified by one of these, so the map's
   stylesheet cannot reach past the map when the board injects it inline. */
export const LABEL_SCOPE = "#FullLabelLayer text, #BriefLabelLayer text";

export const LAND_CLASSES = ["nopower"];
export const SEA_CLASSES = ["water", "seapoly"];
export const IMPASSABLE_CLASSES = ["neutral", "impassable"];

/* Power-coloured classes. jDip ships one per power and the server never uses
   them — ownership is drawn by the board, not baked into the map — but they
   are restyled to the land tone anyway so a stray one cannot flash orange. */
export const POWER_CLASS_PATTERN =
  /^\.((?:unit|sc)?[a-z]+)\s*\{[^}]*fill:[^;}]+[^}]*\}/;

interface Options {
  variants: string[];
  all: boolean;
  classical: string | null;
  server: string;
  grain: boolean;
  write: boolean;
  /** Run the label audit after restyling. */
  labels: boolean;
  /*
  Apply the label repairs, rather than only reporting them.

  Off by default, and deliberately. The audit is safe to run on any map; the
  repair rewrites positions and replaces the odd name with a three-letter
  code, and on 1900 it wanted to abbreviate a third of the map — a dense board
  whose labels nobody has complained about. sailho is the pilot, so sailho is
  what gets fixed, and everything else gets measured and reported first.
  */
  fixLabels: string[];
}

function usage(): string {
  return [
    "restyle — put a converted jDip map into godip's classical style (D-016)",
    "",
    "  --variant <key>    a directory under variants1901/; repeatable",
    "  --all              every variant1901 directory holding a map.svg",
    "  --classical <path> the style source (default: godip's classical map.svg)",
    "  --server <url>     where to fetch classical from when there is no path",
    "  --no-grain         leave off the paper-grain wash",
    "  --no-labels        skip the label audit",
    "  --fix-labels [key] apply the label repairs; bare applies to every",
    "                     variant in the run, with a key only to that one",
    "  --dry-run          report and check, but write nothing",
    "",
    "Writes variants1901/<key>/map-styled.svg beside the original, plus",
    "before/after renders under tools/restyle/out/.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    variants: [],
    all: false,
    classical: null,
    server: process.env.MAP_SERVER || "http://localhost:8192",
    grain: true,
    write: true,
    labels: true,
    fixLabels: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variant" || arg === "-v") options.variants.push(argv[++i]);
    else if (arg === "--all") options.all = true;
    else if (arg === "--classical") options.classical = argv[++i];
    else if (arg === "--server") options.server = argv[++i];
    else if (arg === "--no-grain") options.grain = false;
    else if (arg === "--no-labels") options.labels = false;
    else if (arg === "--fix-labels") {
      /* A bare flag fixes every variant in the run; a key after it fixes only
         that one, which is how sailho is piloted without touching 1900. */
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) options.fixLabels.push(argv[++i]);
      else options.fixLabels.push("*");
    }
    else if (arg === "--dry-run") options.write = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error("unknown argument " + JSON.stringify(arg));
  }
  return options;
}

/*
Where classical's map lives.

The Go module cache is the honest source — it is the file the server itself
serves — but a checkout without a warm cache has to fall back to the running
server, which answers with the same bytes.
*/
async function readClassical(options: Options): Promise<{ svg: string; from: string }> {
  if (options.classical) {
    return { svg: await readFile(options.classical, "utf8"), from: options.classical };
  }
  const home = process.env.HOME || "";
  const modules = join(home, "go", "pkg", "mod", "github.com", "zond");
  if (existsSync(modules)) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(modules);
    const godip = entries.filter((name: string) => name.startsWith("godip@")).sort().pop();
    if (godip) {
      const path = join(modules, godip, "variants", "classical", "svg", "map.svg");
      if (existsSync(path)) return { svg: await readFile(path, "utf8"), from: path };
    }
  }
  const url = options.server + "/variants/classical/map.svg";
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + " answered " + response.status);
  return { svg: await response.text(), from: url };
}

// --- what the map says about itself ---------------------------------------

interface MapFacts {
  key: string;
  width: number;
  /** The scale the art layer applies, so lengths can be pre-divided by it. */
  artScale: number;
  /** Every class the map's own stylesheet defines. */
  declared: string[];
  /** Every class actually used on an element, with how many times. */
  used: Map<string, number>;
  /** Whether the supply centre layer holds anything to restyle. */
  supplyCentreElements: number;
  /*
  The size and alignment jDip chose for each of its label classes, kept
  verbatim. These are a LAYOUT decision, not a style one: jDip sized each
  label to fit the province it names, and — more to the point — every entry in
  placements/<key>.json was measured against the label boxes these produce.
  Restyling the face is a restyle; resizing the labels would silently
  invalidate the placement table.
  */
  labelMetrics: Map<string, string>;
  /** Label sizes whose missing CSS unit the restyle put back. */
  repairedSizes: string[];
}

/*
Which classes end up on a `<text>`.

Read off the elements rather than guessed from the name, because jDip is not
consistent about it: sailho calls them `labeltext`, `ltsmall` and `ltmed`,
1900 calls them `labeltext06` through `labeltext14`, and the label LAYER
carries a class of its own that every text inside inherits.
*/
function textClasses(svg: string): Set<string> {
  const found = new Set<string>();
  for (const hit of svg.matchAll(/<text\b[^>]*\bclass="([^"]+)"/g)) {
    for (const name of hit[1].trim().split(/\s+/)) found.add(name);
  }
  for (const layer of ["FullLabelLayer", "BriefLabelLayer"]) {
    const tag = new RegExp('<g\\b[^>]*\\bid="' + layer + '"[^>]*?>').exec(svg);
    const name = tag && /\bclass="([^"]+)"/.exec(tag[0]);
    if (name) for (const one of name[1].trim().split(/\s+/)) found.add(one);
  }
  return found;
}

/*
Each text class's own font-size and text-anchor, and nothing else — with the
unit jDip forgot.

jDip writes `font-size:150`, which is valid as an SVG presentation attribute
and invalid as a CSS declaration: CSS wants a unit on any length but zero, so
a browser throws the whole declaration away and the label falls back to the
initial 16px. On sailho, whose map is 7300 units wide, that renders every
province name as a two-pixel smudge — which is exactly how these maps have
looked since they were converted, and why the names are unreadable.

jDip's own renderer is lenient about it, so the numbers are right and only the
spelling is wrong. Appending `px` — which in SVG means one user unit — makes
the size jDip asked for the size the browser draws, and changes nothing else.
*/
function readLabelMetrics(svg: string): { metrics: Map<string, string>; repaired: string[] } {
  const wanted = textClasses(svg);
  const metrics = new Map<string, string>();
  const repaired: string[] = [];
  for (const rule of svg.matchAll(/\.([A-Za-z][\w-]*)\s*\{([^}]*)\}/g)) {
    if (!wanted.has(rule[1])) continue;
    const keep: string[] = [];
    for (const property of ["font-size", "text-anchor"]) {
      const hit = new RegExp(property + "\\s*:\\s*([^;}]+)").exec(rule[2]);
      if (!hit) continue;
      let value = hit[1].trim();
      if (property === "font-size" && /^[\d.]+$/.test(value)) {
        repaired.push("." + rule[1] + " " + value + " -> " + value + "px");
        value += "px";
      }
      keep.push(property + ":" + value);
    }
    if (keep.length) metrics.set(rule[1], keep.join("; "));
  }
  return { metrics: metrics, repaired: repaired };
}

function readMapFacts(key: string, svg: string): MapFacts {
  const declared = Array.from(
    new Set((svg.match(/\.[A-Za-z][\w-]*\s*\{/g) || []).map((one) => one.replace(/[.{\s]/g, ""))),
  ).sort();
  const used = new Map<string, number>();
  for (const hit of svg.matchAll(/\bclass="([^"]+)"/g)) {
    for (const name of hit[1].trim().split(/\s+/)) {
      used.set(name, (used.get(name) || 0) + 1);
    }
  }
  const labels = readLabelMetrics(svg);
  const scLayer = /<g\b[^>]*\bid="SupplyCenterLayer"[^>]*?(\/)?>/.exec(svg);
  let supplyCentreElements = 0;
  if (scLayer && !scLayer[1]) {
    const end = svg.indexOf("</g>", scLayer.index);
    supplyCentreElements = (svg.slice(scLayer.index, end).match(/<(path|circle|rect|use|polygon)\b/g) || []).length;
  }
  return {
    key: key,
    width: viewBoxWidth(svg),
    artScale: transformScale(layerTransform(svg, "MapLayer")),
    declared: declared,
    used: used,
    supplyCentreElements: supplyCentreElements,
    labelMetrics: labels.metrics,
    repairedSizes: labels.repaired,
  };
}

// --- which labels name water ----------------------------------------------

export interface LabelVerdict {
  index: number;
  text: string;
  kind: "land" | "sea" | "impassable" | "unknown";
  /** The class of the shape the label was found standing on. */
  over: string | null;
}

/*
Asks the map which labels sit over water.

A name is styled as a sea name because it names a sea, and the only thing that
knows which is the art underneath it. So each label's rendered centre is taken
through the screen CTM into map coordinates — the same route the placement
tool uses, and the only one that survives a layer transform — and hit-tested
against every shape in the art layer with isPointInFill. The class of the
topmost shape it lands in decides.

A label sitting over nothing at all is left alone and reported. Reading the
name for the word "Sea" would guess right most of the time on 1900 and would
be hopeless on sailho, where the water is called things like "Poseidon's
Cauldron" and the land is called "Amazon".
*/
async function classifyLabels(page: Page, svg: string): Promise<LabelVerdict[]> {
  await page.setContent(
    "<!doctype html><html><head><style>html,body{margin:0}svg{display:block;width:1200px;height:auto}</style>" +
      "</head><body>" + svg + "</body></html>",
    { waitUntil: "load" },
  );
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const svgRoot = document.querySelector("svg") as SVGSVGElement;
    const art = svgRoot.querySelector("#MapLayer");
    const probe = svgRoot.createSVGPoint();
    const ctm = svgRoot.getScreenCTM();
    if (!ctm) throw new Error("the map has no screen CTM");
    const toMap = ctm.inverse();

    /*
    A hidden layer has no box and no CTM, and the brief label layer ships
    hidden, so everything is switched to visibility:hidden — geometry live,
    nothing painted — exactly as the placement tool does it.
    */
    Array.prototype.forEach.call(svgRoot.querySelectorAll("g"), (layer: Element) => {
      layer.setAttribute("style", (layer.getAttribute("style") || "") + ";display:inline;visibility:hidden");
    });

    const shapes: SVGGeometryElement[] = [];
    if (art) {
      Array.prototype.forEach.call(art.querySelectorAll("*"), (node: Element) => {
        if (node instanceof SVGGeometryElement) shapes.push(node);
      });
    }
    const intoShape = new Map<SVGGeometryElement, DOMMatrix | null>();
    const matrixFor = (shape: SVGGeometryElement): DOMMatrix | null => {
      if (intoShape.has(shape)) return intoShape.get(shape) || null;
      const own = shape.getScreenCTM();
      const matrix = own ? own.inverse().multiply(ctm) : null;
      intoShape.set(shape, matrix);
      return matrix;
    };

    const classOf = (node: Element): string => {
      // The class may sit on the shape or on a group above it.
      let cursor: Element | null = node;
      while (cursor && cursor !== svgRoot) {
        const name = cursor.getAttribute("class");
        if (name) return name.trim().split(/\s+/)[0];
        cursor = cursor.parentElement;
      }
      return "";
    };

    const out: Array<{ index: number; text: string; kind: string; over: string | null }> = [];
    const texts = svgRoot.querySelectorAll("text");
    for (let i = 0; i < texts.length; i++) {
      const node = texts[i] as SVGGraphicsElement;
      const client = node.getBoundingClientRect();
      let point: { x: number; y: number };
      if (client.width || client.height) {
        probe.x = client.left + client.width / 2;
        probe.y = client.top + client.height / 2;
        const mapped = probe.matrixTransform(toMap);
        point = { x: mapped.x, y: mapped.y };
      } else {
        // A text with no box still has its own x/y, carried through its CTM.
        const own = node.getScreenCTM();
        probe.x = Number(node.getAttribute("x") || 0);
        probe.y = Number(node.getAttribute("y") || 0);
        const screen = own ? probe.matrixTransform(own) : probe;
        const mapped = screen.matrixTransform(toMap);
        point = { x: mapped.x, y: mapped.y };
      }

      // Last shape wins: the art is painted in document order, so the one
      // drawn last is the one a reader sees under the label.
      let over: string | null = null;
      for (const shape of shapes) {
        const matrix = matrixFor(shape);
        probe.x = point.x;
        probe.y = point.y;
        const local = matrix ? probe.matrixTransform(matrix) : probe;
        try {
          if (shape.isPointInFill(local)) over = classOf(shape);
        } catch {
          /* a shape with no fill geometry cannot be stood on */
        }
      }
      out.push({
        index: i,
        text: (node.textContent || "").trim().slice(0, 40),
        kind: "unknown",
        over: over,
      });
    }
    return out;
  }) as Promise<LabelVerdict[]>;
}

function kindOf(over: string | null): LabelVerdict["kind"] {
  if (!over) return "unknown";
  if (SEA_CLASSES.includes(over)) return "sea";
  if (IMPASSABLE_CLASSES.includes(over)) return "impassable";
  if (LAND_CLASSES.includes(over)) return "land";
  return "unknown";
}

// --- the new stylesheet ----------------------------------------------------

/*
Builds the stylesheet that replaces the map's own.

jDip's rules are kept for everything the board draws itself — order strokes,
unit colours, the invisible click rectangles — because those are behaviour,
not style, and the server overrides them anyway. What is replaced is every
rule that paints the map: the terrain classes, the label classes, and the
backdrop.
*/
export function buildStylesheet(
  tokens: ClassicalTokens,
  facts: MapFacts,
  grain: boolean,
): string {
  const carry = (value: number) => carryLength(value, tokens.referenceWidth, facts.width, facts.artScale);
  const border = carry(tokens.borderWidth);
  const lines: string[] = [];

  lines.push("/* Restyled from godip's classical map by tools/restyle (D-016).");
  lines.push("   Terrain, borders and names follow classical; everything the board");
  lines.push("   draws for itself is left as jDip wrote it. */");
  lines.push(tokens.fontFaces);
  lines.push("");

  /* Qualified by the art layer, so a class name as ordinary as ".water"
     cannot reach into the app that embeds this map. */
  const terrain = (selector: string, fill: string) =>
    "#MapLayer " + selector + " { fill:" + fill + "; stroke:" + tokens.borderStroke +
    "; stroke-width:" + border + "; }";

  lines.push("/* terrain — two paper tones and a hatch, which is all classical has */");
  for (const name of LAND_CLASSES) lines.push(terrain("." + name, tokens.landFill));
  for (const name of SEA_CLASSES) lines.push(terrain("." + name, tokens.seaFill));
  for (const name of IMPASSABLE_CLASSES) {
    lines.push(terrain("." + name, "url(#" + tokens.impassablePatternId + ")"));
  }
  lines.push("");

  /*
  Every power class painted as plain land. The board colours ownership itself
  from the game state, so a power colour baked into the map is only ever a
  chance to contradict it.
  */
  const powers = facts.declared.filter(
    (name) =>
      !LAND_CLASSES.includes(name) &&
      !SEA_CLASSES.includes(name) &&
      !IMPASSABLE_CLASSES.includes(name) &&
      !name.startsWith("unit") &&
      !name.startsWith("sc") &&
      !name.startsWith("label") &&
      !name.startsWith("lt") &&
      /* jDip's order-drawing classes carry a fill too, but they style the
         arrows the board draws, not the ground. Painting them parchment
         would be harmless and is still wrong, so they are named out. */
      !/^(shadow|varwidth)|order$|line$/.test(name) &&
      !["invisible", "unordered", "coasttext", "unittext", "provtext", "titletext"].includes(name),
  );
  if (powers.length) {
    lines.push("/* power colours: the board draws ownership, so the map does not */");
    for (const name of powers) lines.push(terrain("." + name, tokens.landFill));
    lines.push("");
  }

  /*
  The ground. jDip paints a black rectangle behind the art, which under a
  parchment palette reads as a hole; and on sailho that rectangle does not
  quite reach the edge of the viewBox, so the page showed through in a thin
  frame. Painting the root as well closes the gap without adding an element.
  */
  lines.push("/* the ground and the backdrop behind the art, in the water tone */");
  /*
  Scoped to an SVG that actually holds this map. The board injects the map
  INLINE into the app's own document, where an SVG stylesheet is not sandboxed
  — a bare `svg { }` rule here would repaint every other SVG on the page.
  */
  lines.push("svg:has(#MapLayer) { background:" + tokens.seaFill + "; }");
  lines.push("#MapLayer > rect:first-of-type { fill:" + tokens.seaFill + "; stroke:none; }");
  lines.push("");

  /*
  Names. Sizes are deliberately NOT touched: jDip chose them to fit its own
  provinces, and every placement in placements/<key>.json was measured against
  the label boxes they produce. What changes is the face, the weight and the
  tracking — classical's typography, on jDip's layout.
  */
  const land = tokens.land;
  const sea = tokens.sea;
  const track = (value: number) => carry(value);
  lines.push("/* names: classical's typography on jDip's own sizes and positions */");
  /* Scoped to the label layers for the same reason: an unqualified `text`
     rule would reach every other SVG in the page that embeds this map. */
  lines.push(
    LABEL_SCOPE + " { font-family:" + land.family + "; fill:" + land.fill + "; stroke:none; }",
  );
  /* jDip's own sizes, carried across untouched. Dropping these was the first
     version's bug: every label fell back to the default 16 user units, which
     on a map eight times classical's width is a speck. */
  for (const [name, metrics] of Array.from(facts.labelMetrics.entries()).sort()) {
    /*
    Two forms, because jDip puts the size class in two places: on the text
    itself, and on the label LAYER for every text that does not carry one.
    The layer form sets the size on the group and lets it inherit, which is
    what keeps it weaker than a text's own class — a rule that matched the
    layer's descendants directly would outrank the text and flatten every
    size on the map to one. That is exactly what the first scoped version
    did, and half of sailho's names vanished into a two-pixel default.
    */
    lines.push("#FullLabelLayer ." + name + ", #BriefLabelLayer ." + name + " { " + metrics + " }");
    lines.push("#FullLabelLayer." + name + ", #BriefLabelLayer." + name + " { " + metrics + " }");
  }
  lines.push(
    ".map-landname { font-family:" + land.family + "; font-weight:" + land.weight +
      "; font-style:" + land.style + "; letter-spacing:" + track(land.letterSpacing) + "; }",
  );
  lines.push(
    ".map-seaname { font-family:" + sea.family + "; font-weight:" + sea.weight +
      "; font-style:" + sea.style + "; letter-spacing:" + track(tokens.seaAbbrevLetterSpacing) + "; }",
  );
  lines.push(
    ".map-seaname.map-longname { letter-spacing:" + track(sea.letterSpacing) + "; }",
  );
  lines.push("");

  if (grain) {
    lines.push("/* classical's paper grain, laid over the finished map */");
    lines.push(
      "#paper-grain { fill:url(#" + tokens.noisePatternId + "); fill-opacity:" +
        tokens.noiseOpacity + "; stroke:none; pointer-events:none; }",
    );
    lines.push("");
  }

  lines.push("/* kept from jDip: these are the board's business, not the map's */");
  lines.push(".invisible { stroke:#000000; fill:#000000; fill-opacity:0.0; opacity:0.0; }");
  return lines.join("\n");
}

// --- the rewrite ------------------------------------------------------------

export interface RestyleResult {
  svg: string;
  facts: MapFacts;
  labels: LabelVerdict[];
  unmappedClasses: string[];
  missingClasses: string[];
  diff: StructureDiff;
  notes: string[];
}

function restyleOne(
  original: string,
  tokens: ClassicalTokens,
  facts: MapFacts,
  labels: LabelVerdict[],
  grain: boolean,
): { svg: string; notes: string[] } {
  const notes: string[] = [];
  let svg = original;

  // 1. The stylesheet. jDip wraps it in CDATA, which is kept.
  const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style>/.exec(svg);
  if (!styleBlock) throw new Error("this map has no <style> block to replace");
  const sheet = buildStylesheet(tokens, facts, grain);
  svg =
    svg.slice(0, styleBlock.index) +
    styleBlock[0].replace(styleBlock[1], "\n<![CDATA[\n" + sheet + "\n]]>\n").replace(/<!\[CDATA\[\s*<!\[CDATA\[/, "<![CDATA[").replace(/\]\]>\s*\]\]>/, "]]>") +
    svg.slice(styleBlock.index + styleBlock[0].length);

  // 2. Patterns into <defs>. Nothing outside defs is added by this step.
  const defs = /<defs\b[^>]*>/.exec(svg);
  if (!defs) throw new Error("this map has no <defs> to put patterns in");
  const additions = [tokens.impassablePattern, grain ? tokens.noisePattern : ""].filter(Boolean);
  svg =
    svg.slice(0, defs.index + defs[0].length) +
    "\n<!-- classical style, added by tools/restyle -->\n" +
    additions.join("\n") +
    "\n" +
    svg.slice(defs.index + defs[0].length);
  notes.push("added " + additions.length + " pattern definition(s) to <defs>");

  /*
  3. The backdrop. jDip paints a black rectangle behind the art, which under a
  parchment palette reads as a hole in the map. It is the one drawing element
  whose own attribute has to change, because it carries its fill inline where
  no stylesheet can reach it.
  */
  const backdrop = /(<rect\b[^>]*\bfill=")black("[^>]*>)/.exec(svg);
  if (backdrop) {
    svg = svg.slice(0, backdrop.index) + backdrop[1] + tokens.seaFill + backdrop[2] +
      svg.slice(backdrop.index + backdrop[0].length);
    notes.push("repainted the black backdrop rect in the sea tone");
  } else {
    notes.push("no black backdrop rect found; nothing to repaint");
  }

  /*
  4. Label classes. A <text> is told whether it names land or water so the
  stylesheet can set it accordingly; the element keeps its own class, which is
  what carries its size.
  */
  let index = 0;
  let land = 0;
  let sea = 0;
  svg = svg.replace(/<text\b([^>]*)>/g, (whole, body: string) => {
    const verdict = labels[index++];
    if (!verdict) return whole;
    const kind = kindOf(verdict.over);
    // Impassable ground and anything unplaceable are named like land, which
    // is what they are: the hatch is terrain, not water.
    const extra = kind === "sea" ? "map-seaname" : "map-landname";
    if (kind === "sea") sea++;
    else land++;
    /* A multi-word name is set at classical's plain sea tracking; a short
       one is an abbreviation and is tracked out, as classical tracks NRG. */
    const longName = /\s/.test(verdict.text) || verdict.text.length > 5;
    const classes = extra + (kind === "sea" && longName ? " map-longname" : "");
    const existing = /\bclass="([^"]*)"/.exec(body);
    if (existing) {
      return "<text" + body.replace(existing[0], 'class="' + existing[1] + " " + classes + '"') + ">";
    }
    return "<text" + body + ' class="' + classes + '">';
  });
  notes.push("classified " + labels.length + " labels: " + land + " as land, " + sea + " as water");

  // 5. The grain overlay, into a drawing layer that ships empty.
  if (grain) {
    const box = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg);
    const parts = (box ? box[1] : "0 0 0 0").trim().split(/[\s,]+/).map(Number);
    const rect =
      '<rect id="paper-grain" x="' + parts[0] + '" y="' + parts[1] +
      '" width="' + parts[2] + '" height="' + parts[3] + '"/>';
    const empty = /<g\b[^>]*\bid="HighestOrderLayer"[^>]*\/>/.exec(svg);
    if (empty) {
      svg = svg.slice(0, empty.index) +
        '<g id="HighestOrderLayer">' + rect + "</g>" +
        svg.slice(empty.index + empty[0].length);
      notes.push("laid the paper grain into HighestOrderLayer, which shipped empty");
    } else {
      notes.push("HighestOrderLayer is not empty; the grain was left off");
    }
  }

  return { svg: svg, notes: notes };
}

// --- reporting --------------------------------------------------------------

function tokenReport(tokens: ClassicalTokens, from: string): string {
  const lines: string[] = [];
  lines.push("CLASSICAL STYLE TOKENS");
  lines.push("  read from            " + from);
  lines.push("  reference width      " + tokens.referenceWidth + " map units");
  lines.push("  land (parchment)     " + tokens.landFill);
  lines.push("  sea / ground         " + tokens.seaFill);
  lines.push("  map frame stroke     " + tokens.frameStroke);
  lines.push("  province border      " + tokens.borderStroke + " at " + tokens.borderWidth + " units");
  lines.push("  coastline shadow     " + tokens.shadowStroke + " at " + tokens.shadowWidth +
    " units, blurred " + tokens.shadowBlur);
  lines.push("  impassable hatch     #" + tokens.impassablePatternId + " (" +
    tokens.impassablePattern.length + " bytes)");
  lines.push("  paper grain          #" + tokens.noisePatternId + " at " +
    tokens.noiseOpacity + " opacity (" + tokens.noisePattern.length + " bytes)");
  lines.push("  embedded faces       " + tokens.fontFaces.length + " bytes");
  lines.push("  land name            " + tokens.land.family + ", " + tokens.land.weight +
    " " + tokens.land.style + ", " + tokens.land.size + "px, tracking " + tokens.land.letterSpacing);
  lines.push("  sea name             " + tokens.sea.family + ", " + tokens.sea.weight +
    " " + tokens.sea.style + ", " + tokens.sea.size + "px, tracking " + tokens.sea.letterSpacing);
  lines.push("  sea abbreviation     tracked out to " + tokens.seaAbbrevLetterSpacing);
  return lines.join("\n");
}

function mapReport(result: RestyleResult, tokens: ClassicalTokens): string {
  const lines: string[] = [];
  const facts = result.facts;
  lines.push("");
  lines.push("=".repeat(66));
  lines.push(facts.key);
  lines.push("=".repeat(66));
  lines.push("  viewBox width        " + facts.width + " (classical is " + tokens.referenceWidth + ")");
  lines.push("  art layer scale      " + facts.artScale);
  lines.push("  border carried to    " +
    carryLength(tokens.borderWidth, tokens.referenceWidth, facts.width, facts.artScale) +
    " units inside #MapLayer");
  lines.push("");
  lines.push("  CLASS MAPPING (what the map actually uses)");
  const rows: string[] = [];
  for (const [name, count] of Array.from(facts.used.entries()).sort()) {
    let role = "label / behaviour, left alone";
    if (LAND_CLASSES.includes(name)) role = "-> land parchment " + tokens.landFill;
    else if (SEA_CLASSES.includes(name)) role = "-> sea tone " + tokens.seaFill;
    else if (IMPASSABLE_CLASSES.includes(name)) role = "-> impassable hatch";
    rows.push("    " + name.padEnd(16) + String(count).padStart(4) + " uses   " + role);
  }
  lines.push(rows.join("\n"));
  if (result.unmappedClasses.length) {
    lines.push("  PAINTED BUT UNMAPPED   " + result.unmappedClasses.join(", "));
    lines.push("    These paint a shape and this tool has no rule for them, so they");
    lines.push("    would keep their jDip colour. Add them to a class list above.");
  } else {
    lines.push("  every painting class the map uses is mapped");
  }
  if (result.missingClasses.length) {
    lines.push("  MAPPED BUT UNUSED      " + result.missingClasses.join(", ") +
      "  (this map does not use them)");
  }
  lines.push("");
  lines.push("  SUPPLY CENTRE MARKERS");
  lines.push("    " + (facts.supplyCentreElements === 0
    ? "SupplyCenterLayer ships empty: this map draws no SC markers, so there"
    : facts.supplyCentreElements + " elements, restyled with the terrain classes"));
  if (facts.supplyCentreElements === 0) {
    lines.push("    is nothing to restyle. The board draws ownership itself.");
  }
  lines.push("");
  lines.push("  LABELS");
  if (facts.repairedSizes.length) {
    lines.push("    jDip wrote these sizes without a CSS unit, so every browser threw");
    lines.push("    the declaration away and drew the label at the 16px default. The");
    lines.push("    unit is put back; the number is jDip's own:");
    for (const one of facts.repairedSizes) lines.push("      " + one);
  }
  const byKind = new Map<string, number>();
  for (const label of result.labels) {
    const kind = kindOf(label.over);
    byKind.set(kind, (byKind.get(kind) || 0) + 1);
  }
  for (const [kind, count] of Array.from(byKind.entries()).sort()) {
    lines.push("    " + kind.padEnd(12) + String(count).padStart(4));
  }
  const unknown = result.labels.filter((label) => kindOf(label.over) === "unknown");
  if (unknown.length) {
    lines.push("    UNCLASSIFIABLE — these sit over no shape at all and are set as");
    lines.push("    land names, which is the safe default:");
    for (const label of unknown.slice(0, 12)) {
      lines.push("      " + JSON.stringify(label.text) + (label.over ? " (over ." + label.over + ")" : ""));
    }
    if (unknown.length > 12) lines.push("      … and " + (unknown.length - 12) + " more");
  }
  lines.push("");
  lines.push("  STRUCTURE CHECK — the restyle must not have moved anything");
  lines.push("    locked layers        " + result.diff.lockedElements + " elements compared");
  lines.push("    document elements    " + result.diff.totalBefore + " -> " + result.diff.totalAfter);
  lines.push("    ids added            " + (result.diff.addedIds.join(", ") || "none"));
  lines.push("    verdict              " + (result.diff.ok ? "PASS — geometry and ids identical" : "FAIL"));
  for (const problem of result.diff.problems) lines.push("      " + problem);
  lines.push("");
  lines.push("  WHAT CHANGED");
  for (const note of result.notes) lines.push("    " + note);
  return lines.join("\n");
}

/** Parses the styled map the way an <img> would, and returns any error. */
async function checkWellFormed(page: Page, svg: string): Promise<string | null> {
  return page.evaluate((text: string) => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const error = doc.querySelector("parsererror");
    return error ? (error.textContent || "parse error").trim().slice(0, 200) : null;
  }, svg);
}


// --- the label pass ---------------------------------------------------------

/*
How far a label may shrink before it stops matching its neighbours.

The same reasoning as the marker scales in the placement tool: below about
three quarters a name reads as a different kind of label rather than a smaller
one, and a map whose names are all slightly different sizes looks worse than a
map with one name in the wrong place.
*/
export const LABEL_SCALES = [1, 0.9, 0.8, 0.75];

/*
The label pass is written for any map, not for sailho.

Nothing in labels.ts knows which variant it is looking at: it reads the label
layer, the province shapes and the approved placement table, all of which
every map has. Classical's twenty-one unavoidable marker-on-name overlaps are
the obvious next customer — a marker that cannot avoid a name is often a name
that could have moved instead — but classical's labels are hand-set by the
same person who hand-corrected its placements, so that pass waits for them to
ask. sailho is the pilot, and --fix-labels is opt-in for exactly that reason.
*/

/*
The board's marker radius on a map of this width, at the pane placement is
judged on. It is duplicated here rather than imported so the restyle does not
drag the whole placement tool in; geometry.ts is the authority and the two are
checked against each other by tools/restyle's own test.
*/
function markerRadiusFor(width: number): number {
  const paneWidth = 1440 - 340 - 16;
  const paneHeight = 900 - 16;
  const fitAll = Math.max(width, width * 0.9 * (paneWidth / paneHeight));
  return Math.min(Math.max(12 * (fitAll / paneWidth), 8), Math.max(8, width / 25));
}

/*
The approved placement table for this variant, if it has one.

Labels are moved clear of the markers, so the table is an input to the label
pass. A variant with no table yet gets an empty one and the labels are placed
against the border alone — which is right: there is nothing to collide with.
*/
async function readPlacements(key: string): Promise<Record<string, MarkerSpot> & { __any?: boolean }> {
  const path = join(PLACEMENTS, key + ".json");
  if (!existsSync(path)) return {};
  const table = JSON.parse(await readFile(path, "utf8")) as Record<string, MarkerSpot>;
  return Object.assign(table, { __any: true });
}

/*
jDip's own three-letter labels, by province.

They are the fallback for a name that will not fit its province at any size,
and they are not invented here — jDip ships them in BriefLabelLayer for
exactly this purpose, and uses them itself on a crowded board.
*/
function readBriefLabels(svg: string): Record<string, string> {
  const out: Record<string, string> = {};
  const start = svg.indexOf('<g id="BriefLabelLayer"');
  if (start < 0) return out;
  const end = svg.indexOf("</g>", start);
  const layer = svg.slice(start, end);
  const codes: string[] = [];
  for (const hit of layer.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)) {
    const text = hit[1].trim();
    if (text) codes.push(text);
  }
  // The brief label IS the province key on these maps, lower-cased.
  for (const code of codes) out[code.toLowerCase()] = code;
  return out;
}

function labelReportOf(
  key: string,
  verdicts: LabelFit[],
  applied: { moved: number; shrunk: number; abbreviated: number },
  problems: string[],
  hasPlacements: boolean,
  applyIt: boolean,
): string {
  const lines: string[] = [];
  const escaped = verdicts.filter((v) => v.spillBefore > SPILL_TOLERANCE);
  const fixed = escaped.filter((v) => !v.unfixable);
  const stuck = verdicts.filter((v) => v.unfixable && !v.blockedByMarker);
  const blocked = verdicts.filter((v) => v.blockedByMarker);
  const renamed = stuck.filter((v) => v.fallback);
  const left = stuck.filter((v) => !v.fallback);
  lines.push("");
  lines.push("  LABELS IN BOUNDS — a name belongs inside the province it names");
  lines.push("    " + (applyIt
    ? "APPLIED: the repairs below are in the file this run wrote."
    : "AUDIT ONLY: nothing below was applied. Re-run with --fix-labels to apply."));
  lines.push("    labels found         " + verdicts.length);
  lines.push("    already inside       " + verdicts.filter((v) => v.spillBefore === 0).length);
  lines.push("    spilled over         " + escaped.length);
  lines.push("    repaired             " + fixed.length +
    " (" + applied.moved + " moved, " + applied.shrunk + " shrunk)");
  lines.push("    could not be fixed   " + stuck.length +
    " — " + renamed.length + " replaced by jDip's brief code, " + left.length + " left as they were");
  lines.push("    inside but on a marker " + blocked.length +
    " — the name fits; the marker is what moves, in the placement pass");
  lines.push("    markers avoided      " + (hasPlacements
    ? "yes — placements/" + key + ".json was read, and a repaired label clears"
    : "no placement table yet, so only the border constrained the search"));
  if (hasPlacements) {
    lines.push("                         the unit and dislodged markers by the RULE B margin");
  }
  lines.push("");
  if (escaped.length) {
    lines.push("    PER LABEL (only the ones that were out of bounds)");
    lines.push("    province   outside before  after   moved      size   name");
    for (const v of escaped.sort((a, b) => b.spillBefore - a.spillBefore).slice(0, 40)) {
      lines.push(
        "    " + String(v.province).padEnd(10) +
          (Math.round(v.spillBefore * 100) + "%").padStart(12) +
          (v.unfixable ? "  STUCK" : (Math.round(v.spillAfter * 100) + "%").padStart(7)) +
          (Math.hypot(v.moved[0], v.moved[1])).toFixed(0).padStart(9) +
          v.scale.toFixed(2).padStart(8) + "   " + v.text.slice(0, 34),
      );
    }
    if (escaped.length > 40) lines.push("    … and " + (escaped.length - 40) + " more");
    lines.push("");
  }
  if (stuck.length) {
    lines.push("    WILL NOT FIT INSIDE ITS PROVINCE AT ANY SIZE OR POSITION");
    lines.push("    The province is too small for the name. jDip's own brief label is");
    lines.push("    used where it has one — which is what jDip does on a crowded board.");
    for (const v of stuck) {
      lines.push("      " + String(v.province).padEnd(10) + JSON.stringify(v.text).slice(0, 40) +
        (v.fallback ? "  -> " + v.fallback : "  (no brief label; left where it was)"));
    }
    lines.push("");
  }
  lines.push("    STRUCTURE  " + (problems.length === 0
    ? "PASS — positions and sizes only; every element, id and order kept"
    : "FAIL — " + problems.join("; ")));
  return lines.join("\n");
}

// --- looking at it ----------------------------------------------------------

/*
The two maps rendered side by side at the same size.

The check above proves nothing moved; only a picture can say whether the
result is worth looking at, and that is the question the restyle exists to
answer. Both halves are drawn through the same headless Chromium the rest of
the tooling uses, so what the file shows here is what a browser will show.
*/
async function renderComparison(page: Page, key: string, before: string, after: string): Promise<void> {
  /*
  Each map goes in its own <img>, not inline.

  An inline SVG's <style> applies to the whole HTML document, so the first
  attempt at this drew both maps in one page and the styled sheet repainted
  the original — a before-and-after where both halves were "after". A data
  URI renders the file exactly as a browser would on its own, which is also
  the honest thing for a comparison to show.
  */
  const dataUri = (svg: string) =>
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const frame = (title: string, svg: string) =>
    "<figure><figcaption>" + title + '</figcaption><img src="' + dataUri(svg) + '"></figure>';
  await page.setContent(
    "<!doctype html><html><head><style>" +
      "html,body{margin:0;background:#14161a;font:13px system-ui,sans-serif;color:#9aa3b2}" +
      "main{display:flex;gap:14px;padding:14px}" +
      "figure{margin:0;flex:1;min-width:0}" +
      "figcaption{padding:0 0 8px}" +
      "img{display:block;width:100%;height:auto;background:#0e1013}" +
      "</style></head><body><main>" +
      frame(key + " — as converted from jDip", before) +
      frame(key + " — classical style", after) +
      "</main></body></html>",
    { waitUntil: "load" },
  );
  await page.waitForTimeout(1200);
  const main = await page.$("main");
  if (main) await main.screenshot({ path: join(OUT, key + ".compare.png") });
}

// --- running ----------------------------------------------------------------

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let keys = options.variants;
  if (options.all) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(VARIANTS, { withFileTypes: true });
    keys = entries
      .filter((entry: { isDirectory(): boolean; name: string }) =>
        entry.isDirectory() && existsSync(join(VARIANTS, entry.name, "map.svg")))
      .map((entry: { name: string }) => entry.name);
  }
  if (keys.length === 0) {
    console.log(usage());
    process.exit(1);
  }

  const classical = await readClassical(options);
  const tokens = extractClassical(classical.svg);
  const report: string[] = [tokenReport(tokens, classical.from)];
  console.log(report[0]);

  await mkdir(OUT, { recursive: true });
  const browser = await openBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let failed = 0;

  try {
    for (const key of keys) {
      const path = join(VARIANTS, key, "map.svg");
      const original = await readFile(path, "utf8");
      const facts = readMapFacts(key, original);
      const labels = (await classifyLabels(page, original)).map((label) => ({
        ...label,
        kind: kindOf(label.over),
      }));

      const painting = new Set([...LAND_CLASSES, ...SEA_CLASSES, ...IMPASSABLE_CLASSES]);
      /* A class is "painting" if the map uses it on a shape AND its own rule
         sets a fill. Anything like that with no mapping would survive the
         restyle in jDip's colours, so it is called out. */
      const paintsFill = new Set(
        (original.match(/\.[A-Za-z][\w-]*\s*\{[^}]*fill:[^}]*\}/g) || []).map((rule: string) =>
          rule.slice(1, rule.indexOf("{")).trim(),
        ),
      );
      const unmapped = Array.from(facts.used.keys())
        .filter((name) => paintsFill.has(name) && !painting.has(name))
        .filter((name) => !name.startsWith("label") && !name.startsWith("lt") &&
          !["coasttext", "unittext", "provtext", "titletext", "invisible"].includes(name))
        .sort();
      const missing = Array.from(painting).filter((name) => !facts.used.has(name)).sort();

      const built = restyleOne(original, tokens, facts, labels, options.grain);
      const diff = compareStructure(original, built.svg);
      /*
      SVG is XML, and a map that does not parse renders as nothing at all.
      Inline in an HTML page the browser forgives it — which is how a stray
      namespace prefix got as far as being served — so the file is parsed the
      strict way, as an image would be, before it is written.
      */
      const wellFormed = await checkWellFormed(page, built.svg);
      if (wellFormed) {
        diff.ok = false;
        diff.problems.push("the styled map is not well-formed XML: " + wellFormed);
      }
      const result: RestyleResult = {
        svg: built.svg,
        facts: facts,
        labels: labels,
        unmappedClasses: unmapped,
        missingClasses: missing,
        diff: diff,
        notes: built.notes,
      };

      const text = mapReport(result, tokens);
      report.push(text);
      console.log(text);

      if (!diff.ok) {
        failed++;
        console.error("\n  REFUSING to write " + key + ": the structure check failed.\n");
        continue;
      }
      /*
      The label pass. It runs on the STYLED map, because the sizes it measures
      are the ones the restyle just made real — measuring jDip's broken 16px
      labels would repair a problem nobody sees and miss the one they do.
      */
      let styled = built.svg;
      let labelReport = "";
      if (options.labels) {
        const placements = await readPlacements(key);
        const brief = readBriefLabels(original);
        const verdicts = await auditLabels(page, styled, {
          placements: placements,
          radius: markerRadiusFor(facts.width),
          minClearanceRadii: MIN_CLEARANCE_RADII,
          scales: LABEL_SCALES,
          tolerance: SPILL_TOLERANCE,
          abbreviateAbove: ABBREVIATE_ABOVE,
          brief: brief,
        });
        const applied = applyLabelFixes(styled, verdicts, new Map());
        const labelProblems = checkLabelStructure(styled, applied.svg);
        const applyIt = options.fixLabels.includes("*") || options.fixLabels.includes(key);
        labelReport = labelReportOf(
          key, verdicts, applied, labelProblems, Boolean(placements.__any), applyIt);
        report.push(labelReport);
        console.log(labelReport);
        if (applyIt && labelProblems.length === 0) styled = applied.svg;
      }

      if (options.write) {
        await writeFile(join(VARIANTS, key, "map-styled.svg"), styled);
        console.log("\n  wrote variants1901/" + key + "/map-styled.svg (" +
          Math.round(styled.length / 1024) + " KB, was " +
          Math.round(original.length / 1024) + " KB)");
      }
      await renderComparison(page, key, original, styled);
      console.log("  rendered tools/restyle/out/" + key + ".compare.png");
    }
  } finally {
    await browser.close();
  }

  await writeFile(join(OUT, "restyle.report.txt"), report.join("\n") + "\n");
  console.log("\nreport written to " + join(OUT, "restyle.report.txt"));
  if (failed) process.exit(1);
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

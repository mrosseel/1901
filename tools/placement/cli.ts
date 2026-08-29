/*
Programmatic placement verification for variant maps (DESIGN.md D-003).

    node cli.ts --variant classical --variant coldwar
    node cli.ts --all
    node cli.ts --variant twentytwenty --no-images

Classical's unit anchors were placed by hand. Every other variant's come out of
a generator that computed them and never checked them, so a marker can sit on
a province name, on a supply centre glyph, or half outside its own province,
where it stops saying which power holds what. This tool measures all three on
real browser geometry, proposes a better table, and draws the two side by side
so the difference can be judged by eye rather than by argument.

One thing the numbers need read carefully: a supply centre's anchor IS the
supply centre glyph on a hand-drawn map — that is where a Diplomacy unit has
always been drawn. A high "covers a supply centre" count is therefore the
normal state of a good map, not a defect, which is why it is scored far below
name overlap and never on its own decides where a marker goes.

Nothing here writes into the app. The JSON, the reports and the images are the
deliverable; serving them is a separate step once the look is approved.
*/

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePoles, openBrowser, measureMap, type MapGeometry, type Terrain } from "./browser.ts";
import {
  COAST_REACH,
  audit,
  measureClearance,
  place,
  placeBrief,
  shippedPlacement,
  type Audit,
  type BriefDecision,
  type ClearanceStudy,
  type Decision,
  type Deviation,
  type PlacementTable,
} from "./audit.ts";
import {
  COAST_SEPARATION,
  MIN_CLEARANCE_RADII,
  REFERENCE_VIEWPORTS,
  baseKey,
  distance,
  isPlaced,
  markerRadius,
  standardRadius,
  stressRadius,
} from "./geometry.ts";
import { renderComparison } from "./render.ts";
import { buildEditor } from "./editor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
/*
Where an approved table lives. The convention, and the whole of it:

  placements/<key>.json       the table the SERVER reads for that variant
  placements/<key>.hand.json  a table a person corrected by hand

The hand file is an input — it seeds the next run and is never overwritten by
the tool. The plain file is the output, and it is the one authority the server
has. Writing it is what "approved" means.
*/
const PLACEMENTS = resolve(HERE, "..", "..", "placements");

interface Options {
  variants: string[];
  all: boolean;
  /*
  Variants --all must leave alone. An approved table can hold corrections a
  person made by hand, and re-deriving it would throw them away silently; the
  only safe way to run the whole set is to be able to name the exceptions.
  */
  skip: string[];
  server: string;
  images: boolean;
  editor: boolean;
  /** An explicit seed table, overriding the per-variant hand file. */
  seed: string | null;
  useSeed: boolean;
  /** The RULE B threshold in radii, if the caller wants to pin it. */
  minClearance: number | null;
  /** Write the result to placements/<key>.json as the served table. */
  approve: boolean;
  /*
  Add the brief code positions to an approved table and change nothing else.

  An approved table can hold corrections a person made by hand, and the codes
  are a later question than the markers were: re-deriving the whole table to
  answer it would throw those corrections away to gain a field. This reads
  placements/<key>.json, places the codes AGAINST the markers it finds there,
  and writes the same table back with one key added per province.
  */
  briefOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    variants: [],
    all: false,
    skip: [],
    server: process.env.MAP_SERVER || "http://localhost:8192",
    images: true,
    editor: false,
    seed: null,
    useSeed: true,
    minClearance: null,
    approve: false,
    briefOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variant" || arg === "-v") options.variants.push(argv[++i]);
    else if (arg === "--all") options.all = true;
    else if (arg === "--skip") options.skip.push(argv[++i]);
    else if (arg === "--server") options.server = argv[++i];
    else if (arg === "--no-images") options.images = false;
    else if (arg === "--editor") options.editor = true;
    else if (arg === "--seed") options.seed = argv[++i];
    else if (arg === "--no-seed") options.useSeed = false;
    else if (arg === "--min-clearance") options.minClearance = Number(argv[++i]);
    else if (arg === "--approve") options.approve = true;
    else if (arg === "--brief-only") options.briefOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error("unknown argument " + JSON.stringify(arg));
  }
  return options;
}

function usage(): string {
  return [
    "placement — verify and re-place unit anchors on variant maps",
    "",
    "  --variant <key>       a variant to work on; repeatable",
    "  --all                 every variant the server lists",
    "  --skip <key>          a variant --all must leave alone; repeatable",
    "  --server <url>        where /variants lives (default http://localhost:8192)",
    "  --no-images           skip the before/after PNGs",
    "  --editor              also write the self-contained drag-to-correct page",
    "  --seed <file>         a privileged table to start from and mostly keep",
    "  --no-seed             ignore placements/<key>.hand.json",
    "  --min-clearance <n>   pin the RULE B margin, in marker radii",
    "  --approve             also write placements/<key>.json, which the server reads",
    "  --brief-only          add the brief code positions to the approved table",
    "                        and change nothing else in it",
    "",
    "With no --seed, placements/<key>.hand.json is used when it exists. Its",
    "positions are kept unless a hard constraint or a placement rule overrules",
    "them, and every departure is listed in the report.",
    "",
    "Writes out/<key>.json, out/<key>.report.txt and out/<key>.compare.png,",
    "and with --editor, out/editor-<key>.html.",
  ].join("\n");
}

async function readSeed(path: string): Promise<PlacementTable> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  // Both shapes are accepted: the editor exports a bare table, the tool's own
  // out/<key>.json wraps one under "placement".
  const table = (parsed && typeof parsed === "object" && "placement" in parsed
    ? (parsed as { placement: PlacementTable }).placement
    : parsed) as PlacementTable;
  for (const [key, spot] of Object.entries(table)) {
    if (!spot || !Array.isArray(spot.unit) || !Array.isArray(spot.dislodged)) {
      throw new Error(path + ": " + key + " has no unit or dislodged point");
    }
  }
  return table;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + " answered " + response.status);
  return response.text();
}

async function listVariants(server: string): Promise<string[]> {
  const body = await fetchText(server + "/variants");
  const parsed = JSON.parse(body) as Array<{ key: string }>;
  return parsed.map((entry) => entry.key).filter(Boolean);
}

/*
One line of the before-and-after table. `higherIsBetter` matters: a rising
count of clean provinces is the good direction, a rising count of anything
else is not.
*/
function bar(label: string, before: number, after: number, higherIsBetter = false, width = 26): string {
  const improved = higherIsBetter ? after > before : after < before;
  const verdict = after === before ? "same" : improved ? "better" : "worse";
  return (
    "  " + label.padEnd(width) + String(before).padStart(5) + " -> " + String(after).padStart(5) + "   " + verdict
  );
}

interface ReportInput {
  key: string;
  map: MapGeometry;
  r: number;
  before: Audit;
  after: Audit;
  decisions: Decision[];
  terrain: Terrain;
  stress: { radius: number; before: Audit; after: Audit };
  /** The clearance study the RULE B threshold was taken from, and the source. */
  study: ClearanceStudy | null;
  studySource: string;
  minClearance: number;
  seedPath: string | null;
  seed: PlacementTable | null;
  /** The seed table judged by the same tests, when there is one. */
  seedAudit: Audit | null;
  deviations: Deviation[];
  keptSeeds: number;
  /** The table this run produced, and the anchors it started from. */
  result: PlacementTable;
  shipped: PlacementTable;
  /** The same clearance measurement run over the table just produced. */
  outcome: ClearanceStudy;
  /** Where each province's three-letter code ended up. */
  brief: BriefDecision[];
}

function report(input: ReportInput): string {
  const { key, map, r, before, after, decisions, terrain, stress } = input;
  const lines: string[] = [];
  lines.push("placement audit — " + key);
  lines.push("=".repeat(64));
  lines.push("");
  lines.push("map viewBox        " + [map.viewBox.x, map.viewBox.y, map.viewBox.w, map.viewBox.h].join(" "));
  lines.push("marker radius      " + r.toFixed(2) + " map units — the standard, see below");
  for (const pane of REFERENCE_VIEWPORTS) {
    lines.push("                     " + pane.name.padEnd(18) + markerRadius(map.viewBox, pane).toFixed(2));
  }
  lines.push("provinces          " + before.summary.provinces);
  lines.push("name labels found  " + map.labels.length);
  lines.push("supply glyphs      " + map.supplyCentres.length);
  for (const note of map.notes) lines.push("note               " + note);
  lines.push("");
  lines.push("Placement is judged at the laptop radius: the whole map on screen,");
  lines.push("which is where a marker is smallest against the map. A phone opens");
  lines.push("stepped in 1.6x, so the same 12px marker covers more map units there;");
  lines.push("that case is reported at the end as a stress test, not as a standard.");
  lines.push("");
  lines.push("VIOLATIONS                before -> after");
  lines.push(bar("marker outside province", before.summary.outside, after.summary.outside));
  lines.push(bar("marker covers a name", before.summary.coversName, after.summary.coversName));
  lines.push(bar("marker covers an SC glyph", before.summary.coversSupplyCentre, after.summary.coversSupplyCentre));
  lines.push(bar("dislodged outside", before.summary.dislodgedOutside, after.summary.dislodgedOutside));
  lines.push(bar("dislodged covers a name", before.summary.dislodgedCoversName, after.summary.dislodgedCoversName));
  lines.push(bar("clean provinces", before.summary.clean, after.summary.clean, true));
  lines.push("");
  if (input.seedAudit) {
    // The comparison that actually matters on a seeded run: the hand table
    // this started from, against what came out.
    const hand = input.seedAudit;
    lines.push("AGAINST THE HAND TABLE     hand -> this run");
    lines.push(bar("marker outside province", hand.summary.outside, after.summary.outside));
    lines.push(bar("marker covers a name", hand.summary.coversName, after.summary.coversName));
    lines.push(bar("marker covers an SC glyph", hand.summary.coversSupplyCentre, after.summary.coversSupplyCentre));
    lines.push(bar("dislodged outside", hand.summary.dislodgedOutside, after.summary.dislodgedOutside));
    lines.push(bar("dislodged covers a name", hand.summary.dislodgedCoversName, after.summary.dislodgedCoversName));
    lines.push(bar("clean provinces", hand.summary.clean, after.summary.clean, true));
    lines.push("");
  }
  lines.push("STRESS: the same tables at the phone radius " + stress.radius.toFixed(2));
  lines.push(bar("marker outside province", stress.before.summary.outside, stress.after.summary.outside));
  lines.push(bar("marker covers a name", stress.before.summary.coversName, stress.after.summary.coversName));
  lines.push(bar("clean provinces", stress.before.summary.clean, stress.after.summary.clean, true));
  lines.push("");
  // --- RULE B: where the threshold came from ------------------------------

  lines.push("CLEARANCE — the margin, measured rather than chosen (RULE B)");
  if (input.study) {
    const s = input.study;
    lines.push("  source                      " + input.studySource);
    lines.push("  markers measured            " + s.samples.length);
    lines.push("  already overlapping         " + s.overlapping);
    lines.push("  median, names and SCs       " + s.medianRadii.toFixed(3) + " radii  (" + s.medianUnits.toFixed(2) + " map units)");
    lines.push("  median, names alone         " + s.medianNameRadii.toFixed(3) + " radii");
    lines.push("  median, supply centres      " + s.medianScRadii.toFixed(3) + " radii");
    lines.push("  deciles (radii)             " + s.deciles.map((d) => d.toFixed(2)).join(" "));
  } else {
    lines.push("  no seed table to measure; the threshold below is the standing default");
  }
  lines.push("  THRESHOLD USED              " + input.minClearance.toFixed(3) + " radii  (" + (input.minClearance * r).toFixed(2) + " map units)");
  lines.push("");
  lines.push("  A position clearing this margin scores full credit and no more, so");
  lines.push("  nothing is gained by shoving a marker further into a corner. Below");
  lines.push("  it the penalty grades. Among positions at full credit the province's");
  lines.push("  pole decides, which keeps centred the aesthetic.");
  lines.push("");
  lines.push("  the same measurement over the table this run produced:");
  lines.push("    median " + input.outcome.medianRadii.toFixed(3) + " radii, " + input.outcome.overlapping + " overlapping, " +
    input.outcome.samples.filter((s) => s.radii >= input.minClearance).length + " of " + input.outcome.samples.length + " at or above the threshold");
  lines.push("");

  // --- RULE A: the coast families -----------------------------------------

  const families = new Map<string, string[]>();
  for (const province of map.provinces) {
    const b = baseKey(province.key);
    families.set(b, (families.get(b) || []).concat(province.key));
  }
  const coastal = Array.from(families.entries()).filter(([, members]) => members.length > 1);
  lines.push("COASTS — every member of a family readable as itself (RULE A)");
  if (coastal.length === 0) {
    lines.push("  this map has no province with named coasts");
  } else {
    lines.push("  A coast anchor has to be tellable from its base province and from");
    lines.push("  its sibling coasts, so family members are held " + COAST_SEPARATION.toFixed(1) + " marker radii");
    lines.push("  (" + (COAST_SEPARATION * r).toFixed(1) + " map units) apart, and a base province may not stand on");
    lines.push("  one of its own coast strips.");
    const stuck = decisions.filter((d) => d.coastIllegible).map((d) => d.key);
    lines.push("  Separation is applied as a FILTER first and a preference second: a");
    lines.push("  position that fails it is not searched at all, so nothing lower in");
    lines.push("  the order can outvote legibility. Only a province offering no such");
    lines.push("  position falls back, and those are named below.");
    lines.push("  no legible position anywhere   " + (stuck.join(", ") || "none"));
    lines.push("  family      pair                        before -> after   (map units)");
    for (const [, members] of coastal) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i];
          const b = members[j];
          const was = gapBetween(input.seed || input.shipped, a, b);
          const now = gapBetween(input.result, a, b);
          if (now === null) continue;
          lines.push(
            "  " + baseKey(a).padEnd(11) +
              (a + " / " + b).padEnd(28) +
              (was === null ? "    —" : was.toFixed(1).padStart(5)) + " ->" + now.toFixed(1).padStart(6) +
              (now + 0.5 >= COAST_SEPARATION * r
                ? "   ok"
                : "   " + Math.round((1 - now / (COAST_SEPARATION * r)) * 100) + "% short"),
          );
        }
      }
    }
  }
  lines.push("");

  // --- what the hand file said, and where this run left it ----------------

  lines.push("SEEDED FROM A HAND-CORRECTED TABLE");
  if (!input.seedPath) {
    lines.push("  none: this run started from the anchors the map ships");
  } else {
    const seeded = Object.keys(input.seed || {}).length;
    lines.push("  file        " + input.seedPath);
    lines.push("  positions   " + seeded + " seeded, " + input.keptSeeds + " kept exactly, " + input.deviations.length + " changed");
    lines.push("");
    lines.push("  A seeded position is kept unless it breaks a hard constraint or a");
    lines.push("  placement rule finds a demonstrably better spot. Being nearer the");
    lines.push("  middle of a province is NOT a reason to overrule a hand. Every");
    lines.push("  departure is listed here, with the term it was overruled on.");
    lines.push("");
    if (input.deviations.length === 0) {
      lines.push("  nothing moved: the hand table survives this run unchanged");
    } else {
      const units = input.deviations.filter((d) => !d.dislodgedOnly);
      const away = input.deviations.filter((d) => d.dislodgedOnly);
      lines.push("  UNIT MARKERS MOVED (" + units.length + ")");
      lines.push("  key        moved   scale        from            to             why");
      for (const d of units.sort((a, b) => b.moved - a.moved)) {
        lines.push(
          "  " + d.key.padEnd(10) +
            d.moved.toFixed(1).padStart(6) + "  " +
            (d.fromScale === d.toScale ? d.toScale.toFixed(2) + "x   " : d.fromScale.toFixed(2) + "->" + d.toScale.toFixed(2)) + "  " +
            ("[" + d.from.map((v) => v.toFixed(0)).join(",") + "]").padEnd(15) +
            ("[" + d.to.map((v) => v.toFixed(0)).join(",") + "]").padEnd(15) +
            d.reason,
        );
      }
      lines.push("");
      lines.push("  DISLODGED MARKERS MOVED, UNIT UNTOUCHED (" + away.length + ")");
      for (const d of away.sort((a, b) => b.moved - a.moved)) {
        lines.push("  " + d.key.padEnd(10) + d.moved.toFixed(1).padStart(6) + " map units");
      }
    }
  }
  lines.push("");

  // --- the brief code labels ----------------------------------------------

  lines.push("BRIEF CODES — where the three-letter label goes (brief mode)");
  if (input.brief.length === 0) {
    lines.push("  none placed: this map draws its own brief labels, or has no");
    lines.push("  province the board would write a code for");
  } else {
    const box = input.brief[0].box;
    lines.push("  Brief mode hides the full names, so a code is judged against the");
    lines.push("  unit marker, the dislodged marker, the supply centre glyph and the");
    lines.push("  province border — and against nothing else. The names it would have");
    lines.push("  to dodge are not on the board when it is drawn.");
    lines.push("  label box                   " + box.w.toFixed(1) + " x " + box.h.toFixed(1) + " map units, at font " +
      (r * 0.95).toFixed(1) + " with a " + (r * 0.16).toFixed(1) + " halo");
    const kept = input.brief.filter((d) => !d.declined);
    const declined = input.brief.filter((d) => d.declined);
    lines.push("  codes placed                " + kept.length + " of " + input.brief.length + " provinces");
    lines.push("  left to the board           " + declined.length +
      " (nothing found beats the offset heuristic there,");
    lines.push("                              so the table stores nothing and the board falls back)");
    const beside = kept.filter((d) => d.quality.pairing === 0);
    lines.push("  beside their own piece      " + beside.length + " of " + kept.length +
      " (the rest were found elsewhere in the province)");
    lines.push("  leaning over their border   " + kept.filter((d) => d.quality.overhang > 0).length +
      " (centred inside, too big for the province)");
    lines.push("  centred outside as well     " + kept.filter((d) => d.quality.stray > 0).length);
    lines.push("  on their own piece or ring  " + kept.filter((d) => d.quality.unit > 0).length);
    lines.push("  on a neighbour's piece      " + kept.filter((d) => d.quality.neighbour > 0).length);
    lines.push("  on a supply centre glyph    " + kept.filter((d) => d.quality.supplyCentre > 0).length);
    const stuck = kept.filter((d) => d.unavoidable);
    lines.push("  nowhere clean in the province (" + stuck.length + ")");
    for (const item of stuck.slice(0, 20)) {
      lines.push(
        "  " + item.key.padEnd(10) +
          (item.quality.stray ? "outside  " : item.quality.overhang ? "leans    " : "inside   ") +
          "own piece " + pct(item.quality.unit).padStart(5) +
          "   glyph " + pct(item.quality.supplyCentre).padStart(5) +
          "   neighbour " + pct(item.quality.neighbour).padStart(5),
      );
    }
    if (stuck.length > 20) lines.push("  … and " + (stuck.length - 20) + " more");
  }
  lines.push("");

  lines.push("map faults (not placement, and not fixable here)");
  lines.push("  anchors with no hit shape   " + (map.anchorsWithoutShape.join(", ") || "none"));
  lines.push("  hit shapes with no anchor   " + (map.shapesWithoutAnchor.join(", ") || "none"));
  lines.push("");

  const shrunk = decisions.filter((d) => d.scale < 1).sort((a, b) => a.scale - b.scale);
  lines.push("MARKER SIZES");
  if (shrunk.length === 0) {
    lines.push("  every province takes a full-size marker");
  } else {
    lines.push("  " + (decisions.length - shrunk.length) + " provinces at full size; these were shrunk to fit:");
    for (const item of shrunk) {
      lines.push("  " + item.key.padEnd(10) + item.scale.toFixed(2) + "x  (" + (r * item.scale).toFixed(1) + " map units)");
    }
  }
  lines.push("");

  const leaning = decisions.filter((d) => d.overhang);
  lines.push("PERMITTED OVERHANG (" + leaning.length + ")");
  if (leaning.length === 0) {
    lines.push("  no province needed it: every marker sits wholly inside its own border");
  } else {
    lines.push("  These provinces take no marker at any size, so the marker is centred");
    lines.push("  well inside the border and allowed out over it. Leaning over sea or");
    lines.push("  empty space costs a reader nothing; leaning over a neighbouring land");
    lines.push("  province is the ambiguity worth counting, so it is counted.");
    lines.push("  key        over land   over sea   over nothing");
    for (const item of leaning) {
      const over = item.overhang!;
      lines.push(
        "  " +
          item.key.padEnd(10) +
          pct(over.land).padStart(9) +
          pct(over.sea).padStart(11) +
          pct(over.open).padStart(14),
      );
    }
  }
  lines.push("");

  const proven = decisions.filter((d) => d.unavoidable);
  lines.push("UNAVOIDABLE (" + proven.length + ")");
  if (proven.length === 0) {
    lines.push("  nothing left over: no marker covers a name it could have avoided");
  } else {
    lines.push("  Each of these was swept exhaustively at one map unit across its whole");
    lines.push("  province. No position avoids what it covers. Hand correction here means");
    lines.push("  moving the LABEL, not the marker.");
    for (const item of proven) {
      lines.push(
        "  " + item.key.padEnd(10) + "covers " + pct(item.quality.name) + " of a name at " + item.scale.toFixed(2) + "x",
      );
    }
  }
  lines.push("");

  lines.push("TERRAIN (read off the map's own fill, used only to choose overhang direction)");
  lines.push("  sea fill  " + (terrain.seaFill || "not found"));
  lines.push("  land fill " + (terrain.landFill || "not found"));
  const counts = { sea: 0, land: 0, unknown: 0 };
  for (const value of Object.values(terrain.kind)) counts[value]++;
  lines.push("  " + counts.sea + " sea, " + counts.land + " land, " + counts.unknown + " unclassified");
  lines.push("");

  const moved = decisions.filter((d) => d.moved > 0.01).sort((a, b) => b.moved - a.moved);
  lines.push("MOVED (" + moved.length + " of " + before.summary.placed + " placed)");
  for (const item of moved.slice(0, 25)) {
    lines.push("  " + item.key.padEnd(10) + item.moved.toFixed(1).padStart(8) + " map units");
  }
  if (moved.length > 25) lines.push("  … and " + (moved.length - 25) + " more");
  lines.push("");

  lines.push("PER PROVINCE (after)");
  lines.push("  key        size   outside  name%   sc%   dislodged");
  const scaleOf = new Map(decisions.map((d) => [d.key, d.scale]));
  for (const v of after.violations) {
    if (v.missingAnchor && v.missingShape) continue;
    lines.push(
      "  " +
        v.key.padEnd(10) +
        (scaleOf.get(v.key) || 1).toFixed(2) +
        "x  " +
        (v.outside ? "  OUT   " : "   ok   ") +
        (v.nameFraction * 100).toFixed(0).padStart(5) +
        (v.scFraction * 100).toFixed(0).padStart(6) +
        "   " +
        (v.dislodgedOutside ? "OUT" : v.dislodgedCoversName ? "on a name" : "ok"),
    );
  }
  return lines.join("\n") + "\n";
}

function pct(fraction: number): string {
  return Math.round(fraction * 100) + "%";
}

/** Two decimals, which is finer than any map is drawn to. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** How far apart two provinces' markers stand in a table, or null. */
function gapBetween(table: PlacementTable | null, a: string, b: string): number | null {
  if (!table || !table[a] || !table[b]) return null;
  return distance(
    { x: table[a].unit[0], y: table[a].unit[1] },
    { x: table[b].unit[0], y: table[b].unit[1] },
  );
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const asked = options.all ? await listVariants(options.server) : options.variants;
  const skip = new Set(options.skip);
  const keys = asked.filter((key) => !skip.has(key));
  if (skip.size) console.log("skipping " + Array.from(skip).sort().join(", "));
  if (keys.length === 0) {
    console.log(usage());
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const browser = await openBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const totals: Array<{ key: string; before: Audit; after: Audit }> = [];

  try {
    for (const key of keys) {
      process.stdout.write("· " + key + " … ");
      const svgText = await fetchText(options.server + "/variants/" + key + "/map.svg");
      const map = await measureMap(page, svgText);
      const r = standardRadius(map.viewBox);
      const rStress = stressRadius(map.viewBox);

      /*
      The codes alone, placed against an approved table and leaving it
      otherwise exactly as it was. Nothing below this runs: the markers are
      not re-derived, so there is no before, no after and nothing to compare.
      */
      if (options.briefOnly) {
        const path = join(PLACEMENTS, key + ".json");
        if (!existsSync(path)) throw new Error(path + ": no approved table to add codes to");
        if (map.drawsBriefLabels) {
          console.log("this map draws its own brief labels; the approved table is unchanged");
          continue;
        }
        const approved = await readSeed(path);
        const drawable = map.provinces.filter((province) => province.shapes > 0).map((province) => province.key);
        const poleList = await computePoles(page, drawable);
        const poles = new Map(poleList.map((pole) => [pole.key, pole.point]));
        /* The same measured threshold the markers were judged on: taken off
           the approved table, which is the placement in force. */
        const threshold =
          options.minClearance !== null ? options.minClearance : measureClearance(map, approved, r).medianRadii;
        const only = await placeBrief(page, map, approved, r, poles, threshold);
        /*
        Written as a replacement, not a merge. A province the tool declines to
        place a code for has to LOSE any code a previous run left there, or
        the file keeps an answer this run disagrees with and no rerun can ever
        take one back.
        */
        for (const spot of Object.values(approved)) delete spot.brief;
        for (const [province, point] of only.points) {
          approved[province].brief = [round(point.x), round(point.y)];
        }
        await writeFile(path, JSON.stringify(approved, null, 2) + "\n");
        const clean = only.decisions.filter((d) => !d.unavoidable).length;
        console.log("codes " + clean + "/" + only.decisions.length + " clean, written to " + path);
        continue;
      }

      const shipped = shippedPlacement(map, r);

      /*
      The privileged table: an explicit --seed, else the variant's own hand
      file if it has one. Its positions are candidates the search must beat
      rather than a starting guess it may discard.
      */
      let seedPath: string | null = null;
      if (options.useSeed) {
        if (options.seed) seedPath = options.seed;
        else {
          const guess = join(PLACEMENTS, key + ".hand.json");
          if (existsSync(guess)) seedPath = guess;
        }
      }
      const seed = seedPath ? await readSeed(seedPath) : null;

      /*
      RULE B's threshold is measured, not chosen: the median margin the hand
      file keeps. Without a hand file there is nothing to measure, so the
      figure measured off classical stands in — it is expressed in radii
      exactly so it can.
      */
      const study = seed ? measureClearance(map, seed, r) : null;
      /* Taken as measured, including when it comes out negative: that is the
         owner saying a marker may touch the box of a nearby name, which on
         this map it routinely must. */
      const minClearance =
        options.minClearance !== null ? options.minClearance : study ? study.medianRadii : MIN_CLEARANCE_RADII;

      /*
      The placer runs first because it works out which provinces are sea and
      which are land, and every audit needs that: the coast rule asks what a
      marker is hanging over, and water is free where another country is not.
      */
      const result = await place(page, map, shipped, r, {
        seed: seed || undefined,
        minClearanceRadii: minClearance,
      });
      /*
      The brief codes, once the markers are settled: a code is placed against
      the pieces, so it can only be placed after it is known where they are.
      */
      const brief = await placeBrief(page, map, result.table, r, result.poles, minClearance);
      for (const [key, point] of brief.points) {
        result.table[key].brief = [round(point.x), round(point.y)];
      }

      const kind = result.terrain.kind;
      const before = await audit(page, map, shipped, r, kind);
      /* The hand table judged by the same tests, so the report can say what
         this run cost or bought against the placement it started from. */
      const seedAudit = seed ? await audit(page, map, seed, r, kind) : null;
      const after = await audit(page, map, result.table, r, kind);
      const outcome = measureClearance(map, result.table, r);

      // The same two tables judged again with the bigger marker a phone draws.
      const stress = {
        radius: rStress,
        before: await audit(page, map, shippedPlacement(map, rStress), rStress, kind),
        after: await audit(page, map, result.table, rStress, kind),
      };

      const payload = {
        variant: key,
        generatedAt: new Date().toISOString(),
        markerRadius: Number(r.toFixed(3)),
        viewBox: [map.viewBox.x, map.viewBox.y, map.viewBox.w, map.viewBox.h],
        placement: result.table,
      };
      await writeFile(join(OUT, key + ".json"), JSON.stringify(payload, null, 2) + "\n");
      if (options.approve) {
        // The bare table, which is what the server reads and what the editor
        // exports — so a hand correction can replace this file wholesale.
        await mkdir(PLACEMENTS, { recursive: true });
        await writeFile(
          join(PLACEMENTS, key + ".json"),
          JSON.stringify(result.table, null, 2) + "\n",
        );
      }
      await writeFile(
        join(OUT, key + ".report.txt"),
        report({
          key: key,
          map: map,
          r: r,
          before: before,
          after: after,
          decisions: result.decisions,
          terrain: result.terrain,
          stress: stress,
          study: study,
          studySource: seedPath || "none",
          minClearance: minClearance,
          seedPath: seedPath,
          seed: seed,
          seedAudit: seedAudit,
          deviations: result.deviations,
          keptSeeds: result.keptSeeds,
          result: result.table,
          shipped: shipped,
          outcome: outcome,
          brief: brief.decisions,
        }),
      );
      await writeFile(
        join(OUT, key + ".audit.json"),
        JSON.stringify(
          { variant: key, markerRadius: r, before: before, after: after, stress: stress },
          null,
          2,
        ) + "\n",
      );

      if (options.images) {
        await renderComparison(
          page,
          {
            svgText: svgText,
            radius: r,
            width: 900,
            /* On a seeded run the comparison worth drawing is against the
               hand table, not against anchors nobody is proposing to keep. */
            left: {
              title: key + (seed ? " — your hand table" : " — shipped anchors"),
              subtitle:
                (seedAudit || before).summary.outside +
                " outside · " +
                (seedAudit || before).summary.coversName +
                " on a name · " +
                (seedAudit || before).summary.clean +
                " clean",
              table: seed || shipped,
              violations: (seedAudit || before).violations,
            },
            right: {
              title: key + " — this run",
              subtitle:
                after.summary.outside +
                " outside · " +
                after.summary.coversName +
                " on a name · " +
                after.summary.clean +
                " clean",
              table: result.table,
              violations: after.violations,
            },
          },
          join(OUT, key + ".compare.png"),
        );
      }

      if (options.editor) {
        await writeFile(
          join(OUT, "editor-" + key + ".html"),
          buildEditor({
            variant: key,
            svgText: svgText,
            map: map,
            radius: r,
            shipped: shipped,
            optimized: result.table,
            hand: seed,
            sea: Object.keys(result.terrain.kind).filter((key) => result.terrain.kind[key] === "sea"),
            coastReach: COAST_REACH,
            deviations: result.deviations.map((d) => ({
              key: d.key,
              reason: d.dislodgedOnly ? "dislodged marker only" : d.reason,
              moved: d.moved,
            })),
          }),
        );
      }

      totals.push({ key: key, before: before, after: after });
      console.log(
        "outside " + before.summary.outside + "->" + after.summary.outside +
          ", on a name " + before.summary.coversName + "->" + after.summary.coversName +
          ", clean " + before.summary.clean + "->" + after.summary.clean +
          (result.decisions.some((d) => d.scale < 1)
            ? ", " + result.decisions.filter((d) => d.scale < 1).length + " shrunk"
            : "") +
          (result.decisions.some((d) => d.overhang)
            ? ", " + result.decisions.filter((d) => d.overhang).length + " overhang"
            : "") +
          (result.decisions.some((d) => d.unavoidable)
            ? ", " + result.decisions.filter((d) => d.unavoidable).length + " unavoidable"
            : "") +
          ", codes " + brief.decisions.filter((d) => !d.unavoidable).length + "/" + brief.decisions.length + " clean",
      );
    }
  } finally {
    await browser.close();
  }

  const summary = [
    "variant".padEnd(26) + "outside".padStart(14) + "on a name".padStart(16) + "clean".padStart(16),
    ...totals.map((row) =>
      row.key.padEnd(26) +
      (row.before.summary.outside + "->" + row.after.summary.outside).padStart(14) +
      (row.before.summary.coversName + "->" + row.after.summary.coversName).padStart(16) +
      (row.before.summary.clean + "->" + row.after.summary.clean).padStart(16),
    ),
  ].join("\n");
  await writeFile(join(OUT, "summary.txt"), summary + "\n");
  console.log("\n" + summary);
  console.log("\nwritten to " + OUT);
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

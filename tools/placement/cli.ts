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

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, measureMap, type MapGeometry } from "./browser.ts";
import {
  audit,
  optimize,
  shippedPlacement,
  type Audit,
  type Fixed,
  type PlacementTable,
} from "./audit.ts";
import {
  DEFAULT_WEIGHTS,
  REFERENCE_VIEWPORTS,
  markerRadius,
  standardRadius,
  stressRadius,
  type Weights,
} from "./geometry.ts";
import { renderComparison } from "./render.ts";
import { buildEditor } from "./editor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

interface Options {
  variants: string[];
  all: boolean;
  server: string;
  images: boolean;
  editor: boolean;
  weights: Weights;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    variants: [],
    all: false,
    server: process.env.MAP_SERVER || "http://localhost:8192",
    images: true,
    editor: false,
    weights: { ...DEFAULT_WEIGHTS },
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variant" || arg === "-v") options.variants.push(argv[++i]);
    else if (arg === "--all") options.all = true;
    else if (arg === "--server") options.server = argv[++i];
    else if (arg === "--no-images") options.images = false;
    else if (arg === "--editor") options.editor = true;
    else if (arg === "--name-weight") options.weights.name = Number(argv[++i]);
    else if (arg === "--sc-weight") options.weights.supplyCentre = Number(argv[++i]);
    else if (arg === "--centre-weight") options.weights.centre = Number(argv[++i]);
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
    "  --variant <key>     a variant to work on; repeatable",
    "  --all               every variant the server lists",
    "  --server <url>      where /variants lives (default http://localhost:8192)",
    "  --no-images         skip the before/after PNGs",
    "  --editor            also write the self-contained drag-to-correct page",
    "  --name-weight <n>   penalty per unit of name overlap (default 1000)",
    "  --sc-weight <n>     penalty per unit of supply centre overlap (default 25)",
    "  --centre-weight <n> penalty per marker-radius from the province pole (default 10)",
    "",
    "Writes out/<key>.json, out/<key>.report.txt and out/<key>.compare.png,",
    "and with --editor, out/editor-<key>.html.",
  ].join("\n");
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

function report(
  key: string,
  map: MapGeometry,
  r: number,
  before: Audit,
  after: Audit,
  fixed: Fixed[],
  flagged: Fixed[],
  stress: { radius: number; before: Audit; after: Audit },
): string {
  const lines: string[] = [];
  lines.push("placement audit — " + key);
  lines.push("=".repeat(60));
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
  lines.push("STRESS: the same tables at the phone radius " + stress.radius.toFixed(2));
  lines.push(bar("marker outside province", stress.before.summary.outside, stress.after.summary.outside));
  lines.push(bar("marker covers a name", stress.before.summary.coversName, stress.after.summary.coversName));
  lines.push(bar("clean provinces", stress.before.summary.clean, stress.after.summary.clean, true));
  lines.push("");
  lines.push("map faults (not placement, and not fixable here)");
  lines.push("  anchors with no hit shape   " + (map.anchorsWithoutShape.join(", ") || "none"));
  lines.push("  hit shapes with no anchor   " + (map.shapesWithoutAnchor.join(", ") || "none"));
  lines.push("");

  if (flagged.length) {
    lines.push("NEEDS A HUMAN (" + flagged.length + ")");
    for (const item of flagged) {
      lines.push("  " + item.key.padEnd(10) + item.reason);
    }
    lines.push("");
  }

  const worseAfter = after.violations.filter((v) => {
    const was = before.violations.find((b) => b.key === v.key);
    return was && !was.coversName && v.coversName;
  });
  if (worseAfter.length) {
    lines.push("REGRESSED (" + worseAfter.length + ") — a name is now covered where it was not");
    for (const item of worseAfter) lines.push("  " + item.key);
    lines.push("");
  }

  lines.push("MOVED (" + fixed.length + " of " + before.summary.placed + " placed)");
  const byDistance = fixed.slice().sort((a, b) => b.moved - a.moved);
  for (const item of byDistance.slice(0, 40)) {
    lines.push("  " + item.key.padEnd(10) + item.moved.toFixed(1).padStart(8) + " map units");
  }
  if (byDistance.length > 40) lines.push("  … and " + (byDistance.length - 40) + " more");
  lines.push("");

  lines.push("PER PROVINCE (after)");
  lines.push("  key        outside  name%   sc%   dislodged");
  for (const v of after.violations) {
    if (v.missingAnchor && v.missingShape) continue;
    lines.push(
      "  " +
        v.key.padEnd(10) +
        (v.outside ? "  OUT   " : "   ok   ") +
        (v.nameFraction * 100).toFixed(0).padStart(5) +
        (v.scFraction * 100).toFixed(0).padStart(6) +
        "   " +
        (v.dislodgedOutside ? "OUT" : v.dislodgedCoversName ? "on a name" : "ok"),
    );
  }
  return lines.join("\n") + "\n";
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const keys = options.all ? await listVariants(options.server) : options.variants;
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

      const shipped = shippedPlacement(map, r);
      const before = await audit(page, map, shipped, r);
      const result = await optimize(page, map, shipped, r, options.weights);
      const after = await audit(page, map, result.table, r);

      // The same two tables judged again with the bigger marker a phone draws.
      const stress = {
        radius: rStress,
        before: await audit(page, map, shippedPlacement(map, rStress), rStress),
        after: await audit(page, map, result.table, rStress),
      };

      const payload = {
        variant: key,
        generatedAt: new Date().toISOString(),
        markerRadius: Number(r.toFixed(3)),
        viewBox: [map.viewBox.x, map.viewBox.y, map.viewBox.w, map.viewBox.h],
        weights: options.weights,
        placement: result.table,
      };
      await writeFile(join(OUT, key + ".json"), JSON.stringify(payload, null, 2) + "\n");
      await writeFile(
        join(OUT, key + ".report.txt"),
        report(key, map, r, before, after, result.fixed, result.flagged, stress),
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
            left: {
              title: key + " — shipped anchors",
              subtitle:
                before.summary.outside +
                " outside · " +
                before.summary.coversName +
                " on a name · " +
                before.summary.clean +
                " clean",
              table: shipped,
              violations: before.violations,
            },
            right: {
              title: key + " — recentred on province poles",
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
          }),
        );
      }

      totals.push({ key: key, before: before, after: after });
      console.log(
        "outside " + before.summary.outside + "->" + after.summary.outside +
          ", on a name " + before.summary.coversName + "->" + after.summary.coversName +
          ", clean " + before.summary.clean + "->" + after.summary.clean +
          (result.flagged.length ? ", " + result.flagged.length + " flagged" : ""),
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

/*
Puts godip's own maps into the named styles (D-024).

    node restyle-godip.ts --all --all-styles
    node restyle-godip.ts --variant classical --style midnight

godip's maps are not files in this checkout: they are embedded in the
dependency, and the only thing that can hand one over is a running server. So
this tool is a client. It asks a server for the variant list, for each map at
`?style=original`, and — this is the part that makes the restyle honest — for
each variant's province types, which is how it learns which colour that map
paints sea in without ever guessing from the tone.

    ADDR=:8195 go run .        # in another terminal
    node restyle-godip.ts --all --all-styles --server http://localhost:8195

What it writes is tools/restyle/out/styled/<key>/map-<style>.svg, for looking
at. The server does not read it: since D-026 it composes a styled map at serve
time from the original art, the style plan plans.ts measured, and the style's
own tokens. This tool's real output is the report and the renderings beside it.

A map whose palette does not come out of the vote decisively is NOT written.
It is listed in the coverage table with the reason, and it goes on being
served in godip's own colours. Twenty-three maps styled and three explained
is a better result than twenty-six maps of which some are quietly wrong.
*/

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../placement/browser.ts";
import { listStyles, loadStyle, stylesDir, type LoadedStyle } from "./styles.ts";
import {
  checkGodipStructure,
  classifyPalette,
  probeMap,
  restyleGodipMap,
  type MapProbe,
  type Palette,
  type ProvinceType,
} from "./godip.ts";
import type { Page } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const STYLES = stylesDir(HERE);
/* Renderings, not assets. The server composes a styled map at serve time out
   of the original art and the plan plans.ts writes (D-026); what this tool
   writes is a picture of the result, for a person to look at. */
const STYLED = join(OUT, "styled");

/*
The maps that are NOT this tool's business.

They are converted from jDip, they carry semantic classes, and restyle.ts does
them properly through a stylesheet. Value substitution would work on them too
and would be the worse tool for the job.
*/
export const JDIP_KEYS = ["1900", "sailho", "sailhocrowded"];

interface Options {
  server: string;
  variants: string[];
  all: boolean;
  styles: string[];
  allStyles: boolean;
  grain: boolean;
  borders: boolean;
  write: boolean;
}

function usage(): string {
  return [
    "restyle-godip — put godip's own maps into a named style (D-024)",
    "",
    "  --server <url>     a running 1901 server (default http://localhost:8195)",
    "  --variant <key>    a variant key; repeatable",
    "  --all              every variant the server lists, bar the jDip ones",
    "  --style <name>     a style in mapstyles/; repeatable (default: parchment)",
    "  --all-styles       every style in mapstyles/",
    "  --no-grain         leave off the style's grain, whatever it says",
    "  --no-borders       leave the province border strokes as the map drew them",
    "  --dry-run          probe, decide and report, but write nothing",
    "",
    "Writes renderings under tools/restyle/out/.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    server: "http://localhost:8195",
    variants: [],
    all: false,
    styles: [],
    allStyles: false,
    grain: true,
    borders: true,
    write: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server") options.server = argv[++i];
    else if (arg === "--variant" || arg === "-v") options.variants.push(argv[++i]);
    else if (arg === "--all") options.all = true;
    else if (arg === "--style" || arg === "-s") options.styles.push(argv[++i]);
    else if (arg === "--all-styles") options.allStyles = true;
    else if (arg === "--no-grain") options.grain = false;
    else if (arg === "--no-borders") options.borders = false;
    else if (arg === "--dry-run") options.write = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error("unknown argument " + JSON.stringify(arg));
  }
  return options;
}

// --- the server -------------------------------------------------------------

interface VariantCard {
  key: string;
  name: string;
}

async function get(url: string): Promise<Response> {
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(url + " answered " + answer.status);
  return answer;
}

async function readVariants(server: string): Promise<VariantCard[]> {
  const cards = (await (await get(server + "/variants")).json()) as VariantCard[];
  return cards.map((one) => ({ key: one.key, name: one.name }));
}

async function readMap(server: string, key: string): Promise<string> {
  return (await get(server + "/variants/" + key + "/map.svg?style=original")).text();
}

async function readProvinces(server: string, key: string): Promise<ProvinceType[]> {
  return (await (await get(server + "/variants/" + key + "/provinces.json")).json()) as ProvinceType[];
}

// --- reporting --------------------------------------------------------------

interface Row {
  key: string;
  name: string;
  styled: boolean;
  /** The reason it was not, or what it was styled from. */
  detail: string;
}

function paletteReport(key: string, name: string, palette: Palette, probe: MapProbe): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(66));
  lines.push(key + "  (" + name + ")");
  lines.push("=".repeat(66));
  lines.push("  viewBox width        " + probe.width);
  lines.push("  provinces sampled    " + Object.keys(probe.underProvince).length +
    (probe.unsampled.length ? ", " + probe.unsampled.length + " with no shape to sample" : ""));
  lines.push("  PALETTE, BY VOTE");
  if (!palette.ok) {
    lines.push("    UNDECIDED — " + palette.reason);
    lines.push("    the map is served in godip's own colours, unchanged");
  } else {
    lines.push("    sea                " + palette.sea + "  (" +
      Math.round(palette.seaConfidence * 100) + "% of the sea provinces)");
    lines.push("    land               " + palette.land + "  (" +
      Math.round(palette.landConfidence * 100) + "% of the land and coast provinces)");
    lines.push("    impassable hatch   " + (palette.impassablePattern
      ? "#" + palette.impassablePattern
      : "none on this map"));
    lines.push("    paper grain        " + (palette.grainPattern
      ? "#" + palette.grainPattern
      : "none on this map"));
    if (palette.extras.length) {
      lines.push("    other tones carried, each keeping its step from the base:");
      for (const extra of palette.extras) {
        lines.push("      " + extra.fill + "  " + (extra.fraction * 100).toFixed(1) +
          "% of the map, nearest " + extra.near);
      }
    }
  }
  lines.push("  COVERAGE, AS PAINTED");
  for (const one of probe.coverage.slice(0, 6)) {
    lines.push("    " + one.fill.padEnd(26) + (one.fraction * 100).toFixed(1) + "%");
  }
  return lines.join("\n");
}

function coverageTable(rows: Row[], styles: string[]): string {
  const lines: string[] = [];
  const styled = rows.filter((one) => one.styled);
  lines.push("");
  lines.push("=".repeat(78));
  lines.push("COVERAGE — " + styled.length + " of " + rows.length +
    " godip maps styled, in " + styles.join(", "));
  lines.push("=".repeat(78));
  for (const row of rows.sort((a, b) => a.key.localeCompare(b.key))) {
    lines.push("  " + row.key.padEnd(24) + (row.styled ? "styled  " : "UNSTYLED") + "  " + row.detail);
  }
  return lines.join("\n");
}

// --- looking at it ----------------------------------------------------------

function dataUri(svg: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const SHEET =
  "html,body{margin:0;background:#14161a;font:13px system-ui,sans-serif;color:#9aa3b2}" +
  "figure{margin:0;min-width:0}figcaption{padding:0 0 8px}" +
  "img{display:block;width:100%;height:auto;background:#0e1013}";

async function shoot(page: Page, body: string, file: string): Promise<void> {
  await page.setContent(
    "<!doctype html><html><head><style>" + SHEET + "</style></head><body>" + body + "</body></html>",
    { waitUntil: "load" },
  );
  await page.waitForTimeout(1600);
  const main = await page.$("main");
  if (main) await main.screenshot({ path: join(OUT, file) });
}

async function renderStyleGrid(
  page: Page, key: string, original: string, drawn: Array<{ style: LoadedStyle; svg: string }>,
): Promise<string> {
  const frame = (title: string, svg: string) =>
    "<figure><figcaption>" + title + '</figcaption><img src="' + dataUri(svg) + '"></figure>';
  await shoot(
    page,
    '<main style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;padding:14px">' +
      frame(key + " — as godip draws it", original) +
      drawn.map((one) => frame(key + " — " + one.style.title, one.svg)).join("") +
      "</main>",
    key + ".godip.styles.png",
  );
  return key + ".godip.styles.png";
}

// --- running ----------------------------------------------------------------

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let styleNames = options.styles;
  if (options.allStyles) styleNames = await listStyles(STYLES);
  if (styleNames.length === 0) styleNames = ["parchment"];
  const styles: LoadedStyle[] = [];
  for (const name of styleNames) styles.push(await loadStyle(STYLES, name));

  const cards = await readVariants(options.server);
  let wanted = cards.filter((one) => options.variants.includes(one.key));
  if (options.all) wanted = cards.filter((one) => !JDIP_KEYS.includes(one.key));
  if (wanted.length === 0) {
    console.log(usage());
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const browser = await openBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const report: string[] = [];
  const rows: Row[] = [];
  let failed = 0;

  try {
    for (const card of wanted) {
      const original = await readMap(options.server, card.key);
      const provinces = await readProvinces(options.server, card.key);
      const probe = await probeMap(page, original);
      const palette = classifyPalette(probe, provinces);
      const text = paletteReport(card.key, card.name, palette, probe);
      report.push(text);
      console.log(text);

      if (!palette.ok) {
        rows.push({ key: card.key, name: card.name, styled: false, detail: palette.reason });
        continue;
      }

      const drawn: Array<{ style: LoadedStyle; svg: string }> = [];
      let wrote = 0;
      for (const style of styles) {
        const built = restyleGodipMap(original, style, palette, probe, {
          grain: options.grain,
          borders: options.borders,
        });
        const diff = checkGodipStructure(original, built.svg);
        const lines: string[] = [];
        lines.push("");
        lines.push("  " + card.key + " in " + style.name);
        for (const note of built.notes) lines.push("    " + note);
        lines.push("    structure: " + (diff.ok
          ? "PASS — " + diff.lockedElements + " locked elements, " +
            diff.totalBefore + " elements, geometry and ids identical"
          : "FAIL"));
        for (const problem of diff.problems) lines.push("      " + problem);
        report.push(lines.join("\n"));
        console.log(lines.join("\n"));

        if (!diff.ok) {
          failed++;
          console.error("  REFUSING to write " + card.key + " in " + style.name);
          continue;
        }
        if (options.write) {
          await mkdir(join(STYLED, card.key), { recursive: true });
          await writeFile(join(STYLED, card.key, "map-" + style.name + ".svg"), built.svg);
          wrote++;
        }
        drawn.push({ style: style, svg: built.svg });
      }
      rows.push({
        key: card.key,
        name: card.name,
        styled: drawn.length > 0,
        detail: "sea " + palette.sea + " -> style sea, land " + palette.land +
          " -> style land; " + wrote + " file(s) written",
      });
      if (drawn.length) {
        const file = await renderStyleGrid(page, card.key, original, drawn);
        console.log("  rendered tools/restyle/out/" + file);
      }
    }
  } finally {
    await browser.close();
  }

  const table = coverageTable(rows, styleNames);
  report.push(table);
  console.log(table);
  await writeFile(join(OUT, "restyle-godip.report.txt"), report.join("\n") + "\n");
  console.log("\nreport written to " + join(OUT, "restyle-godip.report.txt"));
  if (failed) process.exit(1);
}

/* Run only when this file IS the program. It is imported for its detection
   helpers as well — see plans.ts — and an import must not start a run. */
if (import.meta.filename === process.argv[1]) {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}

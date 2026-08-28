/*
Writes one style PLAN per map (D-026).

    ADDR=:8196 go run .        # in another terminal
    node plans.ts --all --server http://localhost:8196

A restyle is two halves, and only one of them is expensive. The expensive half
is DETECTION: loading the map in a real rendering engine and asking it what is
painted under each province, what each label stands on, and how much of the
board each tone covers. The cheap half is APPLICATION: a handful of string
substitutions driven by whatever detection found.

Until now both halves ran here, and the result — every map in every style —
was checked in as 156 MB of SVG. This tool writes the detection instead:
styleplans/<key>.json, a few kilobytes each, holding exactly what the
application half needs. The server then composes a styled map at serve time
from three inputs it already has or can hold in memory: the original art, the
plan, and the style tokens in mapstyles/.

The plan is keyed to the art it was measured on by SHA-256. A godip upgrade
that redraws a map invalidates its plan loudly rather than producing a board
styled from stale measurements.
*/

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../placement/browser.ts";
import {
  borderPlan,
  classifyPalette,
  namePlan,
  probeMap,
  type ProvinceType,
} from "./godip.ts";
import { classifyLabels, labelClasses, powerClasses, readMapFacts } from "./restyle.ts";
import { JDIP_KEYS } from "./restyle-godip.ts";
import type { Page } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLANS = resolve(HERE, "..", "..", "styleplans");

/** The schema version. The server refuses a plan it does not understand. */
export const PLAN_VERSION = 1;

interface Options {
  server: string;
  variants: string[];
  all: boolean;
  write: boolean;
}

function usage(): string {
  return [
    "plans — write the style plan for each map (D-026)",
    "",
    "  --server <url>     a running 1901 server (default http://localhost:8196)",
    "  --variant <key>    a variant key; repeatable",
    "  --all              every variant the server lists",
    "  --dry-run          detect and report, but write nothing",
    "",
    "Writes styleplans/<key>.json.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    server: "http://localhost:8196",
    variants: [],
    all: false,
    write: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server") options.server = argv[++i];
    else if (arg === "--variant" || arg === "-v") options.variants.push(argv[++i]);
    else if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.write = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error("unknown argument " + JSON.stringify(arg));
  }
  return options;
}

async function get(url: string): Promise<Response> {
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(url + " answered " + answer.status);
  return answer;
}

/*
The plan a godip map is styled from: which literal fill values mean what.

Everything here is a measurement of the art. `sea` and `land` are the two
values the palette vote settled on; `extras` are the other tones the map
paints in quantity, each carried onto the style's base tone by the lightness
step it had from the map's own. The two pattern ids are insertion points — the
impassable hatch, whose insides the style replaces, and the paper grain, whose
strength it sets. `names.kinds` is one verdict per name, and `borders` says
whether the foreground layer is province edges or drawing.
*/
interface GodipPlanJSON {
  styleable: boolean;
  reason: string;
  sea: string;
  land: string;
  seaConfidence: number;
  landConfidence: number;
  extras: Array<{ fill: string; near: string }>;
  impassablePattern: string | null;
  grainPattern: string | null;
  grainOverlayId: string | null;
  borders: { found: boolean; candidates: number; provinceCount: number; decoration: boolean };
  names: { found: boolean; kinds: string[] };
}

/*
The plan a converted jDip map is styled from.

These maps paint through semantic classes, so there are no fill values to
find: what detection has to supply is the label metrics jDip wrote without a
CSS unit, the classes that paint power-owned ground, and — the browser half —
which of the labels stand over water.
*/
interface JdipPlanJSON {
  styleable: boolean;
  reason: string;
  artScale: number;
  powerClasses: string[];
  labelMetrics: Array<{ class: string; declarations: string }>;
  labelClasses: string[];
  repairedSizes: string[];
}

interface PlanJSON {
  version: number;
  key: string;
  name: string;
  kind: "godip" | "jdip";
  /** The art this plan was measured on. */
  map: { bytes: number; sha256: string; viewBoxWidth: number };
  godip?: GodipPlanJSON;
  jdip?: JdipPlanJSON;
}

async function godipPlan(page: Page, server: string, key: string, svg: string): Promise<GodipPlanJSON> {
  const provinces = (await (await get(server + "/variants/" + key + "/provinces.json")).json()) as ProvinceType[];
  const probe = await probeMap(page, svg);
  const palette = classifyPalette(probe, provinces);
  const empty: GodipPlanJSON = {
    styleable: false,
    reason: palette.reason,
    sea: "",
    land: "",
    seaConfidence: 0,
    landConfidence: 0,
    extras: [],
    impassablePattern: null,
    grainPattern: null,
    grainOverlayId: null,
    borders: { found: false, candidates: 0, provinceCount: 0, decoration: false },
    names: { found: false, kinds: [] },
  };
  if (!palette.ok) return empty;

  const grainOverlay = probe.overlays.find((one) => /^url\(/.test(one.fill));
  const borders = borderPlan(svg, probe);
  const names = namePlan(svg, palette, probe);
  return {
    styleable: true,
    reason: "",
    sea: palette.sea,
    land: palette.land,
    seaConfidence: palette.seaConfidence,
    landConfidence: palette.landConfidence,
    extras: palette.extras.map((one) => ({ fill: one.fill, near: one.near })),
    impassablePattern: palette.impassablePattern,
    grainPattern: palette.grainPattern,
    grainOverlayId: grainOverlay ? grainOverlay.id : null,
    borders: borders,
    names: { found: names.found, kinds: names.kinds },
  };
}

async function jdipPlan(page: Page, key: string, svg: string): Promise<JdipPlanJSON> {
  const facts = readMapFacts(key, svg);
  const labels = await classifyLabels(page, svg);
  return {
    styleable: true,
    reason: "",
    artScale: facts.artScale,
    powerClasses: powerClasses(facts.declared),
    labelMetrics: Array.from(facts.labelMetrics.entries())
      .sort()
      .map(([name, declarations]) => ({ class: name, declarations: declarations })),
    labelClasses: labels.map(labelClasses),
    repairedSizes: facts.repairedSizes,
  };
}

function viewBoxWidthOf(svg: string): number {
  const box = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg);
  if (!box) throw new Error("this map has no viewBox");
  return Number(box[1].trim().split(/[\s,]+/)[2]);
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cards = (await (await get(options.server + "/variants")).json()) as Array<{
    key: string;
    name: string;
  }>;
  let wanted = cards.filter((one) => options.variants.includes(one.key));
  if (options.all) wanted = cards;
  if (wanted.length === 0) {
    console.log(usage());
    process.exit(1);
  }

  await mkdir(PLANS, { recursive: true });
  const browser = await openBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let written = 0;
  try {
    for (const card of wanted) {
      const svg = await (await get(
        options.server + "/variants/" + card.key + "/map.svg?style=original")).text();
      const kind = JDIP_KEYS.includes(card.key) ? "jdip" : "godip";
      const plan: PlanJSON = {
        version: PLAN_VERSION,
        key: card.key,
        name: card.name,
        kind: kind,
        map: {
          bytes: Buffer.byteLength(svg),
          sha256: createHash("sha256").update(svg).digest("hex"),
          viewBoxWidth: viewBoxWidthOf(svg),
        },
      };
      if (kind === "godip") plan.godip = await godipPlan(page, options.server, card.key, svg);
      else plan.jdip = await jdipPlan(page, card.key, svg);

      const detail = kind === "godip"
        ? (plan.godip!.styleable
            ? "sea " + plan.godip!.sea + ", land " + plan.godip!.land + ", " +
              plan.godip!.names.kinds.length + " name(s), " +
              (plan.godip!.borders.decoration
                ? "foreground left as drawn"
                : plan.godip!.borders.candidates + " border stroke(s)")
            : "NOT STYLEABLE — " + plan.godip!.reason)
        : plan.jdip!.labelClasses.length + " label(s), " +
          plan.jdip!.powerClasses.length + " power class(es)";
      console.log("  " + card.key.padEnd(24) + kind.padEnd(6) + detail);

      if (options.write) {
        await writeFile(join(PLANS, card.key + ".json"), JSON.stringify(plan, null, 2) + "\n");
        written++;
      }
    }
  } finally {
    await browser.close();
  }
  console.log("\n" + written + " plan(s) written to " + PLANS);
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

/*
Writes styles/parchment.json out of godip's classical map.

    node extract-parchment.ts [--classical <path>] [--check]

The house style is classical's, and the only honest record of classical's
style is classical. So the first checked-in style is generated from the file
rather than typed out, and this script is how it is regenerated when godip
moves. --check re-extracts and says whether the checked-in file still matches,
which is what a test asks.

The three assets it writes beside the JSON — the embedded faces, the hatch and
the paper grain — are lifted verbatim, with the editor's own attributes
stripped, and are shared by the styles that want them.
*/

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { extractClassical, type ClassicalTokens } from "./tokens.ts";
import { stylesDir, type StyleDefinition } from "./styles.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = stylesDir(HERE);
const ASSETS = join(STYLES, "assets");

/** classical's map.svg, out of the Go module cache. */
async function readClassical(given: string | null): Promise<{ svg: string; from: string }> {
  if (given) return { svg: await readFile(given, "utf8"), from: given };
  const modules = join(process.env.HOME || "", "go", "pkg", "mod", "github.com", "zond");
  if (existsSync(modules)) {
    const entries = await readdir(modules);
    const godip = entries.filter((name) => name.startsWith("godip@")).sort().pop();
    if (godip) {
      const path = join(modules, godip, "variants", "classical", "svg", "map.svg");
      if (existsSync(path)) return { svg: await readFile(path, "utf8"), from: path };
    }
  }
  throw new Error("classical's map.svg was not found; pass --classical <path>");
}

function definitionFrom(tokens: ClassicalTokens): StyleDefinition {
  return {
    name: "parchment",
    title: "Parchment",
    description:
      "godip's own classical map: two paper tones, a hairline border and Libre Baskerville.",
    referenceWidth: tokens.referenceWidth,
    terrain: {
      land: tokens.landFill,
      sea: tokens.seaFill,
      impassable: "url(#" + tokens.impassablePatternId + ")",
      ground: tokens.seaFill,
    },
    border: {
      stroke: tokens.borderStroke,
      width: tokens.borderWidth,
      opacity: 1,
      dash: null,
      linejoin: "round",
    },
    coast: {
      mode: "shadow",
      stroke: tokens.shadowStroke,
      width: tokens.shadowWidth,
      blur: tokens.shadowBlur,
    },
    grain: {
      patternId: tokens.noisePatternId,
      opacity: tokens.noiseOpacity,
      defs: ["assets/paper-grain.svg"],
    },
    defs: ["assets/impassable-stripes.svg"],
    fonts: ["assets/libre-baskerville.css"],
    typography: {
      land: {
        family: tokens.land.family,
        weight: tokens.land.weight,
        style: tokens.land.style,
        letterSpacing: tokens.land.letterSpacing,
        fill: tokens.land.fill,
        halo: null,
      },
      sea: {
        family: tokens.sea.family,
        weight: tokens.sea.weight,
        style: tokens.sea.style,
        letterSpacing: tokens.sea.letterSpacing,
        fill: tokens.sea.fill,
        halo: null,
      },
      seaAbbrevLetterSpacing: tokens.seaAbbrevLetterSpacing,
    },
    supplyCentre: {
      fill: tokens.borderStroke,
      stroke: tokens.borderStroke,
      strokeWidth: tokens.borderWidth,
      opacity: 1,
    },
  };
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  let classical: string | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--classical") classical = argv[++i];
    else if (argv[i] === "--check") check = true;
    else throw new Error("unknown argument " + JSON.stringify(argv[i]));
  }

  const source = await readClassical(classical);
  const tokens = extractClassical(source.svg);
  const definition = definitionFrom(tokens);
  const json = JSON.stringify(definition, null, 2) + "\n";
  const target = join(STYLES, "parchment.json");

  if (check) {
    const current = existsSync(target) ? await readFile(target, "utf8") : "";
    if (current !== json) {
      console.error("parchment.json is out of date with " + source.from);
      process.exit(1);
    }
    console.log("parchment.json matches " + source.from);
    return;
  }

  await mkdir(ASSETS, { recursive: true });
  await writeFile(join(ASSETS, "libre-baskerville.css"), tokens.fontFaces + "\n");
  await writeFile(join(ASSETS, "impassable-stripes.svg"), tokens.impassablePattern + "\n");
  await writeFile(join(ASSETS, "paper-grain.svg"), tokens.noisePattern + "\n");
  await writeFile(target, json);
  console.log("wrote " + target + " and its three assets, from " + source.from);
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

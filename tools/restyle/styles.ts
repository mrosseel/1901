/*
Named map styles, as data.

A style is a JSON file under tools/restyle/styles/. It says what the two
terrain tones are, how a border is drawn, whether there is a grain, what the
names are set in, and how a supply-centre glyph is painted — and nothing else.
Everything a style can say is a presentation property, because a style that
could say anything more would no longer be a restyle.

The first style checked in is "parchment", and it is not hand-written: it is
extracted from godip's classical map by extract-parchment.ts, so the house
style stays the file's own rather than someone's memory of it. The other three
are designed, and they are read by exactly the same loader.

Lengths are quoted the way classical quotes them — against `referenceWidth`
map units — and carried onto the map being styled by carryLength(). A style
therefore never has to know how wide its target is.

Assets (font faces, pattern definitions) live beside the JSON and are named by
relative path. Keeping the 280 KB of base64 Libre Baskerville in one file that
three styles point at is the difference between a style being readable and a
style being a wall of data.
*/

import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** How one kind of name is set. Lengths are in the style's reference units. */
export interface StyleTypography {
  /** The family stack, most specific first; may name an embedded face. */
  family: string;
  weight: string;
  style: string;
  letterSpacing: number;
  fill: string;
  /*
  The halo a name is drawn over, or null for none.

  This is the whole of the legibility budget. A dark map or a saturated sea
  puts a name over a tone it was never chosen against, and a halo — a stroke
  painted under the glyph with paint-order — is the only way to keep it
  readable without changing the size the placements were measured on.
  */
  halo: { color: string; width: number } | null;
}

export interface StyleDefinition {
  /** The name it is asked for by: --style <name>, ?style=<name>. */
  name: string;
  /** What a person sees in the picker. */
  title: string;
  /** One line on what it is for. */
  description: string;
  /** The width every length below is quoted against. */
  referenceWidth: number;
  terrain: {
    land: string;
    sea: string;
    /** A colour or a url(#id) into one of the defs below. */
    impassable: string;
    /** The ground behind the art, which is usually the sea tone. */
    ground: string;
    /*
    The ground behind a map that draws one polygon per province.

    `ground` is the sea tone, which is right for classical: its art is one
    landmass over a sea-coloured rect, so anything showing through is sea. A
    converted jDip map is the other shape — every province is its own polygon
    and the hairline gaps BETWEEN them show the ground — so the sea tone there
    turns every inland border into a channel of water. This is a land-adjacent
    tone, a darkened land, and it is what those maps are given instead.
    */
    groundInland: string;
  };
  border: {
    stroke: string;
    width: number;
    opacity: number;
    /** Dash pattern in reference units, or null for a solid line. */
    dash: number[] | null;
    linejoin: string;
  };
  /*
  Classical draws its coast as a blurred stroke under one landmass path. A
  converted jDip map has no such path — its land is one polygon per province —
  so a shadow there would fall on every internal border as well. The treatment
  is carried in the style anyway, with the mode that says whether the applier
  may use it, so a map that DOES have a single landmass can have it later.
  */
  coast: {
    mode: "shadow" | "none";
    stroke: string;
    width: number;
    blur: number;
  };
  /** The wash laid over the finished map, or null for a clean one. */
  grain: {
    patternId: string;
    opacity: number;
    /** Pattern definitions, by path relative to the style file. */
    defs: string[];
  } | null;
  /** Other definitions the style needs — hatches, mostly. */
  defs: string[];
  /** CSS files holding @font-face rules, embedded verbatim into the map. */
  fonts: string[];
  typography: {
    land: StyleTypography;
    sea: StyleTypography;
    /** A short sea name is an abbreviation and is tracked out this far. */
    seaAbbrevLetterSpacing: number;
  };
  /** How a supply-centre glyph is painted, where the map draws any. */
  supplyCentre: {
    fill: string;
    stroke: string;
    strokeWidth: number;
    opacity: number;
  };
}

/** A style with its assets read in, which is what the applier works from. */
export interface LoadedStyle extends Omit<StyleDefinition, "defs" | "fonts" | "grain"> {
  /** Every definition the style needs, as SVG text. */
  defs: string[];
  /** The @font-face rules, verbatim. Empty when the style embeds no face. */
  fontFaces: string;
  grain: { patternId: string; opacity: number; svg: string } | null;
  /** Where it was read from, for the report. */
  source: string;
}

/** The default directory: tools/restyle/styles. */
export function stylesDir(here: string): string {
  return join(here, "styles");
}

function fail(source: string, what: string): never {
  throw new Error(source + ": " + what);
}

function str(value: unknown, source: string, what: string): string {
  if (typeof value !== "string" || value === "") fail(source, what + " must be a non-empty string");
  return value as string;
}

function num(value: unknown, source: string, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(source, what + " must be a finite number");
  }
  return value as number;
}

function typography(raw: unknown, source: string, what: string): StyleTypography {
  const one = (raw || {}) as Record<string, unknown>;
  const halo = one.halo as Record<string, unknown> | null | undefined;
  return {
    family: str(one.family, source, what + ".family"),
    weight: str(one.weight, source, what + ".weight"),
    style: str(one.style, source, what + ".style"),
    letterSpacing: num(one.letterSpacing, source, what + ".letterSpacing"),
    fill: str(one.fill, source, what + ".fill"),
    halo: halo
      ? {
          color: str(halo.color, source, what + ".halo.color"),
          width: num(halo.width, source, what + ".halo.width"),
        }
      : null,
  };
}

/*
Reads and checks one style file.

Everything is checked rather than defaulted. A style with a missing tone would
otherwise produce a map with one province painted `undefined`, which a browser
draws as black and nobody notices until it is served.
*/
export function parseStyle(raw: unknown, source: string): StyleDefinition {
  const one = (raw || {}) as Record<string, unknown>;
  const terrain = (one.terrain || {}) as Record<string, unknown>;
  const border = (one.border || {}) as Record<string, unknown>;
  const coast = (one.coast || {}) as Record<string, unknown>;
  const type = (one.typography || {}) as Record<string, unknown>;
  const sc = (one.supplyCentre || {}) as Record<string, unknown>;
  const grain = one.grain as Record<string, unknown> | null | undefined;

  const name = str(one.name, source, "name");
  if (!/^[a-z][a-z0-9]*$/.test(name)) {
    fail(source, "name must be lower-case letters and digits: it is a URL parameter");
  }
  const mode = str(coast.mode, source, "coast.mode");
  if (mode !== "shadow" && mode !== "none") fail(source, 'coast.mode must be "shadow" or "none"');

  const paths = (value: unknown, what: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail(source, what + " must be a list of paths");
    return (value as unknown[]).map((one, i) => str(one, source, what + "[" + i + "]"));
  };

  return {
    name: name,
    title: str(one.title, source, "title"),
    description: str(one.description, source, "description"),
    referenceWidth: num(one.referenceWidth, source, "referenceWidth"),
    terrain: {
      land: str(terrain.land, source, "terrain.land"),
      sea: str(terrain.sea, source, "terrain.sea"),
      impassable: str(terrain.impassable, source, "terrain.impassable"),
      ground: str(terrain.ground, source, "terrain.ground"),
      groundInland: str(terrain.groundInland, source, "terrain.groundInland"),
    },
    border: {
      stroke: str(border.stroke, source, "border.stroke"),
      width: num(border.width, source, "border.width"),
      opacity: num(border.opacity, source, "border.opacity"),
      dash: border.dash === null || border.dash === undefined
        ? null
        : (border.dash as unknown[]).map((one, i) => num(one, source, "border.dash[" + i + "]")),
      linejoin: str(border.linejoin, source, "border.linejoin"),
    },
    coast: {
      mode: mode,
      stroke: str(coast.stroke, source, "coast.stroke"),
      width: num(coast.width, source, "coast.width"),
      blur: num(coast.blur, source, "coast.blur"),
    },
    grain: grain
      ? {
          patternId: str(grain.patternId, source, "grain.patternId"),
          opacity: num(grain.opacity, source, "grain.opacity"),
          defs: paths(grain.defs, "grain.defs"),
        }
      : null,
    defs: paths(one.defs, "defs"),
    fonts: paths(one.fonts, "fonts"),
    typography: {
      land: typography(type.land, source, "typography.land"),
      sea: typography(type.sea, source, "typography.sea"),
      seaAbbrevLetterSpacing: num(
        type.seaAbbrevLetterSpacing, source, "typography.seaAbbrevLetterSpacing"),
    },
    supplyCentre: {
      fill: str(sc.fill, source, "supplyCentre.fill"),
      stroke: str(sc.stroke, source, "supplyCentre.stroke"),
      strokeWidth: num(sc.strokeWidth, source, "supplyCentre.strokeWidth"),
      opacity: num(sc.opacity, source, "supplyCentre.opacity"),
    },
  };
}

async function readAsset(base: string, path: string): Promise<string> {
  const full = isAbsolute(path) ? path : resolve(base, path);
  return (await readFile(full, "utf8")).trim();
}

/** Reads a style file and everything it points at. */
export async function loadStyle(dir: string, name: string): Promise<LoadedStyle> {
  const source = join(dir, name + ".json");
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    const known = (await listStyles(dir)).join(", ");
    throw new Error("no style named " + JSON.stringify(name) + "; there is " + known);
  }
  const definition = parseStyle(JSON.parse(text), source);
  if (definition.name !== name) {
    fail(source, 'the file is named ' + name + '.json but the style calls itself "' + definition.name + '"');
  }
  const base = dirname(source);
  const defs: string[] = [];
  for (const path of definition.defs) defs.push(await readAsset(base, path));
  const faces: string[] = [];
  for (const path of definition.fonts) faces.push(await readAsset(base, path));
  let grain: LoadedStyle["grain"] = null;
  if (definition.grain) {
    const parts: string[] = [];
    for (const path of definition.grain.defs) parts.push(await readAsset(base, path));
    grain = {
      patternId: definition.grain.patternId,
      opacity: definition.grain.opacity,
      svg: parts.join("\n"),
    };
  }
  return { ...definition, defs: defs, fontFaces: faces.join("\n"), grain: grain, source: source };
}

/** Every style name in the directory, sorted. */
export async function listStyles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/** What the server publishes so a picker can be drawn: name, title, line. */
export interface StyleCard {
  name: string;
  title: string;
  description: string;
}

export function styleCard(style: StyleDefinition): StyleCard {
  return { name: style.name, title: style.title, description: style.description };
}

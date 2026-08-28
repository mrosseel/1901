/*
The decisions the godip applier makes, tested without a browser.

Everything that needs a rendering engine — what is painted under a province,
what covers the map — is measured by probeMap and is not tested here; what IS
tested is what the tool concludes from those measurements, which is where a
substitution can go quietly wrong.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECORATION_RATIO,
  VOTE_THRESHOLD,
  checkGodipStructure,
  classifyPalette,
  godipLayer,
  normaliseFill,
  patternId,
  planSubstitutions,
  replaceFills,
  replacePattern,
  restyleGodipMap,
  setStyleProps,
  type MapProbe,
  type ProvinceType,
} from "./godip.ts";
import { loadStyle, stylesDir } from "./styles.ts";
import { carryTone, darken, luma, parseColour, toHex } from "./tokens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = stylesDir(HERE);

/* A map the shape classical is: a sea-coloured ground, one landmass, a hatch
   for the ground nobody can enter, and a paper noise over the lot. */
const PROBE: MapProbe = {
  width: 1524,
  backdrop: "#d4d0ad",
  underProvince: {
    nth: "#d4d0ad", eng: "#d4d0ad", bal: "#d4d0ad",
    lon: "#f4d7b5", par: "#f4d7b5", ber: "#f4d7b5", mun: "#f4d7b5",
    "spa/nc": "#f4d7b5",
  },
  coverage: [
    { fill: "#f4d7b5", fraction: 0.54 },
    { fill: "#d4d0ad", fraction: 0.44 },
    { fill: "url(#impassableStripes)", fraction: 0.012 },
  ],
  overlays: [{ fill: "url(#pattern1827)", opacity: 0.05, id: "Noise" }],
  labels: [],
  unsampled: [],
};

const TYPES: ProvinceType[] = [
  { key: "nth", type: "sea" },
  { key: "eng", type: "sea" },
  { key: "bal", type: "sea" },
  { key: "lon", type: "coast" },
  { key: "par", type: "land" },
  { key: "ber", type: "coast" },
  { key: "mun", type: "land" },
  /* A named coast: the adjudicator calls it sea, the map paints it as land. */
  { key: "spa/nc", type: "sea" },
];

test("the palette is decided by what the adjudicator calls sea", () => {
  const palette = classifyPalette(PROBE, TYPES);
  assert.ok(palette.ok, palette.reason);
  assert.equal(palette.sea, "#d4d0ad");
  assert.equal(palette.land, "#f4d7b5");
  assert.equal(palette.impassablePattern, "impassableStripes");
  assert.equal(palette.grainPattern, "pattern1827");
});

test("a named coast votes for nothing: it is sea that is painted as land", () => {
  /* spa/nc is sea to the adjudicator and parchment on the map. Counted, it
     would say the land tone is the sea tone — which is how classical, Cold
     War and Twenty Twenty all failed their first vote. */
  const palette = classifyPalette(PROBE, TYPES);
  assert.equal(palette.seaConfidence, 1);
});

test("a map whose sea is painted several ways is left alone, and says why", () => {
  const split: MapProbe = {
    ...PROBE,
    underProvince: { ...PROBE.underProvince, eng: "#123456", bal: "#654321" },
  };
  const palette = classifyPalette(split, TYPES);
  assert.equal(palette.ok, false);
  assert.match(palette.reason, /not decisive/);
  assert.ok(VOTE_THRESHOLD > 0.5, "a plurality is not enough to substitute on");
});

test("a variant with no sea takes its ground from the map's corners", () => {
  const pure: MapProbe = {
    ...PROBE,
    underProvince: { a: "#f4d7b5", b: "#f4d7b5" },
    coverage: [{ fill: "#d4d0ad", fraction: 0.84 }, { fill: "#f4d7b5", fraction: 0.16 }],
  };
  const palette = classifyPalette(pure, [
    { key: "a", type: "land" }, { key: "b", type: "land" },
  ]);
  assert.ok(palette.ok, palette.reason);
  assert.equal(palette.sea, "#d4d0ad");
  assert.equal(palette.land, "#f4d7b5");
});

test("sea and land painted the same colour is refused", () => {
  const flat: MapProbe = {
    ...PROBE,
    underProvince: Object.fromEntries(TYPES.map((one) => [one.key, "#d3cfae"])),
  };
  const palette = classifyPalette(flat, TYPES);
  assert.equal(palette.ok, false);
  assert.match(palette.reason, /same colour/);
});

test("a second land tone keeps its distance from the first", async () => {
  const style = await loadStyle(STYLES, "midnight");
  const withExtra: MapProbe = {
    ...PROBE,
    coverage: [...PROBE.coverage, { fill: "#f0cba5", fraction: 0.04 }],
  };
  const palette = classifyPalette(withExtra, TYPES);
  assert.deepEqual(palette.extras.map((one) => one.near), ["land"]);
  const plan = planSubstitutions(palette, style);
  const carried = plan.get("#f0cba5");
  assert.ok(carried, "the second tone is substituted too");
  /* Darker on the map, so darker in the style — and not the same as the
     style's land, which would flatten the two into one. */
  assert.ok(luma(carried as string) < luma(style.terrain.land));
  assert.notEqual(carried, style.terrain.land);
});

test("ink is not terrain: a black shadow keeps its colour", () => {
  const withInk: MapProbe = {
    ...PROBE,
    coverage: [...PROBE.coverage, { fill: "#000000", fraction: 0.12 }],
  };
  const palette = classifyPalette(withInk, TYPES);
  assert.equal(palette.extras.length, 0);
});

test("fills are rewritten however the map spells them, and not inside defs", () => {
  const svg =
    '<svg><defs><pattern id="p"><rect fill="#f4d7b5"/></pattern></defs>' +
    '<path style="fill:#F4D7B5;stroke:#000"/>' +
    '<rect fill="rgb(244, 215, 181)"/>' +
    '<path style="fill:#d4d0ad"/></svg>';
  const plan = new Map([["#f4d7b5", "#49545f"], ["#d4d0ad", "#13202e"]]);
  const out = replaceFills(svg, plan);
  assert.equal((out.svg.match(/#49545f/g) || []).length, 2, "both spellings caught");
  assert.match(out.svg, /<pattern id="p"><rect fill="#f4d7b5"\/>/, "the defs are left alone");
  assert.equal(out.counts.get("#f4d7b5"), 2);
});

test("a colour is one colour however it is written", () => {
  assert.equal(normaliseFill("#F4D7B5"), "#f4d7b5");
  assert.equal(normaliseFill("rgb(244, 215, 181)"), "#f4d7b5");
  assert.equal(normaliseFill("#fff"), "#ffffff");
  assert.equal(normaliseFill('url("#impassableStripes")'), "url(#impassablestripes)");
  assert.equal(patternId("url(#impassableStripes)"), "impassableStripes");
  assert.equal(patternId("#f4d7b5"), null);
});

test("a pattern is swapped for the style's, keeping the id it is called by", () => {
  const svg = '<defs><pattern id="impassableStripes"><line x1="0"/></pattern></defs>';
  const out = replacePattern(svg, "impassableStripes", '<pattern id="other"><rect/></pattern>');
  assert.equal(out, '<defs><pattern id="impassableStripes"><rect/></pattern></defs>');
});

test("a style declaration replaces the one it names and keeps the rest", () => {
  assert.equal(
    setStyleProps("fill:#000;font-size:16px", { fill: "#fff", "font-style": "italic" }),
    "font-size:16px;fill:#fff;font-style:italic",
  );
});

test("a layer is found by id or by the editor's label", () => {
  const svg = '<svg><g inkscape:label="names" id="g99"><text/></g></svg>';
  const found = godipLayer(svg, "names");
  assert.ok(found);
  assert.match(svg.slice(found.start, found.end), /<text\/><\/g>$/);
});

test("colour arithmetic: darker, and the step between two tones is carried", () => {
  assert.equal(darken("#ffffff", 0.12), "#e0e0e0");
  assert.equal(toHex(parseColour("rgb(1,2,3)") as [number, number, number]), "#010203");
  /* A tone 10% lighter than the map's land comes out 10% lighter than the
     style's, whatever the style's land is. */
  const carried = carryTone("#404040", "#808080", "#999999");
  assert.ok(luma(carried) > luma("#404040"));
});

test("the whole restyle moves nothing, and the check would say so if it did", async () => {
  const style = await loadStyle(STYLES, "midnight");
  const svg =
    '<svg viewBox="0 0 1524 1357">' +
    '<defs><pattern id="impassableStripes"><line id="l" x1="0"/></pattern></defs>' +
    '<g id="background"><rect id="bg" x="0" y="0" width="1524" height="1357" style="fill:#d4d0ad"/>' +
    '<path id="land" d="M0 0 L10 0 L10 10 Z" style="fill:#f4d7b5"/></g>' +
    '<g id="foreground"><path id="b1" d="M1 1 L2 2" style="fill:none;stroke:#000000"/></g>' +
    '<g id="names"><text id="t1" x="5" y="5" style="font-size:16px;fill:#000000">Munich</text></g>' +
    '<g id="provinces"><path id="mun" d="M0 0 L10 0 L10 10 Z"/></g></svg>';
  const probe: MapProbe = { ...PROBE, labels: [{ index: 0, text: "Munich", over: "#f4d7b5", italic: false }] };
  const palette = classifyPalette(probe, TYPES);
  const built = restyleGodipMap(svg, style, palette, probe, { grain: true, borders: true });
  const diff = checkGodipStructure(svg, built.svg);
  assert.ok(diff.ok, diff.problems.join("; "));
  assert.match(built.svg, /fill:#13202e/, "the sea is the style's");
  assert.match(built.svg, /fill:#49545f/, "the land is the style's");
  assert.match(built.svg, /font-size:16px/, "the size the map chose is kept");
  assert.equal(built.landNames, 1);

  /* And the check earns its keep: moving one coordinate fails it. */
  const moved = built.svg.replace('d="M0 0 L10 0 L10 10 Z"', 'd="M0 0 L11 0 L10 10 Z"');
  assert.equal(checkGodipStructure(svg, moved).ok, false);
});

test("a foreground full of decoration is left as drawn", async () => {
  const style = await loadStyle(STYLES, "print");
  const knot = Array.from(
    { length: DECORATION_RATIO * 8 + 1 },
    (one, i) => '<path id="k' + i + '" d="M0 0 L1 1" style="fill:none;stroke:#000000"/>',
  ).join("");
  const svg =
    '<svg viewBox="0 0 578 578"><g id="background">' +
    '<rect id="bg" width="578" height="578" style="fill:#d4d0ad"/></g>' +
    '<g id="foreground">' + knot + "</g></svg>";
  const probe: MapProbe = {
    ...PROBE,
    underProvince: { nth: "#d4d0ad", eng: "#d4d0ad", bal: "#d4d0ad", lon: "#f4d7b5",
      par: "#f4d7b5", ber: "#f4d7b5", mun: "#f4d7b5", "spa/nc": "#f4d7b5" },
  };
  const palette = classifyPalette(probe, TYPES);
  const built = restyleGodipMap(svg, style, palette, probe, { grain: true, borders: true });
  assert.match(built.notes.join("\n"), /decoration rather than borders/);
  assert.match(built.svg, /stroke:#000000/, "the knot keeps its own ink");
});

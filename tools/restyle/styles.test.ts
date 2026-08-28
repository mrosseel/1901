import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listStyles, loadStyle, parseStyle, styleCard, stylesDir } from "./styles.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = stylesDir(HERE);

/* A style with every field filled in, which the tests then break one at a
   time. Writing it out once is what makes each failure case one line. */
const WHOLE = {
  name: "example",
  title: "Example",
  description: "A style that exists only in this test.",
  referenceWidth: 1524,
  terrain: { land: "#fff", sea: "#000", impassable: "#888", ground: "#000" },
  border: { stroke: "#000", width: 1, opacity: 1, dash: null, linejoin: "round" },
  coast: { mode: "none", stroke: "#000", width: 4, blur: 5 },
  grain: null,
  defs: [],
  fonts: [],
  typography: {
    land: { family: "serif", weight: "bold", style: "normal", letterSpacing: 0, fill: "#000", halo: null },
    sea: { family: "serif", weight: "normal", style: "italic", letterSpacing: 0, fill: "#333", halo: null },
    seaAbbrevLetterSpacing: 3,
  },
  supplyCentre: { fill: "#000", stroke: "#fff", strokeWidth: 1, opacity: 1 },
};

const without = (path: string): unknown => {
  const copy = JSON.parse(JSON.stringify(WHOLE)) as Record<string, never>;
  const parts = path.split(".");
  let cursor = copy as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  delete cursor[parts[parts.length - 1]];
  return copy;
};

test("a whole style parses, and says what it is", () => {
  const style = parseStyle(WHOLE, "test");
  assert.equal(style.name, "example");
  assert.equal(style.terrain.land, "#fff");
  assert.deepEqual(styleCard(style), {
    name: "example",
    title: "Example",
    description: "A style that exists only in this test.",
  });
});

test("a missing tone is refused rather than defaulted", () => {
  /* A style with no sea would paint every water province `undefined`, which a
     browser draws as black, and nobody sees it until it is served. */
  assert.throws(() => parseStyle(without("terrain.sea"), "test"), /terrain\.sea/);
  assert.throws(() => parseStyle(without("border.width"), "test"), /border\.width/);
  assert.throws(() => parseStyle(without("typography.land.fill"), "test"), /typography\.land\.fill/);
  assert.throws(() => parseStyle(without("supplyCentre.opacity"), "test"), /supplyCentre\.opacity/);
});

test("a name that is not URL-safe is refused: it is a query parameter", () => {
  assert.throws(() => parseStyle({ ...WHOLE, name: "Mid Night" }, "test"), /URL parameter/);
  assert.throws(() => parseStyle({ ...WHOLE, name: "2dark" }, "test"), /URL parameter/);
});

test("coast.mode is one of two words", () => {
  assert.throws(
    () => parseStyle({ ...WHOLE, coast: { ...WHOLE.coast, mode: "blur" } }, "test"),
    /coast\.mode/,
  );
});

test("a halo is optional, and is read whole when it is there", () => {
  const haloed = JSON.parse(JSON.stringify(WHOLE)) as typeof WHOLE;
  (haloed.typography.land as Record<string, unknown>).halo = { color: "#fff", width: 1.2 };
  const style = parseStyle(haloed, "test");
  assert.deepEqual(style.typography.land.halo, { color: "#fff", width: 1.2 });
  assert.equal(style.typography.sea.halo, null);
});

test("the four checked-in styles load, assets and all", async () => {
  const names = await listStyles(STYLES);
  assert.deepEqual(names, ["flat", "midnight", "parchment", "print"]);
  for (const name of names) {
    const style = await loadStyle(STYLES, name);
    assert.equal(style.name, name);
    assert.ok(style.title, name + " has a title for the picker");
    assert.ok(style.description, name + " says what it is for");
    // Every def the style names must have been read, and a style that paints
    // impassable through a pattern must ship the pattern it points at.
    const reference = /url\(#([^)]+)\)/.exec(style.terrain.impassable);
    if (reference) {
      assert.ok(
        style.defs.some((one) => one.includes('id="' + reference[1] + '"')),
        name + " points at #" + reference[1] + " and must define it",
      );
    }
    if (style.grain) {
      assert.ok(
        style.grain.svg.includes('id="' + style.grain.patternId + '"'),
        name + " must define the grain pattern it names",
      );
    }
  }
});

test("parchment carries classical's embedded faces, so the map needs no network", async () => {
  const parchment = await loadStyle(STYLES, "parchment");
  assert.match(parchment.fontFaces, /@font-face/);
  assert.match(parchment.fontFaces, /Libre ?Baskerville/);
  assert.ok(parchment.fontFaces.length > 100000, "the faces are embedded, not linked");
});

test("a style that embeds no face still names a family stack", async () => {
  const print = await loadStyle(STYLES, "print");
  assert.equal(print.fontFaces, "");
  assert.match(print.typography.land.family, /sans-serif/);
});

test("asking for a style that is not there names the ones that are", async () => {
  await assert.rejects(() => loadStyle(STYLES, "sepia"), /parchment/);
});

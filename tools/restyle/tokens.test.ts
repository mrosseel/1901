import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carryLength,
  compareStructure,
  extractClassical,
  layerText,
  layerTransform,
  stripEditorAttributes,
  styleProp,
  summariseStructure,
  transformScale,
  viewBoxWidth,
} from "./tokens.ts";

/*
A miniature of classical's map: the same element ids, the same shape of style
attribute, and nothing else. Every token the restyle needs has to be findable
in this, or extractClassical() is reading something it should not be.
*/
const CLASSICAL = `<svg viewBox="0 0 1524 1357">
<defs>
<filter id="filter848"><feGaussianBlur stdDeviation="5.7648684"/></filter>
<pattern inkscape:collect="always" patternTransform="rotate(35)" height="16" width="16" patternUnits="userSpaceOnUse" id="impassableStripes">
<line stroke-width="18" stroke-opacity="0.1" stroke="#000000" y2="16" x2="0" x1="0"/></pattern>
<pattern inkscape:collect="always" id="pattern1827" xlink:href="#pattern-4-3"/>
<pattern id="pattern-4-3" width="258" height="258"><image id="use11-6" xlink:href="data:image/png;base64,AA=="/></pattern>
<style>@font-face { font-family: 'Libre Baskerville'; src: url(data:font/woff2;base64,AA==); }</style>
</defs>
<g inkscape:label="background" id="background">
  <rect style="fill:#d4d0ad;stroke:#979797" height="1357" width="1523" y="0" x="0" id="background-rect"/>
  <path style="fill:none;stroke:#000000;stroke-width:4;filter:url(#filter848)" id="Shape" d="m 1,2"/>
  <path d="m 3,4" id="path838" style="fill:#f4d7b5"/>
</g>
<g inkscape:label="foreground" id="foreground">
  <path style="fill:none;fill-rule:evenodd;stroke:#000000;stroke-width:1" id="portugal" d="m 5,6"/>
  <path style="fill:url(#impassableStripes);fill-rule:evenodd;stroke:#000000;stroke-width:1" id="cyprus" d="m 7,8"/>
  <rect style="display:inline;fill:url(#pattern1827);fill-opacity:0.05" id="Noise" width="1523" height="1357" x="0" y="0"/>
</g>
<g inkscape:label="names" id="names">
  <text style="font-weight:bold;font-size:16px;font-family:LibreBaskerville-Bold, 'Libre Baskerville';letter-spacing:-0.5;fill:#000000" id="Portugal">Portugal</text>
  <text style="font-style:italic;font-weight:normal;font-size:16px;font-family:LibreBaskerville-Italic, 'Libre Baskerville';letter-spacing:3;fill:#000000" id="NRG">NRG</text>
</g>
</svg>`;

test("the classical tokens are read off the map, not assumed", () => {
  const tokens = extractClassical(CLASSICAL);
  assert.equal(tokens.referenceWidth, 1524);
  assert.equal(tokens.seaFill, "#d4d0ad", "the background rect is the sea tone");
  assert.equal(tokens.landFill, "#f4d7b5", "the single-fill landmass path is the parchment");
  assert.equal(tokens.borderStroke, "#000000");
  assert.equal(tokens.borderWidth, 1);
  assert.equal(tokens.shadowWidth, 4);
  assert.equal(tokens.shadowBlur, 5.7648684);
  assert.equal(tokens.noiseOpacity, 0.05);
  assert.match(tokens.impassablePattern, /rotate\(35\)/);
  assert.match(tokens.fontFaces, /Libre Baskerville/);
});

test("the two kinds of name are told apart by weight and slope", () => {
  const tokens = extractClassical(CLASSICAL);
  assert.equal(tokens.land.weight, "bold");
  assert.equal(tokens.land.style, "normal");
  assert.equal(tokens.land.letterSpacing, -0.5);
  assert.equal(tokens.sea.style, "italic");
  assert.equal(tokens.seaAbbrevLetterSpacing, 3, "an abbreviation like NRG is tracked out");
  assert.equal(tokens.sea.letterSpacing, 0, "a full sea name is not");
});

test("an editor's own attributes are stripped off anything lifted from classical", () => {
  // classical is an Inkscape file and declares xmlns:inkscape; a jDip map
  // does not, so carrying one of those attributes across makes the styled map
  // malformed XML and it fails to render at all.
  const fragment = '<pattern inkscape:collect="always" sodipodi:x="1" id="p" width="4"/>';
  const clean = stripEditorAttributes(fragment);
  assert.equal(clean, '<pattern id="p" width="4"/>');
  assert.ok(!extractClassical(CLASSICAL).impassablePattern.includes("inkscape:"));
  assert.ok(!extractClassical(CLASSICAL).noisePattern.includes("inkscape:"));
});

test("the noise pattern chain is followed to the tile that holds the image", () => {
  const tokens = extractClassical(CLASSICAL);
  assert.equal(tokens.noisePatternId, "pattern1827");
  assert.match(tokens.noisePattern, /pattern-4-3/, "the reference is followed");
  assert.match(tokens.noisePattern, /<image/, "and reaches the tile itself");
});

test("a length crosses to another map as a fraction of its width", () => {
  // Classical's hairline is 1 unit on a 1524-wide map. Sailho is 7300 wide
  // with an art layer that only moves things, so the same hairline is 4.79.
  assert.equal(carryLength(1, 1524, 7300), 4.79);
  // 1900's art layer is drawn a tenth of size, so the number inside it has to
  // be ten times larger to come out the same on screen.
  assert.equal(carryLength(1, 1524, 761, 0.1), 4.993);
  // A map the same size as classical changes nothing.
  assert.equal(carryLength(1, 1524, 1524), 1);
});

test("a layer's scale is read out of its transform, and a move is not a scale", () => {
  assert.equal(transformScale("translate(-600,-1685)"), 1);
  assert.equal(transformScale("translate(0,713) scale(0.1,-0.1)"), 0.1);
  assert.equal(transformScale(null), 1);
});

test("small readers: style properties, viewBox, layer transform", () => {
  assert.equal(styleProp("fill:#abc;stroke:none", "fill"), "#abc");
  assert.equal(styleProp("fill:#abc;stroke-width:2", "stroke"), null, "stroke-width is not stroke");
  assert.equal(viewBoxWidth(CLASSICAL), 1524);
  assert.equal(layerTransform(CLASSICAL, "background"), null);
});

test("a layer's text ends at its own close tag, not the first one it meets", () => {
  const svg = '<svg><g id="outer"><g id="inner"><path id="p"/></g></g><g id="after"/></svg>';
  const outer = layerText(svg, "outer");
  assert.ok(outer);
  assert.ok(outer.includes('id="inner"'));
  assert.ok(!outer.includes('id="after"'), "the scan stopped at the right close");
  assert.equal(layerText(svg, "after"), '<g id="after"/>');
});

// --- the guarantee the whole tool rests on --------------------------------

const MAP = `<svg viewBox="0 0 100 100"><defs><style>.water{fill:blue}</style></defs>
<g id="MapLayer" transform="translate(1,2)"><rect fill="black" x="0" y="0" width="10" height="10"/>
<path id="_adr" class="water" d="M1 2 L3 4"/></g>
<g id="provinces"><path id="adr" d="M1 2 L3 4"/></g>
<g id="province-centers"><path id="adrCenter" d="m 5,6"/></g>
<g id="FullLabelLayer" class="labeltext"><text x="5" y="6">Adriatic</text></g>
<g id="BriefLabelLayer" visibility="hidden"><text x="5" y="6">ADR</text></g>
<g id="HighestOrderLayer"/></svg>`;

test("a pure restyle passes the structure check", () => {
  // Fills, classes and the stylesheet change; nothing else does.
  const styled = MAP
    .replace(".water{fill:blue}", ".water{fill:#d4d0ad;stroke:#000}")
    .replace('fill="black"', 'fill="#d4d0ad"')
    .replace("<text x=\"5\" y=\"6\">Adriatic", '<text x="5" y="6" class="seaname">Adriatic');
  const diff = compareStructure(MAP, styled);
  assert.ok(diff.ok, diff.problems.join("; "));
  assert.equal(diff.totalBefore, diff.totalAfter);
});

test("adding a pattern to defs is allowed, and is reported rather than hidden", () => {
  const styled = MAP.replace("<defs>", '<defs><pattern id="impassableStripes"/>');
  const diff = compareStructure(MAP, styled);
  assert.ok(diff.ok, "defs sits outside the locked layers");
  assert.deepEqual(diff.addedIds, ["impassableStripes"]);
  assert.equal(diff.totalAfter, diff.totalBefore + 1, "and the count still says so");
});

test("moving a coordinate in a locked layer is caught", () => {
  const styled = MAP.replace('<path id="adr" d="M1 2 L3 4"/>', '<path id="adr" d="M1 2 L3 5"/>');
  const diff = compareStructure(MAP, styled);
  assert.ok(!diff.ok);
  assert.match(diff.problems.join(" "), /#provinces: element #adr moved/);
});

test("renaming a province id is caught", () => {
  const styled = MAP.replace('id="adr"', 'id="adriatic"');
  const diff = compareStructure(MAP, styled);
  assert.ok(!diff.ok);
  assert.match(diff.problems.join(" "), /ids (lost|added)/);
});

test("moving an anchor is caught", () => {
  const styled = MAP.replace('<path id="adrCenter" d="m 5,6"/>', '<path id="adrCenter" d="m 5,7"/>');
  const diff = compareStructure(MAP, styled);
  assert.ok(!diff.ok);
  assert.match(diff.problems.join(" "), /#province-centers/);
});

test("dropping a label is caught, because placements were measured against it", () => {
  const styled = MAP.replace('<text x="5" y="6">Adriatic</text>', "");
  const diff = compareStructure(MAP, styled);
  assert.ok(!diff.ok);
  assert.match(diff.problems.join(" "), /#FullLabelLayer/);
});

test("adding an element inside the art layer is caught", () => {
  const styled = MAP.replace('<g id="MapLayer" transform="translate(1,2)">',
    '<g id="MapLayer" transform="translate(1,2)"><rect id="sneaky" x="0" y="0" width="1" height="1"/>');
  const diff = compareStructure(MAP, styled);
  assert.ok(!diff.ok);
  assert.match(diff.problems.join(" "), /#MapLayer/);
});

test("the structure summary reads raw tags, so nothing is normalised away", () => {
  const summary = summariseStructure('<svg><path id="a" d="M0 0"/><path d="M1 1"/></svg>');
  assert.deepEqual(summary.tags, ["svg", "path", "path"]);
  assert.deepEqual(summary.ids, ["a"]);
  assert.equal(summary.geometry.get("#a"), "d=M0 0");
});
